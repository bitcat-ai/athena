import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changedFiles,
  copyableText,
  endedOutcome,
  failedStep,
  legacyStatus,
  phaseGlyph,
  phaseOfMessage,
  phaseText,
  phaseTitle,
  replyText,
  requestSummary,
  resolvedText,
  runningPhase,
  stampPlan,
  toolKind,
  toolTarget,
  toolTitle,
} from '../src/shared/phase.ts';
import { activityItems, formatElapsed, summaryMeta } from '../src/shared/activity.ts';
import type { ChatMessage, PendingAgentRequest, ToolCall } from '../src/shared/types.ts';

const tool = (patch: Partial<ToolCall> & Pick<ToolCall, 'name'>): ToolCall => ({
  id: patch.name,
  input: {},
  status: 'running',
  ...patch,
});
const approval = (action?: 'browser-help'): PendingAgentRequest => ({
  conversationId: 'c',
  messageId: 'm',
  kind: 'approval',
  request: {
    id: 'a1',
    kind: 'command',
    title: '允许执行此命令？',
    detail: '构建项目\nnpm run build',
    target: 'npm run build',
    ...(action ? { action } : {}),
  },
});
const question: PendingAgentRequest = {
  conversationId: 'c',
  messageId: 'm',
  kind: 'input',
  request: {
    id: 'q1',
    questions: [{ id: 'env', header: '环境', question: '使用哪个环境？', isSecret: false }],
  },
};
const idle = { connected: true, stopping: false, requests: [], tools: [] };

test('a running turn has exactly one phase, in priority order', () => {
  assert.deepEqual(runningPhase({ ...idle, connected: false }), { kind: 'preparing' });
  assert.deepEqual(runningPhase(idle), { kind: 'thinking' });
  const command = tool({ name: 'commandExecution', input: '/bin/zsh -lc "npm run build"' });
  assert.deepEqual(runningPhase({ ...idle, tools: [command] }), {
    kind: 'acting',
    tool: 'commandExecution',
    target: 'npm run build',
  });
  const checkpoint = tool({ name: 'neo_checkpoint', input: { summary: '标题显示为欢迎回来' } });
  assert.deepEqual(runningPhase({ ...idle, tools: [command, checkpoint] }), {
    kind: 'verifying',
    checkpoint: '标题显示为欢迎回来',
  });
  // A request outranks the tool that raised it, and stopping outranks everything.
  assert.deepEqual(runningPhase({ ...idle, tools: [command], requests: [approval()] }), {
    kind: 'waiting',
    request: 'approval',
    requestId: 'a1',
  });
  assert.equal(
    (runningPhase({ ...idle, requests: [approval('browser-help')] }) as any).request,
    'handoff',
  );
  assert.equal((runningPhase({ ...idle, requests: [question] }) as any).request, 'input');
  assert.deepEqual(
    runningPhase({ ...idle, stopping: true, tools: [command], requests: [approval()] }),
    { kind: 'stopping' },
  );
  // Finished tools and plan bookkeeping never count as acting.
  assert.deepEqual(
    runningPhase({
      ...idle,
      connected: false,
      tools: [{ ...command, status: 'done' }, tool({ name: 'neo_plan' })],
    }),
    { kind: 'thinking' },
  );
});

test('an unverified web result ends blocked, not failed', () => {
  const event = (kind: any, patch = {}) => ({ id: kind, taskId: 'm', at: 1, kind, ...patch });
  assert.equal(endedOutcome({ status: 'done' }), 'succeeded');
  assert.equal(endedOutcome({ status: 'error' }), 'failed');
  assert.equal(endedOutcome({ status: 'error' }, true), 'cancelled');
  assert.equal(
    endedOutcome({
      status: 'error',
      execution: [event('checkpoint', { status: 'blocked', outcome: 'unknown' })] as any,
    }),
    'blocked',
  );
  assert.equal(
    endedOutcome({
      status: 'done',
      execution: [
        event('recovery', { status: 'blocked', outcome: 'unknown' }),
        event('checkpoint', { status: 'succeeded', outcome: 'verified' }),
      ] as any,
    }),
    'succeeded',
    'a later verified checkpoint clears the earlier doubt',
  );
  assert.equal(
    endedOutcome({
      status: 'error',
      execution: [
        event('recovery', { status: 'blocked', outcome: 'unknown' }),
        event('cancelled', { status: 'failed' }),
      ] as any,
    }),
    'cancelled',
  );
});

