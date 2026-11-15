/** Actual Electron input -> Chrome rendering -> decoded embedded-frame performance. */
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import { CdpConnection } from '../src/main/browser-cdp';

const root = process.cwd();
const appRoot = process.env.ATHENA_PERF_APP_ROOT || root;
const wide = process.env.ATHENA_PERF_WIDE === '1';
const flowSelection = process.env.ATHENA_PERF_FLOW === '1';
const packaged = process.env.ATHENA_PERF_APP;
const output = process.env.ATHENA_PERF_OUTPUT || 'test-results/browser-scroll-performance.json';
const temp = await mkdtemp(path.join(root, '.runtime/scroll-perf-'));
await seedLegacyWorkspace(path.join(temp, 'data'));
const site = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><title>滚动性能验证</title><style>
*{box-sizing:border-box}body{${wide ? 'min-width:1100px;' : ''}margin:0;font:15px system-ui;background:#f5f7fa;color:#24304a}header{${flowSelection ? '' : 'position:sticky;top:0;'}z-index:1;background:#fff;padding:18px 24px;border-bottom:1px solid #dae1ef}h1{font-size:22px;margin:0}main{padding:24px;display:grid;gap:16px}.item{padding:22px;border:1px solid #e1e7f0;border-radius:16px;background:white;box-shadow:0 2px 10px #18305208}.item p{line-height:1.8;color:#65728a;margin:8px 0}.item .bar{height:6px;background:linear-gradient(90deg,#4f65cf,#6bbed0);border-radius:5px;width:65%}button{border:0;border-radius:10px;background:#4f65cf;color:white;padding:10px 14px;font:inherit;margin-top:12px}
</style><header><h1 id="selected">今日工作计划</h1></header><main>${Array.from({ length: Number(process.env.ATHENA_PERF_ITEMS || (wide ? 60 : 30)) }, (_, i) => `<section class="item"><strong>项目 ${i + 1} · 进行中</strong><p>整理计划，记录进展，检查待办事项。<br>继续完成下一项工作。</p><div class="bar"></div><button>查看详情</button></section>`).join('')}</main><script>
window.perfSample={wheels:[],scrolls:[],rafs:[]};
addEventListener('wheel',()=>window.perfSample.wheels.push(performance.timeOrigin+performance.now()),{passive:true});
addEventListener('scroll',()=>window.perfSample.scrolls.push({t:performance.timeOrigin+performance.now(),y:scrollY}),{passive:true});
const tick=t=>{window.perfSample.rafs.push(performance.timeOrigin+t);requestAnimationFrame(tick)};requestAnimationFrame(tick);
</script>`);
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(site.address() as any).port}`;
const app = await electron.launch({
  ...(packaged ? { executablePath: packaged } : {}),
  args: packaged ? [] : ['.'],
  cwd: appRoot,
  env: {
    ...process.env,
    WORKBENCH_USER_DATA_DIR: path.join(temp, 'data'),
  },
});
let native: CdpConnection | undefined;
const errors: string[] = [];
try {
  const application = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
  }));
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate('window.__name = fn => fn');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.setBackgroundThrottling(false);
    w.setSize(1440, 900);
  });
  const snapshot = () => page.evaluate(() => window.workbench.invoke<any>('app:snapshot'));
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 30000 })
    .toBe('ready');
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await page.evaluate((url) => window.workbench.invoke('browser:navigate', { url }), url);
  await expect.poll(async () => (await snapshot()).browser.title).toBe('滚动性能验证');
  await expect(page.locator('.frame-loading')).toHaveCount(0);
  await page
    .locator('.browser-drawer')
    .evaluate(async (node) =>
      Promise.all(node.getAnimations().map((a) => a.finished.catch(() => {}))),
    );
  const port = (
    await readFile(path.join(temp, 'data/browser/agent-browser-profile/DevToolsActivePort'), 'utf8')
  ).split('\n')[0];
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
  native = await CdpConnection.connect(
    targets.find((t) => t.url === url || t.url === url + '/').webSocketDebuggerUrl,
  );
  await native.call('Performance.enable');
  const metrics = async () =>
    Object.fromEntries(
      (await native!.call('Performance.getMetrics')).metrics.map((m: any) => [m.name, m.value]),
    );
  await page.evaluate(() => {
    const f = ((window as any).__scrollPerf = {
      received: [] as number[],
      decoded: [] as number[],
      rafs: [] as number[],
      inputs: [] as number[],
      lastSource: '',
    });
    window.workbench.onEvent((e) => {
      if (e.type === 'browser:frame' && e.frame.data)
        f.received.push(performance.timeOrigin + performance.now());
    });
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      const source = this.currentSrc;
      return decode.call(this).then(() => {
        if (
          this.classList.contains('browser-frame') &&
          source === this.currentSrc &&
          source !== f.lastSource
        ) {
          f.lastSource = source;
          f.decoded.push(performance.timeOrigin + performance.now());
        }
      });
    };
    const tick = (t: number) => {
      f.rafs.push(performance.timeOrigin + t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const percentile = (values: number[], p: number) => {
    const v = [...values].sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.floor(v.length * p))] ?? 0;
  };
  const intervals = (times: number[]) => times.slice(1).map((t, i) => t - times[i]);
  const results: any[] = [];
  for (let round = 0; round < Number(process.env.ATHENA_PERF_ROUNDS || 1); round++) {
    if (round) {
      await page.evaluate(
        (url) => window.workbench.invoke('browser:navigate', { url }),
        url + '/?round=' + round,
      );
      await expect(page.locator('.frame-loading')).toHaveCount(0);
      const closeInspector = page.getByRole('button', { name: '关闭元素检查器', exact: true });
      if (await closeInspector.isVisible()) await closeInspector.click();
    }
    for (const selected of [false, true]) {
      if (selected) {
        await page.evaluate(async () => {
          const q = await window.workbench.invoke<any>('browser:query', { selector: '#selected' });
          await window.workbench.invoke('browser:element', { ref: q.elements[0].ref });
        });
        await expect(page.getByRole('slider', { name: '字号滑块' })).toBeVisible();
      }
      await native.call('Runtime.evaluate', {
        expression: 'scrollTo(0,0);window.perfSample={wheels:[],scrolls:[],rafs:[]}',
      });
      await expect(page.locator('.frame-loading')).toHaveCount(0);
      const before = await metrics();
      const ui: any = await page.evaluate(async () => {
        const f = (window as any).__scrollPerf;
        f.received = [];
        f.decoded = [];
        f.rafs = [];
        f.inputs = [];
        const surface = document.querySelector('.browser-surface')!;
        const b = surface.getBoundingClientRect();
        const nativeFrame = (await window.workbench.invoke<any>('app:snapshot')).browserFrame;
        const scale = nativeFrame.width / b.width;
        const started = performance.timeOrigin + performance.now();
        await new Promise<void>((resolve) => {
          const tick = () => {
            if (performance.timeOrigin + performance.now() - started >= 5000) return resolve();
            f.inputs.push(performance.timeOrigin + performance.now());
            surface.dispatchEvent(
              new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                clientX: b.x + b.width / 2,
                clientY: b.y + b.height / 2,
                deltaY: 8,
              }),
            );
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        const ended = performance.timeOrigin + performance.now();
        return {
          started,
          ended,
          scale,
          received: f.received.filter((t: number) => t >= started && t <= ended),
          decoded: f.decoded.filter((t: number) => t >= started && t <= ended),
          rafs: f.rafs.filter((t: number) => t >= started && t <= ended),
          inputs: f.inputs,
        };
      });
      const drainStarted = Date.now();
      await page.evaluate(() =>
        window.workbench.invoke('browser:query', { selector: '#selected', limit: 1 }),
      );
      const finalY = (
        await native.call('Runtime.evaluate', {
          expression:
            'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(scrollY))))',
          awaitPromise: true,
          returnByValue: true,
        })
      ).result.value;
      const inputDrainMs = Date.now() - drainStarted;
      const after = await metrics();
      const nativeSample = (
        await native.call('Runtime.evaluate', {
          expression: 'window.perfSample',
          returnByValue: true,
        })
      ).result.value;
      const dt = (ui.ended - ui.started) / 1000;
      const gaps = intervals(ui.decoded);
      results.push({
        round,
        selected,
        firstFrameDelay: (ui.decoded[0] ?? ui.ended) - ui.started,
        lastFrameAge: ui.ended - (ui.decoded.at(-1) ?? ui.started),
        frameBins: Array.from(
          { length: 5 },
          (_, second) =>
            ui.decoded.filter(
              (t: number) =>
                t >= ui.started + second * 1000 && t < ui.started + (second + 1) * 1000,
            ).length,
        ),
        rendererRafs: ui.rafs.length,
        inputDrainMs,
        finalY,
        expectedY: ui.inputs.length * 8 * ui.scale,
        duration: dt,
        inputs: ui.inputs.length,
        received: ui.received.length,
        presented: ui.decoded.length,
        presentedFps: ui.decoded.length / dt,
        p95PresentedGap: percentile(gaps, 0.95),
        maxPresentedGap: Math.max(...gaps),
        rendererRafP95: percentile(intervals(ui.rafs), 0.95),
        nativeRafP95: percentile(intervals(nativeSample.rafs), 0.95),
        nativeWheelEvents: nativeSample.wheels.length,
        scrollEvents: nativeSample.scrolls.length,
        scrollY: nativeSample.scrolls.at(-1)?.y,
        metrics: Object.fromEntries(
          [
            'LayoutCount',
            'RecalcStyleCount',
            'LayoutDuration',
            'RecalcStyleDuration',
            'ScriptDuration',
            'TaskDuration',
          ].map((k) => [k, after[k] - before[k]]),
        ),
      });
    }
  }
  const report = {
    wide,
    flowSelection,
    application,
    passed: results.every(
      (r) =>
        r.presentedFps >= 45 &&
        r.p95PresentedGap <= 40 &&
        r.inputDrainMs < 180 &&
        r.finalY >= r.expectedY * 0.99,
    ),
    results,
    errors,
  };
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, []);
  for (const r of results) {
    assert(r.scrollY > 1000, 'The actual page must scroll continuously');
    assert(
      r.inputDrainMs < 180,
      `Wheel input remains queued for ${r.inputDrainMs}ms after release`,
    );
    assert(
      r.presentedFps >= 45,
      `${r.selected ? 'Selected' : 'Unselected'} scroll only presents ${r.presentedFps.toFixed(1)} fps`,
    );
    assert(r.finalY >= r.expectedY * 0.99, 'Scrolling must preserve the requested distance');
    assert(
      r.p95PresentedGap <= 40,
      `Scrolling contains ${r.p95PresentedGap.toFixed(1)}ms p95 frame gaps`,
    );
  }
} finally {
  native?.close();
  await app.close();
  await new Promise<void>((r) => site.close(() => r()));
  await rm(temp, { recursive: true, force: true });
}
