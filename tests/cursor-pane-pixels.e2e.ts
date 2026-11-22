/** A local selected-layout send, rendered inside the real Electron right pane with an isolated profile. */
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AppSnapshot, ElementQueryResult } from '../src/shared/types';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';

const dir = await mkdtemp(path.join(tmpdir(), 'athena-cursor-pane-'));
const out = process.env.ATHENA_MOTION_REPORT || 'test-results/cursor-motion-performance/desktop';
const bin = path.join(dir, 'bin');
const fallback = path.join(dir, 'model-runs');
await seedLegacyWorkspace(dir);
await mkdir(out, { recursive: true });
await mkdir(bin);
await writeFile(fallback, '');
await writeFile(
  path.join(bin, 'codex'),
  `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('codex-cli 0.171.0'); process.exit(0); }
if (!process.argv.includes('app-server')) process.exit(0);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if (request.id===undefined) return;
  if (request.method==='turn/start') require('node:fs').appendFileSync(${JSON.stringify(fallback)},'turn started\\n');
  const result=request.method==='initialize'?{userAgent:'fixture'}:{data:[]};
  console.log(JSON.stringify({id:request.id,result}));
});`,
  { mode: 0o700 },
);
const server = createServer((_req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' })
    .end(
      '<!doctype html><title>Report</title><style>body{font:18px system-ui;margin:36px;color:#171717;background:white}h1,p{margin:0}</style><main><section><h1>Weekly report</h1><p class="subtitle">Reviewed on Friday</p></section></main>',
    ),
);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const app = await electron.launch({
  args: ['tests/electron-background.cjs'],
  cwd: process.cwd(),
  env: {
    ...process.env,
    PATH: bin + ':' + process.env.PATH,
    WORKBENCH_USER_DATA_DIR: dir,
    WORKBENCH_DEV_SERVER_URL: '',
  },
});
try {
  const page = await app.firstWindow();
  const invoke = <T>(action: string, payload?: unknown) =>
    page.evaluate(({ action, payload }) => window.workbench.invoke<T>(action, payload), {
      action,
      payload,
    });
  const snapshot = () => invoke<AppSnapshot>('app:snapshot');
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 30000 })
    .toBe('ready');
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await invoke('browser:navigate', { url });
  const frame = page.locator('img.browser-frame');
  await expect(frame).toBeVisible();
  const query = (selector: string) => invoke<ElementQueryResult>('browser:query', { selector });
  await expect
    .poll(async () => (await query('.subtitle')).elements[0]?.name)
    .toBe('Reviewed on Friday');
  const ref = (await query('h1')).elements[0].ref;
  await page.waitForTimeout(350);
  // Read decoded pixels of the actual <img> presented by the renderer. The local page is entirely grayscale.
  const readPixels = () =>
    frame.evaluate((node) => {
      const img = node as HTMLImageElement;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      if (!c.width || !c.height) return { count: 0, center: [0, 0] };
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
      let count = 0,
        x = 0,
        y = 0;
      for (let i = 0; i < pixels.length; i += 16) {
        const r = pixels[i],
          g = pixels[i + 1],
          b = pixels[i + 2];
        if (Math.max(r, g, b) - Math.min(r, g, b) < 65) continue;
        const offset = i / 4;
        count++;
        x += offset % c.width;
        y += Math.floor(offset / c.width);
      }
      return { count, center: count ? [Math.round(x / count), Math.round(y / count)] : [0, 0] };
    });
  assert.equal((await readPixels()).count, 0, 'fixture must be colorless before the edit');
  await invoke('conversation:send', {
    text: '[ele1] 它和副标题，改为左右布局',
    mentions: [{ token: '[ele1]', ref }],
  });
  const positions = new Set<string>();
  await expect
    .poll(
      async () => {
        const pixels = await readPixels();
        if (pixels.count > 15) positions.add(pixels.center.join(','));
        return positions.size;
      },
      { timeout: 3000, intervals: [10, 20, 30] },
    )
    .toBeGreaterThan(1);
  await page.screenshot({ path: path.join(out, 'athena-right-pane.png') });
  await frame.screenshot({ path: path.join(out, 'right-pane-frame.png') });
  const [a, b] = await Promise.all([query('h1'), query('.subtitle')]);
  const h = a.elements[0].bounds!,
    s = b.elements[0].bounds!;
  assert(h.x + h.width <= s.x + 1 && Math.min(h.y + h.height, s.y + s.height) > Math.max(h.y, s.y));
  assert.equal(await readFile(fallback, 'utf8'), '');
  console.log(JSON.stringify({ movingColorCentroids: [...positions], layoutVerified: true }));
} finally {
  await app.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true, maxRetries: 4 });
}
