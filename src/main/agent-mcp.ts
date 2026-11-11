import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { BrowserTool, ToolCall, ToolResult } from '../shared/types';
import { imageUrl, toolEventInput } from './agents';

// The CLI owns a stdio child; the capability never enters the prompt or project configuration.
const bridge = String.raw`
const readline = require('node:readline');
const client = require('node:crypto').randomUUID();
const pending = new Set();
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async line => {
  let message;
  const abort = new AbortController(); pending.add(abort);
  try {
    message = JSON.parse(line);
    const response = await fetch(process.env.ATHENA_MCP_URL, {
      method: 'POST', headers: { 'content-type': 'application/json',
        authorization: 'Bearer ' + process.env.ATHENA_MCP_TOKEN, 'x-athena-client': client },
      body: line, signal: abort.signal
    });
    if (message.id === undefined) return;
    if (!response.ok) throw new Error('MCP bridge unavailable');
    process.stdout.write(JSON.stringify(await response.json()) + '\n');
  } catch {
    if (message && message.id !== undefined) process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: message.id, error: {code: -32603, message: 'Athena tool connection unavailable'}
    }) + '\n');
  } finally { pending.delete(abort); }
});
lines.on('close', () => { for (const abort of pending) abort.abort(); });
`;

/** Private MCP transport into the same task-scoped tools as Codex. */
export class AgentMcpServer {
  private server?: Server;
  private token = randomBytes(32).toString('hex');
  private url?: string;
  private closed = false;
  private requests = new Set<string>();
  private pending = 0;
  private activeCalls = new Map<string, ToolCall>();
  constructor(
    private tools: BrowserTool[],
    private call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
    private onTool: (call: ToolCall) => void,
  ) {}
  get pendingCalls() {
    return this.pending;
  }

  async start() {
    if (this.server || this.closed) throw new Error('浏览器工具连接不能重复启动');
    this.server = createServer(async (req, res) => {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${this.token}`);
      const client = req.headers['x-athena-client'];
      if (
        this.closed ||
        req.method !== 'POST' ||
        req.url !== '/' ||
        req.headers.origin ||
        typeof client !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(client) ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        res.writeHead(403).end();
        return;
      }
      let id: unknown = null;
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        const message = JSON.parse(Buffer.concat(chunks).toString());
        if (!message || Array.isArray(message) || message.jsonrpc !== '2.0') throw new Error();
        id = message.id;
        if (id === undefined) {
          res.writeHead(204).end();
          return;
        }
        if (!((typeof id === 'string' && id.length <= 256) || Number.isSafeInteger(id)))
          throw new Error();
        let result: unknown;
        if (message.method === 'initialize')
          result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'athena', version: '1.0.0' },
          };
        else if (message.method === 'ping') result = {};
        else if (message.method === 'tools/list') result = { tools: this.tools };
        else if (message.method === 'tools/call') {
          const key = JSON.stringify([client, id]);
          if (this.requests.has(key) || this.requests.size >= 20000) throw new Error();
          const { name, arguments: args = {} } = message.params ?? {};
          if (
            !this.tools.some((tool) => tool.name === name) ||
            !args ||
            typeof args !== 'object' ||
            Array.isArray(args)
          )
            throw new Error();
          this.requests.add(key);
          this.pending++;
          const startedAt = Date.now();
          const event: ToolCall = {
            id: randomUUID(),
            name,
            input: toolEventInput(name, args),
            status: 'running',
            startedAt,
          };
          this.activeCalls.set(event.id, event);
          this.onTool({ ...event });
          try {
            const output = await this.call(name, args);
            if (this.closed || !this.activeCalls.has(event.id)) throw new Error();
            const content: unknown[] = [{ type: 'text', text: output.text }];
            for (const raw of [...(output.image ? [output.image] : []), ...(output.images ?? [])]) {
              const match = imageUrl(raw)?.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
              if (match) content.push({ type: 'image', mimeType: match[1], data: match[2] });
            }
            result = { content, isError: output.isError ?? false };
            this.activeCalls.delete(event.id);
            this.onTool({
              ...event,
              status: output.isError ? 'error' : 'done',
              output: output.text.slice(0, 8000),
              durationMs: Date.now() - startedAt,
            });
          } catch {
            if (this.activeCalls.delete(event.id))
              this.onTool({
                ...event,
                status: 'error',
                output: '浏览器操作未完成，请重新观察页面后继续。',
                durationMs: Date.now() - startedAt,
              });
            throw new Error();
          } finally {
            this.pending--;
          }
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: 'Method not supported' },
            }),
          );
          return;
        }
        if (!res.destroyed)
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      } catch {
        if (!res.destroyed)
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: 'Athena rejected tool request' },
            }),
          );
      }
    });
    this.server.requestTimeout = 30000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    if (this.closed) {
      this.server.close();
      throw new Error('浏览器工具连接已关闭');
    }
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('无法启动工具连接');
    this.url = `http://127.0.0.1:${address.port}/`;
  }
  definition() {
    if (!this.url || this.closed) throw new Error('工具连接尚未启动');
    return {
      command: process.execPath,
      args: ['-e', bridge],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        ATHENA_MCP_URL: this.url,
        ATHENA_MCP_TOKEN: this.token,
      },
    };
  }
  cancelPending() {
    const calls = [...this.activeCalls.values()];
    this.activeCalls.clear();
    for (const call of calls)
      this.onTool({
        ...call,
        status: 'error',
        output: '任务已停止，操作结果需重新核对。',
        durationMs: Date.now() - (call.startedAt ?? Date.now()),
      });
  }
  close() {
    this.closed = true;
    this.token = randomUUID();
    this.cancelPending();
    this.server?.closeAllConnections();
    if (this.server?.listening) this.server.close();
  }
}
