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

test('executes initial thread input exactly once', async (t) => {
  const calls: string[] = [];
  const server = createAthenaMcpEndpoint({
    getState: () => state,
    threads: {
      start: async () => ({ conversationId: 'conversation-1', agentSessionId: 'session-1' }),
      send: async (_thread, text) => { calls.push(text); },
      stop: async () => {},
    },
  });
  await server.start();
  t.after(() => server.stop());
  const pending = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Runner', id: 'runner-1' }, requestedMode: 'supervised' }) });
  const connection = await pending.json();
  await server.approve(connection.id);
  const started = await request(server.url, '/api/v1/threads', { method: 'POST', headers: { authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ text: 'initial', agent: 'codex', workspace: '/Users/test/project' }) });
  assert.equal(started.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['initial']);
});

test('rejects stopping a thread owned by another external connection', async (t) => {
  const calls: string[] = [];
  const server = createAthenaMcpEndpoint({
    getState: () => state,
    threads: {
      start: async () => ({ conversationId: 'conversation-1', agentSessionId: 'session-1' }),
      send: async () => {},
      stop: async () => { calls.push('stop'); },
    },
  });
  await server.start();
  t.after(() => server.stop());
  const connect = async (id: string) => {
    const response = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: id, id }, requestedMode: 'supervised' }) });
    const connection = await response.json();
    await server.approve(connection.id);
    return connection;
  };
  const owner = await connect('owner');
  const other = await connect('other');
  const started = await request(server.url, '/api/v1/threads', { method: 'POST', headers: { authorization: `Bearer ${owner.token}` }, body: JSON.stringify({ text: 'initial' }) });
  const thread = await started.json();
  const stopped = await request(server.url, `/api/v1/threads/${thread.id}/stop`, { method: 'POST', headers: { authorization: `Bearer ${other.token}` } });
  assert.equal(stopped.status, 403);
  assert.deepEqual(await stopped.json(), { error: 'thread_ownership_mismatch' });
  assert.deepEqual(calls, []);
});

test('rejects messages for stopped, failed, and unknown-result threads', async (t) => {
  let failSend = false;
  const server = createAthenaMcpEndpoint({
    getState: () => state,
    threads: {
      start: async () => ({ conversationId: 'conversation-1', agentSessionId: 'session-1' }),
      send: async () => { if (failSend) throw new Error('send failed'); },
      stop: async () => {},
    },
  });
  await server.start();
  t.after(() => server.stop());
  const pending = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Runner', id: 'runner-1' }, requestedMode: 'supervised' }) });
  const connection = await pending.json();
  await server.approve(connection.id);
  const auth = { authorization: `Bearer ${connection.token}` };
  const start = async () => {
    const response = await request(server.url, '/api/v1/threads', { method: 'POST', headers: auth, body: JSON.stringify({ text: 'initial' }) });
    return response.json();
  };
  const send = (id: string) => request(server.url, `/api/v1/threads/${id}/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'late' }) });

  const stopped = await start();
  await request(server.url, `/api/v1/threads/${stopped.id}/stop`, { method: 'POST', headers: auth });
  const stoppedMessage = await send(stopped.id);
  assert.equal(stoppedMessage.status, 410);
  assert.deepEqual(await stoppedMessage.json(), { error: 'thread_gone' });

  failSend = true;
  const failed = await start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const failedMessage = await send(failed.id);
  assert.equal(failedMessage.status, 409);
  assert.deepEqual(await failedMessage.json(), { error: 'thread_not_accepting_messages' });
});

test('stopping an in-flight external thread discards its queued messages', async (t) => {
  const calls: string[] = [];
  let release!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createAthenaMcpEndpoint({
    getState: () => state,
    threads: {
      start: async (input) => { calls.push(`start:${input.text}`); return { conversationId: 'conversation-1', agentSessionId: 'session-1' }; },
      send: async (_thread, text) => { calls.push(`send:${text}`); if (text === 'second') { sendStarted.resolve(); await new Promise<void>((resolve) => { release = resolve; }); } },
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
  const stopped = request(server.url, `/api/v1/threads/${thread.id}/stop`, { method: 'POST', headers: auth });
  await sendStarted;
  release();
  assert.equal((await stopped).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['start:first', 'send:second', 'stop']);
  const threadState = await request(server.url, `/api/v1/threads/${thread.id}`, { headers: auth });
  assert.equal((await threadState.json()).status, 'stopped');
});
