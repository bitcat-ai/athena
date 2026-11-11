import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { HostToolBridge } from '../src/main/host-tool-bridge';
const require = createRequire(import.meta.url);
const gate = require('../resources/cli/pi-permissions.mjs').default;

test('Pi native operations require a live RPC approval and reviewable complete arguments', async () => {
  const handlers = new Map();
  gate({
    on(name: string, handler: unknown) {
      handlers.set(name, handler);
    },
  });
  let confirmations = 0;
  const context = {
    mode: 'rpc',
    hasUI: true,
    signal: new AbortController().signal,
    ui: {
      confirm: async () => {
        confirmations++;
        return true;
      },
      notify() {},
    },
  };
  const call = handlers.get('tool_call');
  assert.equal(
    await call({ toolName: 'write', input: { path: 'file.txt', content: 'hello' } }, context),
    undefined,
  );
  assert.equal(confirmations, 1);
  assert.equal(
    (await call({ toolName: 'bash', input: { command: 'x'.repeat(16001) } }, context)).block,
    true,
  );
  assert.equal(confirmations, 1);
  assert.equal(
    (await call({ toolName: 'read', input: { path: 'file.txt' } }, { ...context, mode: 'json' }))
      .block,
    true,
  );
  assert.equal(
    (
      await call(
        { toolName: 'read', input: { path: 'file.txt' } },
        { ...context, ui: { ...context.ui, confirm: async () => false } },
      )
    ).block,
    true,
  );
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await call({ toolName: 'write', input: {} }, { ...context, signal: controller.signal })).block,
    true,
  );
});

test('Pi Athena 扩展直接注册工具和截图，只有确切宿主工具免除本地工具审批', async () => {
  const bridge = new HostToolBridge(
    [{ name: 'neo_snapshot', description: '读取页面', inputSchema: { type: 'object' } }],
    async () => ({ text: '原文', image: 'data:image/png;base64,aGVsbG8=' }),
  );
  const endpoint = await bridge.start();
  const previous = process.env.WORKBENCH_ATHENA_TOOLS;
  process.env.WORKBENCH_ATHENA_TOOLS = JSON.stringify({
    ...endpoint,
    tools: [{ name: 'neo_snapshot', description: '读取页面', inputSchema: { type: 'object' } }],
  });
  const handlers = new Map();
  const registered = new Map();
  let confirmations = 0;
  const context = {
    mode: 'rpc',
    hasUI: true,
    signal: new AbortController().signal,
    ui: {
      confirm: async () => {
        confirmations++;
        return false;
      },
      notify() {},
    },
  };
  try {
    gate({
      on: (name: string, handler: unknown) => handlers.set(name, handler),
      registerTool: (tool: any) => registered.set(tool.name, tool),
      getActiveTools: () => [...registered.keys()],
    });
    await handlers.get('session_start')({}, context);
    assert.equal(
      await handlers.get('tool_call')({ toolName: 'neo_snapshot', input: {} }, context),
      undefined,
    );
    assert.equal(
      (
        await handlers.get('tool_call')(
          { toolName: 'mcp__athena__unregistered', input: {} },
          context,
        )
      ).block,
      true,
    );
    assert.equal(confirmations, 1);
    const result = await registered.get('neo_snapshot').execute('tool-id', {}, context.signal);
    assert.deepEqual(result.content, [
      { type: 'text', text: '原文' },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    ]);
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (
        await handlers.get('tool_call')(
          { toolName: 'neo_snapshot', input: {} },
          { ...context, signal: controller.signal },
        )
      ).block,
      true,
    );
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_ATHENA_TOOLS;
    else process.env.WORKBENCH_ATHENA_TOOLS = previous;
    await bridge.close();
  }
});
