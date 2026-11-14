import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserRuntime } from '../src/main/browser';
import type { GuideProgress } from '../src/main/browser-guide';

const pages: Record<string, string> = {
  '/': '<title>One</title><style>body{margin:24px;font:16px sans-serif}</style><h1>第一页</h1><a id="go" href="/two">下一页</a>',
  '/two':
    '<title>Two</title><style>body{margin:24px;font:16px sans-serif}label,button{display:block;margin:12px 0}</style><h1>第二页</h1><label>公司名称<input id="company"></label><button id="send">提交</button><script>document.querySelector("#send").addEventListener("click",()=>document.title="Sent")</script>',
};

test(
  'the browser walks a user through a flow that crosses pages, and only the user touches the page',
  { skip: !process.env.ATHENA_TEST_CHROME, timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'athena-guide-'));
    const site = createServer((req, res) => {
      res.setHeader('content-type', 'text/html;charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8">${pages[req.url || '/'] ?? pages['/']}`);
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(site.address() as any).port}`;
    let takeovers = 0;
    const runtime = new BrowserRuntime({
      storageDir: directory,
      binaryPath: process.env.ATHENA_TEST_CHROME,
      onState() {},
      onFrame() {},
      onStep() {},
      onSelected() {},
      onHumanTakeover() {
        takeovers++;
      },
    });
    const until = async <T>(check: () => Promise<T | undefined | false>, what: string) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const value = await check().catch(() => undefined);
        if (value) return value;
        if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      await runtime.resize(900, 700);
      await runtime.start(origin);
      const tabId = runtime.getState().activeTabId!;
      const page = (runtime as any).tabs.get(tabId).page;
      const evaluate = async (expression: string) =>
        (await page.call('Runtime.evaluate', { expression, returnByValue: true })).result.value;
      const centre = (selector: string) =>
        evaluate(
          `(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return r&&{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
        ) as Promise<{ x: number; y: number } | undefined>;
      const click = async (point: { x: number; y: number }) => {
        await runtime.dispatchInput({ type: 'mouse', action: 'down', button: 'left', ...point });
        await runtime.dispatchInput({ type: 'mouse', action: 'up', button: 'left', ...point });
      };
      // The guide's card is in a closed shadow root; the protocol can still see where it is.
      const card = async () => {
        const { root } = await page.call('DOM.getDocument', { depth: -1, pierce: true });
        const found: Record<string, any> = {};
        let note = '';
        const walk = (node: any) => {
          const attributes: string[] = node.attributes || [];
          const at = attributes.indexOf('data-do');
          if (at >= 0 && !attributes.includes('hidden')) found[attributes[at + 1]] = node;
          if (attributes[attributes.indexOf('class') + 1] === 'gd-note')
            note = node.children?.[0]?.nodeValue || '';
          for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) walk(child);
        };
        walk(root);
        if (!found.end) return undefined;
        const buttons: Record<string, { x: number; y: number }> = {};
        for (const [name, node] of Object.entries(found)) {
          const { model } = await page.call('DOM.getBoxModel', { nodeId: node.nodeId });
          const [x1, y1, , , x2, y2] = model.border;
          buttons[name] = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
        }
        return { note, buttons };
      };
      // A step is ready once its card has stopped travelling from the previous one.
      let before = '';
      const showing = (note: string) =>
        until(async () => {
          const seen = await card();
          const now = JSON.stringify(seen);
          const still = now === before;
          before = now;
          return seen?.note === note && still && seen;
        }, `the step "${note}"`);

      const progress: GuideProgress[] = [];
      const running = runtime.guide(
        {
          title: '填写公司',
          steps: [
            { note: '点“下一页”', text: '下一页', action: 'click' },
            { note: '填写公司名称', text: '公司名称', action: 'input' },
            { note: '核对后由你自己提交', selector: '#send' },
          ],
        },
        { handover: true, onProgress: (value) => progress.push(value) },
      );
      await showing('点“下一页”');
      await assert.rejects(runtime.guide({ steps: [{ note: '另一段' }] }), /已有一段带做/);
      // The agent's own tools still answer while the guide waits for the user.
      const tabs = await runtime.callTool('workbench_browser_tabs', {});
      assert.ok(!tabs.isError, tabs.text);

      // The user's click on the link is a real click: the page navigates, the guide follows.
      await click((await centre('#go'))!);
      await showing('填写公司名称');
      assert.equal(await evaluate('location.pathname'), '/two');
      await click((await centre('#company'))!);
      await runtime.dispatchInput({ type: 'text', text: 'unusual-company-name' });
      assert.equal(
        await evaluate('document.querySelector("#company").value'),
        'unusual-company-name',
      );
      await click((await showing('填写公司名称')).buttons.next);
      const last = await showing('核对后由你自己提交');
      // A step that only explains leaves the page alone: nothing was submitted for the user.
      await click(last.buttons.next);
      const result = await running;

      assert.equal(result.ended, 'completed');
      assert.deepEqual(result.steps, [
        { note: '点“下一页”', status: 'done', by: 'click' },
        { note: '填写公司名称', status: 'done', by: 'button', filled: true },
        { note: '核对后由你自己提交', status: 'done', by: 'button' },
      ]);
      assert.deepEqual(result.page, { url: `${origin}/two`, title: 'Two' });
      assert.match(result.outline || '', /第二页/);
      assert.ok(!JSON.stringify(result).includes('unusual-company-name'));
      assert.equal(await evaluate('document.title'), 'Two');
      assert.deepEqual(
        progress.map((item) => item.steps.map((step) => step.status[0]).join('')),
        ['cpp', 'dcp', 'ddc', 'ddd'],
      );
      assert.ok(takeovers > 0, 'the clicks and the typing were the user’s');
      // The goodbye fades and nothing of the guide stays on the page.
      await until(async () => !(await card()), 'the guide to leave the page');

      // Through the tool: a first step that is nowhere on the page starts nothing.
      const missing = await runtime.callTool('workbench_browser_guide', {
        steps: [{ note: '点“删除账号”', text: '删除账号', action: 'click' }],
      });
      assert.equal(missing.isError, true);
      assert.equal(JSON.parse(missing.text).started, false);
      assert.equal(JSON.parse(missing.text).reason, 'text_not_found');
      assert.equal(await card(), undefined);
      const invalid = await runtime.callTool('workbench_browser_guide', { steps: [] });
      assert.equal(invalid.isError, true);
      assert.match(invalid.text, /1 到 12 步/);

      // The user ends a guide from the card; the agent is told not to carry on by itself.
      const second = runtime.callTool('workbench_browser_guide', {
        steps: [{ note: '点“提交”', text: '提交', action: 'click' }, { note: '看结果' }],
      });
      await click((await showing('点“提交”')).buttons.end);
      const ended = JSON.parse((await second).text);
      assert.equal(ended.ended, 'ended_by_user');
      assert.equal(ended.next, 1);
      assert.equal(await evaluate('document.title'), 'Two');
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
