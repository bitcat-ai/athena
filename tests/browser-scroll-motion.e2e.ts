/** Counts decoded scroll positions, not video/image refreshes. Times end at host RAF, not display scanout. */
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import { CdpConnection } from '../src/main/browser-cdp';

const root = process.cwd();
const executablePath = process.env.ATHENA_APP_EXECUTABLE;
const output = process.env.ATHENA_PERF_OUTPUT || 'test-results/browser-scroll-motion.json';
const rounds = Number(process.env.ATHENA_PERF_ROUNDS || 3);
assert(Number.isInteger(rounds) && rounds > 0);
await mkdir(path.join(root, '.runtime'), { recursive: true });
const temp = await mkdtemp(path.join(root, '.runtime/scroll-motion-'));
await seedLegacyWorkspace(temp);
const [portrait, video] = await Promise.all([
  readFile(path.join(root, 'src/renderer/assets/brand/athena-profile-v7-refined-eye.png')),
  readFile(path.join(root, 'tests/fixtures/scroll-motion.mp4')),
]);
const html = `<!doctype html><meta charset="utf-8"><title>今日工作</title><style>
*{box-sizing:border-box}body{margin:0;min-width:1260px;font:16px system-ui;color:#24304a}
header{position:sticky;top:0;background:#fff;z-index:2;padding:18px 30px;border-bottom:1px solid #ccc}
main{max-width:990px;padding:14px 36px}.item{display:flex;align-items:center;gap:18px;min-height:145px;border-bottom:1px solid #ddd}
.item img{object-fit:cover;width:195px;height:124px}.item p{color:#667;line-height:1.6}
aside{position:fixed;right:20px;top:85px;width:265px}video,aside img{display:block;width:240px;height:140px;object-fit:cover;margin:8px}
</style><header>今日工作</header><main>${Array.from({ length: 100 }, (_, i) => `<section class="item">${i < 60 ? '<img src="/portrait.png">' : ''}<div><h3>项目 ${i + 1}</h3><p>工作计划和执行记录，检查条目并查看详细内容。<br>整理新的素材与进展，更新今天的工作。</p></div></section>`).join('')}</main><aside><video muted autoplay playsinline loop src="/motion.mp4"></video><img src="/portrait.png"><img src="/portrait.png"><img src="/portrait.png"></aside>`;
const site = createServer((req, res) => {
  if (req.url === '/motion.mp4') {
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), video.length - 1) : video.length - 1;
    res.writeHead(range ? 206 : 200, {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${video.length}` } : {}),
    });
    res.end(video.subarray(start, end + 1));
  } else if (req.url === '/portrait.png') {
    res.setHeader('content-type', 'image/png');
    res.end(portrait);
  } else {
    res.setHeader('content-type', 'text/html;charset=utf-8');
    res.end(html);
  }
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
let native: CdpConnection | undefined;
const report: any = {
  conditions: {
    window: [1500, 874],
    local: true,
    rounds,
    boundary: 'Last trusted wheel event to final decoded scroll position at host RAF',
    physicalFingerReleaseMeasured: false,
  },
  samples: [],
  traces: [],
  errors: [],
};
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null;
};
try {
  app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? [] : ['.'],
    cwd: root,
    env: {
      ...process.env,
      WORKBENCH_USER_DATA_DIR: temp,
    },
  });
  report.application = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
  }));
  await app.evaluate(() => {
    (globalThis as any).__name = (fn: any) => fn;
  });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.evaluate('window.__name = fn => fn');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.setSize(1500, 874);
  });
  const snapshot = () => page.evaluate(() => window.workbench.invoke<any>('app:snapshot'));
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 30000 })
    .toBe('ready');
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await expect(page.locator('.frame-loading')).toHaveCount(0);
  await page
    .locator('.browser-drawer')
    .evaluate(async (node) =>
      Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {}))),
    );

  // Observe compositor metadata on the existing stream; never change capture options.
  await app.evaluate(({ app, BrowserWindow }) => {
    const global = globalThis as any;
    const ws = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')(
      'ws',
    );
    const send = ws.prototype.send;
    global.__motionTrace = { live: false, frames: [], commands: [], captures: [] };
    ws.prototype.send = function (data: any, ...rest: any[]) {
      if (typeof data === 'string') {
        if (data.includes('"Page.startScreencast"')) {
          global.__motionTrace.captures.push(JSON.parse(data).params);
          if (!this.__motionTap) {
            this.__motionTap = true;
            this.prependListener('message', (raw: Buffer) => {
              if (raw.length < 512 || !raw.subarray(0, 100).includes('Page.screencastFrame'))
                return;
              // Avoid decoding/copying every full JPEG in the measured path.
              const edges = raw.subarray(0, 512).toString() + raw.subarray(-600).toString();
              const number = (key: string) =>
                Number(edges.match(new RegExp('"' + key + '":(-?[0-9.eE+-]+)'))?.[1]);
              global.__motionMetadata = {
                y: number('scrollOffsetY'),
                timestamp: number('timestamp'),
              };
            });
          }
        }
        if (
          global.__motionTrace.live &&
          data.includes('"mouseWheel"') &&
          data.includes('"Input.dispatchMouseEvent"')
        ) {
          global.__motionTrace.commands.push({
            t: performance.timeOrigin + performance.now(),
            deltaY: JSON.parse(data).params.deltaY,
          });
        }
      }
      return send.call(this, data, ...rest);
    };
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const emit = contents.send.bind(contents);
    contents.send = function (channel: string, event: any, ...rest: any[]) {
      if (
        channel === 'workbench:event' &&
        event?.type === 'browser:frame' &&
        event.frame.data &&
        global.__motionTrace.live
      ) {
        const frame = event.frame,
          metadata = global.__motionMetadata || {};
        global.__motionTrace.frames.push({
          id: frame.sequence,
          captured: frame.capturedAt,
          sent: performance.timeOrigin + performance.now(),
          y: metadata.y,
          calibrated: Math.round(metadata.timestamp * 1000) === frame.capturedAt,
          bytes: frame.data.length * 0.75,
        });
        // URL fragments tag the frame without changing JPEG pixels or decoding work.
        event = { ...event, frame: { ...frame, data: frame.data + '#motion-' + frame.sequence } };
      }
      return emit(channel, event, ...rest);
    };
  });
  await page.evaluate((url) => window.workbench.invoke('browser:navigate', { url }), url);
  await expect.poll(async () => (await snapshot()).browser.url, { timeout: 20000 }).toBe(url);
  await expect(page.locator('.frame-loading')).toHaveCount(0, { timeout: 20000 });
  const [port] = (
    await readFile(path.join(temp, 'browser/agent-browser-profile/DevToolsActivePort'), 'utf8')
  ).split('\n');
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
  native = await CdpConnection.connect(
    targets.find((target) => target.url === url).webSocketDebuggerUrl,
  );
  const evaluate = async (expression: string) =>
    (
      await native!.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
    ).result.value;
  await expect
    .poll(() =>
      evaluate(
        "document.querySelector('video').readyState >= 3 && !document.querySelector('video').paused",
      ),
    )
    .toBe(true);
  report.page = await evaluate(
    '({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,images:document.images.length,scrollHeight:document.documentElement.scrollHeight})',
  );
  await evaluate(
    "window.__motionScroll=[];addEventListener('scroll',()=>window.__motionScroll.push([performance.timeOrigin+performance.now(),scrollY]),{passive:true})",
  );
  report.physical = await page.locator('.browser-surface').evaluate((node) => ({
    width: Math.ceil(node.clientWidth * devicePixelRatio),
    height: Math.ceil(node.clientHeight * devicePixelRatio),
    dpr: devicePixelRatio,
  }));
  await page.evaluate(() => {
    const probe = ((window as any).__motionProbe = {
      live: false,
      ready: 0,
      painted: 0,
      points: [] as number[][],
      wheel: [] as any[],
    });
    const image = document.querySelector('.browser-frame') as HTMLImageElement;
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      const source = this.src;
      const id = Number(source.match(/#motion-(\d+)$/)?.[1]);
      return decode.call(this).then(() => {
        if (this === image && probe.live && this.src === source && Number.isFinite(id))
          probe.ready = id;
      });
    };
    document.querySelector('.browser-surface')!.addEventListener(
      'wheel',
      (event) => {
        if (probe.live) {
          const wheel = event as WheelEvent;
          probe.wheel.push([
            performance.timeOrigin + performance.now(),
            wheel.deltaY,
            wheel.isTrusted,
          ]);
        }
      },
      { capture: true, passive: true },
    );
    const tick = () => {
      if (probe.live && probe.ready && probe.ready !== probe.painted) {
        probe.painted = probe.ready;
        probe.points.push([probe.ready, performance.timeOrigin + performance.now()]);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  for (let round = 0; round < rounds; round++) {
    for (const duration of [150, 2200]) {
      await evaluate(
        'scrollTo(0,0);new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))',
      );
      await expect(page.locator('.frame-loading')).toHaveCount(0);
      await page.waitForTimeout(550);
      await evaluate('window.__motionScroll=[]');
      const geometry = await page.locator('.browser-surface').evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return {
          x: bounds.x + bounds.width * 0.32,
          y: bounds.y + bounds.height * 0.38,
          width: bounds.width,
          height: bounds.height,
        };
      });
      await app.evaluate(() =>
        Object.assign((globalThis as any).__motionTrace, { live: true, frames: [], commands: [] }),
      );
      await page.evaluate(() =>
        Object.assign((window as any).__motionProbe, {
          live: true,
          ready: 0,
          painted: 0,
          points: [],
          wheel: [],
        }),
      );
      const sent = await app.evaluate(
        async ({ BrowserWindow }, { x, y, duration }) => {
          const contents = BrowserWindow.getAllWindows()[0].webContents;
          const times: number[] = [],
            start = performance.now();
          await new Promise<void>((resolve) => {
            const timer = setInterval(() => {
              if (performance.now() - start > duration) {
                clearInterval(timer);
                resolve();
                return;
              }
              times.push(performance.timeOrigin + performance.now());
              contents.sendInputEvent({
                type: 'mouseWheel',
                x: Math.round(x),
                y: Math.round(y),
                deltaX: 0,
                deltaY: -3,
                hasPreciseScrollingDeltas: true,
                canScroll: true,
              });
            }, 8);
          });
          return times;
        },
        { ...geometry, duration },
      );
      await page.waitForTimeout(340);
      const ui = await page.evaluate(() => {
        const probe = (window as any).__motionProbe;
        probe.live = false;
        const image = document.querySelector('.browser-frame') as HTMLImageElement;
        return {
          points: probe.points as number[][],
          wheel: probe.wheel as [number, number, boolean][],
          bitmap: [image.naturalWidth, image.naturalHeight],
        };
      });
      const positions: number[][] = await evaluate('window.__motionScroll');
      const finalY: number = await evaluate('scrollY');
      const trace = await app.evaluate(() => {
        const trace = (globalThis as any).__motionTrace;
        trace.live = false;
        return { frames: trace.frames as any[], commands: trace.commands as any[] };
      });
      const frames = new Map<number, any>(trace.frames.map((frame) => [frame.id, frame]));
      const moves: { id: number; y: number; t: number; transport: number; host: number }[] = [];
      let lastY = 0;
      for (const [id, t] of ui.points) {
        const frame = frames.get(id);
        if (!frame?.calibrated || !Number.isFinite(frame.y) || Math.abs(frame.y - lastY) < 1)
          continue;
        moves.push({
          id,
          t,
          y: frame.y,
          transport: frame.sent - frame.captured,
          host: t - frame.sent,
        });
        lastY = frame.y;
      }
      const scale = report.page.width / geometry.width;
      const deltaSum = ui.wheel.reduce((sum, event) => sum + event[1] * scale, 0);
      const firstWheel = ui.wheel[0]?.[0],
        lastWheel = ui.wheel.at(-1)?.[0];
      const activeMoves = moves.filter((move) => move.t >= firstWheel && move.t <= lastWheel!);
      const gaps = activeMoves.map((move, i) => move.t - (i ? activeMoves[i - 1].t : firstWheel));
      if (activeMoves.length) gaps.push(lastWheel! - activeMoves.at(-1)!.t);
      const beforeRelease = moves.findLast((move) => move.t <= lastWheel!)?.y || 0;
      const sample = {
        round,
        duration,
        bitmap: ui.bitmap,
        pane: [geometry.width, geometry.height],
        inputsSent: sent.length,
        wheelEvents: ui.wheel.length,
        trusted: ui.wheel.every((event) => event[2]),
        deltaSum,
        commandDeltaSum: trace.commands.reduce((sum, command) => sum + command.deltaY, 0),
        finalY,
        lastVisibleY: lastY,
        motionFps: (activeMoves.length * 1000) / (lastWheel! - firstWheel),
        p95Gap: percentile(gaps, 0.95),
        worstGap: Math.max(...gaps),
        endWheelToLastNativeSend: trace.commands.at(-1)?.t - lastWheel!,
        endWheelToLastScroll: positions.at(-1)?.[0]! - lastWheel!,
        endWheelToLastPixel: moves.at(-1)?.t! - lastWheel!,
        tailDistanceCss: (lastY - beforeRelease) / scale,
        reverseMoves: moves.filter((move, i) => i > 0 && move.y < moves[i - 1].y - 1).length,
        firstVisibleScroll: moves[0]?.t - firstWheel,
        captureToHostSendP50: percentile(
          moves.map((move) => move.transport),
          0.5,
        ),
        sendToPaintP50: percentile(
          moves.map((move) => move.host),
          0.5,
        ),
        avgJpegKB:
          trace.frames.reduce((sum, frame) => sum + frame.bytes, 0) / trace.frames.length / 1024,
        calibratedFrames: trace.frames.filter(
          (frame) => frame.calibrated && Number.isFinite(frame.y),
        ).length,
        totalFrames: trace.frames.length,
      };
      report.samples.push(sample);
      report.traces.push({ round, duration, sent, wheel: ui.wheel, positions, moves, ...trace });
      console.log(JSON.stringify(sample));
    }
  }
  report.actualConfig = await app.evaluate(() => (globalThis as any).__motionTrace.captures.at(-1));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
  for (const sample of report.samples) {
    const name = `round ${sample.round}, ${sample.duration}ms`;
    assert(sample.trusted && sample.wheelEvents > 0, `${name}: missing trusted wheel input`);
    assert(
      sample.totalFrames > 0 && sample.calibratedFrames >= sample.totalFrames * 0.98,
      `${name}: missing matching compositor metadata`,
    );
    assert(
      Math.abs(sample.finalY - sample.deltaSum) <= 2,
      `${name}: native page lost input distance`,
    );
    assert(
      Math.abs(sample.finalY - sample.lastVisibleY) <= 2,
      `${name}: displayed frame did not reach final scroll position`,
    );
    assert(sample.reverseMoves === 0, `${name}: visible scroll reversed`);
    if (sample.duration > 1000)
      assert(
        sample.motionFps >= 48,
        `${name}: scrolling ${sample.motionFps.toFixed(1)}fps < 48fps`,
      );
    assert(
      sample.endWheelToLastPixel >= 0 && sample.endWheelToLastPixel < 100,
      `${name}: final visible position took ${sample.endWheelToLastPixel.toFixed(1)}ms after last wheel`,
    );
  }
  assert.deepEqual(report.errors, [], 'Renderer errors');
} finally {
  native?.close();
  await app?.close();
  await new Promise<void>((resolve) => site.close(() => resolve()));
  await rm(temp, { recursive: true, force: true });
}
