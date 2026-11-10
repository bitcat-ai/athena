/** Turn phase state machine and its vocabulary: the single source for every status surface. */
import type {
  AgentId,
  AgentPlanStep,
  ApprovalRequest,
  ChatMessage,
  PendingAgentRequest,
  ToolCall,
  UserInputRequest,
} from './types';

export type RequestKind = 'approval' | 'input' | 'handoff';
export type TurnOutcome = 'succeeded' | 'blocked' | 'failed' | 'cancelled';
export type TurnPhase =
  | { kind: 'preparing' }
  | { kind: 'thinking' }
  | { kind: 'acting'; tool: string; target?: string }
  | { kind: 'verifying'; checkpoint: string }
  | { kind: 'waiting'; request: RequestKind; requestId: string }
  | { kind: 'stopping' }
  | { kind: 'ended'; outcome: TurnOutcome; confirmed?: 'user' };
/** How a request left the conversation; kept on the message so history shows what the user decided. */
export interface ResolvedRequest {
  id: string;
  kind: RequestKind;
  summary: string;
  resolution: 'approved' | 'rejected' | 'answered' | 'done' | 'dismissed';
  at: number;
}
export type ToolKind = 'read' | 'edit' | 'run' | 'web' | 'click' | 'verify' | 'wait' | 'think';
export type GlyphKind = ToolKind | 'connect' | 'stopping' | 'done' | 'warn' | 'fail' | 'stopped';

const names: Record<string, string> = {
  browser_context: '查看当前网页',
  snapshot: '查看页面结构',
  screenshot: '截取页面',
  act: '操作网页',
  run: '执行网页步骤',
  read: '读取网页内容',
  grep: '查找内容',
  diff: '查看页面变化',
  wait: '等待页面条件',
  upload: '上传文件',
  download: '下载文件',
  pdf: '保存页面',
  request_human_help: '请求你处理网页',
  await_human_help: '等待你交还网页',
  plan: '更新任务计划',
  checkpoint: '核对结果',
  click: '点击元素',
  fill: '填写内容',
  select: '选择选项',
  navigate: '打开网页',
  scroll: '滚动页面',
  key: '键盘操作',
  logs: '读取页面日志',
  inspect: '检查元素',
  query: '查找元素',
  edit: '预览元素修改',
  undo: '撤销页面修改',
  tabs: '查看标签页',
  new_tab: '新建标签页',
  switch_tab: '切换标签页',
  close_tab: '关闭标签页',
  focus_page: '切换页面',
  commandExecution: '执行命令',
  fileChange: '修改文件',
  status: '检查连接',
  controls: '提供调整控件',
};
const nativeNames: Record<string, string> = {
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  multiedit: '修改文件',
  bash: '执行命令',
  shell: '执行命令',
  grep: '搜索文件内容',
  find: '查找文件',
  glob: '查找文件',
  semsearch: '搜索代码',
  ls: '列出目录',
  webfetch: '打开网页',
  websearch: '搜索网页',
};
const kinds: Record<string, ToolKind> = {
  browser_context: 'read',
  snapshot: 'read',
  screenshot: 'read',
  read: 'read',
  grep: 'read',
  diff: 'read',
  logs: 'read',
  inspect: 'read',
  query: 'read',
  tabs: 'read',
  status: 'read',
  navigate: 'web',
  new_tab: 'web',
  switch_tab: 'web',
  close_tab: 'web',
  focus_page: 'web',
  wait: 'web',
  pdf: 'web',
  upload: 'web',
  download: 'web',
  act: 'click',
  run: 'click',
  click: 'click',
  fill: 'click',
  select: 'click',
  scroll: 'click',
  key: 'click',
  edit: 'edit',
  undo: 'edit',
  controls: 'edit',
  checkpoint: 'verify',
  request_human_help: 'wait',
  await_human_help: 'wait',
  commandExecution: 'run',
  fileChange: 'edit',
};
const nativeKinds: Record<string, ToolKind> = {
  read: 'read',
  ls: 'read',
  grep: 'read',
  find: 'read',
  glob: 'read',
  semsearch: 'read',
  write: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  bash: 'run',
  shell: 'run',
  webfetch: 'web',
  websearch: 'web',
};
// Short verbs read better than the full tool name once a concrete target follows them.
const verbs: Record<string, string> = {
  commandExecution: '运行',
  fileChange: '修改',
  navigate: '打开',
  new_tab: '打开',
};
const nativeVerbs: Record<string, string> = {
  read: '读取',
  write: '写入',
  edit: '修改',
  multiedit: '修改',
  bash: '运行',
  shell: '运行',
  webfetch: '打开',
};
const bare = (name: string) => name.replace(/^(?:workbench_browser_|neo_)/, '');
const native = (name: string) => name.replace(/ToolCall$/, '').toLowerCase();
/** Bookkeeping tools that are shown as plan steps and checkpoints, never as actions. */
export const isBookkeepingTool = (name: string) => ['plan', 'checkpoint'].includes(bare(name));

