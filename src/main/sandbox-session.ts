import { randomUUID } from 'node:crypto';
import type { AgentSession, AgentSessionOptions } from './agent-session';
import type { AgentEvent, BrowserTool, ElementRef } from '../shared/types';
import { zeroTokens, type ModelOption, type ModelSelection } from '../shared/usage';
import type { SandboxEventEnvelope, SandboxTaskEvent } from '../shared/sandbox-protocol';
import { SandboxError, redact } from './sandbox-client';
import type { WorkspaceChannel } from './workspace-channel';
import { unavailableProviderSkillDiscovery } from '../shared/provider-skills';
import type { ProviderSkill } from '../shared/skills';
import type { ImageAttachment } from '../shared/images';

export interface SandboxSessionOptions extends Pick<AgentSessionOptions, 'onEvent' | 'onClose'> {
  channel: WorkspaceChannel;
  /** Stable id of the Coder workspace, used as the thread id for usage records. */
  workspaceId: string;
}

interface Run {
  taskId: string;
  requested?: string;
  text: string;
  /** Request ids the user still has to answer, as last reported by the sandbox. */
  requests: Map<string, 'approval' | 'input'>;
  stopping: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
}

const MAX_TEXT = 64 * 1024;
const MAX_CONTEXT = 256 * 1024;
const START_ATTEMPTS = 3;
const STOP_TIMEOUT_MS = 15_000;

function elementContext(element: ElementRef): string {
  // The browser stays on the Mac; the remote agent only gets a description to search for.
  const {
    ref: _ref,
    backendNodeId: _node,
    tabId: _tab,
    frameId: _frame,
    documentId: _doc,
    nodeId: _id,
    ...rest
  } = element;
  return `<selected_element>\n${JSON.stringify(rest, null, 2).slice(0, 8000)}\n</selected_element>`;
}

/**
 * AgentSession over a remote sandbox. Closing it detaches locally; the remote task keeps
 * running in sandboxd and can be stopped from any connected client.
 */
