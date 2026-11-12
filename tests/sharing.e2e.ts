/** Separate Electron host and Chromium guest use the real HTTPS/WSS protocol on a LAN interface. */
import assert from 'node:assert/strict';
import { chooseOption } from './ui-choices';
import { _electron as electron, chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { get as httpsGet } from 'node:https';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import { CdpConnection } from '../src/main/browser-cdp';
import type { ShareState } from '../src/shared/share';
import { WebSocket } from 'ws';
import {
  installShareMetrics,
  interceptGuestSocket,
  resetShareMetrics,
  readShareMetrics,
  scrollShareSurface,
  frameSummary,
  percentile,
} from './sharing-test-support';
import { uiBrowserExecutable } from './ui-browser';
const root = process.cwd();
const temp = await mkdtemp(path.join(root, '.runtime/share-e2e-'));
await seedLegacyWorkspace(path.join(temp, 'data'));
const site = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  res.end(
    `<!doctype html><meta charset="utf-8"><title>共同编辑计划</title><style>*{box-sizing:border-box}body{margin:0;font:16px system-ui;background:#f5f7fa;color:#26314a}header{position:sticky;top:0;background:white;z-index:1;border-bottom:1px solid #ddd;padding:20px}h1{font-size:24px;margin:0 0 12px}input,button{font:inherit;padding:8px}main{padding:24px;display:grid;gap:18px}.item{background:white;border:1px solid #ddd;padding:28px;border-radius:12px}.item p{line-height:1.8}</style><header><h1 id="title">本周计划</h1><input id="entry" aria-label="计划名称" placeholder="计划名称" ${req.url?.includes('ime=1') ? 'autofocus' : ''}><button id="add" onclick="document.querySelector('#result').textContent=document.querySelector('#entry').value">保存计划</button><p id="result">尚未保存</p></header><main>${Array.from({ length: 120 }, (_, i) => `<section class="item"><strong>计划 ${i + 1}</strong><p>整理进展，协同确认下一步。<br>在同一个页面上完成修改。</p></section>`).join('')}</main><script>window.wheels=[];window.addEventListener('wheel',()=>window.wheels.push(performance.timeOrigin+performance.now()),{passive:true});</script>`,
  );
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(site.address() as any).port}`;
const app = await electron.launch({
  ...(process.env.ATHENA_SHARE_APP ? { executablePath: process.env.ATHENA_SHARE_APP } : {}),
  args: process.env.ATHENA_SHARE_APP ? [] : ['.'],
  cwd: root,
  env: {
    ...process.env,
    WORKBENCH_USER_DATA_DIR: path.join(temp, 'data'),
  },
});
const guestBrowser = await chromium.launch({
  headless: true,
  executablePath: uiBrowserExecutable(),
  args: ['--no-proxy-server'],
});
let native: CdpConnection | undefined;
const errors: string[] = [];
await mkdir('test-results/sharing', { recursive: true });
try {
  const host = await app.firstWindow();
  host.on('pageerror', (e) => errors.push(`host: ${e.message}`));
  await host.evaluate('window.__name=fn=>fn');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1440, 900);
    w.webContents.setBackgroundThrottling(false);
  });
  const invoke = <T = any>(action: string, payload?: unknown) =>
    host.evaluate(({ action, payload }) => window.workbench.invoke<T>(action, payload), {
      action,
      payload,
    });
  await expect
    .poll(async () => (await invoke('app:snapshot')).browser.status, { timeout: 30000 })
    .toBe('ready');
  await host.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await invoke('browser:navigate', { url });
  await expect.poll(async () => (await invoke('app:snapshot')).browser.title).toBe('共同编辑计划');
  await expect(host.locator('.frame-loading')).toHaveCount(0);
  const port = (
    await readFile(path.join(temp, 'data/browser/agent-browser-profile/DevToolsActivePort'), 'utf8')
  ).split('\n')[0];
  const targets: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  native = await CdpConnection.connect(
    targets.find((t) => t.url === url || t.url === url + '/').webSocketDebuggerUrl,
  );
  const evaluate = async (expression: string) =>
    (
      await native!.call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
    ).result.value;
  await host.getByRole('button', { name: '共享页面', exact: true }).click();
  await host.screenshot({ path: 'test-results/sharing/share-start.png', animations: 'disabled' });
  await host.getByLabel('你的称呼', { exact: true }).fill('Alice');
  if (process.env.ATHENA_SHARE_LOOPBACK === '1')
    await chooseOption(host, '连接网络', /127\.0\.0\.1/);
  await host.getByRole('button', { name: '开始共享并生成邀请', exact: true }).click();
  await expect(host.locator('#share-link')).toBeVisible();
  const share = await invoke<ShareState>('share:state');
  if (process.env.ATHENA_SHARE_LOOPBACK !== '1')
    assert(share.address && !share.address.includes('127.0.0.1'), 'must exercise the LAN listener');
  const context = await guestBrowser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 2,
  });
  const guest = await context.newPage();
  await interceptGuestSocket(guest);
  guest.on('pageerror', (e) => {
    errors.push(`guest: ${e.message}`);
    console.log('guest error', e.message);
  });
  guest.on('requestfailed', (r) =>
    console.log('guest request failed', new URL(r.url()).pathname, r.failure()?.errorText),
  );
  guest.on('console', (m) => {
    if (m.type() === 'error') console.log('guest console', m.text().slice(0, 200));
  });
  const response = await new Promise<number | undefined>((resolve, reject) => {
    const r = httpsGet(share.address!, { rejectUnauthorized: false, timeout: 5000 }, (res) => {
      assert.equal(
        (res.socket as import('node:tls').TLSSocket).getPeerCertificate().fingerprint256,
        share.fingerprint,
      );
      res.resume();
      resolve(res.statusCode);
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('HTTPS timed out')));
  });
  console.log('HTTPS static response', response);
  await guest.goto(share.invite!.url, { waitUntil: 'domcontentloaded' });
  await installShareMetrics(guest, true);
  await installShareMetrics(host);
  await guest.screenshot({ path: 'test-results/sharing/guest-join.png' });
  await guest.getByLabel('你的称呼', { exact: true }).fill('Bob');
  await guest.getByRole('button', { name: '请求加入', exact: true }).click();
  await expect(guest.getByText('等待主持人确认', { exact: true })).toBeVisible();
  await expect(guest.locator('.shared-frame')).toHaveCount(0);
  await expect(host.locator('button[data-choice-label="Bob的权限"]')).toBeVisible();
  await chooseOption(host, 'Bob的权限', '可操作');
  await host.screenshot({
    path: 'test-results/sharing/share-participants.png',
    mask: [host.locator('#share-link')],
    maskColor: '#e8ebf4',
  });
  await expect(guest.locator('.shared-frame')).toBeVisible();
  await expect
    .poll(() => guest.locator('.shared-frame').getAttribute('data-sequence'))
    .not.toBeNull();
  console.log(
    'Joined two clients over HTTPS/WSS',
    process.env.ATHENA_SHARE_LOOPBACK === '1' ? 'loopback' : 'LAN interface',
  );
  await guest.getByRole('button', { name: '请求操作', exact: true }).click();
  await expect(host.getByText('请求操作页面', { exact: true })).toBeVisible();
  await host.getByRole('button', { name: '交给 Bob 操作', exact: true }).click();
  await expect(guest.getByText('你正在操作', { exact: true })).toBeVisible();
  await host.getByRole('button', { name: '关闭共享设置', exact: true }).click();
  // Map native CSS coordinates through the guest's letterboxed image at DPR 2.
  const clickNative = async (selector: string) => {
    await expect(host.locator('.frame-loading')).toHaveCount(0);
    await expect(guest.locator('.shared-frame-loading')).toHaveCount(0);
    const p = await evaluate(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth,h:innerHeight}})()`,
    );
    const b = await guest.locator('.shared-frame').boundingBox();
    assert(b);
    const scale = Math.min(b.width / p.w, b.height / p.h);
    await guest.mouse.click(
      b.x + (b.width - p.w * scale) / 2 + p.x * scale,
      b.y + (b.height - p.h * scale) / 2 + p.y * scale,
    );
  };
  await clickNative('#entry');
  await guest.keyboard.type('Shared plan B');
  await clickNative('#add');
  await expect
    .poll(() => evaluate('document.querySelector("#result").textContent'))
    .toBe('Shared plan B');
  await guest.getByRole('button', { name: '修改元素', exact: true }).click();
  console.log('Guest edited the authoritative page through pointer and keyboard');
  await host.screenshot({ path: 'test-results/sharing/host-active.png' });
  await guest.screenshot({ path: 'test-results/sharing/guest-active.png' });
  const guestId = (await invoke<ShareState>('share:state')).participants.find(
    (p) => p.name === 'Bob',
  )!.id;
  await invoke('share:control', { id: 'host' });
  await expect(guest.getByText('Alice正在操作', { exact: true })).toBeVisible();
  const q = await invoke('browser:query', { selector: '#title' });
  await invoke('browser:edit', { ref: q.elements[0].ref, text: 'Alice 与 Bob 的共同计划' });
  await expect
    .poll(() => evaluate('document.querySelector("#title").textContent'))
    .toBe('Alice 与 Bob 的共同计划');
  // A state/control update can arrive before its image. Hold frames to exercise
  // automatic inspector reads with a valid ref but an obsolete display epoch.
  await guest.evaluate(() => {
    const socket = (window as any).__testSocket;
    const receive = socket.onmessage;
    const send = socket.send.bind(socket);
    const details = new Set<number>();
    const held: MessageEvent[] = [];
    const probe = ((window as any).__inspectorFrameGate = { staleReads: 0, held: true });
    socket.send = (data: string) => {
      const message = JSON.parse(data);
      if (message.type === 'command' && message.action === 'browser:element-details')
        details.add(message.id);
      return send(data);
    };
    socket.onmessage = function (event: MessageEvent) {
      const message = JSON.parse(event.data);
      if (message.type === 'frame' && probe.held) {
        held.push(event);
        return;
      }
      if (
        message.type === 'result' &&
        details.has(message.id) &&
        message.error === '画面已过期，请等待新画面后重试'
      )
        probe.staleReads++;
      return receive.call(this, event);
    };
    (window as any).__releaseInspectorFrames = () => {
      probe.held = false;
      socket.onmessage = receive;
      socket.send = send;
      for (const event of held.splice(0)) receive.call(socket, event);
    };
  });
  const inspectorViewport = (await invoke('app:snapshot')).browser.viewport;
  await invoke('browser:resize', {
    width: inspectorViewport.width,
    height: inspectorViewport.height - 10,
  });
  await invoke('browser:resize', {
    width: inspectorViewport.width,
    height: inspectorViewport.height,
  });
  await invoke('share:control', { id: guestId });
  await expect(guest.getByText('你正在操作', { exact: true })).toBeVisible();
  await expect
    .poll(() => guest.evaluate(() => (window as any).__inspectorFrameGate.staleReads))
    .toBe(1);
  await guest.evaluate(() => (window as any).__releaseInspectorFrames());
  await expect(guest.locator('.shared-frame-loading')).toHaveCount(0);
  await expect(guest.getByRole('tab', { name: '内容', exact: true })).toBeVisible();
  await guest.setViewportSize({ width: 760, height: 620 });
  await clickNative('#entry');
  await guest.keyboard.press('Meta+A');
  await guest.keyboard.type('Resized guest');
  await clickNative('#add');
  await expect
    .poll(() => evaluate('document.querySelector("#result").textContent'))
    .toBe('Resized guest');
  // Guest uses the real reused inspector (including A2UI controls), then only its own undo.
  await guest.setViewportSize({ width: 1200, height: 800 });
  await guest.getByRole('button', { name: '选择元素', exact: true }).click();
  await clickNative('#title');
  await expect(guest.getByRole('tab', { name: '内容', exact: true })).toBeVisible();
  await guest.getByRole('tab', { name: '内容', exact: true }).click();
  await guest.getByLabel('元素文字', { exact: true }).fill('Bob 修改的标题');
  await guest.getByRole('button', { name: '应用预览', exact: true }).click();
  await expect
    .poll(() => evaluate('document.querySelector("#title").textContent'))
    .toBe('Bob 修改的标题');
  const bobEdit = (await invoke('app:snapshot')).browser.previewEdits.findLast(
    (e: any) => e.actor?.id === guestId,
  );
  assert(bobEdit, 'guest DOM edit must retain its owner');
  await invoke('share:control', { id: 'host' });
  await assert.rejects(invoke('browser:undo', { editId: bobEdit.editId }), /只能撤销自己的/);
  await invoke('share:control', { id: guestId });
  await expect(guest.getByText('你正在操作', { exact: true })).toBeVisible();
  await guest.getByRole('button', { name: '撤销页面修改', exact: true }).click();
  await expect
    .poll(() => evaluate('document.querySelector("#title").textContent'))
    .toBe('Alice 与 Bob 的共同计划');
  // A dropped transport preserves identity, but control returns to A and no input is replayed.
  await guest.evaluate(() => (window as any).__testSocket.close());
  await expect
    .poll(async () => (await invoke<ShareState>('share:state')).controllerId)
    .toBe('host');
  await expect(guest.getByText('已连接', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(guest.getByText('Alice正在操作', { exact: true })).toBeVisible();
  assert.equal(
    (await invoke<ShareState>('share:state')).participants.find((p) => p.name === 'Bob')?.id,
    guestId,
  );
  await guest.getByRole('button', { name: '请求操作', exact: true }).click();
  await invoke('share:control', { id: guestId });
  await expect(guest.getByText('你正在操作', { exact: true })).toBeVisible();
  // Cross-origin navigation cannot reach host services from the guest page capability.
  await guest.getByLabel('共享网页地址').fill('http://127.0.0.1:9/private');
  await guest.getByRole('button', { name: '打开', exact: true }).click();
  await expect(guest.getByRole('alert')).toContainText('共享仅限当前站点');
  await guest.getByRole('button', { name: '知道了', exact: true }).click();
  assert.equal(await evaluate('location.origin'), url);
  // Composition begun on one document must never be committed into its replacement.
  await clickNative('#entry');
  await guest
    .getByLabel('共享网页键盘输入')
    .evaluate((node) =>
      node.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true, data: '旧输入' }),
      ),
    );
  await evaluate(`location.href='${url}/?ime=1'`);
  await expect.poll(async () => (await invoke('app:snapshot')).browser.url).toBe(url + '/?ime=1');
  await expect(guest.locator('.shared-frame-loading')).toHaveCount(0);
  await guest
    .getByLabel('共享网页键盘输入')
    .evaluate((node) =>
      node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '旧输入' })),
    );
  assert.equal(await evaluate('document.querySelector("#entry").value'), '');
  await clickNative('#entry');
  await guest.keyboard.insertText('共同计划');
  await guest
    .getByLabel('共享网页键盘输入')
    .evaluate((node) =>
      node.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true, data: ' · 双人' }),
      ),
    );
  await guest
    .getByLabel('共享网页键盘输入')
    .evaluate((node) =>
      node.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: ' · 双人' }),
      ),
    );
  await clickNative('#add');
  assert.deepEqual(await guest.locator('.shared-error').allTextContents(), []);
  await expect
    .poll(() => evaluate('document.querySelector("#result").textContent'))
    .toBe('共同计划 · 双人');
  const performanceResults: any[] = [];
  if (process.env.ATHENA_SHARE_PERF === '1') {
    await guest.getByRole('button', { name: '关闭元素检查器', exact: true }).click();
    const performanceCase = async (actor: 'host' | 'guest', selected: boolean, slow = false) => {
      await invoke('share:control', { id: 'host' });
      await invoke('browser:navigate', {
        url: url + '/?perf=' + actor + '-' + selected + '-' + slow,
      });
      await expect(host.locator('.frame-loading')).toHaveCount(0);
      if (selected) {
        const selection = await invoke('browser:query', { selector: '#title' });
        await invoke('browser:element', { ref: selection.elements[0].ref });
      }
      await evaluate('scrollTo(0,0);window.wheels=[]');
      await expect(host.locator('.frame-loading')).toHaveCount(0);
      await invoke('share:control', { id: actor === 'host' ? 'host' : guestId });
      await expect(
        guest.getByText(actor === 'host' ? 'Alice正在操作' : '你正在操作', { exact: true }),
      ).toBeVisible();
      let stableSignature = '',
        stableSince = 0;
      await expect
        .poll(
          async () => {
            const snapshot = await invoke('app:snapshot');
            const viewport = snapshot.browser.viewport;
            const guestEpoch = Number(
              await guest.locator('.shared-frame').getAttribute('data-epoch'),
            );
            const b = await host.locator('.browser-surface').boundingBox();
            const signature = JSON.stringify([viewport, b]);
            if (signature !== stableSignature) {
              stableSignature = signature;
              stableSince = Date.now();
            }
            return (
              !snapshot.browser.loading &&
              snapshot.browserFrame?.epoch === viewport.epoch &&
              guestEpoch === viewport.epoch &&
              Date.now() - stableSince >= 250 &&
              (await host.locator('.frame-loading').count()) === 0 &&
              (await guest.locator('.shared-frame-loading').count()) === 0
            );
          },
          { timeout: 10000 },
        )
        .toBe(true);
      await resetShareMetrics(host);
      await resetShareMetrics(guest);
      const activity = await scrollShareSurface(actor === 'host' ? host : guest, actor === 'guest');
      if (actor === 'guest') await guest.evaluate(() => (window as any).__waitSharedInputs());
      await invoke('browser:query', { selector: '#title' });
      await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const ended = Date.now();
      const nativeState = await evaluate('({scrollY,wheels:window.wheels})');
      const [hm, gm] = await Promise.all([readShareMetrics(host), readShareMetrics(guest)]);
      const duration = activity.ended - activity.started;
      const h = frameSummary(
        hm.decoded.filter((t: number) => t >= activity.started && t <= activity.ended),
        duration,
        activity.started,
      );
      const g = frameSummary(
        gm.decoded.filter((t: number) => t >= activity.started && t <= activity.ended),
        duration,
        activity.started,
      );
      const result = {
        actor,
        selected,
        slow,
        sent: activity.sent,
        host: h,
        guest: g,
        inputDrainMs: ended - activity.ended,
        inputAckP95: percentile(
          gm.results.map((r: any) => r.ms),
          0.95,
        ),
        scrollDistance: nativeState.scrollY,
        guestErrors: gm.errors,
      };
      performanceResults.push(result);
      console.log('shared scroll measurement', JSON.stringify(result));
      assert(
        Math.abs(nativeState.scrollY - activity.sent * 8) <= 2,
        'scroll distance must be preserved',
      );
      if (actor === 'guest')
        assert.equal(gm.results.length, activity.sent, 'every guest input must be acknowledged');
      assert(h.fps > 35 && g.fps > 25, 'measure decoded frames, never configured fps');
      assert(result.inputDrainMs < 400, 'bounded input must drain promptly');
      assert.deepEqual(gm.errors, []);
    };
    for (const actor of ['host', 'guest'] as const)
      for (const selected of [false, true]) await performanceCase(actor, selected);
    const slow = new WebSocket(share.address!.replace('https:', 'wss:') + '/connect', {
      rejectUnauthorized: false,
      origin: share.address!,
    });
    let slowFrames = 0;
    slow.on('message', (raw) => {
      if (JSON.parse(raw.toString()).type === 'frame') slowFrames++;
    });
    await new Promise<void>((r) => slow.once('open', r));
    slow.send(
      JSON.stringify({
        type: 'join',
        name: 'Slow viewer',
        invite: new URLSearchParams(new URL(share.invite!.url).hash.slice(1)).get('invite'),
      }),
    );
    await expect
      .poll(async () =>
        (await invoke<ShareState>('share:state')).participants.some(
          (p) => p.name === 'Slow viewer',
        ),
      )
      .toBe(true);
    const slowId = (await invoke<ShareState>('share:state')).participants.find(
      (p) => p.name === 'Slow viewer',
    )!.id;
    await invoke('share:approve', { id: slowId, role: 'viewer' });
    await performanceCase('host', true, true);
    assert.equal(slowFrames, 1, 'a non-acknowledging client receives only one frame');
    slow.terminate();
  }
  // An invisible iframe document change must not strand either client on an old epoch.
  await evaluate(
    `new Promise(resolve => { const f=document.createElement('iframe'); f.hidden=true; f.id='invisible-frame'; f.onload=()=>resolve(true); f.src='${url}/hidden-frame'; document.body.appendChild(f); })`,
  );
  await expect
    .poll(
      async () =>
        Number(await guest.locator('.shared-frame').getAttribute('data-epoch')) ===
        (await invoke('app:snapshot')).browser.viewport.epoch,
      { timeout: 10000 },
    )
    .toBe(true);
  await expect(guest.locator('.shared-frame-loading')).toHaveCount(0);
  await host.screenshot({ path: 'test-results/sharing/host-final.png' });
  await guest.screenshot({ path: 'test-results/sharing/guest-final.png' });
  const recording = await invoke('share:stop');
  await expect(guest.getByRole('heading', { name: '操作记录', exact: true })).toBeVisible();
  await expect(guest.getByText('本次共享已结束', { exact: true })).toBeVisible();
  assert(recording.steps.some((s: any) => s.actor?.name === 'Bob' && s.kind === 'fill'));
  assert(recording.steps.some((s: any) => s.actor?.name === 'Alice' && s.kind === 'edit'));
  assert.equal((await invoke<ShareState>('share:state')).active, false);
  await writeFile(
    process.env.ATHENA_SHARE_OUTPUT || 'test-results/sharing/initial-e2e.json',
    JSON.stringify(
      {
        passed: true,
        transport: `HTTPS/WSS over ${process.env.ATHENA_SHARE_LOOPBACK === '1' ? 'loopback' : 'LAN interface'}; separate Electron and Chromium processes on one Mac`,
        app: await app.evaluate(({ app }) => ({
          version: app.getVersion(),
          packaged: app.isPackaged,
        })),
        devicePixelRatio: {
          host: await host.evaluate(() => devicePixelRatio),
          guest: await guest.evaluate(() => devicePixelRatio),
          native: await evaluate('devicePixelRatio'),
        },
        performanceResults,
        guestViewports: [
          { width: 1200, height: 800 },
          { width: 760, height: 620 },
        ],
        inspectorFrameRecovery: {
          staleReads: await guest.evaluate(() => (window as any).__inspectorFrameGate.staleReads),
          recoveredWithoutReselecting: true,
        },
        steps: recording.steps,
        errors,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  console.log('Initial sharing E2E passed');
} finally {
  native?.close();
  await guestBrowser.close();
  await app.close();
  await new Promise<void>((r) => site.close(() => r()));
  await rm(temp, { recursive: true, force: true });
}
