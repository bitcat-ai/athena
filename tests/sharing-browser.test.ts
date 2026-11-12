import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserRuntime } from '../src/main/browser';
import type { RecordedStep } from '../src/shared/types';

test(
  'real browser handoffs settle previews with their owner, refuse foreign undo and release held input',
  { skip: !process.env.ATHENA_TEST_CHROME },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'athena-share-browser-'));
    const site = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><h1 id="title">Plan</h1><button id="save" onclick="window.clicks++">Save</button><script>window.clicks=0;</script>',
      );
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(site.address() as any).port}`;
    const steps: RecordedStep[] = [];
    const runtime = new BrowserRuntime({
      storageDir: directory,
      binaryPath: process.env.ATHENA_TEST_CHROME,
      onFrame() {},
      onState() {},
      onStep: (s) => steps.push(s),
      onSelected() {},
      onHumanTakeover() {},
    });
    const alice = { id: 'host', name: 'Alice' },
      bob = { id: 'bob', name: 'Bob' };
    try {
      await runtime.start(url);
      const tabId = runtime.getState().activeTabId!;
      await runtime.setSharedTab(tabId);
      runtime.withActor(alice, undefined, () => runtime.startRecording('session', 1));
      const title = (await runtime.queryElements({ selector: '#title' })).elements[0];
      await runtime.withActor(alice, undefined, () => runtime.selectElement(title.ref));
      const preview = await runtime.withActor(alice, undefined, () =>
        runtime.previewStyles(title.ref, { color: 'rgb(255, 0, 0)' }),
      );
      await assert.rejects(
        runtime.withActor(bob, undefined, () =>
          runtime.previewStyles(title.ref, { color: 'blue' }, preview.editId),
        ),
        /自己的预览/,
      );
      await runtime.withActor(bob, undefined, () => runtime.resetHumanInput());
      assert(
        steps.some(
          (s) => s.kind === 'edit' && s.editId === preview.editId && s.actor?.name === 'Alice',
        ),
      );
      const edit = await runtime.withActor(bob, undefined, () =>
        runtime.editElement(title.ref, { text: 'Bob plan', styles: { color: 'blue' } }),
      );
      assert.equal(
        runtime.getState().previewEdits!.find((e) => e.editId === edit.editId)!.actor!.id,
        'bob',
      );
      await assert.rejects(
        runtime.withActor(alice, undefined, () => runtime.undoEdit(edit.editId)),
        /只能撤销自己的/,
      );
      await assert.rejects(
        runtime.withActor(alice, undefined, () => runtime.undoEdit(preview.editId)),
        /其他参与者/,
      );
      await runtime.withActor(bob, undefined, () => runtime.undoEdit(edit.editId));
      const restored = await runtime.withActor(alice, undefined, () =>
        runtime.undoEdit(preview.editId),
      );
      assert.equal(restored.element.textContent, 'Plan');
      const button = (await runtime.queryElements({ selector: '#save' })).elements[0];
      const b = button.bounds!;
      let allowed = true;
      const guard = () => {
        if (!allowed) throw new Error('revoked');
      };
      await runtime.withActor(bob, guard, () =>
        runtime.dispatchInput({
          type: 'mouse',
          action: 'down',
          x: b.x + b.width / 2,
          y: b.y + b.height / 2,
          tabId,
        }),
      );
      allowed = false;
      await runtime.withActor(alice, undefined, () => runtime.resetHumanInput());
      const page = (runtime as any).tabs.get(tabId).page;
      assert.equal(
        (await page.call('Runtime.evaluate', { expression: 'window.clicks', returnByValue: true }))
          .result.value,
        0,
        'cancelled mouse press must not click during handoff',
      );
      await page.call('Runtime.evaluate', { expression: "document.body.style.height='5000px'" });
      await runtime.withActor(bob, undefined, () =>
        runtime.dispatchInput({
          type: 'wheel',
          x: 200,
          y: 300,
          deltaX: 0,
          deltaY: 180,
          tabId,
        }),
      );
      await runtime.withActor(alice, undefined, () => runtime.resetHumanInput());
      assert.equal(
        steps.findLast((s) => s.kind === 'scroll')?.actor?.id,
        'bob',
        'a compositor scroll completing during handoff still belongs to its sender',
      );
      await assert.rejects(
        runtime.withActor(bob, undefined, () => runtime.navigate('http://127.0.0.1:9/')),
        /共享仅限/,
      );
      await assert.rejects(runtime.newTab(url), /停止共享/);
      assert.throws(() => runtime.allowAgentControl(), /停止共享/);
      const epoch = runtime.getSurfaceEpoch();
      await runtime.withActor(bob, undefined, () => runtime.navigate(url + '/?next=1'));
      await assert.rejects(
        runtime.dispatchInput({ type: 'text', text: 'stale', frameEpoch: epoch }),
        /画面已过期/,
      );
      const recording = await runtime.stopRecording();
      assert.equal(recording.sharedSessionId, 'session');
      assert(recording.steps.some((s) => s.kind === 'edit' && s.actor?.id === 'bob'));
    } finally {
      await runtime.dispose();
      await new Promise<void>((r) => site.close(() => r()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
