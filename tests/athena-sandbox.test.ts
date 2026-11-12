/** Conformance: the real athena-sandbox daemon, driven by Athena's own client and session. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { SandboxSession } from '../src/main/sandbox-session';
import { WorkspaceChannel } from '../src/main/workspace-channel';
import {
  EventEnvelope,
  RpcNotification,
  RpcResponse,
  methods,
} from '../src/shared/sandbox-protocol';
import type { AgentEvent, ApprovalRequest, UserInputRequest } from '../src/shared/types';
import { until } from './sandbox-test-support';

const program = fileURLToPath(
  new URL('../packages/athena-sandbox/athena-sandbox.mjs', import.meta.url),
);

// Minimal `codex app-server` speaking the JSON-RPC subset athena-sandbox uses.
const fakeCodex = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let turn = 0, waiting = new Map(), active;
const thread = 'thr-1';
const note = (method, params) => out({ method, params: { threadId: thread, ...params } });
function finish(turnId, status, error) { note('turn/completed', { turn: { id: turnId, status, ...(error ? { error: { message: error } } : {}) } }); active = undefined; }
function proceed(turnId, text) {
  note('item/agentMessage/delta', { turnId, itemId: 'm2', delta: text });
  note('turn/plan/updated', { turnId, plan: [{ step: '修改接口', status: 'completed' }] });
  note('thread/tokenUsage/updated', { turnId, tokenUsage: { total: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, last: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } } });
  finish(turnId, 'completed');
}
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return out({ id: m.id, result: {} });
  if (m.method === 'initialized') return;
  if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: thread }, approvalsReviewer: 'user', model: 'fake-model' } });
  if (m.method === 'model/list') return out({ id: m.id, result: { data: [{ id: 'fake', model: 'fake-model', displayName: 'Fake', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'm' }], defaultReasoningEffort: 'medium' }] } });
  if (m.method === 'turn/interrupt') { out({ id: m.id, result: {} }); return finish(m.params.turnId, 'interrupted'); }
  if (m.method === 'turn/start') {
    const turnId = 'turn-' + (++turn); active = turnId;
    const text = m.params.input[0].text;
    out({ id: m.id, result: { turn: { id: turnId, model: 'fake-model' } } });
    note('item/agentMessage/delta', { turnId, itemId: 'm1', delta: '收到。' });
    note('item/started', { turnId, item: { id: 'cmd/1', type: 'commandExecution', command: 'git status --token=abc' } });
    note('item/completed', { turnId, item: { id: 'cmd/1', type: 'commandExecution', command: 'git status --token=abc', exitCode: 0, aggregatedOutput: 'clean Bearer xyz' } });
    if (text.includes('[approval]')) { waiting.set(900 + turn, { turnId, kind: 'approval' }); return out({ id: 900 + turn, method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId, itemId: 'cmd/2', command: 'npm test', reason: '运行测试' } }); }
    if (text.includes('[input]')) { waiting.set(900 + turn, { turnId, kind: 'input' }); return out({ id: 900 + turn, method: 'item/tool/requestUserInput', params: { threadId: thread, turnId, itemId: 'q', isBlocking: true, questions: [{ id: 'branch', header: '分支', question: '基于哪个分支？', isSecret: false, options: [{ label: 'main', description: '' }] }] } }); }
    if (text.includes('[error]')) { note('error', { turnId, willRetry: false, error: { message: '模型服务不可达' } }); return finish(turnId, 'failed', '模型服务不可达'); }
    if (text.includes('[hold]')) return;
    return proceed(turnId, text.includes('<task_context>') ? '已参考上下文' : '完成');
  }
  if (m.id !== undefined && waiting.has(m.id)) {
    const { turnId, kind } = waiting.get(m.id); waiting.delete(m.id);
    note('serverRequest/resolved', { requestId: m.id });
    if (kind === 'approval') return m.result.decision === 'accept' ? proceed(turnId, '已批准并完成') : finish(turnId, 'failed', '用户拒绝');
    return proceed(turnId, '分支 ' + m.result.answers.branch.answers[0]);
  }
  if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: 'unsupported' } });
});
`;

async function setup(t: test.TestContext, options: { codex?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'athena-sandbox-real-'));
  const home = path.join(root, 'state');
  const repo = path.join(root, 'order-api');
  await mkdir(repo, { recursive: true });
  const gitRun = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  gitRun('init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'order.ts'), 'export interface Order {\n  id: string;\n}\n');
  gitRun('add', '.');
  gitRun('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const codex = path.join(root, 'codex');
  await writeFile(codex, fakeCodex);
  await chmod(codex, 0o755);
  const env = {
    ...process.env,
    ATHENA_SANDBOX_HOME: home,
    ATHENA_SANDBOX_REPOS: repo,
    ATHENA_SANDBOX_CODEX: options.codex === false ? path.join(root, 'missing-codex') : codex,
    PATH: process.env.PATH,
  };
  const channel = new WorkspaceChannel({
    ssh: 'coder.test',
    clientVersion: 'test',
    transport: { command: process.execPath, args: [program, 'attach', '--protocol', '1'], env },
    clientOptions: { backoffMs: [100], maxAttempts: 5, requestTimeoutMs: 10_000 },
  });
  t.after(async () => {
    channel.close();
    execFileSync(process.execPath, [program, 'stop'], { env, stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await rm(root, { recursive: true, force: true });
  });
  return { channel, env, repo, home };
}

/** Every line the daemon writes must parse against the protocol schemas. */
async function transcript(env: NodeJS.ProcessEnv, requests: unknown[]) {
  const child = spawn(process.execPath, [program, 'attach', '--protocol', '1'], {
    env,
    stdio: 'pipe',
  });
  const lines: unknown[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => lines.push(JSON.parse(line)));
  for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n');
  await until(
    () => lines.filter((line: any) => line.id !== undefined).length >= requests.length,
    10_000,
  );
  child.stdin.end();
  return lines;
}

