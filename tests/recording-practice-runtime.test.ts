import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserRuntime } from '../src/main/browser';
import { practiseRecording, recordingPracticePlan } from '../src/main/recording-practice';

test(
  'guiding a different row verifies its new status without reusing the demonstrated response',
  {
    skip: !process.env.ATHENA_TEST_CHROME,
    timeout: 30_000,
  },
  async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'athena-guide-feedback-'));
    const site = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html;charset=utf-8');
      res.end(
        '<table>' +
          ['C1001', 'C1008']
            .map(
              (id) =>
                `<tr><th>${id}</th><td><button id="${id}" onclick="document.getElementById(\'notice\').textContent=this.id+\' 已保存\'">保存</button></td></tr>`,
            )
            .join('') +
          '</table><div role="status" id="notice">等待保存</div>',
      );
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
    const browser = new BrowserRuntime({
      storageDir: dir,
      binaryPath: process.env.ATHENA_TEST_CHROME,
      onState() {},
      onFrame() {},
      onStep() {},
      onSelected() {},
      onHumanTakeover() {},
    });
    t.after(async () => {
      await browser.dispose();
      site.close();
      await rm(dir, { recursive: true, force: true });
    });
    await browser.start(url);
    const click = async (id: string) => {
      const item = (await browser.queryElements({ selector: '#' + id })).elements[0];
      const b = item.bounds!;
      const point = { button: 'left' as const, x: b.x + b.width / 2, y: b.y + b.height / 2 };
      await browser.dispatchInput({ type: 'mouse', action: 'down', ...point });
      await browser.dispatchInput({ type: 'mouse', action: 'up', ...point });
    };
    await browser.startRecording();
    await click('C1001');
    const original = await browser.stopRecording();
    const source = original.steps.find((s) => s.kind === 'click')!;
    original.workflow = {
      revision: 'r',
      goal: '保存客户',
      steps: [{ note: '保存 C1001', stepIds: [source.id] }],
      questions: [],
    };
    const plan = recordingPracticePlan(
      original,
      {
        revision: 'r',
        example: 'C1001',
        target: 'C1008',
        verifyCustomerZip: false,
        excludeInternal: false,
        expectedFeedback: 'C1008 已保存',
      },
      url,
    );
    let shown!: () => void;
    const ready = new Promise<void>((resolve) => {
      shown = resolve;
    });
    const abort = new AbortController();
    const run = practiseRecording(
      browser,
      plan,
      browser.getState().activeTabId!,
      abort.signal,
      (p) => {
        if (p.progress.some((s) => s.status === 'current')) shown();
      },
    );
    try {
      await Promise.race([
        ready,
        run.then((p) => {
          throw Error(p.detail);
        }),
      ]);
      await click('C1008');
      const result = await run;
      assert.equal(result.status, 'finished');
      assert.equal(result.verification, 'passed', result.detail);
      assert.match(result.detail, /C1008 已保存/);
    } finally {
      abort.abort();
      await run.catch(() => {});
    }
  },
);
