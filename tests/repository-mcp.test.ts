import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { RepositoryMcp, repositoryTools } from '../src/main/repository-mcp';
import { SandboxPool, sandboxPoolTools } from '../src/main/sandbox-pool';
import { cliEnvironment } from '../src/main/agent-process';

test('repository MCP initializes, discovers and calls through the authenticated wire', async () => {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    methods.push(message.method);
    if (message.id === undefined) {
      res.writeHead(204).end();
      return;
    }
    const result =
      message.method === 'tools/list'
        ? { tools: repositoryTools }
        : message.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'resolved real repository' }] }
          : { protocolVersion: '2024-11-05' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new RepositoryMcp(
      `http://127.0.0.1:${(server.address() as any).port}/mcp`,
      'fixture-secret',
    );
    const result = await client.call(
      'workbench_repository_resolve',
      { website_url: 'http://localhost', module: 'customers' },
      new AbortController().signal,
    );
    assert.equal(result.text, 'resolved real repository');
    assert.deepEqual(methods, [
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]);
    await assert.rejects(client.call('unregistered', {}, new AbortController().signal), /未知/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('registry configuration and sandbox selectors reject untrusted destinations', async () => {
  assert.throws(() => new RepositoryMcp('https://example.com', 'secret'), /回环/);
  assert.throws(() => new RepositoryMcp('http://127.0.0.1', ''), /回环/);
  const pool = new SandboxPool('/unused', '/unused/program', () => {});
  await assert.rejects(
    pool.call(
      'athena_sandbox_status',
      { target: '../../outside' },
      { conversationId: 'c', turnId: 't', signal: new AbortController().signal },
    ),
    /目标/,
  );
  assert.ok(
    sandboxPoolTools.every((tool) =>
      (tool.inputSchema as any).properties.target.enum.includes('backend'),
    ),
  );
  await pool.dispose();
});
test('repository host credentials never enter CLI child environments', () => {
  const previous = process.env.ATHENA_REPOSITORY_MCP_TOKEN;
  try {
    process.env.ATHENA_REPOSITORY_MCP_TOKEN = 'fixture-private-token';
    assert.equal(cliEnvironment('/usr/bin/codex').ATHENA_REPOSITORY_MCP_TOKEN, undefined);
  } finally {
    if (previous === undefined) delete process.env.ATHENA_REPOSITORY_MCP_TOKEN;
    else process.env.ATHENA_REPOSITORY_MCP_TOKEN = previous;
  }
});
