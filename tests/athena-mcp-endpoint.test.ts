import assert from 'node:assert/strict';
import test from 'node:test';
import { createAthenaMcpEndpoint, type AthenaMcpState } from '../src/main/athena-mcp-endpoint';

const state: AthenaMcpState = {
  workspace: { path: '/Users/test/project', mode: 'project' },
  conversations: [{ id: 'conversation-1', title: 'Review', status: 'idle', agent: 'codex', model: 'gpt-5' }],
  providers: [{ id: 'codex', available: true, authenticated: true }],
  capabilities: ['workspace.read', 'thread.read'],
};

async function endpoint() {
  const server = createAthenaMcpEndpoint({ getState: () => state });
  await server.start();
  return server;
}

async function request(baseUrl: string, path: string, init?: RequestInit) {
  return fetch(baseUrl + path, { ...init, headers: { ...(init?.headers ?? {}), 'content-type': 'application/json' } });
}

test('requires local approval and exposes only read-only state after approval', async (t) => {
  const server = await endpoint();
  t.after(() => server.stop());
  const pending = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Inspector', id: 'inspector-1' }, requestedMode: 'read-only' }) });
  assert.equal(pending.status, 202);
  const connection = await pending.json();
  assert.deepEqual(connection.request.agent, { name: 'Inspector', id: 'inspector-1' });
  assert.equal(connection.request.requestedMode, 'read-only');
  assert.equal((await request(server.url, '/api/v1/state')).status, 401);
  assert.equal((await server.approve(connection.id)).mode, 'read-only');
  const stateResponse = await request(server.url, '/api/v1/state', { headers: { authorization: `Bearer ${connection.token}` } });
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), { ...state, accessMode: 'read-only' });
});

test('revocation takes effect immediately and rejection does not authorize', async (t) => {
  const server = await endpoint();
  t.after(() => server.stop());
  const response = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Agent', id: 'agent-1' }, requestedMode: 'read-only' }) });
  const connection = await response.json();
  await server.reject(connection.id);
  assert.equal((await request(server.url, '/api/v1/state', { headers: { authorization: `Bearer ${connection.token}` } })).status, 401);
  const second = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Agent', id: 'agent-1' }, requestedMode: 'read-only' }) });
  const approved = await second.json();
  await server.approve(approved.id);
  assert.equal((await server.revoke(approved.id)).revoked, true);
  assert.equal((await request(server.url, '/api/v1/state', { headers: { authorization: `Bearer ${approved.token}` } })).status, 401);
});

test('rejects malformed requests and refuses write or sensitive routes', async (t) => {
  const server = await endpoint();
  t.after(() => server.stop());
  assert.equal((await request(server.url, '/api/v1/connections', { method: 'POST', body: '{}' })).status, 400);
  const pending = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Agent', id: 'agent-1' }, requestedMode: 'full' }) });
  assert.equal(pending.status, 400);
});