export function toolTitle(name: string, agent: AgentId = 'codex'): string {
  return (agent !== 'codex' ? nativeNames[native(name)] : undefined) ?? names[bare(name)] ?? name;
}
export function toolKind(name: string, agent: AgentId = 'codex'): ToolKind {
  return (
    (agent !== 'codex' ? nativeKinds[native(name)] : undefined) ?? kinds[bare(name)] ?? 'think'
  );
}
function oneLine(value: string, limit = 120): string {
  const line =
    value
      .split('\n')
      .find((item) => item.trim())
      ?.trim() ?? '';
  // Codex wraps commands in a login shell; only the inner command means something to the user.
  const inner = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(line)?.[2] ?? line;
  return inner.length > limit ? inner.slice(0, limit - 1) + '…' : inner;
}
function shortPath(value: string): string {
  const parts = value.split('/').filter(Boolean);
  return value.startsWith('/') && parts.length > 3 ? parts.slice(-3).join('/') : value;
}
/** The object a tool call acts on, or '' when its input names nothing a user would recognise. */
export function toolTarget(tool: Pick<ToolCall, 'name' | 'input'>): string {
  const { input } = tool;
  if (typeof input === 'string') return oneLine(input);
  if (!input || typeof input !== 'object') return '';
  const changed = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap((item) => (typeof item?.path === 'string' ? [item.path] : []))
      : value && typeof value === 'object'
        ? Object.keys(value)
        : [];
  const data = input as Record<string, unknown>;
  const files = Array.isArray(input) ? changed(input) : changed(data.changes);
  if (files.length)
    return shortPath(files[0]) + (files.length > 1 ? ` 等 ${files.length} 个文件` : '');
  if (Array.isArray(input)) return '';
  if (typeof data.command === 'string') return oneLine(data.command);
  if (Array.isArray(data.command)) return oneLine(data.command.join(' '));
  if (typeof data.url === 'string') {
    try {
      const url = new URL(data.url);
      return url.hostname + (url.pathname === '/' ? '' : url.pathname);
    } catch {
      /* No URL to show. */
    }
  }
  for (const key of ['path', 'file_path', 'filePath', 'file'])
    if (typeof data[key] === 'string' && data[key]) return shortPath(data[key] as string);
  if (typeof data.page === 'number') return `页面 ${data.page}`;
  return '';
}
/** Files a turn changed, for the result summary. */
export function changedFiles(tools: ToolCall[], agent: AgentId = 'codex'): number {
  const files = new Set<string>();
  for (const tool of tools) {
    if (tool.status !== 'done' || toolKind(tool.name, agent) !== 'edit') continue;
    const { input } = tool;
    const data = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const changes = Array.isArray(input) ? input : data.changes;
    if (Array.isArray(changes)) {
      for (const item of changes) if (typeof item?.path === 'string') files.add(item.path);
    } else if (changes && typeof changes === 'object') {
      for (const file of Object.keys(changes)) files.add(file);
    } else
      for (const key of ['path', 'file_path', 'filePath', 'file'])
        if (typeof data[key] === 'string') files.add(data[key] as string);
  }
  return files.size;
}

/** Identity of one open request. Request ids alone repeat across conversations and turns. */
export const requestKey = (pending: PendingAgentRequest) =>
  JSON.stringify([pending.conversationId, pending.messageId, pending.request.id]);