test('messages saved before phases existed still resolve to a phase', () => {
  const base: ChatMessage = { id: 'm', role: 'assistant', text: '好了', createdAt: 1 };
  assert.deepEqual(phaseOfMessage({ ...base, status: 'done' }), {
    kind: 'ended',
    outcome: 'succeeded',
  });
  assert.deepEqual(phaseOfMessage({ ...base, status: 'error', text: '任务已停止' }), {
    kind: 'ended',
    outcome: 'cancelled',
  });
  assert.deepEqual(phaseOfMessage({ ...base, text: '', status: 'streaming' }), {
    kind: 'preparing',
  });
  const stored = { kind: 'ended', outcome: 'succeeded', confirmed: 'user' } as const;
  assert.equal(phaseOfMessage({ ...base, status: 'error', phase: stored }), stored);
});

test('vocabulary: titles, glyphs and legacy status come from the phase alone', () => {
  assert.equal(phaseTitle({ kind: 'preparing' }), '正在连接');
  assert.equal(phaseTitle({ kind: 'thinking' }), '思考中');
  assert.equal(phaseTitle({ kind: 'stopping' }), '正在停止');
  assert.equal(phaseTitle({ kind: 'verifying', checkpoint: '标题已更新' }), '核对：标题已更新');
  assert.equal(
    phaseTitle({ kind: 'waiting', request: 'handoff', requestId: 'x' }),
    '等你在页面完成操作',
  );
  assert.equal(phaseTitle({ kind: 'ended', outcome: 'blocked' }), '结果待核对');
  const run = { kind: 'acting', tool: 'commandExecution', target: 'npm test' } as const;
  assert.equal(phaseText(run), '运行 npm test');
  assert.equal(phaseTitle({ kind: 'acting', tool: 'commandExecution' }), '执行命令');
  assert.equal(
    phaseTitle({ kind: 'acting', tool: 'neo_snapshot', target: '页面 2' }),
    '查看页面结构',
  );
  assert.equal(
    phaseText({ kind: 'acting', tool: 'read', target: 'src/a.ts' }, 'pi'),
    '读取 src/a.ts',
  );
  assert.equal(phaseGlyph(run), 'run');
  assert.equal(phaseGlyph({ kind: 'acting', tool: 'mystery_tool' }), 'think');
  assert.equal(phaseGlyph({ kind: 'ended', outcome: 'succeeded' }), 'done');
  assert.equal(phaseGlyph({ kind: 'ended', outcome: 'cancelled' }), 'stopped');
  assert.equal(legacyStatus({ kind: 'preparing' }), 'starting');
  assert.equal(legacyStatus(run), 'working');
  assert.equal(legacyStatus({ kind: 'stopping' }), 'waiting');
  assert.equal(legacyStatus({ kind: 'ended', outcome: 'failed' }), 'idle');
});

test('tools map to a glyph kind, a title and a recognisable target', () => {
  assert.equal(toolKind('fileChange'), 'edit');
  assert.equal(toolKind('neo_navigate'), 'web');
  assert.equal(toolKind('neo_act'), 'click');
  assert.equal(toolKind('workbench_browser_snapshot'), 'read');
  assert.equal(toolKind('grepToolCall', 'cursor'), 'read');
  assert.equal(toolKind('bash', 'pi'), 'run');
  assert.equal(toolTitle('read', 'pi'), '读取文件');
  assert.equal(toolTitle('write', 'pi'), '写入文件');
  assert.equal(toolTitle('neo_read'), '读取网页内容');
  assert.equal(toolTitle('mystery_tool'), 'mystery_tool');
  assert.equal(
    toolTarget({ name: 'neo_navigate', input: { url: 'https://example.com/docs?q=1' } }),
    'example.com/docs',
  );
  assert.equal(toolTarget({ name: 'neo_snapshot', input: { page: 2 } }), '页面 2');
  assert.equal(
    toolTarget({ name: 'read', input: { path: '/Users/me/project/src/renderer/App.tsx' } }),
    'src/renderer/App.tsx',
  );
  const changes = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }];
  assert.equal(toolTarget({ name: 'fileChange', input: changes }), 'src/a.ts 等 2 个文件');
  assert.equal(toolTarget({ name: 'neo_act', input: { action: 'click' } }), '');
  assert.equal(
    changedFiles([
      tool({ name: 'fileChange', input: changes, status: 'done' }),
      tool({ name: 'fileChange', input: [{ path: 'src/a.ts' }], status: 'done' }),
      tool({ name: 'fileChange', input: [{ path: 'src/c.ts' }], status: 'error' }),
    ]),
    2,
  );
});

