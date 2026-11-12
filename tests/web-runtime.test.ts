import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserRuntime } from '../src/main/browser';
import { WebRuntime } from '../src/main/web-runtime';
import type { ApprovalRequest, ToolResult } from '../src/shared/types';

async function waitFor<T>(
  read: () => Promise<T>,
  match: (x: T) => boolean,
  timeout = 5000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (match(value)) return value;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Expected native state did not arrive');
}
function ref(text: string, label: string) {
  const value = text
    .split('\n')
    .find((line) => line.includes('"' + label + '"'))
    ?.match(/\bref=(ab[a-f0-9]{8}:e\d+)/)?.[1];
  assert(value, label);
  return value;
}
// Real pinned agent-browser daemon and an Athena-owned Chrome profile; no model requests.
const enabled = process.env.ATHENA_TEST_AGENT_BROWSER === '1';

test(
  'the web executor drives the visible page, batches a form, records the result, and cancels future actions',
  { skip: !enabled, timeout: 60000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'athena-native-test-'));
    const saved: Array<{ title: string; owner: string }> = [];
    let nativeStarted = 0;
    const site = createServer(async (req, res) => {
      if (req.url === '/signal' && req.method === 'POST') {
        nativeStarted++;
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
        return;
      }
      if (req.url === '/save' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const value = JSON.parse(body);
        saved.push(value);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: saved.length, ...value }));
        return;
      }
      res.setHeader('content-type', 'text/html;charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><title>相同标题</title><label>标题<input id="title" aria-label="标题"></label><label>负责人<input id="owner" aria-label="负责人"></label><button id="save">保存</button><button id="confirm">确认后保存</button><p id="result" role="status">尚未保存</p><script>
    save.onclick=async()=>{const r=await fetch('/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:document.querySelector('#title').value,owner:owner.value})});result.textContent='已保存 #'+(await r.json()).id;};
    document.querySelector('#confirm').onclick=()=>{if(confirm('保存测试记录？'))save.click();};</script>`);
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    const approvals: Array<Omit<ApprovalRequest, 'id' | 'kind'>> = [];
    let approve = true;
    let native: WebRuntime;
    const browser = new BrowserRuntime({
      storageDir: path.join(directory, 'browser'),
      onState() {},
      onFrame() {},
      onStep() {},
      onSelected() {},
      onHumanTakeover() {
        if (native && !native.isHandingOver()) void native.cancelTask();
      },
    });
    native = new WebRuntime(browser, {
      directory: path.join(directory, 'native'),
      onState() {},
      onDisconnect() {},
      approve: async (request) => {
        approvals.push(request);
        if (request.action === 'browser-help' && approve) {
          assert(native.isHandingOver());
          const element = (await browser.queryElements({ selector: '#owner' })).elements[0];
          await browser.selectElement(element.ref);
          assert(native.isHandingOver(), 'Human actions during requested help must not cancel');
        }
        return approve;
      },
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await native.callTool(name, args);
      assert.equal(result.isError, false, result.text);
      return result;
    };
    try {
      await browser.start(url);
      const first = browser.getState().activeTabId!;
      await browser.newTab(url);
      const second = browser.getState().activeTabId!;
      await native.start();
      assert.equal(native.getState().version, '0.42.0');
      const tools = native.getTools();
      assert(tools.some((tool) => tool.name === 'web_act'));
      assert(!tools.some((tool) => tool.name === 'workbench_browser_click'));
      assert(
        !tools.some(
          (tool) =>
            tool.name === 'web_credentials' ||
            tool.name === 'web_browser_profiles' ||
            tool.name === 'web_save_skill',
        ),
      );
      browser.allowAgentControl();
      const task = await native.beginTask('form');
      const context = JSON.parse(task.context.match(/<web_browser_context>\n([^\n]+)/)![1]);
      assert.equal(context.currentPage.targetId, second);
      const page = context.currentPage.pageId;
      const snapshot = await call('web_snapshot', { page, mode: 'interactive' });
      await call('web_act', {
        page,
        kind: 'fill',
        fields: [
          { ref: ref(snapshot.text, '标题'), value: '发布 Athena' },
          { ref: ref(snapshot.text, '负责人'), value: 'Ada' },
        ],
      });
      await call('web_act', { page, kind: 'click', ref: ref(snapshot.text, '保存') });
      await call('web_wait', { page, for: 'text', value: '已保存 #1', timeout: 3000 });
      assert.deepEqual(saved, [{ title: '发布 Athena', owner: 'Ada' }]);
      const other = (browser as any).tabs.get(first);
      const value = await other.page.call('Runtime.evaluate', {
        expression: 'document.querySelector("#title").value',
        returnByValue: true,
      });
      assert.equal(
        value.result.value,
        '',
        'A duplicate URL/title must not select the other target',
      );
      assert.equal(browser.getState().activeTabId, second);
      const record = await native.server.detail(task.sessionId);
      assert(
        record.dispatches.some(
          (step) => step.toolName === 'act' && step.argsJson?.includes('fields'),
        ),
      );
      assert(
        record.dispatches.some(
          (step) => step.toolName === 'act' && step.argsJson?.includes('click'),
        ),
      );
      await call('web_request_human_help', { page, reason: '确认负责人', kind: 'other' });
      assert.equal(native.isHandingOver(), false);
      const resumed = await call('web_snapshot', { page });
      assert.match(resumed.text, /负责人/);
      await native.finishTask('form');
      const finished = await native.server.detail(task.sessionId);
      assert.notEqual(
        finished.session.status,
        'live',
        'Closing the transport must finish the native session',
      );

      browser.allowAgentControl();
      const control = await native.beginTask('control');
      const controlContext = JSON.parse(
        control.context.match(/<web_browser_context>\n([^\n]+)/)![1],
      );
      const controlPage = controlContext.currentPage.pageId;
      const controlSnapshot = await call('web_snapshot', { page: controlPage });
      await call('web_run', {
        code: `const p=browser.page(${controlPage});await p.evaluateInPage(()=>fetch('/signal',{method:'POST'}).then(r=>r.json()));await p.waitForTime(2000);await p.click(${JSON.stringify(ref(controlSnapshot.text, '保存'))});return true;`,
      });
      await waitFor(
        async () => saved.length,
        (value) => value === 2,
      );
      await native.finishTask('control');
      browser.allowAgentControl();
      const waiting = await native.beginTask('cancel');
      const waitingContext = JSON.parse(
        waiting.context.match(/<web_browser_context>\n([^\n]+)/)![1],
      );
      const current = waitingContext.currentPage.pageId;
      const fresh = await call('web_snapshot', { page: current });
      const planned = native.callTool('web_run', {
        code: `const p=browser.page(${current});await p.evaluateInPage(()=>fetch('/signal',{method:'POST'}).then(r=>r.json()));await p.waitForTime(2000);await p.click(${JSON.stringify(ref(fresh.text, '保存'))});return true;`,
      });
      await waitFor(
        async () => nativeStarted,
        (x) => x === 2,
      );
      await native.cancelTask();
      const cancelled = await planned;
      assert.equal(cancelled.isError, true);
      await new Promise((r) => setTimeout(r, 2100));
      assert.equal(saved.length, 2, 'A stopped native script must not perform its later click');
      assert.equal((await native.server.detail(waiting.sessionId)).session.status, 'cancelled');
      await native.finishTask('cancel');

      browser.allowAgentControl();
      approve = false;
      const denied = await native.beginTask('denied');
      const deniedResult = await native.callTool('web_run', { code: 'return 7;' });
      assert.equal(deniedResult.isError, true);
      assert.match(deniedResult.text, /未允许/);
      assert.equal(approvals.at(-1)?.action, 'browser-script');
      assert.equal(saved.length, 2);
      await native.finishTask('denied');
      assert((await native.server.records()).some((item) => item.sessionId === task.sessionId));
    } finally {
      await native.stop();
      await browser.dispose();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
