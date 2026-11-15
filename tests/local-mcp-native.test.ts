import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { LocalMcp } from '../src/main/local-mcp';

// Opt-in: uses an existing public documentation MCP, without a model turn or config writes.
test(
  'native CLI connects a configured MCP and performs a real documentation read',
  { skip: process.env.ATHENA_TEST_LOCAL_MCP !== '1' },
  async (t) => {
    const executablePath = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
    const mcp = new LocalMcp({ workspace: process.cwd(), executablePath, enabled: [] });
    t.after(() => mcp.close());
    const state = await mcp.discover();
    const server = state.servers.find(
      (server) => server.source === 'Codex' && server.name === 'openaiDeveloperDocs',
    );
    assert.ok(server, 'Configure openaiDeveloperDocs in the native Codex CLI first');
    assert.equal(server.enabled, false);
    await mcp.enable(server.id, true);
    const context = {
      signal: AbortSignal.timeout(60000),
      readonly: false,
      approve: async (request: { target?: string }) =>
        request.target?.endsWith('/ search_openai_docs') === true,
    };
    const catalog = JSON.parse(
      (await mcp.call('workbench_mcp_tools', { server: server.id }, context)).text,
    );
    const search = catalog.tools.find((tool: any) => tool.name === 'search_openai_docs');
    assert.ok(search?.inputSchema?.properties?.query);
    const result = await mcp.call(
      'workbench_mcp_call',
      { server: server.id, tool: search.name, arguments: { query: 'Responses API', limit: 1 } },
      context,
    );
    assert.notEqual(result.isError, true, result.text);
    assert.match(result.text, /openai.com|developers.openai/);
    assert.ok(result.text.length > 100);
    console.log(
      JSON.stringify({
        server: server.name,
        status: mcp.state().servers.find((item) => item.id === server.id)?.status,
        tools: catalog.tools.length,
        responseCharacters: result.text.length,
        modelTurns: 0,
      }),
    );
  },
);