export function requestKind(pending: Pick<PendingAgentRequest, 'kind' | 'request'>): RequestKind {
  if (pending.kind === 'input') return 'input';
  return (pending.request as ApprovalRequest).action === 'browser-help' ? 'handoff' : 'approval';
}
/** One line that identifies a request after it has been handled. */
export function requestSummary(pending: Pick<PendingAgentRequest, 'kind' | 'request'>): string {
  if (pending.kind === 'input')
    return (pending.request as UserInputRequest).questions[0]?.question ?? '';
  const request = pending.request as ApprovalRequest;
  if (request.action === 'browser-help') return request.title;
  return request.target || oneLine(request.detail, 80) || request.title;
}
const resolutions: Record<ResolvedRequest['resolution'], string> = {
  approved: '已允许',
  rejected: '已拒绝',
  answered: '已回答',
  done: '你已在页面完成操作',
  dismissed: '已停止处理',
};
export function resolvedText(request: ResolvedRequest): string {
  const label = resolutions[request.resolution];
  return request.summary ? `${label} · ${request.summary}` : label;
}

/** Phase of a turn that is still running, from the facts the host already tracks. */
export function runningPhase(turn: {
  connected: boolean;
  stopping: boolean;
  requests: Array<Pick<PendingAgentRequest, 'kind' | 'request'>>;
  tools: ToolCall[];
}): TurnPhase {
  if (turn.stopping) return { kind: 'stopping' };
  // The oldest request is the one the user has to handle first.
  const pending = turn.requests[0];
  if (pending)
    return { kind: 'waiting', request: requestKind(pending), requestId: pending.request.id };
  const tool = turn.tools.findLast((item) => item.status === 'running');
  if (tool && bare(tool.name) === 'checkpoint') {
    const summary = (tool.input as { summary?: unknown } | null)?.summary;
    return { kind: 'verifying', checkpoint: typeof summary === 'string' ? summary : '' };
  }
  if (tool && bare(tool.name) !== 'plan') {
    const target = toolTarget(tool);
    return { kind: 'acting', tool: tool.name, ...(target ? { target } : {}) };
  }
  return turn.connected || turn.tools.length ? { kind: 'thinking' } : { kind: 'preparing' };
}
/** Remembers when each plan step first left pending so the timeline can order it among actions. */
export function stampPlan(
  previous: AgentPlanStep[] | undefined,
  steps: AgentPlanStep[],
  at: number,
): AgentPlanStep[] {
  return steps.map((step) => {
    const startedAt =
      previous?.find((item) => item.step === step.step)?.startedAt ??
      (step.status === 'pending' ? undefined : at);
    return startedAt === undefined ? step : { ...step, startedAt };
  });
}
/** A web result nobody verified: the turn stopped without confirming what the page shows. */
export function unverified(message: Pick<ChatMessage, 'execution'>): boolean {
  const events = message.execution ?? [];
  if (events.some((event) => event.kind === 'cancelled')) return false;
  const last = events.findLast((event) =>
    ['recovery', 'checkpoint', 'human-help'].includes(event.kind),
  );
  return last?.status === 'blocked' || last?.outcome === 'unknown';
}
/** The action a failed turn stopped on, numbered the way the timeline counts steps. */
export function failedStep(
  message: Pick<ChatMessage, 'tools'>,
): { index: number; tool: ToolCall } | undefined {
  const tools = (message.tools ?? []).filter((tool) => !isBookkeepingTool(tool.name));
  const index = tools.findLastIndex((tool) => tool.status === 'error');
  return index < 0 ? undefined : { index: index + 1, tool: tools[index] };
}
/** Checkpoints the agent could not confirm against the page. */
export function unverifiedChecks(message: Pick<ChatMessage, 'execution'>) {
  return (message.execution ?? []).filter(
    (event) => event.kind === 'checkpoint' && event.outcome === 'unknown',
  );
}
export function endedOutcome(
  message: Pick<ChatMessage, 'status' | 'execution'>,
  cancelled = false,
): TurnOutcome {
  if (cancelled || message.execution?.some((event) => event.kind === 'cancelled'))
    return 'cancelled';
  if (unverified(message)) return 'blocked';
  return message.status === 'error' ? 'failed' : 'succeeded';
}
/** Messages saved before phases existed still render the right row. */
export function phaseOfMessage(message: ChatMessage): TurnPhase {
  if (message.phase) return message.phase;
  if (message.status === 'streaming')
    return runningPhase({
      connected: !!message.text || !!message.model,
      stopping: false,
      requests: [],
      tools: message.tools ?? [],
    });
  return { kind: 'ended', outcome: endedOutcome(message, message.text === '任务已停止') };
}
/**
 * What a surface shows: the stored phase, unless a request for this turn is still open. An open
 * request wins even over a stale ended phase, because hiding it would leave the turn hanging.
 */
