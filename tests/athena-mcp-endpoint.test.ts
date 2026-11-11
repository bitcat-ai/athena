import assert from 'node:assert/strict';
import test from 'node:test';
import { createAthenaMcpEndpoint, type AthenaMcpState } from '../src/main/athena-mcp-endpoint';

const state: AthenaMcpState = {
  workspace: { path: '/Users/test/project', mode: 'project' },
  conversations: [{ id: 'conversation-1', title: 'Review', status: 'idle', agent: 'codex', model: 'gpt-5' }],
  providers: [{ id: 'codex', available: true }],
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

test('failed external stop remains retryable and does not report a misleading gone thread', async (t) => {
  let stopAttempts = 0;
  const server = createAthenaMcpEndpoint({
    getState: () => state,
    threads: {
      start: async () => ({ conversationId: 'conversation-1', agentSessionId: 'session-1' }),
      send: async () => {},
      stop: async () => { stopAttempts += 1; throw new Error('stop unavailable'); },
    },
  });
  await server.start();
  t.after(() => server.stop());
  const pending = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Runner', id: 'runner-1' }, requestedMode: 'supervised' }) });
  const connection = await pending.json();
  await server.approve(connection.id);
  const auth = { authorization: `Bearer ${connection.token}` };
  const started = await request(server.url, '/api/v1/threads', { method: 'POST', headers: auth, body: JSON.stringify({ text: 'initial' }) });
  const thread = await started.json();
  const stopped = await request(server.url, `/api/v1/threads/${thread.id}/stop`, { method: 'POST', headers: auth });
  assert.equal(stopped.status, 502);
  assert.deepEqual(await stopped.json(), { error: 'stop unavailable' });
  const status = await request(server.url, `/api/v1/threads/${thread.id}`, { headers: auth });
  assert.equal((await status.json()).status, 'unknown-result');
  const message = await request(server.url, `/api/v1/threads/${thread.id}/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'retry' }) });
  assert.equal(message.status, 409);
  assert.deepEqual(await message.json(), { error: 'thread_stop_unknown' });
  assert.equal(stopAttempts, 1);
});

test('passes an external model selection to the thread controller', async (t) => {
  let receivedModel: string | undefined;
  const server = createAthenaMcpEndpoint({
    getState: () => state,
    threads: {
      start: async (input) => { receivedModel = input.model; return { conversationId: 'conversation-1' }; },
      send: async () => {},
      stop: async () => {},
    },
  });
  await server.start();
  t.after(() => server.stop());
  const pending = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Runner', id: 'runner-1' }, requestedMode: 'supervised' }) });
  const connection = await pending.json();
  await server.approve(connection.id);
  const started = await request(server.url, '/api/v1/threads', { method: 'POST', headers: { authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ text: 'initial', model: 'gpt-5-mini' }) });
  assert.equal(started.status, 201);
  assert.equal(receivedModel, 'gpt-5-mini');
});

test('serializes external thread operations so starts cannot overlap', async (t) => {
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createAthenaMcpEndpoint({
    getState: () => state,
    threads: {
      start: async (input) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return { conversationId: input.text };
      },
      send: async () => {},
      stop: async () => {},
    },
  });
  await server.start();
  t.after(() => server.stop());
  const response = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Runner', id: 'runner-1' }, requestedMode: 'supervised' }) });
  const connection = await response.json();
  await server.approve(connection.id);
  const auth = { authorization: `Bearer ${connection.token}` };
  await Promise.all([
    request(server.url, '/api/v1/threads', { method: 'POST', headers: auth, body: JSON.stringify({ text: 'one' }) }),
    request(server.url, '/api/v1/threads', { method: 'POST', headers: auth, body: JSON.stringify({ text: 'two' }) }),
  ]);
  assert.equal(maxInFlight, 1);
});

const hung = Symbol('hung');
const settled = <T>(promise: Promise<T>) =>
  Promise.race([promise, new Promise<typeof hung>((resolve) => setTimeout(() => resolve(hung), 500))]);

test('stopping an in-flight external thread interrupts the turn instead of waiting for it', async (t) => {
  const calls: string[] = [];
  let releaseSend!: () => void;
  let resolveSendStarted!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    resolveSendStarted = resolve;
  });
  const server = createAthenaMcpEndpoint({
    getState: () => state,
    threads: {
      start: async (input) => { calls.push(`start:${input.text}`); return { conversationId: 'conversation-1', agentSessionId: 'session-1' }; },
      send: async (_thread, text) => { calls.push(`send:${text}`); if (text === 'second') { resolveSendStarted(); await new Promise<void>((resolve) => { releaseSend = resolve; }); } },
      // The turn only ends because it is interrupted, as a hung task would.
      stop: async () => { calls.push('stop'); releaseSend(); },
    },
  });
  await server.start();
  t.after(() => { releaseSend?.(); return server.stop(); });
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
  await sendStarted;
  const third = await request(server.url, `/api/v1/threads/${thread.id}/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'third' }) });
  assert.equal(third.status, 202);
  const stopped = await settled(request(server.url, `/api/v1/threads/${thread.id}/stop`, { method: 'POST', headers: auth }));
  assert.notEqual(stopped, hung, 'stop must not wait behind the running turn');
  assert.equal((stopped as Response).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['start:first', 'send:first', 'send:second', 'stop']);
  const threadState = await request(server.url, `/api/v1/threads/${thread.id}`, { headers: auth });
  assert.equal((await threadState.json()).status, 'stopped');
});

