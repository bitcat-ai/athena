import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const gate = require('../resources/cli/pi-permissions.mjs').default;

test('Pi browser requests use transport IDs independent of reused model call IDs', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.ATHENA_MCP_URL;
  const previousToken = process.env.ATHENA_MCP_TOKEN;
  const ids: number[] = [];
  let registered: any;
  process.env.ATHENA_MCP_URL = 'http://127.0.0.1:1/';
  process.env.ATHENA_MCP_TOKEN = 'fixture-only';
  globalThis.fetch = (async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    ids.push(request.id);
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result:
          request.method === 'tools/list'
            ? {
                tools: [
                  { name: 'neo_status', description: 'Status', inputSchema: { type: 'object' } },
                ],
              }
            : { content: [{ type: 'text', text: 'ready' }] },
      }),
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.ATHENA_MCP_URL;
    else process.env.ATHENA_MCP_URL = previousUrl;
    if (previousToken === undefined) delete process.env.ATHENA_MCP_TOKEN;
    else process.env.ATHENA_MCP_TOKEN = previousToken;
  });
  await gate({
    on() {},
    registerTool(tool: unknown) {
      registered = tool;
    },
  });
  await registered.execute('same-model-call-id', {});
  await registered.execute('same-model-call-id', {});
  assert.deepEqual(ids, [1, 2, 3]);
});

test('Pi native operations require a live RPC approval and reviewable complete arguments', async () => {
  const handlers = new Map();
  await gate({
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
