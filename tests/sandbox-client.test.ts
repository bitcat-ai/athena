import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SandboxClient, SandboxError, redact, sshArgs } from '../src/main/sandbox-client';
import type { SandboxEventEnvelope } from '../src/shared/sandbox-protocol';
import { sandboxProtocolSchema, schemaPath } from '../scripts/export-sandbox-protocol';
import { mockClient, mockDaemon, until } from './sandbox-test-support';

const service = (name: string) => ({ name, command: 'npm run dev', port: 5173 });

test('committed protocol schema matches the zod definitions', async () => {
  const committed = JSON.parse(await readFile(schemaPath, 'utf8'));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(sandboxProtocolSchema())));
});

test('ssh arguments keep the host out of option parsing', () => {
  const args = sshArgs('athena-sbx');
  assert.deepEqual(args.slice(args.indexOf('--')), [
    '--',
    'athena-sbx',
    'PATH="$HOME/.local/bin:$PATH"',
    'exec',
    'athena-sandbox',
    'attach',
    '--protocol',
    '1',
  ]);
  assert.ok(args.includes('BatchMode=yes'));
  assert.throws(() => new SandboxClient({ host: '-oProxyCommand=x', clientVersion: 't' }), /别名/);
});

test('redact hides tokens and secrets', () => {
  assert.equal(
    redact('Bearer abc sk-123 token=xyz password: p@ss'),
    'Bearer [hidden] [hidden] token=[hidden] password=[hidden]',
  );
  // A value that follows no pattern is hidden when it is named.
  assert.equal(
    redact('session Zx9-opaque rejected', ['Zx9-opaque', '']),
    'session [hidden] rejected',
  );
});

test('handshake, subscribe, ordered events and validated results', async (t) => {
  const daemon = await mockDaemon();
  const events: SandboxEventEnvelope[] = [];
  let resyncs = 0;
  const client = mockClient(daemon, {
    onEvent: (event) => events.push(event),
    onResync: () => resyncs++,
  });
  t.after(async () => {
    client.close();
    await daemon.cleanup();
  });
  await assert.rejects(
    client.request('workspace.info', {}),
    (error: SandboxError) => error.reason === 'NOT_CONNECTED',
  );
  await client.connect();
  assert.equal(client.state.status, 'ready');
  assert.deepEqual(client.state.server?.capabilities.agents, ['codex']);
  assert.equal(resyncs, 1, 'first connection has no cached state to trust');
  const { workspace } = await client.request('workspace.info', {});
  assert.equal(workspace.agent.status, 'ready');
  await client.request('service.start', service('web'));
  await until(() =>
    events.some(
      (item) => item.event.type === 'service.state' && item.event.service.status === 'healthy',
    ),
  );
  const seqs = events.map((item) => item.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  );
  await assert.rejects(
    client.request('service.start', service('web')),
    (error: SandboxError) => error.reason === 'CONFLICT' && /已在运行/.test(error.message),
  );
  await assert.rejects(client.request('task.get', { taskId: 'bad id' }), /参数无效/);
});

test('task.start is idempotent by taskId', async (t) => {
  const daemon = await mockDaemon();
  const events: SandboxEventEnvelope[] = [];
  const client = mockClient(daemon, { onEvent: (event) => events.push(event) });
  t.after(async () => {
    client.close();
    await daemon.cleanup();
  });
  await client.connect();
  const first = await client.request('task.start', { taskId: 't1', text: 'hello' });
  const second = await client.request('task.start', { taskId: 't1', text: 'hello' });
  assert.equal(second.task.id, first.task.id);
  await until(() =>
    events.some(
      (item) => item.event.type === 'task.state' && item.event.task.status === 'completed',
    ),
  );
  const completions = events.filter(
    (item) => item.event.type === 'task.event' && item.event.event.type === 'completed',
  );
  assert.equal(completions.length, 1, 'repeating task.start never runs twice');
});