test('handled requests keep one line of what the user decided', () => {
  assert.equal(requestSummary(approval()), 'npm run build');
  assert.equal(requestSummary(question), '使用哪个环境？');
  const resolved = { id: 'a1', kind: 'approval', summary: 'npm run build', at: 1 } as const;
  assert.equal(resolvedText({ ...resolved, resolution: 'approved' }), '已允许 · npm run build');
  assert.equal(resolvedText({ ...resolved, resolution: 'rejected' }), '已拒绝 · npm run build');
  assert.equal(
    resolvedText({ ...resolved, kind: 'handoff', summary: '', resolution: 'done' }),
    '你已在页面完成操作',
  );
});

test('the timeline merges plan, actions, checkpoints and requests by time', () => {
  const plan = stampPlan(
    undefined,
    [
      { step: '修改标题', status: 'inProgress' },
      { step: '核对页面', status: 'pending' },
    ],
    10,
  );
  assert.deepEqual(
    plan.map((step) => step.startedAt),
    [10, undefined],
  );
  const next = stampPlan(
    plan,
    [
      { step: '修改标题', status: 'completed' },
      { step: '核对页面', status: 'inProgress' },
    ],
    40,
  );
  assert.deepEqual(
    next.map((step) => step.startedAt),
    [10, 40],
    'a step keeps the time it first started',
  );
  const message: ChatMessage = {
    id: 'm',
    role: 'assistant',
    text: '',
    createdAt: 0,
    endedAt: 61_000,
    status: 'done',
    plan: next,
    tools: [
      tool({ name: 'fileChange', input: [{ path: 'src/a.ts' }], status: 'done', startedAt: 20 }),
      tool({ name: 'neo_plan', status: 'done', startedAt: 39 }),
      tool({ name: 'commandExecution', input: 'npm run build', status: 'error', startedAt: 30 }),
      tool({ name: 'neo_snapshot', input: { page: 1 }, status: 'done', startedAt: 50 }),
    ],
    requests: [
      { id: 'a1', kind: 'approval', summary: 'npm run build', resolution: 'approved', at: 25 },
    ],
    execution: [
      {
        id: 'c1',
        taskId: 'm',
        at: 60,
        kind: 'checkpoint',
        status: 'succeeded',
        outcome: 'verified',
        summary: '标题显示为欢迎回来',
        evidence: '欢迎回来',
      },
    ],
  };
  assert.deepEqual(
    activityItems(message).map((item) => `${item.kind}:${'text' in item ? item.text : item.id}`),
    [
      'plan:修改标题',
      'tool:fileChange',
      'request:已允许 · npm run build',
      'tool:commandExecution',
      'plan:核对页面',
      'tool:neo_snapshot',
      'check:已核对 · 标题显示为欢迎回来',
    ],
  );
  assert.deepEqual(summaryMeta(message), ['3 步', '核对 1 处', '1 个文件', '1m 1s']);
  assert.deepEqual(summaryMeta({ ...message, status: 'error' }), ['完成 2 步', '1m 1s']);
  assert.deepEqual(failedStep(message)?.index, 2);
  assert.equal(formatElapsed(38_400), '38s');
  // An interrupted turn never shows a step as still in flight.
  const stopped = activityItems({
    ...message,
    status: 'error',
    plan: [{ step: '核对页面', status: 'inProgress' }],
    tools: [tool({ name: 'neo_act' })],
    execution: [],
    requests: [],
  });
  assert.deepEqual(
    stopped.map((item) => 'state' in item && item.state),
    ['todo', 'stopped'],
  );
});

test('a turn offers its reply for copying, or the bare failure its outcome card shows', () => {
  const message = (patch: Partial<ChatMessage>): ChatMessage => ({
    id: 'a',
    role: 'assistant',
    text: '',
    createdAt: 0,
    status: 'done',
    ...patch,
  });
  const answered = message({ text: '已完成' });
  assert.equal(copyableText(answered, false), '已完成');
  // A failed turn that still said something: the reply is copied, the reason stays in the card.
  const partial = message({ text: '改了一半', status: 'error', failure: '模型服务中断' });
  assert.equal(replyText(partial), '改了一半');
  assert.equal(copyableText(partial, true), '改了一半');
  // Only the failure: no reply is rendered, and the card that shows it exists on the latest turn.
  const bare = message({ text: '模型服务中断', status: 'error', failure: '模型服务中断' });
  assert.equal(replyText(bare), '');
  assert.equal(copyableText(bare, true), '模型服务中断');
  assert.equal(copyableText(bare, false), '');
  assert.equal(copyableText(message({ text: '任务已停止', status: 'error' }), true), '');
});
