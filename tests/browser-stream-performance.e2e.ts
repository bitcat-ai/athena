/** Real Electron, isolated local Chrome and deterministic model deltas. Run after npm run build. */
import assert from 'node:assert/strict';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppSnapshot } from '../src/shared/types';

const dir = await mkdtemp(path.join(tmpdir(), 'athena-stream-frame-'));
const workspace = path.join(dir, 'workspace');
await mkdir(workspace);
const now = Date.now();
const history = Array.from({ length: 16 }, (_, i) => ({
  id: 'm' + i,
  role: 'assistant',
  status: 'done',
  createdAt: now + i,
  text:
    '## 核对第 ' +
    i +
    ' 项\n' +
    Array.from(
      { length: 18 },
      (_, j) =>
        '- 已验证 **表单字段 ' +
        j +
        '**，请查看 [示例说明](https://example.test) 和 `field' +
        j +
        '`。',
    ).join('\n') +
    '\n\n```ts\nconst result = await render();\n```',
}));
const conversation = {
  id: 'stream-perf',
  title: '渲染测试',
  workspace,
  agent: 'codex',
  updatedAt: now,
  messages: [
    ...history,
    {
      id: 'streaming-turn',
      text: '## 生成代码\n\n```ts\n',
      role: 'assistant',
      status: 'done',
      createdAt: now + 99,
    },
  ],
};
await writeFile(
  path.join(dir, 'workspace.json'),
  JSON.stringify({
    settings: { workspace, agent: 'codex' },
    conversations: [conversation],
    recordings: [],
  }),
);
const clicks: number[] = [];
const site = createServer((req, res) => {
  if (req.url === '/clicked') {
    clicks.push(performance.now());
    res.writeHead(204).end();
    return;
  }
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  res.end(
    '<title>输入验证</title><button style="width:100vw;height:100vh" onclick="fetch(\'/clicked\')">核对</button>',
  );
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + (site.address() as { port: number }).port;
let app: ElectronApplication | undefined;
try {
  app = await electron.launch({
    args: ['tests/electron-background.cjs'],
    env: { ...process.env, WORKBENCH_USER_DATA_DIR: dir },
    cwd: process.cwd(),
  });
  const page = await app.firstWindow();
  await expect(page.locator('.messages .markdown')).toHaveCount(history.length + 1, {
    timeout: 30000,
  });
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(
          async () => (await window.workbench.invoke<AppSnapshot>('app:snapshot')).browser.status,
        ),
      { timeout: 30000 },
    )
    .toBe('ready');
  await page.evaluate((url) => window.workbench.invoke('browser:navigate', { url }), url);
  await expect(page.locator('.frame-loading')).toHaveCount(0);
  await page.waitForFunction(
    () => document.querySelector<HTMLImageElement>('.browser-frame')?.naturalWidth,
  );
  await page.waitForTimeout(700);
  await page.evaluate('window.__name=fn=>fn');
  const listeners = await page.evaluateHandle(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    const samples = {
      writes: 0,
      duplicates: 0,
      decodes: 0,
      received: 0,
      frames: [] as number[],
      running: true,
    };
    window.workbench.onEvent((e) => {
      if (e.type === 'browser:frame' && e.frame.data) samples.received++;
    });
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...descriptor,
      set(value) {
        if (this.classList.contains('browser-frame')) {
          samples.writes++;
          if (descriptor.get!.call(this) === value) samples.duplicates++;
        }
        descriptor.set!.call(this, value);
      },
    });
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      if (this.classList.contains('browser-frame')) samples.decodes++;
      return decode.call(this);
    };
    const sample = (time: number) => {
      if (samples.running) {
        samples.frames.push(time);
        requestAnimationFrame(sample);
      }
    };
    requestAnimationFrame(sample);
    return samples;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const taskDuration = async () =>
    (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')!
      .value;
  const before = await taskDuration(),
    start = performance.now();
  const surface = await page.locator('.browser-surface').boundingBox();
  assert(surface);
  const inputDelays: number[] = [];
  await Promise.all([
    app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      for (let i = 0; i < 96; i++) {
        window.webContents.send('workbench:event', {
          type: 'agent:event',
          conversationId: 'stream-perf',
          messageId: 'streaming-turn',
          event: { type: 'delta', text: 'const value' + i + ' = ' + i + ';\n' },
        });
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    }),
    (async () => {
      for (let i = 0; i < 6; i++) {
        await delay(100);
        const sent = performance.now();
        await page.mouse.click(surface.x + surface.width / 2, surface.y + surface.height / 2);
        await expect.poll(() => clicks.length, { intervals: [10] }).toBe(i + 1);
        inputDelays.push(Math.round(clicks[i] - sent));
      }
    })(),
  ]);
  await expect(page.locator('.markdown').last()).toContainText('value95', { timeout: 40000 });
  const elapsedMs = Math.round(performance.now() - start),
    mainThreadMs = Math.round(((await taskDuration()) - before) * 1000);
  const samples = await listeners.evaluate((s) => {
    s.running = false;
    const gaps = s.frames
      .slice(1)
      .map((v, i) => v - s.frames[i])
      .sort((a, b) => a - b);
    return {
      frames: s.frames.length,
      p95FrameIntervalMs: gaps[Math.floor(gaps.length * 0.95)],
      maxGapMs: gaps.at(-1),
      srcWrites: s.writes,
      received: s.received,
      duplicateSrcWrites: s.duplicates,
      decodes: s.decodes,
    };
  });
  console.log(JSON.stringify({ elapsedMs, mainThreadMs, clickToSiteMs: inputDelays, ...samples }));
  assert(
    samples.srcWrites <= samples.received + 1,
    'Streaming code must not reassign the last bitmap while waiting for a new Chrome frame',
  );
} finally {
  site.closeAllConnections();
  site.close();
  await app?.close();
  await rm(dir, { force: true, recursive: true });
}
