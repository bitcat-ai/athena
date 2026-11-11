const tools = JSON.parse(process.env.WORKBENCH_MCP_TOOLS || '[]');
const endpoint = process.env.WORKBENCH_MCP_URL;
const token = process.env.WORKBENCH_MCP_TOKEN;
const protocolVersion = '2025-03-26';
let input = '';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function callTool(id, name, args) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id: String(id), name, arguments: args }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!response.ok) throw new Error('Host tool request rejected');
  const result = await response.json();
  const content = [{ type: 'text', text: typeof result.text === 'string' ? result.text : '' }];
  for (const value of result.images ?? []) {
    const match =
      typeof value === 'string' &&
      value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (match) content.push({ type: 'image', mimeType: match[1], data: match[2] });
  }
  return {
    content,
    isError: result.isError === true,
  };
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || !('id' in message)) return;
  try {
    let result;
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params?.protocolVersion || protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'athena', version: '1.0.0' },
      };
    } else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') {
      result = {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      };
    } else if (message.method === 'tools/call') {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (!tools.some((tool) => tool.name === name)) throw new Error('tool unavailable');
      result = await callTool(message.id, name, args);
    } else {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      });
      return;
    }
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'Athena 宿主工具调用失败' }], isError: true },
    });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > 2 * 1024 * 1024) process.exit(1);
  let index;
  while ((index = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, index).replace(/\r$/, '');
    input = input.slice(index + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      process.exit(1);
    }
  }
});
