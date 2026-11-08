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
  const pending = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Agent', id: 'agent-1' }, requestedMode: 'read-only' }) });
  const connection = await pending.json();
  await server.approve(connection.id);
  assert.equal((await request(server.url, '/api/v1/threads', { method: 'POST', headers: { authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ text: 'run' }) })).status, 403);
});

test('starts, reports, queues and stops an authorized external thread', async (t) => {
  const calls: string[] = [];
  let release!: () => void;
  const server = createAthenaMcpEndpoint({
    getState: () => state,
    threads: {
      start: async (input) => { calls.push(`start:${input.text}`); return { conversationId: 'conversation-1', agentSessionId: 'session-1' }; },
      send: async (_thread, text) => { calls.push(`send:${text}`); await new Promise<void>((resolve) => { release = resolve; }); },
      stop: async () => { calls.push('stop'); },
    },
  });
  await server.start();
  t.after(() => server.stop());
  const pending = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Runner', id: 'runner-1' }, requestedMode: 'supervised' }) });
  const connection = await pending.json();
  await server.approve(connection.id);
  const auth = { authorization: `Bearer ${connection.token}` };
  const started = await request(server.url, '/api/v1/threads', { method: 'POST', headers: auth, body: JSON.stringify({ text: 'first', agent: 'codex', workspace: '/Users/test/project' }) });
  assert.equal(started.status, 201);
  const thread = await started.json();
  assert.equal(thread.conversationId, 'conversation-1');
  const queued = await request(server.url, `/api/v1/threads/${thread.id}/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'second' }) });
  assert.equal(queued.status, 202);
  assert.deepEqual(await queued.json(), { queued: true, position: 1 });
  assert.equal((await request(server.url, `/api/v1/threads/${thread.id}`, { headers: auth })).status, 200);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['start:first', 'send:second']);
  const stopped = await request(server.url, `/api/v1/threads/${thread.id}/stop`, { method: 'POST', headers: auth });
  assert.equal(stopped.status, 200);
  assert.equal(calls.at(-1), 'stop');
});
