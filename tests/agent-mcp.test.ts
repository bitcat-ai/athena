import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AgentMcpServer } from '../src/main/agent-mcp';
import type { ToolCall } from '../src/shared/types';
import { testImage } from './image-fixture';

const tool = {
  name: 'neo_act',
  description: 'Perform a browser operation',
  inputSchema: { type: 'object', properties: {} },
};

test('private MCP authenticates, limits tool names, redacts UI inputs and refuses duplicate operations', async (t) => {
  const events: ToolCall[] = [];
  let calls = 0;
  const server = new AgentMcpServer(
    [tool],
    async (_name, args) => {
      calls++;
      assert.equal(args.text, 'secret-input');
      return { text: 'browser result', image: testImage.data };
    },
    (event) => events.push(event),
  );
  t.after(() => server.close());
  await server.start();
  const env = server.definition().env;
  const headers = {
    authorization: `Bearer ${env.ATHENA_MCP_TOKEN}`,
    'x-athena-client': 'test',
    'content-type': 'application/json',
  };
  const invoke = (id: string, method: string, params?: unknown) =>
    fetch(env.ATHENA_MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
  assert.equal(
    (
      await fetch(env.ATHENA_MCP_URL, {
        method: 'POST',
        headers: { ...headers, authorization: 'wrong' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(env.ATHENA_MCP_URL, {
        method: 'POST',
        headers: { ...headers, origin: 'https://untrusted.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.deepEqual((await (await invoke('list', 'tools/list')).json()).result.tools, [tool]);
  assert.ok(
    (
      await (
        await invoke('unknown', 'tools/call', { name: 'arbitrary_command', arguments: {} })
      ).json()
    ).error,
  );
  const params = { name: 'neo_act', arguments: { text: 'secret-input', sensitive: true } };
  const result = (await (await invoke('operation', 'tools/call', params)).json()).result;
  assert.deepEqual(result.content, [
    { type: 'text', text: 'browser result' },
    { type: 'image', mimeType: 'image/png', data: testImage.data },
  ]);
  assert.ok((await (await invoke('operation', 'tools/call', params)).json()).error);
  assert.equal(calls, 1);
  assert.deepEqual(
    events.map((event) => event.status),
    ['running', 'done'],
  );
  assert.ok(!JSON.stringify(events).includes('secret-input'));
  assert.equal(server.pendingCalls, 0);
});

test('the actual stdio child completes MCP initialization and tool calls without a model', async (t) => {
  const server = new AgentMcpServer(
    [tool],
    async () => ({ text: 'one browser action' }),
    () => {},
  );
  await server.start();
  const definition = server.definition();
  const child = spawn(definition.command, definition.args, {
    env: { ...process.env, ...definition.env },
    stdio: 'pipe',
  });
  t.after(() => {
    child.kill('SIGTERM');
    server.close();
  });
  child.stderr.resume();
  const pending = new Map<string, (value: any) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const request = (id: string, method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('stdio request timeout')), 5000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  assert.equal(
    (
      await request('init', 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })
    ).result.serverInfo.name,
    'athena',
  );
  assert.deepEqual((await request('list', 'tools/list')).result.tools, [tool]);
  assert.equal(
    (await request('call', 'tools/call', { name: 'neo_act', arguments: {} })).result.content[0]
      .text,
    'one browser action',
  );
});

test('closing a MCP connection revokes pending results and all subsequent access', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: ToolCall[] = [];
  const server = new AgentMcpServer(
    [tool],
    async () => {
      entered();
      await gate;
      return { text: 'late result' };
    },
    (event) => events.push(event),
  );
  await server.start();
  const env = server.definition().env;
  const response = fetch(env.ATHENA_MCP_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.ATHENA_MCP_TOKEN}`, 'x-athena-client': 'test' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'neo_act' },
    }),
  }).then(
    () => false,
    () => true,
  );
  await started;
  assert.equal(server.pendingCalls, 1);
  server.close();
  release();
  assert.equal(await response, true);
  assert.deepEqual(
    events.map((event) => event.status),
    ['running', 'error'],
  );
  assert.match(events.at(-1)!.output!, /需重新核对/);
  assert.throws(() => server.definition(), /尚未启动/);
  await assert.rejects(fetch(env.ATHENA_MCP_URL));
});