test('reconnect replays events missed while disconnected', async (t) => {
  const daemon = await mockDaemon();
  const seen: SandboxEventEnvelope[] = [];
  const states: string[] = [];
  let resyncs = 0;
  const a = mockClient(daemon, {
    backoffMs: [250],
    onEvent: (event) => seen.push(event),
    onState: (state) => states.push(state.status),
    onResync: () => resyncs++,
  });
  // Only A watches the drop file, so B's connection stays up.
  const b = mockClient(daemon, { env: { ...daemon.env, MOCK_SANDBOXD_DROP_FILE: '' } });
  t.after(async () => {
    a.close();
    b.close();
    await daemon.cleanup();
  });
  await a.connect();
  await a.request('service.start', service('api'));
  await until(() => seen.length >= 2);
  await b.connect();
  await daemon.drop();
  await until(() => a.state.status === 'reconnecting');
  // Another client acts while A is away; A must still see it, in order, exactly once.
  await b.request('service.start', service('web'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  b.close();
  await until(() => a.state.status === 'ready');
  const web = await until(() =>
    seen.find((item) => item.event.type === 'service.state' && item.event.service.name === 'web'),
  );
  assert.ok(web);
  const seqs = seen.map((item) => item.seq);
  assert.deepEqual(
    seqs,
    [...new Set(seqs)].sort((x, y) => x - y),
    'no duplicates, no reordering',
  );
  assert.equal(resyncs, 1, 'replay succeeded, so no extra resync');
  assert.ok(states.includes('reconnecting'));
});

test('expired replay window falls back to a full resync', async (t) => {
  const daemon = await mockDaemon({ MOCK_SANDBOXD_RETAIN: '1' });
  let resyncs = 0;
  const a = mockClient(daemon, { backoffMs: [250], onResync: () => resyncs++ });
  // Only A watches the drop file, so B's connection stays up.
  const b = mockClient(daemon, { env: { ...daemon.env, MOCK_SANDBOXD_DROP_FILE: '' } });
  t.after(async () => {
    a.close();
    b.close();
    await daemon.cleanup();
  });
  await a.connect();
  await b.connect();
  await daemon.drop();
  await until(() => a.state.status === 'reconnecting');
  await b.request('service.start', service('api'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  b.close();
  await until(() => a.state.status === 'ready');
  await until(() => resyncs === 2);
});

test('pending requests fail as outcome-unknown when the channel drops', async (t) => {
  const daemon = await mockDaemon({ MOCK_SANDBOXD_MODE: 'hang-ping' });
  const client = mockClient(daemon, { backoffMs: [1000] });
  t.after(async () => {
    client.close();
    await daemon.cleanup();
  });
  await client.connect();
  const ping = client.request('ping', {});
  await daemon.drop();
  await assert.rejects(
    ping,
    (error: SandboxError) => error.reason === 'CONNECTION_LOST' && error.outcomeUnknown,
  );
});

test('missed heartbeats force a reconnect', async (t) => {
  const daemon = await mockDaemon({ MOCK_SANDBOXD_MODE: 'hang-ping' });
  const client = mockClient(daemon, { heartbeatMs: 20, heartbeatTimeoutMs: 15, backoffMs: [1000] });
  t.after(async () => {
    client.close();
    await daemon.cleanup();
  });
  await client.connect();
  await until(() => client.state.status === 'reconnecting', 2000);
});

for (const [name, env, pattern] of [
  ['daemon not running', { MOCK_SANDBOXD_MODE: 'fatal' }, /沙箱服务未运行/],
  ['protocol mismatch', { MOCK_SANDBOXD_MODE: 'old-protocol' }, /协议版本不兼容/],
  ['non-protocol output', { MOCK_SANDBOXD_MODE: 'garbage' }, /不是沙箱协议/],
] as const)
  test(`fails permanently: ${name}`, async (t) => {
    const daemon = await mockDaemon(env);
    const client = mockClient(daemon);
    t.after(async () => {
      client.close();
      await daemon.cleanup();
    });
    await assert.rejects(client.connect(), pattern);
    assert.equal(client.state.status, 'failed');
  });

test('exit code 127 means the sandbox command is not installed', async () => {
  const client = new SandboxClient({
    host: 'mock',
    clientVersion: 'test',
    command: '/bin/sh',
    args: ['-c', 'exit 127'],
  });
  await assert.rejects(client.connect(), /未安装 athena-sandbox/);
  client.close();
});

test('ssh failure on first connect is reported with the login hint', async () => {
  const client = new SandboxClient({
    host: 'athena-sbx',
    clientVersion: 'test',
    command: '/bin/sh',
    args: ['-c', 'echo "Permission denied (publickey) token=abc" >&2; exit 255'],
  });
  await assert.rejects(client.connect(), (error: Error) => {
    assert.match(error.message, /SSH 连接失败.*Permission denied/);
    assert.match(error.message, /ssh athena-sbx/);
    assert.doesNotMatch(error.message, /abc/);
    return true;
  });
  client.close();
});

test('a secret handed to the channel never shows in what it reports of the failure', async () => {
  const client = new SandboxClient({
    host: 'athena-sbx',
    clientVersion: 'test',
    command: '/bin/sh',
    args: ['-c', 'echo "session Zx9-opaque was rejected" >&2; exit 255'],
    secrets: ['Zx9-opaque'],
  });
  await assert.rejects(client.connect(), (error: Error) => {
    assert.match(error.message, /SSH 连接失败：session \[hidden\] was rejected/);
    assert.doesNotMatch(error.message, /Zx9-opaque/);
    return true;
  });
  client.close();
});
