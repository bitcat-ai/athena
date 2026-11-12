import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserRuntime } from '../src/main/browser';

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const frames: any[] = [],
    acknowledgements: number[] = [];
  let emitted = 0;
  const runtime = new BrowserRuntime({
    storageDir: '/unused-capture-race',
    onState() {},
    onStep() {},
    onSelected() {},
    onHumanTakeover() {},
    onFrame: (frame) => frames.push(frame),
  }) as any;
  runtime.browser = {};
  runtime.state.status = 'ready';
  runtime.activeTabId = 'tab';
  runtime.width = 1100;
  runtime.height = 1833;
  runtime.invalidateSurface();
  const tab = {
    info: { id: 'tab' },
    diagnostics: [],
    page: {
      async call(method: string, args: any) {
        if (method === 'Page.getLayoutMetrics')
          return { cssVisualViewport: { pageX: 0, pageY: 0 } };
        if (method === 'Page.captureScreenshot') {
          entered();
          await held;
          return { data: 'fallback' };
        }
        if (method === 'Page.screencastFrameAck') {
          acknowledgements.push(args.sessionId);
          return {};
        }
        throw new Error(method);
      },
    },
  };
  runtime.tabs.set('tab', tab);
  const emit = (width = 615, height = 1024, timestamp = Date.now() / 1000) =>
    runtime.receiveScreencastFrame(tab, {
      sessionId: ++emitted,
      data: 'stream',
      metadata: { deviceWidth: width, deviceHeight: height, timestamp },
    });
  const begin = async () => {
    runtime.refreshUnpaintedSurface(tab);
    t.mock.timers.tick(60);
    await started;
  };
  t.after(async () => {
    runtime.disposed = true;
    release();
    await runtime.queue;
    clearTimeout(runtime.frameRefreshTimer);
    runtime.releaseFrames();
  });
  return { runtime, frames, acknowledgements, begin, emit, release };
}

test('scaled screenshot metadata cannot consume the fallback frame or its epoch', async (t) => {
  const f = fixture(t);
  await f.begin();
  f.emit();
  assert.equal(
    f.frames.length,
    0,
    'Transient 615×1024 metadata must not replace a 1100×1833 viewport',
  );
  assert.equal(f.runtime.publishedEpoch, -1);
  assert.equal(f.runtime.frameSequence, 0);
  f.release();
  await f.runtime.queue;
  assert.equal(f.frames.length, 1);
  assert.deepEqual(
    [f.frames[0].width, f.frames[0].height, f.frames[0].data],
    [1100, 1833, 'data:image/jpeg;base64,fallback'],
  );
  assert.equal(f.frames[0].epoch, f.runtime.getSurfaceEpoch());
  f.runtime.releaseFrames();
  assert.deepEqual(f.acknowledgements, [1]);
  assert.equal(await f.runtime.serialize(async () => 'input queue free'), 'input queue free');
});

test('a valid newer stream frame still supersedes an in-flight fallback', async (t) => {
  const f = fixture(t);
  await f.begin();
  f.emit(1100, 1833);
  f.release();
  await f.runtime.queue;
  assert.equal(f.frames.length, 1);
  assert.equal(f.frames[0].data, 'data:image/jpeg;base64,stream');
});

test('document changes still discard the old in-flight fallback', async (t) => {
  const f = fixture(t);
  await f.begin();
  f.runtime.invalidateSurface();
  f.emit(615, 1024);
  f.release();
  await f.runtime.queue;
  assert.equal(f.frames.length, 0);
  assert.notEqual(f.runtime.publishedEpoch, f.runtime.getSurfaceEpoch());
});

test('frames during viewport probes and old captures are acknowledged without publication', async (t) => {
  const f = fixture(t);
  f.runtime.resizingViewport = true;
  f.emit(1100, 1833);
  assert.equal(f.frames.length, 0);
  f.runtime.resizingViewport = false;
  f.emit(1100, 1833, 9);
  assert.equal(f.frames.length, 0);
  f.runtime.releaseFrames();
  assert.equal(f.acknowledgements.length, 2);
});

test('repeated rejected frames cannot postpone static-page recovery', async (t) => {
  const f = fixture(t);
  f.emit();
  t.mock.timers.tick(30);
  f.emit();
  t.mock.timers.tick(30);
  // The original deadline must start capture even though another invalid frame arrived.
  f.release();
  await f.runtime.queue;
  assert.equal(f.frames.length, 1);
  assert.equal(f.frames[0].data, 'data:image/jpeg;base64,fallback');
});

