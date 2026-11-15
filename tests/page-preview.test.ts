import assert from 'node:assert/strict';
import test from 'node:test';
import { PagePreview, fastPreviewModel, wantsPagePreview } from '../src/main/page-preview';
import type { AgentSessionOptions } from '../src/main/agent-session';
import type { ModelOption } from '../src/shared/usage';

test('preview routing is limited to creation requests and models actually listed by the CLI', () => {
  for (const text of ['帮我生成一个咖啡店落地页', 'create a landing page for a library'])
    assert.equal(wantsPagePreview(text), true);
  for (const text of [
    '不要创建页面，先分析',
    '修改这个页面的字体',
    '在仓库里生成页面源码',
    'create a website at https://example.com',
    '解释一下页面',
  ])
    assert.equal(wantsPagePreview(text), false, text);
  const model = (id: string, efforts: string[] = []) =>
    ({ model: id, name: id, efforts: efforts.map((id) => ({ id })) }) as ModelOption;
  assert.equal(fastPreviewModel([model('custom-primary')]), undefined);
  assert.deepEqual(fastPreviewModel([model('sonnet', ['low', 'high'])]), {
    model: 'sonnet',
    effort: 'low',
  });
  assert.equal(fastPreviewModel([model('haiku')]), undefined);
});

test('preview confines writes to one insertion on the observed page and exposes the actual receipt', async () => {
  const dispatched: unknown[] = [];
  let release!: () => void;
  const planning = new Promise<void>((resolve) => {
    release = resolve;
  });
  const preview = new PagePreview({
    workspace: '/isolated',
    executablePath: '/bin/claude',
    selection: { model: 'haiku' },
    request: '生成一个页面',
    ref: 'body-ref',
    tabId: 'page-1',
    signal: new AbortController().signal,
    tool: { name: 'workbench_browser_edit', description: '', inputSchema: {} },
    onEvent() {},
    call: async (_name, args) => {
      dispatched.push(args);
      return { text: '{"editId":"edit-1","element":{"ref":"new-ref"}}' };
    },
    createSession: (_agent, options) => ({
      async send() {
        assert.equal(options.previewOnly, true);
        await planning;
        assert.equal(
          (
            await options.callTool('workbench_browser_edit', {
              ref: 'elsewhere',
              insert: { node: { tag: 'section' } },
            })
          ).isError,
          true,
        );
        await options.callTool('workbench_browser_edit', {
          ref: 'body-ref',
          tabId: 'wrong-page',
          insert: { node: { tag: 'section', text: 'Real page' } },
        });
        assert.equal(
          (
            await options.callTool('workbench_browser_edit', {
              ref: 'body-ref',
              insert: { node: { tag: 'section' } },
            })
          ).isError,
          true,
        );
      },
      close() {},
      resolveApproval() {},
      resolveUserInput() {},
    }),
  });
  let mainWorking = false;
  const primary = Promise.resolve().then(() => {
    mainWorking = true;
    release();
  });
  assert.equal(preview.settled, false);
  await primary;
  const result = await preview.done;
  assert.equal(mainWorking, true);
  assert.equal(result.status, 'rendered');
  assert.equal(dispatched.length, 1);
  assert.equal((dispatched[0] as any).tabId, 'page-1');
  assert.ok(result.firstVisibleAt! >= result.startedAt);
  assert.equal(JSON.parse(result.result!.text).editId, 'edit-1');
});

test('stop terminates the worker and never dispatches its late write', async () => {
  const abort = new AbortController();
  let options!: AgentSessionOptions;
  let reject!: (error: Error) => void;
  let calls = 0;
  const preview = new PagePreview({
    workspace: '/isolated',
    executablePath: '/bin/codex',
    selection: { model: 'small' },
    request: '生成页面',
    ref: 'body',
    tabId: 'p',
    signal: abort.signal,
    tool: { name: 'workbench_browser_edit', description: '', inputSchema: {} },
    onEvent() {},
    call: async () => {
      calls++;
      return { text: 'no' };
    },
    createSession: (_agent, value) => {
      options = value;
      return {
        send: () =>
          new Promise((_resolve, no) => {
            reject = no;
          }),
        close: () => reject(new Error('stopped')),
        resolveApproval() {},
        resolveUserInput() {},
      };
    },
  });
  abort.abort();
  assert.equal((await preview.done).status, 'cancelled');
  await assert.rejects(
    options.callTool('workbench_browser_edit', {
      ref: 'body',
      insert: { node: { tag: 'section' } },
    }),
  );
  assert.equal(calls, 0);
});
