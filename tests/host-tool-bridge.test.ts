import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { HostToolBridge } from '../src/main/host-tool-bridge';
import type { AgentEvent, BrowserTool } from '../src/shared/types';

const tool: BrowserTool = {
  name: 'neo_snapshot',
  description: '读取测试页面',
  inputSchema: { type: 'object', properties: { page: { type: 'number' } }, required: ['page'] },
};

test('宿主桥验证令牌、工具白名单和调用 ID，关闭后拒绝晚到请求', async () => {
  let calls = 0;
  const events: AgentEvent[] = [];
  const bridge = new HostToolBridge(
    [tool],
    async () => {
      calls++;
      return { text: '已核对' };
    },
    (e) => events.push(e),
  );
  const endpoint = await bridge.start();
  const call = (value: unknown, token = endpoint.token) =>
    fetch(endpoint.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(value),
    });
  try {
    assert.equal((await call({ id: 'a', name: tool.name, arguments: {} }, 'invalid')).status, 401);
    assert.equal((await call({ id: 'a', name: 'unknown', arguments: {} })).status, 403);
    assert.equal((await call({ id: 'a', name: tool.name, arguments: [] })).status, 400);
    assert.deepEqual(
      await (await call({ id: 'a', name: tool.name, arguments: { page: 1 } })).json(),
      { text: '已核对', images: [], isError: false },
    );
    assert.equal((await call({ id: 'a', name: tool.name, arguments: { page: 2 } })).status, 409);
    assert.equal(calls, 1);
    assert.deepEqual(
      events.filter((e) => e.type === 'tool').map((e) => e.call.status),
      ['running', 'done'],
    );
    await bridge.close();
    await assert.rejects(call({ id: 'late', name: tool.name, arguments: {} }));
  } finally {
    await bridge.close();
  }
});

test('MCP stdio 往返保留中文和截图，拒绝未知工具且不泄漏宿主异常', async () => {
  const bridge = new HostToolBridge([tool], async (_name, args) => {
    if (args.page === 2) throw new Error('private-secret');
    return { text: '页面原文', image: 'data:image/png;base64,aGVsbG8=' };
  });
  const endpoint = await bridge.start();
  const child = spawn(process.execPath, [path.resolve('resources/cli/athena-mcp-stdio.mjs')], {
    env: {
      ...process.env,
      WORKBENCH_MCP_URL: endpoint.url,
      WORKBENCH_MCP_TOKEN: endpoint.token,
      WORKBENCH_MCP_TOOLS: JSON.stringify([tool]),
    },
    stdio: 'pipe',
  });
  let sequence = 0;
  const pending = new Map<number, (value: any) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  const request = (method: string, params = {}) =>
    new Promise<any>((resolve) => {
      const id = ++sequence;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  try {
    assert.equal(
      (await request('initialize', { protocolVersion: '2025-03-26' })).result.serverInfo.name,
      'athena',
    );
    assert.deepEqual((await request('tools/list')).result.tools, [tool]);
    assert.deepEqual(
      (await request('tools/call', { name: tool.name, arguments: { page: 1 } })).result,
      {
        content: [
          { type: 'text', text: '页面原文' },
          { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        ],
        isError: false,
      },
    );
    const failed = await request('tools/call', { name: tool.name, arguments: { page: 2 } });
    assert.equal(failed.result.isError, true);
    assert.equal(JSON.stringify(failed).includes('private-secret'), false);
    assert.equal((await request('tools/call', { name: 'unknown' })).result.isError, true);
  } finally {
    child.kill();
    await bridge.close();
  }
});

test('宿主桥关闭不会等待未决工具，晚到结果不能发出完成事件', async () => {
  let finish!: (value: { text: string }) => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const events: AgentEvent[] = [];
  const bridge = new HostToolBridge(
    [tool],
    () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    (e) => events.push(e),
  );
  const endpoint = await bridge.start();
  const pending = fetch(endpoint.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}` },
    body: JSON.stringify({ id: 'pending', name: tool.name, arguments: {} }),
  }).catch(() => undefined);
  await began;
  await bridge.close();
  finish({ text: '晚到' });
  await pending;
  assert.equal(events.filter((e) => e.type === 'tool' && e.call.status === 'done').length, 0);
});
