/** Built Electron + real Chrome + local duplex WebRTC; synthetic audio and a test-only signaling endpoint. */
import assert from 'node:assert/strict';
import { _electron as electron, expect, type Video } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import type { AppSnapshot, ElementQueryResult } from '../src/shared/types';

const dir = await mkdtemp(path.join(tmpdir(), 'athena-live-workspace-'));
const out = path.resolve('test-results/live-workspace');
await seedLegacyWorkspace(dir);
const historyText = '可以，先看看首页的开场文案。';
const workspaceFile = path.join(dir, 'workspace.json');
const stored = JSON.parse(await readFile(workspaceFile, 'utf8'));
const now = Date.now();
stored.conversations.push({
  id: 'welcome-review',
  title: '欢迎页文案',
  workspace: stored.settings.workspace,
  updatedAt: now,
  messages: [
    { id: 'review-user', role: 'user', text: '我们一起看看欢迎页。', createdAt: now - 2_000 },
    {
      id: 'review-answer',
      role: 'assistant',
      text: historyText,
      createdAt: now - 1_000,
      status: 'done',
    },
  ],
});
await writeFile(workspaceFile, JSON.stringify(stored));
await mkdir(out, { recursive: true });
const app = await electron.launch({
  args: [
    process.env.ATHENA_TEST_ENTRY || 'tests/electron-background.cjs',
    '--use-mock-keychain',
    '--use-fake-device-for-media-stream',
    '--allow-loopback-in-peer-connection',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--mute-audio',
  ],
  recordVideo: { dir: out, size: { width: 1200, height: 740 } },
  cwd: process.cwd(),
  env: { ...process.env, WORKBENCH_DEV_SERVER_URL: '', WORKBENCH_USER_DATA_DIR: dir },
});
let video: Video | null = null;
try {
  const page = await app.firstWindow();
  video = page.video();
  // tsx preserves function names in the serialized Playwright callback.
  await page.evaluate('globalThis.__name = value => value; void 0');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.workbench.invoke<AppSnapshot>('app:snapshot')).browser.status,
      ),
    )
    .toBe('ready');
  await page.evaluate(() => {
    const f: any = ((window as any).__liveTest = {
      opens: 0,
      closes: 0,
      tracks: [] as MediaStreamTrack[],
    });
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (options) => {
      const stream = await original(options);
      f.tracks.push(...stream.getAudioTracks());
      return stream;
    };
    (window as any).answerLocalLive = async (sdp: string) => {
      f.opens++;
      const peer = new RTCPeerConnection();
      f.peer = peer;
      const ctx = new AudioContext();
      f.ctx = ctx;
      await ctx.resume();
      const tone = ctx.createOscillator(),
        output = ctx.createMediaStreamDestination(),
        gain = ctx.createGain();
      gain.gain.value = 0.07;
      tone.connect(gain).connect(output);
      tone.start();
      peer.ondatachannel = (e) => {
        const ch = e.channel;
        const emit = (obj: object) =>
          ch.send(JSON.stringify({ event_id: crypto.randomUUID(), ...obj }));
        f.emit = emit;
        ch.onopen = () => emit({ type: 'session.started', session: { id: 'live_local_ui' } });
        ch.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'session.close') {
            f.closes++;
            if (!f.silentClose)
              emit({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 8 } });
          }
        };
      };
      await peer.setRemoteDescription({ type: 'offer', sdp });
      for (const track of output.stream.getTracks()) peer.addTrack(track, output.stream);
      await peer.setLocalDescription(await peer.createAnswer());
      if (peer.iceGatheringState !== 'complete')
        await new Promise<void>((resolve) => {
          const watch = () => {
            if (peer.iceGatheringState === 'complete') {
              peer.removeEventListener('icegatheringstatechange', watch);
              resolve();
            }
          };
          peer.addEventListener('icegatheringstatechange', watch);
          watch();
        });
      return peer.localDescription!.sdp;
    };
  });
  await app.evaluate(({ net, BrowserWindow }) => {
    const orig = net.fetch.bind(net);
    net.fetch = async (url, init) => {
      if (String(url) === 'https://api.openai.com/v1/live/sessions') {
        const offer = JSON.parse(String(init?.body)).transport.sdp;
        const sdp = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
          'window.answerLocalLive(' + JSON.stringify(offer) + ')',
        );
        return Response.json({
          session: { id: 'live_local_ui' },
          transport: { type: 'webrtc', sdp },
        });
      }
      if (String(url).startsWith('https://api.openai.com/v1/live/')) {
        if ((globalThis as any).__rejectLiveHangup) {
          (globalThis as any).__failedLiveHangups++;
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 200 });
      }
      return orig(url, init);
    };
  });
  type MotionFrame = {
    at: number;
    elements: Record<
      string,
      { x: number; y: number; width: number; height: number; opacity: number; transform: string }
    >;
  };
  const motions: Array<{ name: string; pageTime: number; frames: MotionFrame[] }> = [];
  async function observeTransition(name: string, act: () => Promise<unknown>) {
    await page.evaluate(() => {
      const f = (window as any).__liveTest;
      f.motion = [];
      f.motionStarted = performance.now();
      const sample = (time: number) => {
        const elements: Record<string, unknown> = {};
        for (const [name, selector] of Object.entries({
          shell: '.composer-surface',
          voice: '.live-composer-anchor',
          input: '.composer-text-layer',
          island: '.live-bar-row',
          portrait: '.live-portrait',
        })) {
          const node = document.querySelector<HTMLElement>(selector);
          if (!node) continue;
          const rect = node.getBoundingClientRect(),
            style = getComputedStyle(node);
          if (rect.width && rect.height)
            elements[name] = {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              opacity: Number(style.opacity),
              transform: style.transform,
            };
        }
        f.motion.push({ at: time - f.motionStarted, elements });
        if (time - f.motionStarted < 700) requestAnimationFrame(sample);
        else f.motionFinished = true;
      };
      f.motionFinished = false;
      requestAnimationFrame(sample);
    });
    const pageTime = await page.evaluate(() => (window as any).__liveTest.motionStarted / 1000);
    await act();
    await page.waitForFunction(() => (window as any).__liveTest.motionFinished);
    const frames: MotionFrame[] = await page.evaluate(() => (window as any).__liveTest.motion);
    motions.push({ name, pageTime, frames });
    await writeFile(path.join(out, 'motion.json'), JSON.stringify(motions, null, 2));
    return frames;
  }
  function hasIntermediate(frames: MotionFrame[], field: string) {
    const items = frames.map((f) => f.elements[field]).filter(Boolean);
    return (
      items.some((item) => item.opacity > 0.02 && item.opacity < 0.98) ||
      new Set(items.map((item) => Math.round(item.height * 10))).size > 3 ||
      new Set(items.map((item) => item.transform)).size > 3
    );
  }
  async function capture(name: string) {
    await page.mouse.move(4, 50);
    await page.screenshot({ animations: 'disabled', path: path.join(out, name + '.png') });
  }
  const entry = page.getByRole('button', { name: '语音通话', exact: true });
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  const surface = page.locator('[data-voice-mode]');
  const button = (name: string) => surface.getByRole('button', { name, exact: true });
  const history = page.locator('.chat-scroll').getByText(historyText, { exact: true });
  const say = (role: 'input' | 'output', delta: string, start: number, end: number) =>
    page.evaluate(
      ([role, delta, start, end]) =>
        (window as any).__liveTest.emit({
          type: `session.${role}_transcript.delta`,
          delta,
          start_ms: start,
          end_ms: end,
        }),
      [role, delta, start, end] as const,
    );
  await expect(history).toBeVisible();
  await composer.fill('留给键盘的草稿');
  const before = await page.locator('.composer [data-slot="prompt-input-shell"]').boundingBox();
  assert(before);
  const entering = await observeTransition('enter', () => entry.click());
  assert(
    hasIntermediate(entering, 'voice') || hasIntermediate(entering, 'shell'),
    'entering voice must include rendered intermediate frames',
  );
  await expect(surface).toHaveAttribute('data-voice-mode', 'chat');
  await expect(composer).toBeHidden();
  await expect(history).toBeVisible();
  const inline = await surface.boundingBox();
  assert(inline);
  assert(
    inline.width <= before.width + 2 &&
      Math.abs(inline.x + inline.width / 2 - before.x - before.width / 2) < 12,
    'Live replaces the composer in the same message column',
  );
  assert(
    Math.abs(inline.y + inline.height - (before.y + before.height)) < 24 &&
      Math.abs(inline.height - before.height) < 24,
    'the voice surface keeps the size and place of the composer',
  );
  // Without a key nothing connects; the one action leads to the setting.
  await expect(button('设置语音')).toBeVisible();
  assert.equal(await page.evaluate(() => (window as any).__liveTest.tracks.length), 0);
  await page.screenshot({
    animations: 'disabled',
    path: path.join(out, 'live-not-configured.png'),
  });
  async function brightness(selector: string) {
    return page.locator(selector).evaluate((el) => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = getComputedStyle(el).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      const rgba = ctx.getImageData(0, 0, 1, 1).data;
      return { level: (rgba[0] + rgba[1] + rgba[2]) / 3, alpha: rgba[3] };
    });
  }
  const white = await brightness('.composer-surface');
  assert(white.level > 225, 'the voice surface is the composer’s own light shell');
  await button('设置语音').click();
  await page.getByLabel('OpenAI API 密钥').fill('sk-live-ui-isolated-test-only');
  await page.getByRole('button', { name: '保存密钥' }).click();
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  assert.equal(
    await page.evaluate(() => (window as any).__liveTest.tracks.length),
    0,
    'saving a key does not open the microphone',
  );
  // Entering Live with a key is the request to talk: it connects without a second press.
  if (!(await surface.count())) await entry.click();
  try {
    await expect(button('麦克风静音')).toBeVisible({ timeout: 25000 });
  } catch (error) {
    console.log(
      await page.evaluate(() => {
        const f = (window as any).__liveTest;
        return {
          opens: f.opens,
          mic: f.tracks.length,
          audio: f.ctx?.state,
          ice: f.peer?.iceConnectionState,
          gather: f.peer?.iceGatheringState,
          signaling: f.peer?.signalingState,
          emitted: !!f.emit,
        };
      }),
    );
    throw error;
  }
  assert.equal(await page.evaluate(() => (window as any).__liveTest.opens), 1);
  await expect(button('关闭语音')).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: path.join(out, 'live-idle.png') });
  await say('input', '一起看看现在的网页。', 200, 1600);
  await say('output', '好，打开浏览器后我们一起看。', 1700, 3000);
  await expect(surface.getByRole('log')).toContainText('一起看看');
  await expect(surface.getByRole('log')).toContainText('打开浏览器后');
  await expect(history).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: path.join(out, 'live-conversation.png') });

  // With a page open the conversation steps aside and the call becomes the pane's bottom row.
  await button('打开浏览器').click();
  await expect(surface).toHaveAttribute('data-voice-mode', 'browser');
  const sidebar = page.locator('.athena-sidebar[aria-label="主导航"]');
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
  await expect(sidebar).toHaveJSProperty('inert', true);
  await expect(page.locator('.work-area')).toBeHidden();
  await expect(page.locator('.browser-frame')).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.browser-frame').evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  const frame = page.locator('.browser-surface');
  const bar = page.locator('.live-bar-row');
  await expect(page.locator('.frame-loading')).toBeHidden();
  await expect
    .poll(async () => {
      const f = await frame.boundingBox(),
        b = await bar.boundingBox();
      // The row sits under the page and takes none of its pixels.
      return !!(f && b && Math.abs(b.y - (f.y + f.height)) <= 2 && Math.abs(b.width - f.width) <= 2);
    })
    .toBe(true);
  const barColor = await brightness('.live-bar-row');
  assert(barColor.level > 225, 'the voice row follows the light theme');
  await say('output', '标题在页面的左上方。', 5000, 6200);
  const subtitle = page.locator('.live-subtitle');
  await expect(subtitle).toHaveCount(1);
  await expect(subtitle).toContainText('标题在页面的左上方');
  const placed = await page.evaluate(() => {
    const caption = document.querySelector('.live-subtitle')!.getBoundingClientRect();
    const view = document.querySelector('.browser-surface')!.getBoundingClientRect();
    return {
      over: caption.bottom <= view.bottom + 1 && caption.top >= view.top + view.height / 2,
      centred: Math.abs(caption.x + caption.width / 2 - view.x - view.width / 2) < 4,
      // A click on the words lands on the page beneath them.
      through: getComputedStyle(document.querySelector('.live-subtitles')!).pointerEvents === 'none',
    };
  });
  assert.deepEqual(placed, { over: true, centred: true, through: true });
  await capture('live-browser');
  // Once the voice falls silent the sentence leaves the page.
  await page.evaluate(() => (window as any).__liveTest.ctx.suspend());
  await expect(subtitle).toHaveCount(0, { timeout: 9000 });
  await page.evaluate(() => (window as any).__liveTest.ctx.resume());
  await button('麦克风静音').click();
  assert.equal(await page.evaluate(() => (window as any).__liveTest.tracks[0].enabled), false);
  await button('取消麦克风静音').click();
  // The row belongs to Electron. Click the page through its actual pixel surface.
  const theme = () =>
    page.evaluate(
      async () =>
        (await window.workbench.invoke<ElementQueryResult>('browser:query', { selector: '#theme' }))
          .elements[0],
    );
  const themeBefore = await theme();
  const viewport = await page.evaluate(
    async () => (await window.workbench.invoke<AppSnapshot>('app:snapshot')).browser.viewport,
  );
  const box = await frame.boundingBox();
  assert(viewport && box && themeBefore.bounds);
  const scale = box.width / viewport.width;
  await page.mouse.click(
    box.x + (themeBefore.bounds.x + themeBefore.bounds.width / 2) * scale,
    box.y + (themeBefore.bounds.y + themeBefore.bounds.height / 2) * scale,
  );
  await expect.poll(async () => (await theme()).text).not.toBe(themeBefore.text);
  await button('查看对话').click();
  await expect(surface).toHaveAttribute('data-voice-mode', 'compact');
  await expect(composer).toBeHidden();
  await expect(history).toBeVisible();
  // The pill slides off the page as the drawer narrows.
  await expect
    .poll(async () => {
      const pill = await page.locator('.live-pill').boundingBox();
      const work = await page.locator('.work-area').boundingBox();
      return !!(pill && work && pill.x >= work.x && pill.x + pill.width <= work.x + work.width + 1);
    }, { message: 'the call pill stays over the conversation, not the page' })
    .toBe(true);
  await capture('live-browser-expanded');
  await button('返回沉浸语音').click();
  await expect(surface).toHaveAttribute('data-voice-mode', 'browser');
  await button('返回语音对话').click();
  await expect(surface).toHaveAttribute('data-voice-mode', 'chat');
  await expect(sidebar).toHaveJSProperty('inert', false);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '语音', exact: true }).click();
  await expect(surface).toHaveAttribute('data-voice-mode', 'compact');
  await expect(page.getByRole('button', { name: '移除密钥' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '结束语音通话' })).toHaveCount(0);
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(surface).toHaveAttribute('data-voice-mode', 'chat');
  assert.equal(await page.evaluate(() => (window as any).__liveTest.opens), 1);
  const leaving = await observeTransition('exit', () => button('结束通话').click());
  assert(
    hasIntermediate(leaving, 'input') || hasIntermediate(leaving, 'shell'),
    'returning to text must include rendered intermediate frames',
  );
  await expect(surface).toHaveCount(0);
  await expect(composer).toContainText('留给键盘的草稿');
  await expect(history).toBeVisible();
  const ended = await page.evaluate(() => {
    const f = (window as any).__liveTest;
    return { tracks: f.tracks.map((t: MediaStreamTrack) => t.readyState), closes: f.closes };
  });
  assert.deepEqual(ended, { tracks: ['ended'], closes: 1 });

  // A user can leave while the service is unable to confirm hangup.
  await entry.click();
  await expect(button('麦克风静音')).toBeVisible({ timeout: 15000 });
  const microphoneCount = await page.evaluate(() => {
    const f = (window as any).__liveTest;
    f.silentClose = true;
    return f.tracks.length;
  });
  await app.evaluate(() => {
    (globalThis as any).__rejectLiveHangup = true;
    (globalThis as any).__failedLiveHangups = 0;
  });
  await page.locator('.new-conversation').click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__failedLiveHangups)).toBe(1);
  await entry.click();
  await expect(button('开始通话')).toHaveCount(0);
  const retryHangup = button('重试结束通话');
  await retryHangup.click();
  await expect(surface.getByRole('alert')).toContainText('未确认远端通话结束');
  await app.evaluate(() => {
    (globalThis as any).__rejectLiveHangup = false;
  });
  await retryHangup.click();
  // Ending the old call never starts a new one by itself.
  await expect(button('开始通话')).toBeVisible();
  assert.deepEqual(
    await page.evaluate(async () => {
      const f = (window as any).__liveTest;
      return {
        tracks: f.tracks.length,
        stopped: f.tracks.every((track: MediaStreamTrack) => track.readyState === 'ended'),
        active: (await window.workbench.invoke<{ active: boolean }>('voice:config')).active,
      };
    }),
    { tracks: microphoneCount, stopped: true, active: false },
  );
  await button('关闭语音').click();
  await page.evaluate(() => {
    (window as any).__liveTest.silentClose = false;
  });
  const homeComposer = await page
    .locator('.is-home .composer [data-slot="prompt-input-shell"]')
    .boundingBox();
  assert(homeComposer);
  await entry.click();
  await expect(surface).toHaveAttribute('data-voice-mode', 'chat');
  await expect(page.locator('.welcome:visible')).toHaveCount(0);
  await expect(page.locator('.welcome-suggestions:visible')).toHaveCount(0);
  const homeBar = await surface.boundingBox();
  assert(
    homeBar && Math.abs(homeBar.y - homeComposer.y) < 24,
    'the empty chat keeps its composer location when entering Live',
  );
  await expect(button('麦克风静音')).toBeVisible({ timeout: 15000 });
  const recoveryNotice = page.getByRole('button', { name: '关闭提示', exact: true });
  if (await recoveryNotice.isVisible()) await recoveryNotice.click();
  await page.screenshot({ animations: 'disabled', path: path.join(out, 'live-idle-empty.png') });
  // Real appearance controls and the minimum supported desktop window keep the same hierarchy.
  const userMenu = page.getByRole('button', { name: '本机用户菜单' });
  await userMenu.click();
  await page.getByRole('menuitem', { name: /外观/ }).hover();
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dark = await brightness('.composer-surface');
  assert(dark.level < 90, 'dark theme follows the application surface');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 700));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1060);
  const fits = await surface.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  });
  assert(fits, 'voice controls fit the minimum supported window');
  await capture('live-dark-narrow');
  await button('结束通话').click();
  await expect(surface).toHaveCount(0);
  await entry.click({ trial: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await observeTransition('reduced-enter', () => entry.click());
  assert(
    !hasIntermediate(reduced, 'voice') && !hasIntermediate(reduced, 'shell'),
    'reduced motion avoids sliding and morphing',
  );
  await expect(button('麦克风静音')).toBeVisible({ timeout: 15000 });
  await capture('live-reduced-motion');
  await button('结束通话').click();
  await expect(surface).toHaveCount(0);
  await writeFile(path.join(out, 'motion.json'), JSON.stringify(motions, null, 2));
  assert.deepEqual(errors, []);
  console.log(
    'Composer-shaped voice surface, direct connection, history, two-way local audio, the pane’s voice row and subtitles, mute, hangup recovery and draft restoration verified in Electron.',
  );
} finally {
  await app.close();
  if (video) {
    await video.saveAs(path.join(out, 'voice-transitions.webm'));
    await video.delete();
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 4 });
}
