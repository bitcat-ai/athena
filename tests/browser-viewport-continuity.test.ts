import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserRuntime } from '../src/main/browser';

test(
  'URL-only fit checks preserve input epochs; actual overflow still invalidates old coordinates',
  { skip: !process.env.ATHENA_TEST_CHROME, timeout: 30_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'athena-viewport-continuity-'));
    const site = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html;charset=utf-8');
      res.end(
        '<!doctype html><title>Viewport continuity</title><style>body{margin:0}</style><input id="field"><main>Responsive content</main>',
      );
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const runtime = new BrowserRuntime({
      storageDir: directory,
      binaryPath: process.env.ATHENA_TEST_CHROME,
      onState() {},
      onFrame() {},
      onStep() {},
      onSelected() {},
      onHumanTakeover() {},
    });
    try {
      await runtime.resize(620, 400);
      await runtime.start(`http://127.0.0.1:${(site.address() as any).port}`);
      const tabId = runtime.getState().activeTabId!;
      const page = (runtime as any).tabs.get(tabId).page;
      await runtime.queryElements({ selector: '#field' });
      await runtime.resize(620, 400, { fitToWidth: true, tabId });
      const epoch = runtime.getSurfaceEpoch();
      await page.call('Runtime.evaluate', {
        expression: "history.replaceState({}, '', '?q=a');document.querySelector('#field').focus()",
      });
      const unchanged = await runtime.resize(620, 400, { fitToWidth: true, tabId });
      assert.equal(unchanged.width, 620);
      assert.equal(unchanged.height, 400);
      assert.equal(runtime.getSurfaceEpoch(), epoch);
      await runtime.dispatchInput({
        type: 'text',
        text: 'still responsive',
        tabId,
        frameEpoch: epoch,
      });
      const value = await page.call('Runtime.evaluate', {
        expression: "document.querySelector('#field').value",
        returnByValue: true,
      });
      assert.equal(value.result.value, 'still responsive');

      await page.call('Runtime.evaluate', {
        expression:
          "document.querySelector('main').style.width='1100px';history.replaceState({}, '', '?wide=1')",
      });
      const fitted = await runtime.resize(620, 400, { fitToWidth: true, tabId });
      assert(fitted.width >= 1100, 'URL revalidation must still detect newly overflowing content');
      assert(Math.abs(fitted.height / fitted.width - 400 / 620) < 0.002);
      assert(runtime.getSurfaceEpoch() > epoch);
      await assert.rejects(
        runtime.dispatchInput({ type: 'text', text: 'stale', tabId, frameEpoch: epoch }),
        /画面已过期/,
      );
      const actual = await runtime.resize(620, 400, { fitToWidth: false, tabId });
      assert.equal(actual.width, 620);
      const fittedAgain = await runtime.resize(620, 400, { fitToWidth: true, tabId });
      assert(
        fittedAgain.width >= 1100,
        'Switching back to fit must not reuse an overflowing 100% view',
      );
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