export class SandboxSession implements AgentSession {
  private active?: Run;
  private closed = false;
  private stopTimer?: NodeJS.Timeout;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: SandboxSessionOptions) {
    this.unsubscribe = options.channel.subscribe({
      onEvent: (envelope) => this.receive(envelope),
      onResync: () => void this.reconcile(),
      onConnection: (state) => {
        if (state.status === 'failed' && this.active)
          this.finish(
            `与沙箱的连接已断开：${state.message ?? ''}。任务可能仍在沙箱中运行，请重新连接后查看`,
          );
      },
    });
  }

  get sessionId() {
    return this.options.workspaceId;
  }
  get toolsFingerprint() {
    return undefined;
  }
  get replacedSessionId() {
    return undefined;
  }
  get isReady() {
    return !this.closed && this.options.channel.client.state.status === 'ready';
  }
  get isClosed() {
    return this.closed;
  }
  /** Remote sessions do not depend on the local workspace, CLI path or browser tools. */
  matchesConfiguration(_workspace: string, _executablePath: string, _tools: BrowserTool[]) {
    return !this.closed;
  }

  async prepare(_selection?: ModelSelection) {
    if (this.closed) throw new Error('沙箱会话已关闭');
    const { channel } = this.options;
    await channel.connect();
    const info = channel.info ?? (await channel.client.request('workspace.info', {})).workspace;
    if (info.agent.status !== 'ready')
      throw new Error(info.agent.message ? redact(info.agent.message) : '沙箱中的 Agent 不可用');
  }

  async listModels(): Promise<ModelOption[]> {
    await this.options.channel.connect();
    const { models } = await this.options.channel.client.request('models.list', {});
    return models;
  }

  async discoverProviderSkills() {
    return unavailableProviderSkillDiscovery(
      { id: 'sandbox', name: '远程沙箱' },
      '当前远程沙箱未提供 Skill 目录。',
    );
  }

  async send(
    text: string,
    context?: string,
    selectedElement?: ElementRef,
    selection?: ModelSelection,
    skills: ProviderSkill[] = [],
    images: ImageAttachment[] = [],
  ) {
    if (skills.length) throw new Error('当前沙箱会话不支持选择本机 Skill');
    if (images.length) throw new Error('当前沙箱会话不支持图片输入');
    if (this.active) throw new Error('请等待沙箱当前任务完成，或先停止');
    const fullContext = [context, selectedElement ? elementContext(selectedElement) : '']
      .filter(Boolean)
      .join('\n\n');
    if (!text.trim() || text.length > MAX_TEXT || fullContext.length > MAX_CONTEXT)
      throw new Error('消息格式或长度无效');
    await this.prepare(selection);
    if (this.active) throw new Error('请等待沙箱当前任务完成，或先停止');
    const done = new Promise<void>((resolve, reject) => {
      this.active = {
        taskId: `t_${randomUUID()}`,
        requested: selection?.model,
        text: '',
        requests: new Map(),
        stopping: false,
        resolve,
        reject,
      };
    });
    const run = this.active!;
    this.emit({
      type: 'run-started',
      threadId: this.options.workspaceId,
      turnId: run.taskId,
      model: { requested: selection?.model, source: 'unconfirmed' },
      baseline: zeroTokens(),
    });
    this.emit({ type: 'status', status: 'thinking', label: '沙箱已接收任务' });
    void this.start(run, text, fullContext || undefined, selection);
    return done;
  }

  private async start(run: Run, text: string, context?: string, model?: ModelSelection) {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.options.channel.client.request('task.start', {
          taskId: run.taskId,
          text,
          context,
          model,
        });
        return;
      } catch (error) {
        if (this.active !== run) return;
        // task.start is idempotent by taskId, so repeating it after an unknown outcome
        // can only attach to the same run, never start a second one.
        const retry =
          error instanceof SandboxError &&
          (error.outcomeUnknown || error.reason === 'NOT_CONNECTED') &&
          attempt < START_ATTEMPTS;
        if (!retry) return this.finish(`沙箱未能启动任务：${(error as Error).message}`);
        try {
          await this.options.channel.connect();
        } catch (reconnect) {
          return this.finish(`沙箱未能启动任务：${(reconnect as Error).message}`);
        }
      }
    }
  }

  async interrupt() {
    const run = this.active;
    if (!run || run.stopping) return;
    run.stopping = true;
    this.emit({ type: 'status', status: 'waiting', label: '正在停止沙箱任务' });
    this.stopTimer = setTimeout(() => {
      if (this.active === run) this.finish('无法确认沙箱任务已停止，请稍后在沙箱列表中核对');
    }, STOP_TIMEOUT_MS);
    try {
      await this.options.channel.client.request('task.stop', { taskId: run.taskId });
    } catch (error) {
      // NOT_FOUND means task.start never landed, so nothing is running remotely.
      if (this.active !== run) return;
      if (error instanceof SandboxError && error.reason === 'NOT_FOUND') this.finish('任务已停止');
      else this.finish(`无法确认沙箱任务已停止：${(error as Error).message}`);
    }
  }

  resolveApproval(id: string, approved: boolean) {
    this.resolveRequest(id, 'approval', { kind: 'approval', approved });
  }

  resolveUserInput(id: string, answers: Record<string, string[]>) {
    this.resolveRequest(id, 'input', { kind: 'input', answers });
  }

  private resolveRequest(
    id: string,
    kind: 'approval' | 'input',
    resolution:
      | { kind: 'approval'; approved: boolean }
      | { kind: 'input'; answers: Record<string, string[]> },
  ) {
    const run = this.active;
    if (!run || run.stopping || run.requests.get(id) !== kind)
      throw new Error(kind === 'approval' ? '沙箱审批已失效' : '沙箱问题已失效');
    // The request stays pending until the sandbox confirms with request-resolved.
    this.options.channel.client
      .request('request.resolve', {
        taskId: run.taskId,
        requestId: id,
        resolution,
      })
      .catch((error) => {
        if (this.active !== run) return;
        if (error instanceof SandboxError && error.outcomeUnknown) {
          // Reconnect resync re-reads pending requests; nothing is resent blindly.
          this.emit({ type: 'status', status: 'waiting', label: '回应结果未知，重新连接后核对' });
          return;
        }
        run.requests.delete(id);
        this.emit({ type: 'request-resolved', id });
        this.emit({ type: 'error', message: `回应未被沙箱接受：${(error as Error).message}` });
      });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    if (this.active) this.finish('沙箱会话已关闭，任务仍在沙箱中运行');
    this.options.onClose?.('沙箱会话已关闭');
  }

  private receive({ event }: SandboxEventEnvelope) {
    const run = this.active;
    if (!run) return;
    if (event.type === 'task.event') {
      if (event.taskId === run.taskId) this.translate(run, event.event);
      return;
    }
    // Terminal task events normally finish first; this covers a restarted sandboxd.
    if (
      event.type === 'task.state' &&
      event.task.id === run.taskId &&
      event.task.status === 'unknown'
    )
      this.finish('沙箱服务重启过，任务状态未知。请检查沙箱中的改动后再决定是否重试');
  }

  private translate(run: Run, event: SandboxTaskEvent) {
    const ids = { threadId: this.options.workspaceId, turnId: run.taskId };
    switch (event.type) {
      case 'started':
        if (event.model?.model)
          this.emit({
            type: 'model',
            ...ids,
            model: { requested: run.requested, ...event.model, source: 'cli-message' },
          });
        return;
      case 'status':
        return this.emit({ type: 'status', status: event.status, label: event.label });
      case 'delta':
        run.text += event.text;
        return this.emit({ type: 'delta', text: event.text });
      case 'tool': {
        const { startedAt, finishedAt } = event.call;
        return this.emit({
          type: 'tool',
          call: {
            ...event.call,
            input: event.call.input,
            durationMs: startedAt && finishedAt ? Math.max(0, finishedAt - startedAt) : undefined,
          },
        });
      }
      case 'plan':
        return this.emit({ type: 'plan', steps: event.steps, at: Date.now() });
      case 'approval':
        if (run.requests.has(event.request.id)) return;
        run.requests.set(event.request.id, 'approval');
        return this.emit({ type: 'approval', request: event.request });
      case 'user-input':
        if (run.requests.has(event.request.id)) return;
        run.requests.set(event.request.id, 'input');
        return this.emit({ type: 'user-input', request: event.request });
      case 'request-resolved':
        if (!run.requests.delete(event.requestId)) return;
        return this.emit({ type: 'request-resolved', id: event.requestId });
      case 'usage':
        return this.emit({ type: 'usage', ...ids, total: event.total, last: event.last });
      case 'completed':
        if (event.text !== undefined) run.text = event.text;
        return this.finish();
      case 'failed':
        return this.finish(redact(event.message));
      case 'cancelled':
        return this.finish('任务已停止');
    }
  }

  /** After missed events: trust task.get over anything cached locally. */
  private async reconcile() {
    const run = this.active;
    if (!run) return;
    let task;
    try {
      ({ task } = await this.options.channel.client.request('task.get', { taskId: run.taskId }));
    } catch (error) {
      if (this.active !== run) return;
      if (error instanceof SandboxError && error.reason === 'NOT_FOUND')
        this.finish('沙箱中没有找到这个任务，它可能没有启动');
      return;
    }
    if (this.active !== run) return;
    const pending = new Map(task.pendingRequests.map((item) => [item.request.id, item]));
    for (const id of [...run.requests.keys()])
      if (!pending.has(id)) {
        run.requests.delete(id);
        this.emit({ type: 'request-resolved', id });
      }
    for (const item of pending.values())
      this.translate(
        run,
        item.kind === 'approval'
          ? { type: 'approval', request: item.request }
          : { type: 'user-input', request: item.request },
      );
    if (task.status === 'completed') this.finish();
    else if (task.status === 'failed') this.finish(redact(task.failure ?? '沙箱任务失败'));
    else if (task.status === 'cancelled') this.finish('任务已停止');
    else if (task.status === 'unknown')
      this.finish('沙箱服务重启过，任务状态未知。请检查沙箱中的改动后再决定是否重试');
  }

  private finish(error?: string) {
    const run = this.active;
    if (!run) return;
    this.active = undefined;
    clearTimeout(this.stopTimer);
    for (const id of run.requests.keys()) this.emit({ type: 'request-resolved', id });
    if (error) {
      this.emit({ type: 'error', message: error });
      run.reject(new Error(error));
    } else {
      this.emit({ type: 'complete', text: run.text, sessionId: this.sessionId });
      run.resolve();
    }
    this.emit({ type: 'status', status: 'idle' });
  }

  private emit(event: AgentEvent) {
    this.options.onEvent(event);
  }
}
