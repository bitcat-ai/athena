import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface AthenaMcpState {
  workspace: { path: string; mode: 'project' | 'personal' };
  conversations: Array<{ id: string; title: string; status: string; agent?: string; model?: string }>;
  providers: Array<{ id: string; available: boolean; authenticated: boolean }>;
  capabilities: string[];
}

type AccessMode = 'read-only' | 'supervised' | 'full';
export interface ExternalThreadInput { text: string; agent?: string; workspace?: string; model?: string; }
export interface ExternalThreadRef { conversationId: string; agentSessionId?: string; }
export interface ThreadController {
  start(input: ExternalThreadInput): Promise<ExternalThreadRef>;
  send(thread: ExternalThreadRef, text: string): Promise<void>;
  stop(thread: ExternalThreadRef): Promise<void>;
}
interface ConnectionRequest { id: string; token: string; agent: { id: string; name: string }; requestedMode: AccessMode; status: 'pending' | 'approved' | 'rejected' | 'revoked'; mode?: AccessMode; }
interface Thread { id: string; ref: ExternalThreadRef; status: 'running' | 'idle' | 'stopped' | 'failed' | 'unknown-result'; queue: string[]; busy: boolean; }
export interface AthenaMcpEndpoint {
  readonly url: string;
  start(): Promise<void>; stop(): Promise<void>;
  approve(id: string): Promise<{ id: string; mode: AccessMode }>;
  reject(id: string): Promise<{ id: string; rejected: true }>;
  revoke(id: string): Promise<{ id: string; revoked: true }>;
}
function json(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
async function body(request: IncomingMessage): Promise<unknown> { let data = ''; for await (const chunk of request) data += chunk; if (data.length > 64 * 1024) throw new Error('request too large'); return JSON.parse(data || '{}'); }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 60_000) throw new Error('invalid text'); return value; }
export function createAthenaMcpEndpoint(options: { getState: () => AthenaMcpState; threads?: ThreadController }): AthenaMcpEndpoint {
  const connections = new Map<string, ConnectionRequest>(); const threads = new Map<string, Thread>(); let server: Server | undefined; let address = '';
  function authorized(request: IncomingMessage, write = false) { const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/)?.[1]; const connection = [...connections.values()].find((item) => item.token === token && item.status === 'approved'); if (!connection) throw Object.assign(new Error('approval_required'), { status: 401 }); if (write && connection.mode === 'read-only') throw Object.assign(new Error('access_denied'), { status: 403 }); return connection; }
  async function drain(thread: Thread) { if (thread.busy || !thread.queue.length || !options.threads) return; const next = thread.queue.shift()!; thread.busy = true; thread.status = 'running'; try { await options.threads.send(thread.ref, next); thread.status = 'idle'; } catch { thread.status = 'failed'; } finally { thread.busy = false; if (thread.queue.length && thread.status === 'idle') void drain(thread); } }
  const endpoint: AthenaMcpEndpoint = {
    get url() { return address; },
    async start() { if (server) return; server = createServer(async (request, response) => { try { const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname === '/api/v1/connections') { const value = await body(request) as any; if (!value.agent || typeof value.agent.id !== 'string' || typeof value.agent.name !== 'string' || !['read-only', 'supervised', 'full'].includes(value.requestedMode)) { json(response, 400, { error: 'invalid_connection_request' }); return; } const connection: ConnectionRequest = { id: randomUUID(), token: randomBytes(32).toString('hex'), agent: { id: value.agent.id, name: value.agent.name }, requestedMode: value.requestedMode, status: 'pending' }; connections.set(connection.id, connection); json(response, 202, { id: connection.id, token: connection.token, request: { agent: connection.agent, requestedMode: connection.requestedMode, status: connection.status } }); return; }
      if (request.method === 'GET' && url.pathname === '/api/v1/state') { const connection = authorized(request); json(response, 200, { ...options.getState(), accessMode: connection.mode }); return; }
      if (url.pathname === '/api/v1/threads' || url.pathname.startsWith('/api/v1/threads/')) { const connection = authorized(request, request.method !== 'GET'); if (!options.threads) { json(response, 501, { error: 'thread_control_unavailable' }); return; }
        if (request.method === 'POST' && url.pathname === '/api/v1/threads') { const input = await body(request) as any; const value: ExternalThreadInput = { text: text(input.text), agent: input.agent, workspace: input.workspace, model: input.model }; const ref = await options.threads.start(value); const thread: Thread = { id: randomUUID(), ref, status: 'running', queue: [], busy: true }; threads.set(thread.id, thread); void Promise.resolve().then(() => { thread.busy = false; thread.status = 'idle'; void drain(thread); }); json(response, 201, { id: thread.id, ...ref, status: thread.status, accessMode: connection.mode }); return; }
        const match = url.pathname.match(/^\/api\/v1\/threads\/([^/]+)(?:\/(messages|stop))?$/); const thread = match && threads.get(match[1]); if (!thread) { json(response, 404, { error: 'thread_not_found' }); return; }
        if (request.method === 'GET') { json(response, 200, { id: thread.id, conversationId: thread.ref.conversationId, agentSessionId: thread.ref.agentSessionId, status: thread.status, queueLength: thread.queue.length }); return; }
        if (request.method === 'POST' && match[2] === 'messages') { const value = await body(request) as any; thread.queue.push(text(value.text)); const position = thread.queue.length; void drain(thread); json(response, 202, { queued: true, position }); return; }
        if (request.method === 'POST' && match[2] === 'stop') { thread.status = 'stopped'; thread.queue.length = 0; thread.busy = false; await options.threads.stop(thread.ref); json(response, 200, { stopped: true }); return; }
      }
      json(response, 404, { error: 'not_found' });
    } catch (error) { json(response, (error as any).status ?? 400, { error: error instanceof Error ? error.message : 'malformed_request' }); } }); await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); }); const info = server.address() as { port: number }; address = `http://127.0.0.1:${info.port}`; },
    async stop() { if (!server) return; await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; address = ''; },
    async approve(id) { const connection = connections.get(id); if (!connection || connection.status !== 'pending') throw new Error('connection is not pending'); connection.status = 'approved'; connection.mode = connection.requestedMode; return { id, mode: connection.mode }; },
    async reject(id) { const connection = connections.get(id); if (!connection || connection.status !== 'pending') throw new Error('connection is not pending'); connection.status = 'rejected'; return { id, rejected: true }; },
    async revoke(id) { const connection = connections.get(id); if (!connection || connection.status !== 'approved') throw new Error('connection is not approved'); connection.status = 'revoked'; return { id, revoked: true }; },
  }; return endpoint;
}
