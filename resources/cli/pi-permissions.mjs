// Loaded explicitly by Athena; no dependency on the app's node_modules.
export default async function athenaPermissions(pi) {
  const browserTools = new Set();
  if (process.env.ATHENA_MCP_URL || process.env.ATHENA_MCP_TOKEN) {
    const url = new URL(process.env.ATHENA_MCP_URL);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !process.env.ATHENA_MCP_TOKEN)
      throw new Error('Invalid Athena browser connection');
    const client = crypto.randomUUID();
    let sequence = 0;
    const request = async (method, params, signal) => {
      const response = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.ATHENA_MCP_TOKEN}`,
          'x-athena-client': client,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }),
      });
      if (!response.ok) throw new Error('Athena browser connection unavailable');
      const message = await response.json();
      if (message.error) throw new Error('Athena rejected this browser operation');
      return message.result;
    };
    const result = await request('tools/list', undefined, AbortSignal.timeout(10000));
    if (!Array.isArray(result?.tools)) throw new Error('Athena browser tools unavailable');
    for (const tool of result.tools) {
      browserTools.add(tool.name);
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: async (_id, args, signal) => {
          const result = await request('tools/call', { name: tool.name, arguments: args }, signal);
          if (result.isError)
            throw new Error(
              result.content
                .filter((item) => item.type === 'text')
                .map((item) => item.text)
                .join('\n'),
            );
          return { content: result.content, details: {} };
        },
      });
    }
  }
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'rpc') throw new Error('Athena requires Pi RPC mode');
    ctx.ui.notify('athena-permissions-v1', 'info');
    if (browserTools.size) ctx.ui.notify('athena-browser-tools-v1', 'info');
  });
  pi.on('tool_call', async (event, ctx) => {
    // Every native operation is user-approved, including reads outside the workspace.
    // No pattern-based dangerous-command heuristic and no persistent "always allow".
    if (ctx.mode !== 'rpc' || !ctx.hasUI || ctx.signal?.aborted)
      return { block: true, reason: 'Athena authorization is unavailable' };
    // Neo's host owns page scope, approvals and cancellation for these exact registered tools.
    if (browserTools.has(event.toolName)) return;
    const detail = JSON.stringify(event.input);
    if (typeof detail !== 'string' || detail.length > 16000)
      return { block: true, reason: 'Tool arguments exceed the reviewable approval limit' };
    const approved = await ctx.ui.confirm(`Pi · ${event.toolName}`, detail, { signal: ctx.signal });
    if (!approved || ctx.signal?.aborted)
      return { block: true, reason: 'This operation was not approved in Athena' };
  });
}
