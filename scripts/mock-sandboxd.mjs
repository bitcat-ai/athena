#!/usr/bin/env node
// Reference behaviour for the Athena Sandbox Protocol (docs/sandbox/protocol.md).
// In-memory, no isolation, no real agent: for Athena tests and protocol comparison only.
//
// One process = one `athena-sandbox attach` connection into one Coder workspace. Set
// MOCK_SANDBOXD_STATE to a file path to persist state across processes, which stands in for
// the resident daemon inside the workspace.
//
// Scripted agent: the task text drives behaviour.
//   [approval] waits for an approval   [input] asks one question
//   [fail]     ends with failed        [hold]  keeps running until task.stop
//
// Fault injection via MOCK_SANDBOXD_MODE:
//   fatal | old-protocol | garbage | expire | hang-ping
// MOCK_SANDBOXD_DROP_FILE: when that file appears, it is removed and this connection
// exits, simulating a dropped ssh session while the daemon state survives.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const MODE = process.env.MOCK_SANDBOXD_MODE ?? '';
const STATE_FILE = process.env.MOCK_SANDBOXD_STATE;
const RETAIN = Number(process.env.MOCK_SANDBOXD_RETAIN ?? 10_000);
const STEP_MS = Number(process.env.MOCK_SANDBOXD_STEP_MS ?? 5);
const PROTOCOL = 1;

