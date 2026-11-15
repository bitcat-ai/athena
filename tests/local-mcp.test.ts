import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalMcp } from '../src/main/local-mcp';
import { toolEventInput } from '../src/main/agents';

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'athena-mcp-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls: Array<{ method: string; params: any }> = [];
  let fail = false;
  let hang = false;
  let closed = 0;
  const tools = {
    read: {
      name: 'read',
      description: 'Read record',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
    },
    write: { name: 'write', description: 'Write record', inputSchema: { type: 'object' } },
  };
  const mcp = new LocalMcp({
    workspace: home,
    home,
    enabled: [],
    createClient: () => {
      let rejectPending: ((error: Error) => void) | undefined;
      return {
        async requestMcp(method, params) {
          calls.push({ method, params });
          if (method === 'config/read')
            return {
              layers: [
                { name: { type: 'sessionFlags' }, config: { mcp_servers: {} } },
                {
                  name: { type: 'user' },
                  config: {
                    mcp_servers: {
                      docs: {
                        url: 'https://example.test/mcp',
                        http_headers: { Authorization: 'Bearer CONFIG_SECRET' },
                      },
                    },
                  },
                },
              ],
            };
          if (method === 'thread/start') return { thread: { id: 'ephemeral' } };
          if (method === 'mcpServerStatus/list')
            return {
              data: [
                { name: 'docs', runtimeStatus: 'connected', authStatus: 'bearerToken', tools },
              ],
            };
          if (fail) throw new Error('Authorization: Bearer CONFIG_SECRET');
          if (hang)
            return new Promise((_resolve, reject) => {
              rejectPending = reject;
            });
          return { content: [{ type: 'text', text: 'actual result' }], isError: false };
        },
        close() {
          closed++;
          rejectPending?.(new Error('closed'));
        },
      };
    },
  });
  t.after(() => mcp.close());
  const state = await mcp.discover();
  return {
    mcp,
    home,
    calls,
    id: state.servers.find((s) => s.name === 'docs')!.id,
    fail: () => {
      fail = true;
    },
    hang: () => {
      hang = true;
    },
    closed: () => closed,
  };
}

test('inventory never starts servers or exposes configuration secrets; connection returns actual tool schemas', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.cursor'));
  await writeFile(
    path.join(f.home, '.cursor/mcp.json'),
    JSON.stringify({
      mcpServers: {
        local: { command: 'node', args: ['server.js'], env: { TOKEN: 'PRIVATE_ENV' } },
      },
    }),
  );
  const inventory = await f.mcp.discover();
  assert.equal(inventory.servers.length, 2);
  assert.doesNotMatch(JSON.stringify(inventory), /CONFIG_SECRET|PRIVATE_ENV|Authorization/);
  assert.equal(f.calls.filter((x) => x.method === 'thread/start').length, 0);
  const context = {
    signal: new AbortController().signal,
    readonly: false,
    approve: async () => false,
  };
  await assert.rejects(f.mcp.call('workbench_mcp_tools', { server: f.id }, context), /尚未连接/);
  await f.mcp.enable(f.id, true);
  const catalog = await f.mcp.call('workbench_mcp_tools', { server: f.id }, context);
  assert.deepEqual(
    JSON.parse(catalog.text).tools.map((x: any) => x.name),
    ['read', 'write'],
  );
  const response = await f.mcp.call(
    'workbench_mcp_call',
    { server: f.id, tool: 'read', arguments: {} },
    context,
  );
  assert.equal(response.text, 'actual result');
  assert.equal(f.calls.find((x) => x.method === 'thread/start')?.params.ephemeral, true);
  assert.equal(
    f.calls.some((x) => x.method.startsWith('turn/')),
    false,
  );
});

test('unknown or mutating tools require a specific approval and readonly tasks cannot call them', async (t) => {
  const f = await fixture(t);
  await f.mcp.enable(f.id, true);
  const args = { server: f.id, tool: 'write', arguments: { record: 'r42', token: 'PRIVATE' } };
  let approvals = 0;
  const context = {
    signal: new AbortController().signal,
    readonly: false,
    approve: async (request: any) => {
      approvals++;
      assert.match(request.detail, /r42/);
      assert.doesNotMatch(request.detail, /PRIVATE/);
      return false;
    },
  };
  assert.equal((await f.mcp.call('workbench_mcp_call', args, context)).isError, true);
  assert.equal(approvals, 1);
  assert.equal(f.calls.filter((x) => x.method === 'mcpServer/tool/call').length, 0);
  await assert.rejects(
    f.mcp.call('workbench_mcp_call', args, { ...context, readonly: true }),
    /只读/,
  );
  await assert.rejects(
    f.mcp.call('workbench_mcp_call', { ...args, tool: '__proto__' }, context),
    /工具或参数/,
  );
  await f.mcp.call('workbench_mcp_call', args, { ...context, approve: async () => true });
  assert.equal(f.calls.filter((x) => x.method === 'mcpServer/tool/call').length, 1);
});

test('lost replies are not retried and block subsequent mutations until user reconnects', async (t) => {
  const f = await fixture(t);
  await f.mcp.enable(f.id, true);
  f.fail();
  const args = { server: f.id, tool: 'write', arguments: {} };
  const context = {
    signal: new AbortController().signal,
    readonly: false,
    approve: async () => true,
  };
  const result = await f.mcp.call('workbench_mcp_call', args, context);
  assert.match(result.text, /结果未知/);
  assert.doesNotMatch(JSON.stringify([result, f.mcp.state()]), /CONFIG_SECRET/);
  await assert.rejects(f.mcp.call('workbench_mcp_call', args, context), /上次 MCP 操作结果未知/);
  assert.equal(f.calls.filter((x) => x.method === 'mcpServer/tool/call').length, 1);
});

test('stop closes the exact MCP connection and reports the uncertain result', async (t) => {
  const f = await fixture(t);
  await f.mcp.enable(f.id, true);
  f.hang();
  const abort = new AbortController();
  const pending = f.mcp.call(
    'workbench_mcp_call',
    { server: f.id, tool: 'write', arguments: {} },
    { signal: abort.signal, readonly: false, approve: async () => true },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort();
  assert.match((await pending).text, /结果未知/);
  assert.ok(f.closed() >= 2);
  assert.equal(f.mcp.state().servers.find((x) => x.id === f.id)?.status, 'error');
});

test('MCP review survives discovery refresh and sensitive arguments do not enter activity records', async (t) => {
  const f = await fixture(t);
  await f.mcp.enable(f.id, true);
  f.fail();
  const context = {
    signal: new AbortController().signal,
    readonly: false,
    approve: async () => true,
  };
  await f.mcp.call('workbench_mcp_call', { server: f.id, tool: 'write', arguments: {} }, context);
  await f.mcp.discover();
  assert.equal(f.mcp.state().servers.find((x) => x.id === f.id)?.needsReview, true);
  await assert.rejects(
    f.mcp.call('workbench_mcp_call', { server: f.id, tool: 'write', arguments: {} }, context),
    /结果未知/,
  );
  const visible = toolEventInput('workbench_mcp_call', {
    server: 'docs',
    tool: 'read',
    arguments: { authorization: 'PRIVATE', nested: { token: 'ALSO_PRIVATE' }, query: 'coffee' },
  });
  assert.doesNotMatch(JSON.stringify(visible), /PRIVATE/);
  assert.match(JSON.stringify(visible), /coffee/);
});
