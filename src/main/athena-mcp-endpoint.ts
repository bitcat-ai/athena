import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface AthenaMcpState {
  workspace: { path: string; mode: 'project' | 'personal' };
  conversations: Array<{ id: string; title: string; status: string; agent?: string; model?: string }>;
  providers: Array<{ id: string; available: boolean }>;
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
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PENDING_CONNECTIONS = 8;
const MAX_THREADS = 64;
const MAX_QUEUED_MESSAGES = 32;
const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
// A JSON content type keeps a web page from posting here without a CORS preflight. The limit is enforced while reading.
async function body(request: IncomingMessage): Promise<unknown> { if (!/^application\/json\b/i.test(request.headers['content-type'] ?? '')) throw failure('unsupported_media_type', 415); const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY_BYTES) throw failure('request_too_large', 413); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
// The agent adapters take at most 20000 characters per message.
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw new Error('invalid text'); return value; }
// Shown on the approval card: one short line, without control characters.
function label(value: unknown): string | undefined { if (typeof value !== 'string') return undefined; const clean = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim(); return clean && clean.length <= 80 ? clean : undefined; }
export function createAthenaMcpEndpoint(options: { getState: () => AthenaMcpState; threads?: ThreadController; configuration?: ConfigurationController; onConnections?: (connections: PendingConnection[]) => void }): AthenaMcpEndpoint {
  const connections = new Map<string, ConnectionRequest>(); const threads = new Map<string, Thread>(); let server: Server | undefined; let address = ''; let port = 0;
  // Starts and turns run one at a time. A stop never waits in this queue: it must reach the turn that is still running.
  let taskQueue = Promise.resolve();
  function schedule<T>(operation: () => Promise<T>): Promise<T> {
    const result = taskQueue.then(operation, operation);
    taskQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  // Stops what a thread is doing and whatever it still has queued. The status is set first: nothing may start while the stop is awaited.
  async function halt(thread: Thread) { thread.generation += 1; thread.queue.length = 0; thread.busy = false; thread.status = 'stopped'; try { await options.threads!.stop(thread.ref); } catch (error) { thread.status = 'unknown-result'; throw error; } }
  function authorized(request: IncomingMessage, operation = 'state.read') { const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/)?.[1]; const connection = [...connections.values()].find((item) => item.token === token && item.status === 'approved'); if (!connection) throw Object.assign(new Error('approval_required'), { status: 401 }); if (!connection.mode || !canAccess(connection.mode, operation)) throw Object.assign(new Error('access_denied'), { status: 403 }); return connection; }
  async function drain(thread: Thread) { if (thread.busy || !thread.queue.length || !options.threads || thread.status === 'stopped') return; const generation = thread.generation; const next = thread.queue.shift()!; thread.busy = true; thread.status = 'running'; try { await schedule(async () => { if (thread.generation === generation) await options.threads!.send(thread.ref, next); }); if (thread.generation === generation) thread.status = 'idle'; } catch { if (thread.generation === generation) thread.status = 'failed'; } finally { if (thread.generation !== generation) return; thread.busy = false; if (thread.queue.length && thread.status === 'idle') void drain(thread); } }
  const endpoint: AthenaMcpEndpoint = {
    get url() { return address; },
    connections() {
      return [...connections.values()].map(({ token: _token, ...connection }) => ({ ...connection }));
    },
    async start() { if (server) return; server = createServer(async (request, response) => { try { const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      // Only local programs connect here. A browser sends Origin on a cross-site request, and a rebound DNS name shows up in Host.
      if (request.headers.origin !== undefined || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host ?? '')) { json(response, 403, { error: 'forbidden_origin' }); return; }
      if (request.method === 'POST' && url.pathname === '/api/v1/connections') { const value = await body(request) as any; const id = label(value.agent?.id); const name = label(value.agent?.name); if (!id || !name || !['read-only', 'supervised', 'full'].includes(value.requestedMode)) { json(response, 400, { error: 'invalid_connection_request' }); return; } if ([...connections.values()].filter((item) => item.status === 'pending').length >= MAX_PENDING_CONNECTIONS) { json(response, 429, { error: 'too_many_pending_connections' }); return; } const connection: ConnectionRequest = { id: randomUUID(), token: randomBytes(32).toString('hex'), agent: { id, name }, requestedMode: value.requestedMode, status: 'pending' }; connections.set(connection.id, connection); options.onConnections?.(endpoint.connections()); json(response, 202, { id: connection.id, token: connection.token, request: { agent: connection.agent, requestedMode: connection.requestedMode, status: connection.status } }); return; }
      if (request.method === 'GET' && url.pathname === '/api/v1/state') { const connection = authorized(request, 'state.read'); json(response, 200, { ...options.getState(), accessMode: connection.mode }); return; }
      if (url.pathname === '/api/v1/configuration' || url.pathname.startsWith('/api/v1/configuration/')) { const kind = url.pathname.slice('/api/v1/configuration/'.length) as ConfigurationKind; if (!['skills', 'mcp', 'agents', 'workspace'].includes(kind)) { json(response, 404, { error: 'configuration_not_found' }); return; } if (request.method === 'GET') { authorized(request, 'configuration.read'); if (!options.configuration) { json(response, 501, { error: 'configuration_unavailable' }); return; } json(response, 200, { kind, value: await options.configuration.read(kind) }); return; } if (request.method === 'PUT') { authorized(request, 'configuration.write'); if (!options.configuration) { json(response, 501, { error: 'configuration_unavailable' }); return; } const value = await body(request); json(response, 200, { kind, value: await options.configuration.write(kind, value) }); return; } json(response, 405, { error: 'method_not_allowed' }); return; }
      if (url.pathname === '/api/v1/threads' || url.pathname.startsWith('/api/v1/threads/')) { const routeMatch = url.pathname.match(/^\/api\/v1\/threads\/([^/]+)(?:\/(messages|stop))?$/); const connection = authorized(request, request.method === 'GET' ? 'thread.read' : routeMatch?.[2] === 'stop' ? 'thread.stop' : routeMatch?.[2] === 'messages' ? 'thread.send' : 'thread.start'); if (!options.threads) { json(response, 501, { error: 'thread_control_unavailable' }); return; }
        if (request.method === 'POST' && url.pathname === '/api/v1/threads') { const input = await body(request) as any; const value: ExternalThreadInput = { text: text(input.text), agent: input.agent, workspace: input.workspace, model: input.model }; if (threads.size >= MAX_THREADS) { const ended = [...threads.values()].find((item) => !item.busy && !item.queue.length && item.status !== 'running'); if (!ended) { json(response, 429, { error: 'too_many_threads' }); return; } threads.delete(ended.id); } const ref = await schedule(() => options.threads!.start(value)); const thread: Thread = { id: randomUUID(), ownerConnectionId: connection.id, ref, status: 'running', queue: [value.text], busy: false, generation: 0 }; threads.set(thread.id, thread); void drain(thread); json(response, 201, { id: thread.id, ...ref, status: thread.status, accessMode: connection.mode }); return; }
        const thread = routeMatch && threads.get(routeMatch[1]); if (!thread) { json(response, 404, { error: 'thread_not_found' }); return; } if (thread.ownerConnectionId !== connection.id) { json(response, 403, { error: 'thread_ownership_mismatch' }); return; }
        if (request.method === 'GET') { json(response, 200, { id: thread.id, conversationId: thread.ref.conversationId, agentSessionId: thread.ref.agentSessionId, status: thread.status, queueLength: thread.queue.length }); return; }
        if (request.method === 'POST' && routeMatch![2] === 'messages') { if (thread.status === 'stopped') { json(response, 410, { error: 'thread_gone' }); return; } if (thread.status === 'unknown-result') { json(response, 409, { error: 'thread_stop_unknown' }); return; } if (thread.status === 'failed') { json(response, 409, { error: 'thread_not_accepting_messages' }); return; } const value = await body(request) as any; const message = text(value.text); if (thread.queue.length >= MAX_QUEUED_MESSAGES) { json(response, 429, { error: 'thread_queue_full' }); return; } thread.queue.push(message); const position = thread.queue.length; void drain(thread); json(response, 202, { queued: true, position }); return; }
        if (request.method === 'POST' && routeMatch![2] === 'stop') { try { await halt(thread); json(response, 200, { stopped: true }); } catch (error) { throw Object.assign(error instanceof Error ? error : new Error('thread_stop_failed'), { status: 502 }); } return; }
      }
      json(response, 404, { error: 'not_found' });
    } catch (error) { const status = (error as any).status ?? 400; if (status === 413) response.setHeader('connection', 'close'); json(response, status, { error: error instanceof Error ? error.message : 'malformed_request' }); } }); await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); }); port = (server.address() as { port: number }).port; address = `http://127.0.0.1:${port}`; },
    async stop() { if (!server) return; const closing = server; server = undefined; await new Promise<void>((resolve) => { closing.close(() => resolve()); closing.closeAllConnections(); }); address = ''; },
    async approve(id) { const connection = connections.get(id); if (!connection || connection.status !== 'pending') throw new Error('connection is not pending'); connection.status = 'approved'; connection.mode = connection.requestedMode; options.onConnections?.(endpoint.connections()); return { id, mode: connection.mode }; },
    async reject(id) { const connection = connections.get(id); if (!connection || connection.status !== 'pending') throw new Error('connection is not pending'); connection.status = 'rejected'; connections.delete(id); options.onConnections?.(endpoint.connections()); return { id, rejected: true }; },
    async revoke(id) { const connection = connections.get(id); if (!connection || connection.status !== 'approved') throw new Error('connection is not approved'); connection.status = 'revoked'; connections.delete(id); options.onConnections?.(endpoint.connections());
      // The work this connection started ends with it.
      if (options.threads) await Promise.all([...threads.values()].filter((thread) => thread.ownerConnectionId === id && (thread.busy || thread.queue.length > 0 || thread.status === 'running')).map((thread) => halt(thread).catch(() => undefined))); return { id, revoked: true }; },
  }; return endpoint;
}
