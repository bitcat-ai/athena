import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface AthenaMcpState {
  workspace: { path: string; mode: 'project' | 'personal' };
  conversations: Array<{ id: string; title: string; status: string; agent?: string; model?: string }>;
  providers: Array<{ id: string; available: boolean; authenticated: boolean }>;
  capabilities: string[];
}

interface ConnectionRequest {
  id: string;
  token: string;
  agent: { id: string; name: string };
  requestedMode: 'read-only';
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
}

export interface AthenaMcpEndpoint {
  readonly url: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  approve(id: string): Promise<{ id: string; mode: 'read-only' }>;
  reject(id: string): Promise<{ id: string; rejected: true }>;
  revoke(id: string): Promise<{ id: string; revoked: true }>;
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of request) data += chunk;
  if (data.length > 64 * 1024) throw new Error('request too large');
  return JSON.parse(data || '{}');
}

export function createAthenaMcpEndpoint(options: { getState: () => AthenaMcpState }): AthenaMcpEndpoint {
  const connections = new Map<string, ConnectionRequest>();
  let server: Server | undefined;
  let address = '';
  const endpoint: AthenaMcpEndpoint = {
    get url() { return address; },
    async start() {
      if (server) return;
      server = createServer(async (request, response) => {
        try {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1');
          if (request.method === 'POST' && url.pathname === '/api/v1/connections') {
            const value = await body(request) as any;
            if (!value.agent || typeof value.agent.id !== 'string' || typeof value.agent.name !== 'string' || value.requestedMode !== 'read-only') {
              json(response, 400, { error: 'invalid_connection_request' }); return;
            }
            const connection: ConnectionRequest = { id: randomUUID(), token: randomBytes(32).toString('hex'), agent: { id: value.agent.id, name: value.agent.name }, requestedMode: 'read-only', status: 'pending' };
            connections.set(connection.id, connection);
            json(response, 202, { id: connection.id, token: connection.token, request: { agent: connection.agent, requestedMode: connection.requestedMode, status: connection.status } }); return;
          }
          if (request.method === 'GET' && url.pathname === '/api/v1/state') {
            const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/)?.[1];
            const connection = [...connections.values()].find((item) => item.token === token && item.status === 'approved');
            if (!connection) { json(response, 401, { error: 'approval_required' }); return; }
            json(response, 200, { ...options.getState(), accessMode: connection.requestedMode }); return;
          }
          json(response, 404, { error: 'not_found' });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : 'malformed_request' });
        }
      });
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
      const info = server.address() as { port: number };
      address = `http://127.0.0.1:${info.port}`;
    },
    async stop() { if (!server) return; await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; address = ''; },
    async approve(id) { const connection = connections.get(id); if (!connection || connection.status !== 'pending') throw new Error('connection is not pending'); connection.status = 'approved'; return { id, mode: 'read-only' }; },
    async reject(id) { const connection = connections.get(id); if (!connection || connection.status !== 'pending') throw new Error('connection is not pending'); connection.status = 'rejected'; return { id, rejected: true }; },
    async revoke(id) { const connection = connections.get(id); if (!connection || connection.status !== 'approved') throw new Error('connection is not approved'); connection.status = 'revoked'; return { id, revoked: true }; },
  };
  return endpoint;
}
