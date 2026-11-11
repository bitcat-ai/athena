// 由 Athena 显式加载，不依赖应用的 node_modules 或 Pi 内置 MCP 扩展。
export default function athenaPermissions(pi) {
  const raw = process.env.WORKBENCH_ATHENA_TOOLS;
  const configuration = raw ? JSON.parse(raw) : undefined;
  const hostTools = new Set();
  if (configuration) {
    if (
      !Array.isArray(configuration.tools) ||
      typeof configuration.url !== 'string' ||
      typeof configuration.token !== 'string'
    )
      throw new Error('Athena 宿主工具配置无效');
    for (const tool of configuration.tools) {
      hostTools.add(tool.name);
      pi.registerTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        async execute(id, args, signal) {
          const response = await fetch(configuration.url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${configuration.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ id, name: tool.name, arguments: args }),
            signal,
          });
          if (!response.ok) throw new Error('Athena 宿主工具请求被拒绝');
          const result = await response.json();
          if (result.isError) throw new Error(result.text || 'Athena 宿主工具调用失败');
          const content = [{ type: 'text', text: result.text }];
          for (const value of result.images ?? []) {
            const match =
              typeof value === 'string' &&
              value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
            if (match) content.push({ type: 'image', mimeType: match[1], data: match[2] });
          }
          return { content, details: {} };
        },
      });
    }
  }
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'rpc') throw new Error('Athena requires Pi RPC mode');
    if (hostTools.size && [...hostTools].some((name) => !pi.getActiveTools().includes(name)))
      throw new Error('Athena 宿主工具未激活');
    ctx.ui.notify('athena-permissions-v1', 'info');
  });
  pi.on('tool_call', async (event, ctx) => {
    if (ctx.mode !== 'rpc' || !ctx.hasUI || ctx.signal?.aborted)
      return { block: true, reason: 'Athena authorization is unavailable' };
    if (hostTools.has(event.toolName)) return;
    // 本地工具逐次确认，包含工作区外的读取；不持久化“总是允许”。
    const detail = JSON.stringify(event.input);
    if (typeof detail !== 'string' || detail.length > 16000)
      return { block: true, reason: 'Tool arguments exceed the reviewable approval limit' };
    const approved = await ctx.ui.confirm(`Pi · ${event.toolName}`, detail, { signal: ctx.signal });
    if (!approved || ctx.signal?.aborted)
      return { block: true, reason: 'This operation was not approved in Athena' };
  });
}