test('a thread stopped while it waits behind another thread never starts its turn', async (t) => {
  const calls: string[] = [];
  let releaseSend!: () => void;
  let resolveSendStarted!: () => void;
  const sendStarted = new Promise<void>((resolve) => {
    resolveSendStarted = resolve;
  });
  const server = createAthenaMcpEndpoint({
    getState: () => state,
    threads: {
      start: async (input) => ({ conversationId: input.text }),
      send: async (thread, text) => { calls.push(`send:${thread.conversationId}:${text}`); if (text === 'long') { resolveSendStarted(); await new Promise<void>((resolve) => { releaseSend = resolve; }); } },
      stop: async (thread) => { calls.push(`stop:${thread.conversationId}`); },
    },
  });
  await server.start();
  t.after(() => { releaseSend?.(); return server.stop(); });
  const pending = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Runner', id: 'runner-1' }, requestedMode: 'supervised' }) });
  const connection = await pending.json();
  await server.approve(connection.id);
  const auth = { authorization: `Bearer ${connection.token}` };
  const start = async (text: string) =>
    (await request(server.url, '/api/v1/threads', { method: 'POST', headers: auth, body: JSON.stringify({ text }) })).json();
  const message = (id: string, text: string) =>
    request(server.url, `/api/v1/threads/${id}/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ text }) });
  const a = await start('a');
  const b = await start('b');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await message(a.id, 'long');
  await sendStarted;
  await message(b.id, 'waiting');
  const stopped = await settled(request(server.url, `/api/v1/threads/${b.id}/stop`, { method: 'POST', headers: auth }));
  assert.notEqual(stopped, hung, 'stop must not wait behind another thread');
  assert.equal((stopped as Response).status, 200);
  releaseSend();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['send:a:a', 'send:b:b', 'send:a:long', 'stop:b']);
  const running = await request(server.url, `/api/v1/threads/${a.id}`, { headers: auth });
  assert.equal((await running.json()).status, 'idle');
});

const connect = async (server: { url: string; approve(id: string): Promise<unknown> }, requestedMode = 'supervised') => {
  const response = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { name: 'Runner', id: 'runner-1' }, requestedMode }) });
  const connection = await response.json();
  await server.approve(connection.id);
  return { id: connection.id as string, auth: { authorization: `Bearer ${connection.token}` } };
};

test('refuses requests a web page could send', async (t) => {
  const server = await endpoint();
  t.after(() => server.stop());
  const payload = JSON.stringify({ agent: { name: 'Page', id: 'page-1' }, requestedMode: 'full' });
  // A cross-site form or no-cors fetch cannot set a JSON content type without a preflight.
  const simple = await fetch(`${server.url}/api/v1/connections`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: payload });
  assert.equal(simple.status, 415);
  const crossSite = await request(server.url, '/api/v1/connections', { method: 'POST', headers: { origin: 'https://example.com' }, body: payload });
  assert.equal(crossSite.status, 403);
  // A rebound DNS name reaches the loopback address with its own Host.
  const { port } = new URL(server.url);
  const { request: raw } = await import('node:http');
  const rebound = await new Promise<number>((resolve, reject) => {
    const call = raw({ host: '127.0.0.1', port, path: '/api/v1/state', headers: { host: `attacker.example:${port}` } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
    call.on('error', reject);
    call.end();
  });
  assert.equal(rebound, 403);
  assert.deepEqual(server.connections(), []);
});

test('bounds connection requests, names and request bodies', async (t) => {
  const notified: number[] = [];
  const server = createAthenaMcpEndpoint({ getState: () => state, onConnections: (connections) => notified.push(connections.length) });
  await server.start();
  t.after(() => server.stop());
  const ask = (agent: unknown) => request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent, requestedMode: 'read-only' }) });
  assert.equal((await ask({ id: 'a', name: 'x'.repeat(81) })).status, 400);
  assert.equal((await ask({ id: 'a', name: '   ' })).status, 400);
  const named = await (await ask({ id: 'a', name: 'Build\nbot\u0007' })).json();
  assert.equal(named.request.agent.name, 'Build bot');
  for (let index = 1; index < 8; index += 1) assert.equal((await ask({ id: `a${index}`, name: 'Agent' })).status, 202);
  const refused = await ask({ id: 'late', name: 'Agent' });
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: 'too_many_pending_connections' });
  // A decided request leaves the list and frees its place.
  await server.reject(named.id);
  assert.equal(server.connections().length, 7);
  assert.equal((await ask({ id: 'late', name: 'Agent' })).status, 202);
  assert.deepEqual(notified, [1, 2, 3, 4, 5, 6, 7, 8, 7, 8]);
  const large = await request(server.url, '/api/v1/connections', { method: 'POST', body: JSON.stringify({ agent: { id: 'a', name: 'Agent' }, requestedMode: 'read-only', padding: 'x'.repeat(70 * 1024) }) });
  assert.equal(large.status, 413);
});

test('a stop is final for messages that arrive while it is still in progress', async (t) => {
  const calls: string[] = [];
  let releaseStop!: () => void;
  let resolveStopStarted!: () => void;
  const stopStarted = new Promise<void>((resolve) => { resolveStopStarted = resolve; });
  const server = createAthenaMcpEndpoint({
    getState: () => state,
    threads: {
      start: async () => ({ conversationId: 'conversation-1' }),
      send: async (_thread, text) => { calls.push(`send:${text}`); },
      stop: async () => { calls.push('stop'); resolveStopStarted(); await new Promise<void>((resolve) => { releaseStop = resolve; }); },
    },
  });
  await server.start();
  t.after(() => { releaseStop?.(); return server.stop(); });
  const { auth } = await connect(server);
  const thread = await (await request(server.url, '/api/v1/threads', { method: 'POST', headers: auth, body: JSON.stringify({ text: 'first' }) })).json();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const stopping = request(server.url, `/api/v1/threads/${thread.id}/stop`, { method: 'POST', headers: auth });
  await stopStarted;
  const late = await request(server.url, `/api/v1/threads/${thread.id}/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'late' }) });
  assert.equal(late.status, 410);
  releaseStop();
  assert.equal((await stopping).status, 200);
  assert.deepEqual(calls, ['send:first', 'stop']);
});