test('the daemon starts on first attach and every message conforms to the schema', async (t) => {
  const { channel, env } = await setup(t);
  await channel.connect();
  await channel.resync();
  assert.equal(channel.info?.agent.status, 'ready');
  assert.equal(channel.info?.repos[0].ref, 'main');
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'hello',
      params: { protocol: 1, client: { name: 't', version: '0' } },
    },
    { jsonrpc: '2.0', id: 2, method: 'events.subscribe', params: { after: 0 } },
    { jsonrpc: '2.0', id: 3, method: 'workspace.info', params: {} },
    { jsonrpc: '2.0', id: 4, method: 'workspace.diff', params: {} },
    { jsonrpc: '2.0', id: 5, method: 'models.list', params: {} },
    { jsonrpc: '2.0', id: 6, method: 'task.get', params: { taskId: 'missing' } },
  ];
  const lines = await transcript(env, requests);
  const byId = new Map<number, string>(requests.map((item) => [item.id, item.method]));
  for (const line of lines as any[]) {
    if (line.method) {
      const parsed = RpcNotification.safeParse(line);
      assert.ok(parsed.success, `invalid notification: ${JSON.stringify(line).slice(0, 200)}`);
      if (line.method === 'event') assert.ok(EventEnvelope.safeParse(line.params).success);
      continue;
    }
    assert.ok(RpcResponse.safeParse(line).success);
    if ('result' in line) {
      const method = byId.get(line.id) as keyof typeof methods;
      const parsed = methods[method].result.safeParse(line.result);
      if (!parsed.success)
        assert.fail(`${method}: ${JSON.stringify(parsed.error.issues).slice(0, 300)}`);
    } else assert.equal(line.error.data.reason, 'NOT_FOUND');
  }
});

test('a task runs Codex, streams redacted events and completes through SandboxSession', async (t) => {
  const { channel } = await setup(t);
  const events: AgentEvent[] = [];
  const session = new SandboxSession({
    channel,
    workspaceId: 'ws',
    onEvent: (event) => events.push(event),
  });
  t.after(() => session.close());
  assert.equal((await session.discoverProviderSkills()).status, 'unavailable');
  await assert.rejects(
    session.send('task', undefined, undefined, undefined, [{ name: 'local-skill' } as any]),
    /不支持选择本机 Skill/,
  );
  await assert.rejects(
    session.send('task', undefined, undefined, undefined, [], [{} as any]),
    /不支持图片输入/,
  );
  assert.equal(events.length, 0);
  assert.equal((await session.listModels())[0].model, 'fake-model');
  await session.send('给订单加字段', '后端 diff');
  const complete = events.find((event) => event.type === 'complete');
  assert.ok(complete?.type === 'complete' && complete.text?.includes('已参考上下文'));
  const tool = events.findLast((event) => event.type === 'tool');
  assert.ok(tool?.type === 'tool' && tool.call.status === 'done');
  assert.equal(tool.call.input, 'git status --token=[hidden]');
  assert.doesNotMatch(tool.call.output ?? '', /xyz/);
  assert.ok(events.some((event) => event.type === 'plan'));
  assert.ok(events.some((event) => event.type === 'usage'));
});