const E = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  PROTOCOL_UNSUPPORTED: -32001,
  NOT_FOUND: -32002,
  CONFLICT: -32003,
  EVENTS_EXPIRED: -32004,
  UNAVAILABLE: -32005,
  INVALID_STATE: -32007,
};
class RpcError extends Error {
  constructor(reason, message, data = {}) {
    super(message);
    this.code = E[reason];
    this.data = { reason, ...data };
  }
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

if (MODE === 'fatal') {
  send({ method: 'fatal', params: { reason: 'DAEMON_UNAVAILABLE', message: 'sandboxd 未运行' } });
  process.exit(3);
}

// ---- persistent state (stands in for the resident daemon) ----
// `requests` holds bookkeeping that never goes on the wire.
const blank = () => ({
  seq: 0,
  events: [],
  workspace: {
    repos: [{ url: 'git@git.example.test:pay/order-api.git', ref: 'main', commit: 'a1b2c3d', path: '/home/coder/order-api' }],
    agent: { id: 'codex', status: 'ready' },
  },
  tasks: {},
  services: {},
  requests: {},
});
let state = blank();
if (STATE_FILE && existsSync(STATE_FILE)) {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  // A restarted daemon must not resume runs it can no longer observe; only waiting tasks
  // persist here because their next step depends solely on a client decision.
  for (const task of Object.values(state.tasks))
    if (['queued', 'running', 'stopping'].includes(task.status)) {
      task.status = 'unknown';
      task.updatedAt = Date.now();
    }
}
function save() {
  if (!STATE_FILE) return;
  writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
  renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

let subscribed = false;
let handshaken = false;
let afterReply;
function emit(event) {
  const envelope = { seq: ++state.seq, at: Date.now(), event };
  state.events.push(envelope);
  if (state.events.length > RETAIN) state.events.splice(0, state.events.length - RETAIN);
  save();
  if (subscribed) send({ method: 'event', params: envelope });
}

const now = () => Date.now();
const terminal = (status) => ['completed', 'failed', 'cancelled', 'unknown'].includes(status);
const requireString = (value, name) => {
  if (typeof value !== 'string' || !value) throw new RpcError('INVALID_PARAMS', `${name} 无效`);
  return value;
};
const taskOf = (taskId) => {
  const task = state.tasks[taskId];
  if (!task) throw new RpcError('NOT_FOUND', '任务不存在');
  return task;
};
const serviceOf = (serviceId) => {
  const service = state.services[serviceId];
  if (!service) throw new RpcError('NOT_FOUND', '服务不存在');
  return service;
};

function setTask(task, patch) {
  Object.assign(task, patch, { updatedAt: now() });
  const activeTaskId = terminal(task.status) ? undefined : task.id;
  if (state.workspace.activeTaskId !== activeTaskId) {
    state.workspace.activeTaskId = activeTaskId;
    emit({ type: 'workspace.state', workspace: state.workspace });
  }
  emit({ type: 'task.state', task });
}
const taskEvent = (task, event) => emit({ type: 'task.event', taskId: task.id, event });
function setService(service, patch) {
  Object.assign(service, patch, { updatedAt: now() });
  emit({ type: 'service.state', service });
}

// ---- scripted agent ----
const timers = new Map();
const later = (task, fn) => {
  const timer = setTimeout(() => {
    timers.delete(task.id);
    if (!terminal(task.status) && task.status !== 'stopping') fn();
  }, STEP_MS);
  timers.set(task.id, timer);
};
function runAgent(task) {
  const request = state.requests[task.id] ?? {};
  setTask(task, { status: 'running' });
  taskEvent(task, { type: 'started', model: { requested: request.model?.model, model: 'mock-model' } });
  taskEvent(task, { type: 'status', status: 'thinking', label: '正在分析' });
  later(task, () => {
    taskEvent(task, { type: 'plan', steps: [{ step: '读取代码', status: 'inProgress' }] });
    const call = { id: `${task.id}-tool`, name: 'shell', input: { command: 'git status' }, startedAt: now() };
    taskEvent(task, { type: 'tool', call: { ...call, status: 'running' } });
    taskEvent(task, { type: 'tool', call: { ...call, status: 'done', output: 'clean', finishedAt: now() } });
    taskEvent(task, { type: 'delta', text: '已收到：' });
    if (request.text?.includes('[approval]')) return ask(task, 'approval');
    if (request.text?.includes('[input]')) return ask(task, 'input');
    afterAnswer(task);
  });
}
function ask(task, kind) {
  const request =
    kind === 'approval'
      ? { id: `${task.id}-approval`, title: '执行命令', detail: 'npm test', kind: 'command' }
      : {
          id: `${task.id}-input`,
          questions: [{ id: 'q', header: '分支', question: '基于哪个分支？', isSecret: false, options: [{ label: 'main', description: '主分支' }] }],
        };
  taskEvent(task, kind === 'approval' ? { type: 'approval', request } : { type: 'user-input', request });
  setTask(task, { status: 'waiting', pendingRequests: [{ kind, request }] });
}
function afterAnswer(task, answer) {
  const text = state.requests[task.id]?.text ?? '';
  later(task, () => {
    taskEvent(task, { type: 'delta', text: text.replace(/\[[a-z]+\]/g, '').trim() + (answer ? `（${answer}）` : '') });
    taskEvent(task, { type: 'plan', steps: [{ step: '读取代码', status: 'completed' }] });
    const tokens = { inputTokens: 12, outputTokens: 5, cachedInputTokens: null, cacheWriteInputTokens: null, reasoningOutputTokens: null, totalTokens: 17 };
    taskEvent(task, { type: 'usage', total: tokens, last: tokens });
    if (text.includes('[hold]')) return; // runs until task.stop
    if (text.includes('[fail]')) {
      taskEvent(task, { type: 'failed', message: '模拟失败', code: 'MOCK' });
      return setTask(task, { status: 'failed', failure: '模拟失败' });
    }
    taskEvent(task, { type: 'completed' });
    setTask(task, { status: 'completed' });
  });
}

// ---- methods ----
const handlers = {
  hello(params) {
    if (MODE === 'old-protocol' || params?.protocol !== PROTOCOL)
      throw new RpcError('PROTOCOL_UNSUPPORTED', '协议版本不支持', { supported: [MODE === 'old-protocol' ? 0 : PROTOCOL] });
    handshaken = true;
    return {
      protocol: PROTOCOL,
      server: { name: 'mock-sandboxd', version: '0.0.0' },
      latestSeq: state.seq,
      capabilities: { agents: ['codex'], services: true, diff: true },
    };
  },
  ping() {
    if (MODE === 'hang-ping') return new Promise(() => {});
    return { at: now() };
  },
  'events.subscribe'(params) {
    const after = params?.after;
    if (!Number.isInteger(after) || after < 0) throw new RpcError('INVALID_PARAMS', 'after 无效');
    const oldest = state.events[0]?.seq ?? state.seq + 1;
    if (MODE === 'expire' || (after < oldest - 1 && after < state.seq))
      throw new RpcError('EVENTS_EXPIRED', '事件已过期', { oldestSeq: oldest });
    // Reply first, then replay in order, then live events (see protocol §4).
    afterReply = () => {
      for (const envelope of state.events) if (envelope.seq > after) send({ method: 'event', params: envelope });
      subscribed = true;
    };
    return { latestSeq: state.seq };
  },
  'workspace.info': () => ({ workspace: state.workspace }),
  'workspace.diff'(params) {
    const patch = 'diff --git a/src/order.ts b/src/order.ts\n+  refundStatus: string;\n';
    const max = params?.maxBytes ?? 200 * 1024;
    return {
      base: 'a1b2c3d',
      files: [{ path: 'src/order.ts', status: 'modified', additions: 1, deletions: 0 }],
      patch: patch.slice(0, max),
      truncated: patch.length > max,
    };
  },
  'models.list': () => ({
    models: [{ id: 'mock-model', model: 'mock-model', name: 'Mock', description: '模拟模型', isDefault: true, efforts: [{ id: 'medium', description: '默认' }], defaultEffort: 'medium' }],
  }),
  'task.start'(params) {
    const taskId = requireString(params?.taskId, 'taskId');
    const existing = state.tasks[taskId];
    if (existing) return { task: existing }; // idempotent: never a second run
    if (typeof params.text !== 'string' || !params.text) throw new RpcError('INVALID_PARAMS', 'text 无效');
    if (state.workspace.agent.status !== 'ready') throw new RpcError('UNAVAILABLE', 'Agent 不可用');
    if (state.workspace.activeTaskId) throw new RpcError('CONFLICT', '工作区中已有运行中的任务');
    const task = { id: taskId, status: 'queued', pendingRequests: [], createdAt: now(), updatedAt: now() };
    state.tasks[taskId] = task;
    state.requests[taskId] = { text: params.text, context: params.context, model: params.model };
    setTask(task, {});
    setTimeout(() => runAgent(task), STEP_MS);
    return { task };
  },
  'task.get': (params) => ({ task: taskOf(params?.taskId) }),
  'task.stop'(params) {
    const task = taskOf(params?.taskId);
    if (terminal(task.status)) return { task };
    clearTimeout(timers.get(task.id));
    setTask(task, { status: 'stopping' });
    setTimeout(() => {
      for (const pending of task.pendingRequests) taskEvent(task, { type: 'request-resolved', requestId: pending.request.id });
      taskEvent(task, { type: 'cancelled' });
      setTask(task, { status: 'cancelled', pendingRequests: [] });
    }, STEP_MS);
    return { task };
  },
  'request.resolve'(params) {
    const task = taskOf(params?.taskId);
    const pending = task.pendingRequests.find((item) => item.request.id === params?.requestId);
    if (!pending || task.status !== 'waiting') throw new RpcError('NOT_FOUND', '请求不存在或已处理');
    const resolution = params.resolution;
    if (resolution?.kind !== pending.kind) throw new RpcError('INVALID_PARAMS', '回应类型与请求不符');
    taskEvent(task, { type: 'request-resolved', requestId: pending.request.id });
    setTask(task, { status: 'running', pendingRequests: [] });
    if (pending.kind === 'approval' && !resolution.approved) {
      taskEvent(task, { type: 'failed', message: '审批被拒绝' });
      setTask(task, { status: 'failed', failure: '审批被拒绝' });
    } else afterAnswer(task, pending.kind === 'input' ? Object.values(resolution.answers ?? {}).flat().join(',') : undefined);
    return {};
  },
  'service.list': () => ({ services: Object.values(state.services) }),
  'service.start'(params) {
    const name = requireString(params?.name, 'name');
    if (!params.command) throw new RpcError('NOT_FOUND', '仓库中没有声明这个服务');
    const running = Object.values(state.services).find((item) => item.name === name);
    if (running && running.status !== 'stopped' && running.status !== 'failed') throw new RpcError('CONFLICT', '服务已在运行');
    const service = running ?? { id: `svc_${randomUUID().slice(0, 8)}`, name, port: params.port ?? 3000 };
    state.services[service.id] = service;
    setService(service, { status: 'starting', message: undefined });
    const crash = params.command.includes('crash');
    setTimeout(() => setService(service, { status: crash ? 'failed' : 'healthy', message: crash ? '进程退出 (1)' : undefined }), STEP_MS);
    return { service };
  },
  'service.stop'(params) {
    const service = serviceOf(params?.serviceId);
    setService(service, { status: 'stopped' });
    return { service };
  },
  'service.restart'(params) {
    const service = serviceOf(params?.serviceId);
    setService(service, { status: 'starting' });
    setTimeout(() => setService(service, { status: 'healthy' }), STEP_MS);
    return { service };
  },
  'service.logs'(params) {
    serviceOf(params?.serviceId);
    return { lines: ['listening on $PORT'] };
  },
};

const DROP_FILE = process.env.MOCK_SANDBOXD_DROP_FILE;
if (DROP_FILE)
  setInterval(() => {
    if (!existsSync(DROP_FILE)) return;
    rmSync(DROP_FILE, { force: true });
    process.exit(1);
  }, 5).unref();

// ---- wire ----
if (MODE === 'garbage') for (let i = 0; i < 25; i++) process.stdout.write('not json\n');
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: E.PARSE_ERROR, message: '不是合法的 JSON', data: { reason: 'PARSE_ERROR' } } });
  }
  const { id, method, params } = message ?? {};
  if (message?.jsonrpc !== '2.0' || typeof method !== 'string' || id === undefined)
    return send({ id: id ?? null, error: { code: E.INVALID_REQUEST, message: '不是合法的请求', data: { reason: 'INVALID_REQUEST' } } });
  const handler = handlers[method];
  try {
    if (!handler) throw new RpcError('METHOD_NOT_FOUND', `未知方法 ${method}`);
    if (!handshaken && method !== 'hello') throw new RpcError('INVALID_STATE', '请先握手');
    // Synchronous handlers stay synchronous so replies keep request order relative to events.
    const value = handler(params ?? {});
    send({ id, result: value instanceof Promise ? await value : value });
    afterReply?.();
    afterReply = undefined;
  } catch (error) {
    if (!(error instanceof RpcError)) error = new RpcError('INVALID_PARAMS', String(error?.message ?? error));
    send({ id, error: { code: error.code, message: error.message, data: error.data } });
  }
});
lines.on('close', () => process.exit(0));