test('switching tabs while capture is pending never publishes the previous tab', async (t) => {
  const f = fixture(t);
  await f.begin();
  f.runtime.activeTabId = 'other';
  f.emit(1100, 1833);
  f.release();
  await f.runtime.queue;
  assert.equal(f.frames.length, 0);
  assert.deepEqual(f.acknowledgements, [1]);
});

test('a failed resize releases the transition guard and the input queue', async (t) => {
  const f = fixture(t);
  f.runtime.tabs.get('tab').page.call = async (method: string) => {
    if (method === 'Page.stopScreencast') throw new Error('capture transport interrupted');
    return {};
  };
  await assert.rejects(f.runtime.resize(620, 400), /capture transport interrupted/);
  assert.equal(f.runtime.resizingViewport, false);
  f.emit(1100, 1833);
  assert.equal(f.frames.length, 1);
  assert.equal(await f.runtime.serialize(async () => 'ready'), 'ready');
});

test(
  'real Chrome: concurrent capture, resizing and input recover without stale frames or deadlock',
  {
    skip: !process.env.ATHENA_TEST_CHROME,
    timeout: 30_000,
  },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'athena-capture-race-'));
    const site = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html;charset=utf-8');
      res.end(
        '<!doctype html><title>Capture race</title><style>body{margin:0;min-width:1100px}input{position:absolute;left:20px;top:20px}button{position:absolute;left:1000px;top:20px;width:80px;height:40px}</style><input id="field"><button id="right" onclick="window.clicks++">Click</button><script>window.clicks=0</script>',
      );
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const frames: any[] = [],
      mismatches: any[] = [];
    const runtime = new BrowserRuntime({
      storageDir: directory,
      binaryPath: process.env.ATHENA_TEST_CHROME,
      onState() {},
      onStep() {},
      onSelected() {},
      onHumanTakeover() {},
      onFrame(frame) {
        if (!frame.data) return;
        frames.push(frame);
        const expected = runtime.getSurfaceViewport();
        if (
          frame.width !== expected.width ||
          frame.height !== expected.height ||
          frame.epoch !== runtime.getSurfaceEpoch()
        )
          mismatches.push({
            frame: { width: frame.width, height: frame.height, epoch: frame.epoch },
            expected,
          });
      },
    });
    const until = async (check: () => boolean) => {
      const end = Date.now() + 2000;
      while (!check()) {
        assert(Date.now() < end, 'The settled viewport must recover a valid frame');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    try {
      await runtime.resize(620, 490);
      await runtime.start(`http://127.0.0.1:${(site.address() as any).port}`);
      await runtime.queryElements({ selector: '#field' });
      const page = (runtime as any).tabs.get(runtime.getState().activeTabId).page;
      for (let i = 0; i < 8; i++) {
        const oldEpoch = runtime.getSurfaceEpoch();
        const resizing = runtime.resize(i % 2 ? 620 : 390, i % 2 ? 490 : 650, { fitToWidth: true });
        const capture = runtime.screenshot();
        const stale = assert.rejects(
          runtime.dispatchInput({ type: 'text', text: 'stale', frameEpoch: oldEpoch }),
          /页面已改变|画面已过期/,
        );
        const [viewport, screenshot] = await Promise.all([resizing, capture, stale]);
        assert(screenshot.image);
        await until(() =>
          frames.some(
            (f) =>
              f.epoch === runtime.getSurfaceEpoch() &&
              f.width === viewport.width &&
              f.height === viewport.height,
          ),
        );
        await page.call('Runtime.evaluate', {
          expression: "document.querySelector('#field').focus()",
        });
        const target = (await runtime.queryElements({ selector: '#right' })).elements[0].bounds;
        assert(target);
        const point = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
        await Promise.all([
          runtime.screenshot(),
          runtime.dispatchInput({ type: 'text', text: 'x', frameEpoch: runtime.getSurfaceEpoch() }),
          runtime.dispatchInput({ type: 'mouse', action: 'down', ...point, button: 'left' }),
          runtime.dispatchInput({ type: 'mouse', action: 'up', ...point, button: 'left' }),
        ]);
        const values = await page.call('Runtime.evaluate', {
          expression: "({text:document.querySelector('#field').value,clicks:window.clicks})",
          returnByValue: true,
        });
        assert.equal(values.result.value.text, 'x'.repeat(i + 1));
        assert.equal(values.result.value.clicks, i + 1);
      }
      assert.deepEqual(mismatches, []);
    } finally {
      await runtime.dispose();
      await new Promise<void>((r) => site.close(() => r()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
