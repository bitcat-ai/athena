import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgentEvent, BrowserTool, ToolResult } from '../shared/types';

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > 2 * 1024 * 1024) throw new Error('MCP 请求超过大小限制');
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function respond(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

export class HostToolBridge {
  private server?: Server;
  private token = randomBytes(32).toString('hex');
  private controllers = new Set<AbortController>();
  private tools = new Map<string, BrowserTool>();
  private calls = new Set<string>();
  private closed = false;

  constructor(
    tools: BrowserTool[],
    private callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
    private onTool?: (event: AgentEvent) => void,
  ) {
    for (const tool of tools) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(tool.name) || this.tools.has(tool.name))
        throw new Error('宿主工具名称无效或重复');
      this.tools.set(tool.name, structuredClone(tool));
    }
  }

  async start(): Promise<{ url: string; token: string }> {
    if (this.server || this.closed) throw new Error('宿主工具桥已经启动或关闭');
    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (this.closed) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error('宿主工具桥已关闭');
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      await this.close();
      throw new Error('宿主工具桥没有本机端口');
    }
    return { url: `http://127.0.0.1:${address.port}/call`, token: this.token };
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    if (
      request.method !== 'POST' ||
      request.url !== '/call' ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')
    ) {
      respond(response, 404, { error: 'not found' });
      return;
    }
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      respond(response, 401, { error: 'unauthorized' });
      return;
    }
    let input: unknown;
    try {
      input = await body(request);
    } catch {
      respond(response, 400, { error: 'invalid request' });
      return;
    }
    if (this.closed) {
      respond(response, 410, { error: 'bridge closed' });
      return;
    }
    if (
      !object(input) ||
      typeof input.id !== 'string' ||
      !input.id.length ||
      input.id.length > 256 ||
      typeof input.name !== 'string' ||
      !object(input.arguments)
    ) {
      respond(response, 400, { error: 'invalid tool request' });
      return;
    }
    const tool = this.tools.get(input.name);
    if (!tool) {
      respond(response, 403, { error: 'tool unavailable' });
      return;
    }
    if (this.calls.has(input.id) || this.calls.size >= 10_000) {
      respond(response, 409, { error: 'duplicate or excessive tool request' });
      return;
    }
    this.calls.add(input.id);
    const controller = new AbortController();
    this.controllers.add(controller);
    response.once('close', () => {
      if (!response.writableEnded) controller.abort();
    });
    const id = `host:${randomBytes(12).toString('hex')}`;
    const call = {
      id,
      name: tool.name,
      input: input.arguments,
      status: 'running' as const,
    };
    try {
      this.onTool?.({ type: 'tool', call });
      const result = await this.callTool(tool.name, input.arguments);
      if (!this.closed)
        this.onTool?.({
          type: 'tool',
          call: { ...call, status: result.isError ? 'error' : 'done' },
        });
      if (!controller.signal.aborted)
        respond(response, 200, {
          text: result.text.slice(0, 1_000_000),
          images: [...(result.image ? [result.image] : []), ...(result.images ?? [])],
          isError: result.isError === true,
        });
    } catch {
      if (!this.closed) this.onTool?.({ type: 'tool', call: { ...call, status: 'error' } });
      if (!controller.signal.aborted)
        respond(response, 200, { text: '宿主工具调用失败', isError: true });
    } finally {
      this.controllers.delete(controller);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    const server = this.server;
    this.server = undefined;
    this.token = '';
    if (server?.listening) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
  }
}
