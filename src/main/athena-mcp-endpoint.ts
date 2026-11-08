import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface AthenaMcpState {
  workspace: { path: string; mode: 'project' | 'personal' };
  conversations: Array<{ id: string; title: string; status: string; agent?: string; model?: string }>;
  providers: Array<{ id: string; available: boolean; authenticated: boolean }>;
  capabilities: string[];
}

import { canAccess, type AccessMode, type ConfigurationKind } from '../shared/access';
export interface ExternalThreadInput { text: string; agent?: string; workspace?: string; model?: string; }
export interface ExternalThreadRef { conversationId: string; agentSessionId?: string; }
export interface ThreadController {
  start(input: ExternalThreadInput): Promise<ExternalThreadRef>;
  send(thread: ExternalThreadRef, text: string): Promise<void>;
  stop(thread: ExternalThreadRef): Promise<void>;
}
export interface ConfigurationController {
  read(kind: ConfigurationKind): Promise<unknown> | unknown;
  write(kind: ConfigurationKind, value: unknown): Promise<unknown> | unknown;
}
interface ConnectionRequest { id: string; token: string; agent: { id: string; name: string }; requestedMode: AccessMode; status: 'pending' | 'approved' | 'rejected' | 'revoked'; mode?: AccessMode; }
interface Thread { id: string; ownerConnectionId: string; ref: ExternalThreadRef; status: 'running' | 'idle' | 'stopped' | 'failed' | 'unknown-result'; queue: string[]; busy: boolean; generation: number; }
export interface PendingConnection {
  id: string;
  agent: { id: string; name: string };
  requestedMode: AccessMode;
  status: ConnectionRequest['status'];
  mode?: AccessMode;
}
export interface AthenaMcpEndpoint {
  readonly url: string;
  start(): Promise<void>; stop(): Promise<void>;
  connections(): PendingConnection[];
  approve(id: string): Promise<{ id: string; mode: AccessMode }>;
  reject(id: string): Promise<{ id: string; rejected: true }>;
  revoke(id: string): Promise<{ id: string; revoked: true }>;
}
function json(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
async function body(request: IncomingMessage): Promise<unknown> { let data = ''; for await (const chunk of request) data += chunk; if (data.length > 64 * 1024) throw new Error('request too large'); return JSON.parse(data || '{}'); }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 60_000) throw new Error('invalid text'); return value; }
export function createAthenaMcpEndpoint(options: { getState: () => AthenaMcpState; threads?: ThreadController; configuration?: ConfigurationController; onConnections?: (connections: PendingConnection[]) => void }): AthenaMcpEndpoint {
  const connections = new Map<string, ConnectionRequest>(); const threads = new Map<string, Thread>(); let server: Server | undefined; let address = '';
  function authorized(request: IncomingMessage, operation = 'state.read') { const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/)?.[1]; const connection = [...connections.values()].find((item) => item.token === token && item.status === 'approved'); if (!connection) throw Object.assign(new Error('approval_required'), { status: 401 }); if (!connection.mode || !canAccess(connection.mode, operation)) throw Object.assign(new Error('access_denied'), { status: 403 }); return connection; }
  async function drain(thread: Thread) { if (thread.busy || !thread.queue.length || !options.threads || thread.status === 'stopped') return; const generation = thread.generation; const next = thread.queue.shift()!; thread.busy = true; thread.status = 'running'; try { await options.threads.send(thread.ref, next); if (thread.generation === generation && thread.status !== 'stopped') thread.status = 'idle'; } catch { if (thread.generation === generation && thread.status !== 'stopped') thread.status = 'failed'; } finally { if (thread.generation !== generation || thread.status === 'stopped') return; thread.busy = false; if (thread.queue.length && thread.status === 'idle') void drain(thread); } }
  const endpoint: AthenaMcpEndpoint = {
    get url() { return address; },
    connections() {
      return [...connections.values()].map(({ token: _token, ...connection }) => ({ ...connection }));
    },
    async start() { if (server) return; server = createServer(async (request, response) => { try { const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname === '/api/v1/connections') { const value = await body(request) as any; if (!value.agent || typeof value.agent.id !== 'string' || typeof value.agent.name !== 'string' || !['read-only', 'supervised', 'full'].includes(value.requestedMode)) { json(response, 400, { error: 'invalid_connection_request' }); return; } const connection: ConnectionRequest = { id: randomUUID(), token: randomBytes(32).toString('hex'), agent: { id: value.agent.id, name: value.agent.name }, requestedMode: value.requestedMode, status: 'pending' }; connections.set(connection.id, connection); options.onConnections?.(endpoint.connections()); json(response, 202, { id: connection.id, token: connection.token, request: { agent: connection.agent, requestedMode: connection.requestedMode, status: connection.status } }); return; }
      if (request.method === 'GET' && url.pathname === '/api/v1/state') { const connection = authorized(request, 'state.read'); json(response, 200, { ...options.getState(), accessMode: connection.mode }); return; }
      if (url.pathname === '/api/v1/configuration' || url.pathname.startsWith('/api/v1/configuration/')) { const kind = url.pathname.slice('/api/v1/configuration/'.length) as ConfigurationKind; if (!['skills', 'mcp', 'agents', 'workspace'].includes(kind)) { json(response, 404, { error: 'configuration_not_found' }); return; } if (request.method === 'GET') { authorized(request, 'configuration.read'); if (!options.configuration) { json(response, 501, { error: 'configuration_unavailable' }); return; } json(response, 200, { kind, value: await options.configuration.read(kind) }); return; } if (request.method === 'PUT') { authorized(request, 'configuration.write'); if (!options.configuration) { json(response, 501, { error: 'configuration_unavailable' }); return; } const value = await body(request); json(response, 200, { kind, value: await options.configuration.write(kind, value) }); return; } json(response, 405, { error: 'method_not_allowed' }); return; }
      if (url.pathname === '/api/v1/threads' || url.pathname.startsWith('/api/v1/threads/')) { const routeMatch = url.pathname.match(/^\/api\/v1\/threads\/([^/]+)(?:\/(messages|stop))?$/); const connection = authorized(request, request.method === 'GET' ? 'thread.read' : routeMatch?.[2] === 'stop' ? 'thread.stop' : routeMatch?.[2] === 'messages' ? 'thread.send' : 'thread.start'); if (!options.threads) { json(response, 501, { error: 'thread_control_unavailable' }); return; }
        if (request.method === 'POST' && url.pathname === '/api/v1/threads') { const input = await body(request) as any; const value: ExternalThreadInput = { text: text(input.text), agent: input.agent, workspace: input.workspace, model: input.model }; const ref = await options.threads.start(value); const thread: Thread = { id: randomUUID(), ownerConnectionId: connection.id, ref, status: 'running', queue: [value.text], busy: false, generation: 0 }; threads.set(thread.id, thread); void drain(thread); json(response, 201, { id: thread.id, ...ref, status: thread.status, accessMode: connection.mode }); return; }
        const thread = routeMatch && threads.get(routeMatch[1]); if (!thread) { json(response, 404, { error: 'thread_not_found' }); return; } if (thread.ownerConnectionId !== connection.id) { json(response, 403, { error: 'thread_ownership_mismatch' }); return; }
        if (request.method === 'GET') { json(response, 200, { id: thread.id, conversationId: thread.ref.conversationId, agentSessionId: thread.ref.agentSessionId, status: thread.status, queueLength: thread.queue.length }); return; }
        if (request.method === 'POST' && routeMatch![2] === 'messages') { if (thread.status === 'stopped') { json(response, 410, { error: 'thread_gone' }); return; } if (thread.status === 'unknown-result') { json(response, 409, { error: 'thread_stop_unknown' }); return; } if (thread.status === 'failed') { json(response, 409, { error: 'thread_not_accepting_messages' }); return; } const value = await body(request) as any; thread.queue.push(text(value.text)); const position = thread.queue.length; void drain(thread); json(response, 202, { queued: true, position }); return; }
        if (request.method === 'POST' && routeMatch![2] === 'stop') { thread.generation += 1; thread.queue.length = 0; thread.busy = false; try { await options.threads.stop(thread.ref); thread.status = 'stopped'; json(response, 200, { stopped: true }); } catch (error) { thread.status = 'unknown-result'; throw Object.assign(error instanceof Error ? error : new Error('thread_stop_failed'), { status: 502 }); } return; }
      }
      json(response, 404, { error: 'not_found' });
    } catch (error) { json(response, (error as any).status ?? 400, { error: error instanceof Error ? error.message : 'malformed_request' }); } }); await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); }); const info = server.address() as { port: number }; address = `http://127.0.0.1:${info.port}`; },
    async stop() { if (!server) return; await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; address = ''; },
    async approve(id) { const connection = connections.get(id); if (!connection || connection.status !== 'pending') throw new Error('connection is not pending'); connection.status = 'approved'; connection.mode = connection.requestedMode; options.onConnections?.(endpoint.connections()); return { id, mode: connection.mode }; },
    async reject(id) { const connection = connections.get(id); if (!connection || connection.status !== 'pending') throw new Error('connection is not pending'); connection.status = 'rejected'; options.onConnections?.(endpoint.connections()); return { id, rejected: true }; },
    async revoke(id) { const connection = connections.get(id); if (!connection || connection.status !== 'approved') throw new Error('connection is not approved'); connection.status = 'revoked'; options.onConnections?.(endpoint.connections()); return { id, revoked: true }; },
  }; return endpoint;
}
