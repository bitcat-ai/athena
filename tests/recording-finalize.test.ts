/** Real scroll input and recorder shutdown, including the captured participant identity. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserRuntime } from '../src/main/browser';

test(
  'stopping immediately flushes scroll once and never leaks it into the next recording',
  {
    skip: process.env.ATHENA_TEST_RECORDING !== '1',
    timeout: 20000,
  },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'athena-recording-end-'));
    const site = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(
        _req.url === '/frame'
          ? '<html><body style="height:4000px;margin:0"><h2>Contact details</h2></body></html>'
          : '<!doctype html><title>Weekly plan</title><h1>Weekly plan</h1><iframe id="child" src="/frame" width="400" height="180"></iframe><div style="height:5000px">Plan details</div>',
      );
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const browser = new BrowserRuntime({
      storageDir: directory,
      onState() {},
      onFrame() {},
      onStep() {},
      onSelected() {},
      onHumanTakeover() {},
    });
    try {
      await browser.start(`http://127.0.0.1:${(site.address() as any).port}`);
      await browser.queryElements({ selector: 'h1' });
      browser.startRecording('shared-test', 1);
      await browser.withActor({ id: 'bob', name: 'Bob' }, undefined, () =>
        browser.dispatchInput({ type: 'wheel', x: 850, y: 450, deltaY: 360, deltaX: 0 }),
      );
      const ending = browser.stopRecording();
      assert.equal(
        browser.stopRecording(),
        ending,
        'concurrent stop calls must share the same finalization',
      );
      const first = await ending;
      const scrolls = first.steps.filter((step) => step.kind === 'scroll');
      assert.equal(scrolls.length, 1, 'the final gesture must be recorded exactly once');
      assert(JSON.parse(scrolls[0].value!).y > 0);
      assert.equal(
        scrolls[0].actor?.id,
        'bob',
        'flushing as host must retain the original participant',
      );
      assert.equal(first.sharedSessionId, 'shared-test');
      browser.startRecording('shared-test', 2);
      await new Promise((resolve) => setTimeout(resolve, 220));
      const second = await browser.stopRecording();
      assert(
        !second.steps.some((step) => step.kind === 'scroll'),
        'no old timer may append into the next part',
      );
      const origin = `http://127.0.0.1:${(site.address() as any).port}`;
      await browser.navigate(origin + '/frames');
      const frame = (await browser.queryElements({ selector: '#child' })).elements[0];
      assert(frame?.bounds);
      browser.startRecording('shared-test', 3);
      await browser.withActor({ id: 'bob', name: 'Bob' }, undefined, () =>
        browser.dispatchInput({
          type: 'wheel',
          x: frame.bounds!.x + 100,
          y: frame.bounds!.y + 100,
          deltaY: 300,
          deltaX: 0,
        }),
      );
      const childRecording = await browser.stopRecording();
      const childScroll = childRecording.steps.find((step) => step.kind === 'scroll');
      assert(childScroll);
      assert.notEqual(childScroll.frameId, childRecording.steps[0].frameId);
      assert.equal(childScroll.actor?.id, 'bob');
      assert(JSON.parse(childScroll.value!).y > 0);
      browser.startRecording('shared-test', 4);
      const originalTab = browser.getState().activeTabId;
      await browser.withActor({ id: 'bob', name: 'Bob' }, undefined, () =>
        browser.dispatchInput({ type: 'wheel', x: 850, y: 450, deltaY: 300, deltaX: 0 }),
      );
      await browser.newTab(origin + '/other');
      await browser.queryElements({ selector: 'h1' });
      const switched = await browser.stopRecording();
      assert(
        switched.steps.some(
          (step) =>
            step.kind === 'scroll' && step.tabId === originalTab && step.actor?.id === 'bob',
        ),
        'background tab pending scroll must survive a tab switch',
      );
    } finally {
      await browser.dispose();
      site.closeAllConnections();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