test('revoking a connection stops the work it started', async (t) => {
  const calls: string[] = [];
  let releaseSend!: () => void;
  let resolveSendStarted!: () => void;
  const sendStarted = new Promise<void>((resolve) => { resolveSendStarted = resolve; });
  const server = createAthenaMcpEndpoint({
    getState: () => state,
    threads: {
      start: async () => ({ conversationId: 'conversation-1' }),
      send: async (_thread, text) => { calls.push(`send:${text}`); if (text === 'long') { resolveSendStarted(); await new Promise<void>((resolve) => { releaseSend = resolve; }); } },
      stop: async () => { calls.push('stop'); releaseSend(); },
    },
  });
  await server.start();
  t.after(() => { releaseSend?.(); return server.stop(); });
  const { id, auth } = await connect(server);
  const thread = await (await request(server.url, '/api/v1/threads', { method: 'POST', headers: auth, body: JSON.stringify({ text: 'long' }) })).json();
  await sendStarted;
  await request(server.url, `/api/v1/threads/${thread.id}/messages`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'queued' }) });
  await server.revoke(id);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['send:long', 'stop']);
  assert.equal((await request(server.url, `/api/v1/threads/${thread.id}`, { headers: auth })).status, 401);
});

test('refuses messages longer than an agent accepts', async (t) => {
  const server = createAthenaMcpEndpoint({ getState: () => state, threads: { start: async () => ({ conversationId: 'conversation-1' }), send: async () => {}, stop: async () => {} } });
  await server.start();
  t.after(() => server.stop());
  const { auth } = await connect(server);
  const started = await request(server.url, '/api/v1/threads', { method: 'POST', headers: auth, body: JSON.stringify({ text: 'x'.repeat(20_001) }) });
  assert.equal(started.status, 400);
});