export function displayPhase(
  message: ChatMessage,
  requests: Array<Pick<PendingAgentRequest, 'kind' | 'request'>> = [],
): TurnPhase {
  const phase = phaseOfMessage(message);
  const pending = requests[0];
  if (!pending || phase.kind === 'stopping') return phase;
  return { kind: 'waiting', request: requestKind(pending), requestId: pending.request.id };
}
/** The reply worth rendering; a bare failure or stop notice already shows in the row and card. */
export function replyText(message: ChatMessage): string {
  const phase = phaseOfMessage(message);
  if (phase.kind !== 'ended' || phase.outcome === 'succeeded') return message.text;
  return message.text === message.failure || message.text === '任务已停止' ? '' : message.text;
}
/**
 * What the copy entry of a turn hands over: its reply, or, on the latest turn that only failed,
 * the failure its outcome card shows in place of a reply.
 */
export function copyableText(message: ChatMessage, last: boolean): string {
  const reply = replyText(message);
  if (reply || !last) return reply;
  const phase = phaseOfMessage(message);
  const failed = phase.kind === 'ended' && phase.outcome === 'failed';
  return failed && message.text === message.failure ? message.text : '';
}
/** Coarse status kept for consumers that predate phases. */
export function legacyStatus(
  phase: TurnPhase,
): 'starting' | 'thinking' | 'working' | 'waiting' | 'idle' {
  switch (phase.kind) {
    case 'preparing':
      return 'starting';
    case 'thinking':
      return 'thinking';
    case 'acting':
    case 'verifying':
      return 'working';
    case 'waiting':
    case 'stopping':
      return 'waiting';
    case 'ended':
      return 'idle';
  }
}

const waiting: Record<RequestKind, string> = {
  approval: '等待你的批准',
  input: '等待你的回答',
  handoff: '等你在页面完成操作',
};
const outcomes: Record<TurnOutcome, string> = {
  succeeded: '已完成',
  blocked: '结果待核对',
  failed: '未完成',
  cancelled: '已停止',
};
const outcomeGlyphs: Record<TurnOutcome, GlyphKind> = {
  succeeded: 'done',
  blocked: 'warn',
  failed: 'fail',
  cancelled: 'stopped',
};
export function phaseTitle(phase: TurnPhase, agent: AgentId = 'codex'): string {
  switch (phase.kind) {
    case 'preparing':
      return '正在连接';
    case 'thinking':
      return '思考中';
    case 'acting':
      return (
        (phase.target &&
          (agent !== 'codex' ? nativeVerbs[native(phase.tool)] : verbs[bare(phase.tool)])) ||
        toolTitle(phase.tool, agent)
      );
    case 'verifying':
      return phase.checkpoint ? `核对：${phase.checkpoint}` : '正在核对结果';
    case 'waiting':
      return waiting[phase.request];
    case 'stopping':
      return '正在停止';
    case 'ended':
      return outcomes[phase.outcome];
  }
}
export function phaseGlyph(phase: TurnPhase, agent: AgentId = 'codex'): GlyphKind {
  switch (phase.kind) {
    case 'preparing':
      return 'connect';
    case 'thinking':
      return 'think';
    case 'acting':
      return toolKind(phase.tool, agent);
    case 'verifying':
      return 'verify';
    case 'waiting':
      return 'wait';
    case 'stopping':
      return 'stopping';
    case 'ended':
      return outcomeGlyphs[phase.outcome];
  }
}
/** Full sentence for surfaces outside the conversation, such as the browser footer. */
export function phaseText(phase: TurnPhase, agent: AgentId = 'codex'): string {
  const title = phaseTitle(phase, agent);
  return phase.kind === 'acting' && phase.target ? `${title} ${phase.target}` : title;
}
export const samePhase = (a?: TurnPhase, b?: TurnPhase) => JSON.stringify(a) === JSON.stringify(b);