test('approvals wait for Athena, then resume', async (t) => {
  const { channel } = await setup(t);
  const events: AgentEvent[] = [];
  const session = new SandboxSession({
    channel,
    workspaceId: 'ws',
    onEvent: (event) => events.push(event),
  });
  t.after(() => session.close());
  const run = session.send('跑测试 [approval]');
  const request = await until(() => {
    const event = events.find((item) => item.type === 'approval');
    return event?.type === 'approval' ? (event.request as ApprovalRequest) : undefined;
  }, 10_000);
  assert.match(request.detail, /npm test/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!events.some((event) => event.type === 'complete'), 'never auto-approved');
  session.resolveApproval(request.id, true);
  await run;
  const complete = events.find((event) => event.type === 'complete');
  assert.ok(complete?.type === 'complete' && complete.text?.includes('已批准'));
});

test('questions are answered with the original question ids', async (t) => {
  const { channel } = await setup(t);
  const events: AgentEvent[] = [];
  const session = new SandboxSession({
    channel,
    workspaceId: 'ws',
    onEvent: (event) => events.push(event),
  });
  t.after(() => session.close());
  const run = session.send('建分支 [input]');
  const request = await until(() => {
    const event = events.find((item) => item.type === 'user-input');
    return event?.type === 'user-input' ? (event.request as UserInputRequest) : undefined;
  }, 10_000);
  session.resolveUserInput(request.id, { [request.questions[0].id]: ['main'] });
  await run;
  const complete = events.find((event) => event.type === 'complete');
  assert.ok(complete?.type === 'complete' && complete.text?.includes('分支 main'));
});

test('stop interrupts the Codex turn; model errors fail the task', async (t) => {
  const { channel } = await setup(t);
  const events: AgentEvent[] = [];
  const session = new SandboxSession({
    channel,
    workspaceId: 'ws',
    onEvent: (event) => events.push(event),
  });
  t.after(() => session.close());
  const held = session.send('长任务 [hold]');
  await until(() => events.some((event) => event.type === 'tool'), 10_000);
  await session.interrupt();
  await assert.rejects(held, /任务已停止/);
  await assert.rejects(session.send('[error]'), /模型服务不可达/);
});

test('a task survives a dropped connection and the daemon replays missed events', async (t) => {
  const { channel, env } = await setup(t);
  const events: AgentEvent[] = [];
  const session = new SandboxSession({
    channel,
    workspaceId: 'ws',
    onEvent: (event) => events.push(event),
  });
  t.after(() => session.close());
  const run = session.send('跑测试 [approval]');
  const request = await until(() => {
    const event = events.find((item) => item.type === 'approval');
    return event?.type === 'approval' ? event.request : undefined;
  }, 10_000);
  // Kill only the attach bridge, as a dropped ssh session would; the daemon keeps the task.
  execFileSync('pkill', ['-f', `${program} attach`]);
  await until(() => channel.client.state.status === 'reconnecting', 5000);
  await until(() => channel.client.state.status === 'ready', 10_000);
  session.resolveApproval(request.id, true);
  await run;
  assert.equal(events.filter((event) => event.type === 'approval').length, 1);
  void env;
});

test('services start, pass health checks and report logs; diff shows edits and new files', async (t) => {
  const { channel, repo } = await setup(t);
  await channel.connect();
  const command = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT,'127.0.0.1',()=>console.log('up token=secret'))"`;
  const { service } = await channel.client.request('service.start', {
    name: 'api',
    command,
    health: { path: '/' },
  });
  await until(
    () => channel.serviceList.find((item) => item.id === service.id)?.status === 'healthy',
    15_000,
  );
  await assert.rejects(
    channel.client.request('service.start', { name: 'api', command }),
    /已在运行/,
  );
  const { lines } = await channel.client.request('service.logs', { serviceId: service.id });
  assert.ok(lines.some((line) => line.includes('up token=[hidden]')));
  await channel.client.request('service.stop', { serviceId: service.id });
  await until(
    () => channel.serviceList.find((item) => item.id === service.id)?.status === 'stopped',
    10_000,
  );

  await writeFile(
    path.join(repo, 'order.ts'),
    'export interface Order {\n  id: string;\n  refundStatus: string;\n}\n',
  );
  await writeFile(path.join(repo, 'refund.ts'), 'export const refund = 1;\n');
  const diff = await channel.client.request('workspace.diff', {});
  assert.deepEqual(diff.files.map((file) => [file.path, file.status, file.additions]).sort(), [
    ['order.ts', 'modified', 1],
    ['refund.ts', 'added', 1],
  ]);
  assert.match(diff.patch, /\+  refundStatus: string;/);
  const small = await channel.client.request('workspace.diff', { maxBytes: 1024 });
  assert.equal(small.truncated, false);
});

test('without Codex the agent reports unavailable instead of failing silently', async (t) => {
  const { channel } = await setup(t, { codex: false });
  await channel.connect();
  await channel.resync();
  assert.equal(channel.info?.agent.status, 'unavailable');
  await assert.rejects(
    channel.client.request('task.start', { taskId: 't1', text: 'hi' }),
    /未安装 Codex/,
  );
});

