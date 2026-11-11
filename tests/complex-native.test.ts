import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { BrowserRuntime } from '../src/main/browser';
import { NeoBrowserRuntime } from '../src/main/neo-browser';
import { complexWorkflowFixture } from './complex-workflow-fixture';
import type { WebExecutionEvent } from '../src/shared/types';

const binary = process.env.WORKBENCH_BROWSEROS_TEST_BINARY;
function ref(text: string, label: string) {
  const value = text
    .split('\n')
    .find((line) => line.includes('"' + label + '"') && line.includes('[ref='))
    ?.match(/\[ref=(e\d+)\]/)?.[1];
  assert(value, label);
  return value;
}
const observation = (text: string) => text.match(/Athena observationId: ([a-f0-9-]+)/)![1];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(
  'native readonly wait releases human wheel and click immediately without a mutation recovery barrier',
  { skip: !binary, timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'athena-readonly-interaction-'));
    const site = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html;charset=utf-8');
      response.end(
        '<!doctype html><title>工作清单</title><style>body{margin:0;height:5000px}button{position:fixed;left:30px;top:30px;width:130px;height:40px}#count{position:fixed;left:30px;top:80px}</style><button aria-label="增加计数" onclick="document.querySelector(\'#count\').textContent=String(++window.clicks)">增加计数</button><span id="count">0</span><script>window.clicks=0</script>',
      );
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    let neo!: NeoBrowserRuntime;
    const browser = new BrowserRuntime({
      storageDir: path.join(dir, 'browser'),
      binaryPath: binary,
      onState() {},
      onFrame() {},
      onSelected() {},
      onStep() {},
      onHumanTakeover: () => neo?.onHumanInteraction(),
    });
    neo = new NeoBrowserRuntime(browser, {
      directory: path.join(dir, 'neo'),
      onState() {},
      onDisconnect() {},
      approve: async () => true,
    });
    const samples: unknown[] = [];
    try {
      await browser.start(`http://127.0.0.1:${(site.address() as { port: number }).port}`);
      await neo.start();
      browser.allowAgentControl();
      const task = await neo.beginTask('readonly-interaction');
      const page = JSON.parse(task.context.match(/<neo_browser_context>\n([^\n]+)/)![1]).currentPage
        .pageId;
      const native = (browser as any).tabs.get(browser.getState().activeTabId).page;
      const value = async (expression: string) =>
        (
          await native.call('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          })
        ).result.value;
      for (const gesture of ['wheel', 'click']) {
        const initial = await neo.callTool('neo_snapshot', { page });
        assert.equal(initial.isError, false, initial.text);
        const previousSession = (neo as any).current.client.id;
        const beforeCount = await value('window.clicks');
        const waiting = neo.callTool('neo_wait', {
          page,
          for: 'text',
          value: 'NEVER-READY-READONLY',
          timeout: 5000,
        });
        const deadline = Date.now() + 2000;
        while (!(neo as any).current.running) {
          assert(Date.now() < deadline, 'Native wait must actually be in flight');
          await delay(10);
        }
        assert.equal((neo as any).current.running.mutating, false);
        await delay(80);
        const started = performance.now();
        const input =
          gesture === 'wheel'
            ? browser.dispatchInput({ type: 'wheel', x: 300, y: 300, deltaX: 0, deltaY: 240 })
            : (async () => {
                await browser.dispatchInput({
                  type: 'mouse',
                  action: 'down',
                  x: 60,
                  y: 45,
                  button: 'left',
                });
                await browser.dispatchInput({
                  type: 'mouse',
                  action: 'up',
                  x: 60,
                  y: 45,
                  button: 'left',
                });
              })();
        await Promise.race([
          input,
          delay(1000).then(() => assert.fail(`${gesture} was blocked by the 5s readonly wait`)),
        ]);
        await value('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
        const elapsedMs = performance.now() - started;
        const actual = gesture === 'wheel' ? await value('scrollY') : await value('window.clicks');
        assert(elapsedMs < 1000, `${gesture} must become visible within 1 second`);
        if (gesture === 'wheel')
          assert(actual >= 230, 'The wheel must change the actual page position');
        else assert.equal(actual, beforeCount + 1, 'The manual click must reach the real button');
        assert.equal((await waiting).isError, true);
        assert.equal((neo as any).current.stopped, false, 'AI task must remain active');
        assert.equal(
          (neo as any).current.execution.needsRecovery,
          false,
          'A cancelled read has no uncertain write to reconcile',
        );
        const fresh = await neo.callTool('neo_snapshot', { page });
        assert.equal(fresh.isError, false, fresh.text);
        assert.notEqual((neo as any).current.client.id, previousSession);
        const continued = await neo.callTool('neo_act', {
          page,
          kind: 'click',
          ref: ref(fresh.text, '增加计数'),
        });
        assert.equal(continued.isError, false, continued.text);
        assert.equal(await value('window.clicks'), beforeCount + (gesture === 'click' ? 2 : 1));
        samples.push({ gesture, elapsedMs, actual, continued: true });
      }
      await mkdir('test-results/interaction-refinement', { recursive: true });
      await writeFile(
        'test-results/interaction-refinement/readonly-wait-interaction.json',
        JSON.stringify({ passed: true, samples }, null, 2),
      );
    } finally {
      await neo.stop();
      await browser.dispose();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'native complex workflow: validation, stale references, gated recovery, iframe/shadow, transfer, unknown commit, bounded run and takeover',
  { skip: !binary, timeout: 120000 },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'athena-complex-native-'));
    const fixture = await complexWorkflowFixture();
    const events: WebExecutionEvent[] = [];
    let approved = true;
    let pendingApproval: ((answer: boolean) => void) | undefined;
    let holdApproval = false;
    let neo: NeoBrowserRuntime;
    const browser = new BrowserRuntime({
      storageDir: path.join(dir, 'browser'),
      binaryPath: binary,
      onState() {},
      onFrame() {},
      onSelected() {},
      onStep() {},
      onHumanTakeover() {
        neo?.onHumanInteraction();
      },
    });
    neo = new NeoBrowserRuntime(browser, {
      directory: path.join(dir, 'neo'),
      onState() {},
      onDisconnect() {},
      onExecution: (e) => events.push(e),
      approve: async (request) => {
        if (holdApproval)
          return new Promise<boolean>((r) => {
            pendingApproval = r;
          });
        if (request.action === 'browser-help' && approved) {
          const field = (await browser.queryElements({ selector: '#customer' })).elements[0];
          await browser.selectElement(field.ref);
        }
        return approved;
      },
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await neo.callTool('neo_' + name, args);
      assert.equal(result.isError, false, result.text);
      return result;
    };
    const checkpoint = async (
      page: number,
      evidence: string,
      outcome = 'verified',
      recoveryPage?: number,
    ) => {
      const read = await call('read', { page });
      return call('checkpoint', {
        observationId: observation(read.text),
        summary: evidence,
        evidence,
        outcome,
        ...(recoveryPage ? { recoveryPage } : {}),
      });
    };
    const begin = async (id: string) => {
      browser.allowAgentControl();
      const task = await neo.beginTask(id);
      return {
        task,
        page: JSON.parse(task.context.match(/<neo_browser_context>\n([^\n]+)/)![1]).currentPage
          .pageId as number,
      };
    };
    try {
      await browser.start(fixture.origin + '/?loseReply=1');
      await neo.start();
      const { task, page } = await begin('workflow');
      let snap = await call('snapshot', { page });
      await call('act', {
        page,
        kind: 'select',
        ref: ref(snap.text, '筛选状态'),
        value: 'pending',
      });
      await call('wait', { page, for: 'text', value: 'Cedar', timeout: 3000 });
      snap = await call('snapshot', { page });
      await call('act', { page, kind: 'click', ref: ref(snap.text, '下一页') });
      await call('wait', { page, for: 'text', value: '处理 Ada Studio', timeout: 3000 });
      snap = await call('snapshot', { page });
      await call('act', { page, kind: 'click', ref: ref(snap.text, '处理 Ada Studio') });
      snap = await call('snapshot', { page });
      await call('act', {
        page,
        kind: 'select',
        ref: ref(snap.text, '区域'),
        value: 'international',
      });
      await call('wait', { page, for: 'selector', value: '#tax', timeout: 3000 });
      snap = await call('snapshot', { page });
      const taxRef = ref(snap.text, '税号');
      await call('act', { page, kind: 'click', ref: ref(snap.text, '检查订单') });
      await call('wait', { page, for: 'text', value: '国际税号应为 INT-2048', timeout: 3000 });
      assert.equal(fixture.attempts, 0);
      // Removing a conditional field invalidates its native ref. A queued write must see that failure.
      await call('act', { page, kind: 'select', ref: ref(snap.text, '区域'), value: 'domestic' });
      await delay(500);
      const stale = neo.callTool('neo_act', { page, kind: 'fill', ref: taxRef, value: 'WRONG' });
      const queued = neo.callTool('neo_act', {
        page,
        kind: 'fill',
        ref: ref(snap.text, '客户名称'),
        value: 'SHOULD-NOT',
      });
      assert.equal((await stale).isError, true);
      assert.match((await queued).text, /核对/);
      await checkpoint(page, '新建订单', 'not_applied');
      snap = await call('snapshot', { page });
      await call('act', {
        page,
        kind: 'select',
        ref: ref(snap.text, '区域'),
        value: 'international',
      });
      await call('wait', { page, for: 'selector', value: '#tax', timeout: 3000 });
      snap = await call('snapshot', { page });
      await call('act', {
        page,
        kind: 'fill',
        fields: [
          { ref: ref(snap.text, '客户名称'), value: 'Ada Studio' },
          { ref: ref(snap.text, '税号'), value: 'INT-2048' },
          { ref: ref(snap.text, '联系邮箱'), value: 'ada@example.test' },
        ],
      });
      await call('act', {
        page,
        kind: 'select',
        ref: ref(snap.text, '配送方式'),
        value: 'express',
      });
      const file = path.join(dir, 'approved-fixture.txt');
      await writeFile(file, 'Athena controlled upload\n');
      approved = false;
      assert.equal(
        (await neo.callTool('neo_upload', { page, ref: ref(snap.text, '订单附件'), file })).isError,
        true,
      );
      assert.equal(fixture.uploads.length, 0);
      approved = true;
      await call('upload', { page, ref: ref(snap.text, '订单附件'), file });
      await call('wait', { page, for: 'text', value: '附件已验证', timeout: 3000 });
      await call('request_human_help', { page, reason: '检查表单', kind: 'other' });
      assert.match(
        (await neo.callTool('neo_act', { page, kind: 'click', ref: ref(snap.text, '检查订单') }))
          .text,
        /核对/,
      );
      await checkpoint(page, '附件已验证');
      snap = await call('snapshot', { page });
      await call('act', { page, kind: 'click', ref: ref(snap.text, '检查订单') });
      await call('wait', { page, for: 'text', value: '校验通过，可以提交', timeout: 3000 });
      await checkpoint(page, '校验通过，可以提交');
      snap = await call('snapshot', { page });
      const submit = { page, kind: 'click', ref: ref(snap.text, '提交订单') };
      await call('act', submit);
      const unmatched = await neo.callTool('neo_wait', {
        page,
        for: 'text',
        value: '已保存',
        timeout: 100,
      });
      assert.equal(unmatched.isError, true, 'Native timeout must not be reported as success');
      assert.match((await neo.callTool('neo_act', submit)).text, /核对/);
      assert.equal(fixture.attempts, 1, 'No blind retry reached the server');
      const receiptTab = await call('tabs', { action: 'new', url: fixture.origin + '/receipts' });
      const receiptPage = Number(receiptTab.text.match(/opened page (\d+)/)![1]);
      await call('wait', { page: receiptPage, for: 'text', value: 'ORDER-1', timeout: 3000 });
      await checkpoint(receiptPage, 'ORDER-1', 'verified', page);
      snap = await call('snapshot', { page: receiptPage });
      await call('download', { page: receiptPage, ref: ref(snap.text, '下载回执 CSV') });
      const artifact = events.find((e) => e.kind === 'artifact')!.artifact!;
      assert(artifact.path.startsWith((await realpath(browser.getDownloadDirectory())) + path.sep));
      assert.match(
        await readFile(artifact.path, 'utf8'),
        /ORDER-1,Ada Studio,international,INT-2048,express,ada@example.test/,
      );
      const run = await call('run', {
        code: `const pages=await browser.pages.list();const p=browser.page(${receiptPage});const content=await p.read();return {pages:pages.length,receipt:content.includes('ORDER-1')};`,
      });
      assert.match(run.text, /true/);
      const record = await neo.server.detail(task.sessionId);
      assert(record.dispatches.some((x) => x.toolName === 'run'));
      await neo.finishTask('workflow');
      await browser.switchTab(browser.getState().tabs.find((t) => t.url.includes('loseReply'))!.id);
      const takeover = await begin('takeover');
      snap = await call('snapshot', { page: takeover.page });
      const customer = ref(snap.text, '客户名称');
      const humanField = (await browser.queryElements({ selector: '#customer' })).elements[0];
      const late = neo.callTool('neo_run', {
        code: `const p=browser.page(${takeover.page});await p.waitForTime(1000);await p.fill('${customer}','SHOULD-NOT');return true;`,
      });
      const later = neo.callTool('neo_act', {
        page: takeover.page,
        kind: 'fill',
        ref: customer,
        value: 'SHOULD-NOT-EITHER',
      });
      await delay(120);
      await browser.selectElement(humanField.ref);
      assert.equal((await late).isError, true);
      assert.equal((await later).isError, true);
      await delay(1100);
      assert.equal((await browser.getElementDetails(humanField.ref)).value, 'Ada Studio');
      assert.equal(fixture.attempts, 1);
      assert.equal((neo as any).current.stopped, false, 'Human input must not stop the AI task');
      const oldNativeSession = (neo as any).current.client.id;
      snap = await call('snapshot', { page: takeover.page });
      assert.notEqual(
        (neo as any).current.client.id,
        oldNativeSession,
        'Interrupted native dispatch gets a fresh session',
      );
      assert.equal(
        (
          await neo.callTool('neo_act', {
            page: takeover.page,
            kind: 'fill',
            ref: ref(snap.text, '客户名称'),
            value: 'UNVERIFIED',
          })
        ).isError,
        true,
        'Observation alone cannot replay an interrupted mutation',
      );
      await checkpoint(takeover.page, 'Ada Studio', 'not_applied');
      snap = await call('snapshot', { page: takeover.page });
      await call('act', {
        page: takeover.page,
        kind: 'fill',
        ref: ref(snap.text, '客户名称'),
        value: 'Continued after interaction',
      });
      const continued = (await browser.queryElements({ selector: '#customer' })).elements[0];
      assert.equal(
        (await browser.getElementDetails(continued.ref)).value,
        'Continued after interaction',
      );

      const idleSession = (neo as any).current.client.id;
      await browser.dispatchInput({ type: 'wheel', x: 30, y: 30, deltaX: 0, deltaY: 30 });
      assert.equal((neo as any).current.stopped, false);
      const staleAfterScroll = await neo.callTool('neo_act', {
        page: takeover.page,
        kind: 'fill',
        ref: ref(snap.text, '客户名称'),
        value: 'STALE',
      });
      assert.equal(staleAfterScroll.isError, true);
      snap = await call('snapshot', { page: takeover.page });
      assert.equal(
        (neo as any).current.client.id,
        idleSession,
        'Idle viewing does not restart native session',
      );
      await call('act', {
        page: takeover.page,
        kind: 'fill',
        ref: ref(snap.text, '客户名称'),
        value: 'After scroll',
      });
      await neo.finishTask('takeover');
      await begin('approval-cancel');
      holdApproval = true;
      const pending = neo.callTool('neo_run', { code: 'throw new Error("must not dispatch");' });
      while (!pendingApproval) await delay(10);
      await neo.cancelTask();
      pendingApproval(true);
      assert.equal((await pending).isError, true);
      await neo.finishTask('approval-cancel');
      pendingApproval = undefined;
      await begin('finish-pending');
      const unfinished = neo.callTool('neo_run', {
        code: 'throw new Error(\"must not dispatch\");',
      });
      while (!pendingApproval) await delay(10);
      await neo.finishTask('finish-pending');
      (pendingApproval as (answer: boolean) => void)(true);
      assert.equal((await unfinished).isError, true);
      assert(events.some((e) => e.kind === 'cancelled'));
      await mkdir('test-results/complex-agent', { recursive: true });
      await writeFile(
        'test-results/complex-agent/native-workflow.json',
        JSON.stringify(
          {
            passed: true,
            realModel: false,
            saves: fixture.saves,
            attempts: fixture.attempts,
            events,
            nativeDispatches: record.dispatches.map((x) => ({
              tool: x.toolName,
              durationMs: x.durationMs,
            })),
          },
          null,
          2,
        ),
      );
    } finally {
      await neo.stop();
      await browser.dispose();
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'native structural insertions reconcile unknown receipts and never replay confirmed creations',
  { skip: !binary, timeout: 30000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'athena-structure-receipt-'));
    const site = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html;charset=utf-8');
      response.end(
        '<!doctype html><title>Structure receipt</title><main id="workspace">Original content</main>',
      );
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    let neo!: NeoBrowserRuntime;
    const browser = new BrowserRuntime({
      storageDir: path.join(directory, 'browser'),
      binaryPath: binary,
      onState() {},
      onFrame() {},
      onSelected() {},
      onStep() {},
      onHumanTakeover: () => neo?.onHumanInteraction(),
    });
    neo = new NeoBrowserRuntime(browser, {
      directory: path.join(directory, 'neo'),
      onState() {},
      onDisconnect() {},
      approve: async () => false,
    });
    try {
      await browser.start(`http://127.0.0.1:${(site.address() as { port: number }).port}`);
      await neo.start();
      browser.allowAgentControl();
      await neo.beginTask('structure-receipt');
      const queried = await neo.callTool('workbench_browser_query', { selector: '#workspace' });
      assert.ok(!queried.isError, queried.text);
      const anchor = JSON.parse(queried.text).elements[0].ref;
      const first = {
        ref: anchor,
        insert: {
          node: { tag: 'section', text: 'Created once', attributes: { id: 'first-created' } },
        },
      };
      const nativeCall = browser.callTool.bind(browser);
      let loseReply = true,
        insertions = 0;
      browser.callTool = async (name, args) => {
        const result = await nativeCall(name, args);
        if (
          name === 'workbench_browser_edit' &&
          (args as Record<string, unknown>).insert &&
          !result.isError
        ) {
          insertions++;
          if (loseReply) {
            loseReply = false;
            return { text: 'Fixture lost the insertion receipt', isError: true };
          }
        }
        return result;
      };
      assert.equal((await neo.callTool('workbench_browser_edit', first)).isError, true);
      assert.equal((await neo.callTool('workbench_browser_edit', first)).isError, true);
      assert.equal(insertions, 1);
      const observed = await neo.callTool('workbench_browser_query', {
        selector: '#first-created',
      });
      const evidence = JSON.parse(observed.text);
      assert.equal(evidence.elements.length, 1);
      const verified = await neo.callTool('neo_checkpoint', {
        observationId: evidence.observationId,
        summary: 'Insertion already exists',
        evidence: 'Created once',
        outcome: 'verified',
      });
      assert.equal(verified.isError, false, verified.text);
      assert.match((await neo.callTool('workbench_browser_edit', first)).text, /不能重复/);
      const second = {
        ref: anchor,
        insert: {
          node: { tag: 'section', text: 'Second creation', attributes: { id: 'second-created' } },
        },
      };
      const succeeded = await neo.callTool('workbench_browser_edit', second);
      assert.ok(!succeeded.isError, succeeded.text);
      assert.match((await neo.callTool('workbench_browser_edit', second)).text, /不能重复/);
      assert.equal(insertions, 2);
      assert.equal(
        (await browser.queryElements({ selector: '#second-created' })).elements.length,
        1,
      );
      const undone = await neo.callTool('workbench_browser_undo', {
        editId: JSON.parse(succeeded.text).editId,
      });
      assert.ok(!undone.isError, undone.text);
      assert.equal(
        (await browser.queryElements({ selector: '#second-created' })).elements.length,
        0,
      );
      await neo.finishTask('structure-receipt');
    } finally {
      await neo.stop();
      await browser.dispose();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