test('a daemon restart marks unfinished tasks unknown and keeps the sequence', async (t) => {
  const { channel, env } = await setup(t);
  await channel.connect();
  await channel.client.request('task.start', { taskId: 'held', text: '[hold]' });
  await until(() => channel.activeTask?.status === 'running', 10_000);
  const before = channel.client.latestSeq!;
  execFileSync(process.execPath, [program, 'stop'], { env, stdio: 'ignore' });
  await until(() => channel.client.state.status === 'reconnecting', 5000);
  await until(() => channel.client.state.status === 'ready', 15_000);
  const { task } = await channel.client.request('task.get', { taskId: 'held' });
  assert.equal(task.status, 'unknown');
  assert.ok(channel.client.latestSeq! > before, 'sequence continues across restarts');
});

test('commands stream output, report exit codes, time out, stop and are idempotent', async (t) => {
  const { channel, repo } = await setup(t);
  await channel.connect();
  const outputs: string[] = [];
  channel.subscribe({
    onEvent: ({ event }) => {
      if (event.type === 'command.output') outputs.push(event.text);
    },
  });
  const wait = async (commandId: string) => {
    for (;;) {
      const result = await channel.client.request('command.get', { commandId });
      if (result.command.status !== 'running') return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const first = await channel.client.request('command.run', {
    commandId: 'c1',
    command: 'echo building; echo token=abc 1>&2; pwd',
  });
  assert.equal(first.command.cwd, repo);
  const again = await channel.client.request('command.run', {
    commandId: 'c1',
    command: 'echo twice',
  });
  assert.equal(again.command.command, first.command.command, 'same commandId never runs twice');
  const done = await wait('c1');
  assert.equal(done.command.status, 'succeeded');
  assert.equal(done.command.exitCode, 0);
  assert.match(done.output, /building/);
  assert.match(done.output, /token=\[hidden\]/);
  assert.match(done.output, /order-api/);
  await until(() => outputs.join('').includes('building'), 3000);
  assert.doesNotMatch(outputs.join(''), /abc/);

  await channel.client.request('command.run', { commandId: 'c2', command: 'exit 3' });
  assert.equal((await wait('c2')).command.exitCode, 3);
  await channel.client.request('command.run', {
    commandId: 'c3',
    command: 'sleep 30',
    timeoutSeconds: 1,
  });
  const timed = await wait('c3');
  assert.equal(timed.command.status, 'failed');
  assert.equal(timed.command.signal, 'TIMEOUT');
  await channel.client.request('command.run', { commandId: 'c4', command: 'sleep 30' });
  await channel.client.request('command.stop', { commandId: 'c4' });
  assert.equal((await wait('c4')).command.status, 'cancelled');
  await assert.rejects(
    channel.client.request('command.run', { commandId: 'c5', command: 'true', cwd: 'missing-dir' }),
    /工作目录不存在/,
  );
  await channel.client.request('command.run', { commandId: 'c6', command: 'seq 1 5000' });
  await wait('c6');
  const full = await channel.client.request('command.get', { commandId: 'c6', tailBytes: 64 });
  assert.ok(full.truncated && full.output.trim().endsWith('5000'));
});

test('a daemon crash marks running commands unknown; a graceful stop cancels them', async (t) => {
  const { channel, env, home } = await setup(t);
  await channel.connect();
  await channel.client.request('command.run', { commandId: 'graceful', command: 'sleep 60' });
  execFileSync(process.execPath, [program, 'stop'], { env, stdio: 'ignore' });
  await until(() => channel.client.state.status === 'reconnecting', 5000);
  await until(() => channel.client.state.status === 'ready', 15_000);
  assert.equal(
    (await channel.client.request('command.get', { commandId: 'graceful' })).command.status,
    'cancelled',
  );
  await channel.client.request('command.run', { commandId: 'long', command: 'sleep 60' });
  const group = JSON.parse(readFileSync(path.join(home, 'state.json'), 'utf8')).groups
    .long as number;
  assert.ok(group > 0, 'the running command records its process group');
  const pid = Number(readFileSync(path.join(home, 'daemon.pid'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await until(() => channel.client.state.status === 'reconnecting', 5000);
  await until(() => channel.client.state.status === 'ready', 15_000);
  const { command } = await channel.client.request('command.get', { commandId: 'long' });
  assert.equal(command.status, 'unknown');
  // The orphaned process group from before the crash is cleaned up on restart.
  await until(() => {
    try {
      process.kill(-group, 0);
      return false;
    } catch {
      return true;
    }
  }, 5000);
});
