import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { piIsolationArguments } from './agent-discovery';
import { cliEnvironment } from './agent-process';
import { HostToolBridge } from './host-tool-bridge';
import type { AgentSession, AgentSessionOptions } from './agent-session';
import { selectedElementContext } from './agent-session';
import type { AgentEvent, BrowserTool, ElementRef, ToolCall } from '../shared/types';
import {
  unknownTokens,
  zeroTokens,
  type ModelOption,
  type ModelSelection,
  type TokenCounts,
} from '../shared/usage';

type RecordValue = Record<string, any>;
const object = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, limit = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit;
interface Run {
  id: string;
  requested?: string;
  resolve(): void;
  reject(error: Error): void;
  text: string;
  messageText: string;
  totals: TokenCounts;
  cancelled: boolean;
  started: boolean;
  answered: boolean;
  missingTokens: Set<keyof TokenCounts>;
  failed?: string;
}

/** Pi's long-lived JSONL RPC. Never treats prompt acceptance or agent_end as completion. */
export class PiSession implements AgentSession {
  private child?: ChildProcessWithoutNullStreams;
  private startup?: Promise<void>;
  private startupAbort = new AbortController();
  private ready = false;
  private closed = false;
  private id?: string;
  private sequence = 0;
  private active?: Run;
  private sending = false;
  private permissionReady = false;
  private pending = new Map<
    string,
    {
      type: string;
      resolve(value: any): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private requests = new Map<
    string,
    { method: string; run: Run; options?: string[]; timer?: ReturnType<typeof setTimeout> }
  >();
  private tools = new Map<string, ToolCall>();
  private hostBridge?: HostToolBridge;

  constructor(private options: AgentSessionOptions) {
    if (
      ![options.workspace, options.executablePath, options.permissionsExtensionPath].every(
        (p) => p && path.isAbsolute(p),
      )
    )
      throw new Error('Pi 需要工作目录、CLI 与授权扩展的完整路径');
    if (options.sessionId && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(options.sessionId))
      throw new Error('Pi 会话标识无效');
    this.id = options.sessionId;
  }
  get sessionId() {
    return this.id;
  }
  get toolsFingerprint() {
    return createHash('sha256').update(JSON.stringify(this.options.tools)).digest('hex');
  }
  get replacedSessionId() {
    return undefined;
  }
  get isReady() {
    return this.ready && !this.closed;
  }
  get isClosed() {
    return this.closed;
  }
  matchesConfiguration(workspace: string, executablePath: string, tools: BrowserTool[]) {
    return (
      workspace === this.options.workspace &&
      executablePath === this.options.executablePath &&
      JSON.stringify(tools) === JSON.stringify(this.options.tools)
    );
  }
  private emit(event: AgentEvent) {
    this.options.onEvent(event);
  }

  async prepare(selection?: ModelSelection) {
    if (this.closed) throw new Error('Pi 会话已关闭');
    this.startup ??= this.start().catch((error) => {
      this.shutdown(error instanceof Error ? error.message : 'Pi 初始化失败');
      throw error;
    });
    await this.startup;
    if (selection) await this.selectModel(selection);
  }
  private async start() {
    let help: string;
    try {
      help = (
        await promisify(execFile)(this.options.executablePath, ['--help'], {
          timeout: 8000,
          maxBuffer: 256 * 1024,
          signal: this.startupAbort.signal,
          env: cliEnvironment(this.options.executablePath),
        })
      ).stdout;
    } catch {
      this.shutdown('无法检查本机 Pi 的启动参数');
      throw new Error('无法检查本机 Pi 的启动参数');
    }
    const isolation = piIsolationArguments(help);
    if (!isolation) {
      this.shutdown('当前 Pi 版本无法确认扩展与 MCP 隔离，请更新 CLI');
      throw new Error('当前 Pi 版本无法确认扩展与 MCP 隔离，请更新 CLI');
    }
    if (this.closed) throw new Error('Pi 会话已关闭');
    const id = this.id ?? randomUUID();
    let hostConfiguration: Record<string, unknown> | undefined;
    if (this.options.tools.length) {
      this.hostBridge = new HostToolBridge(this.options.tools, (name, args) => {
        if (!this.active || this.active.cancelled || !this.active.started || this.closed)
          return Promise.resolve({ text: 'Pi 当前没有可执行的任务', isError: true });
        return this.options.callTool(name, args);
      });
      const endpoint = await this.hostBridge.start();
      hostConfiguration = { ...endpoint, tools: this.options.tools };
      if (this.closed) throw new Error('Pi 会话已关闭');
    }
    const args = [
      '--mode',
      'rpc',
      ...isolation,
      '--extension',
      this.options.permissionsExtensionPath!,
      '--tools',
      [
        'read',
        'bash',
        'write',
        'edit',
        'grep',
        'find',
        'ls',
        ...this.options.tools.map((tool) => tool.name),
      ].join(','),
      ...(this.options.sessionDirectory ? ['--session-dir', this.options.sessionDirectory] : []),
      ...(this.id ? ['--session', this.id] : ['--session-id', id]),
    ];
    const child = spawn(this.options.executablePath, args, {
      cwd: this.options.workspace,
      env: {
        ...process.env,
        PATH: `${path.dirname(this.options.executablePath)}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
        ...(hostConfiguration ? { WORKBENCH_ATHENA_TOOLS: JSON.stringify(hostConfiguration) } : {}),
      },
      detached: process.platform !== 'win32',
      stdio: 'pipe',
    });
    this.child = child;
    // Diagnostics can contain credentials or provider headers. Drain, never display them.
    child.stderr.resume();
    child.on('error', () => this.shutdown('无法启动本机 Pi，请检查 CLI 安装'));
    child.on('exit', () => {
      if (!this.closed) this.shutdown('Pi 进程已退出，请重新连接');
    });
    child.stdin.on('error', () => {
      if (!this.closed) this.shutdown('Pi 输入连接中断');
    });
    child.stdout.setEncoding('utf8');
    let buffer = '';
    child.stdout.on('data', (chunk: string) => {
      if (this.closed) return;
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) return this.shutdown('Pi 协议记录过大，已关闭连接');
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, '');
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (!object(record)) throw new Error('invalid');
          this.handle(record);
        } catch {
          this.shutdown('Pi 返回无效的 JSONL 协议记录');
          return;
        }
      }
    });
    try {
      const state = await this.request('get_state', {}, 20000);
      if (!this.permissionReady) throw new Error('Pi 授权扩展未就绪，不能执行任务');
      if (!text(state?.sessionId) || state.isStreaming || state.pendingMessageCount > 0)
        throw new Error('Pi 未返回可用的空闲会话');
      if (state.sessionId !== id) throw new Error('Pi 返回了其他会话，已拒绝使用');
      this.id = state.sessionId;
      this.ready = true;
    } catch (error) {
      this.shutdown(error instanceof Error ? error.message : 'Pi 初始化失败');
      throw error;
    }
  }
  private async selectModel(selection: ModelSelection) {
    if (this.active) throw new Error('任务进行中，不能切换 Pi 模型');
    const models = await this.models();
    const model = models.find((m) => `${m.provider}/${m.id}` === selection.model);
    if (!model) throw new Error('所选模型不在 Pi 可用目录中');
    await this.request('set_model', { provider: model.provider, modelId: model.id });
    if (selection.effort) {
      const { levels } = await this.request('get_available_thinking_levels');
      if (!Array.isArray(levels) || !levels.includes(selection.effort))
        throw new Error('Pi 不支持所选推理强度');
      await this.request('set_thinking_level', { level: selection.effort });
    }
  }
  private async models(): Promise<RecordValue[]> {
    const data = await this.request('get_available_models');
    if (!Array.isArray(data?.models)) throw new Error('Pi 模型目录格式无效');
    return data.models.filter(
      (model: unknown) => object(model) && text(model.id) && text(model.provider),
    );
  }
  async listModels(): Promise<ModelOption[]> {
    await this.prepare();
    const [models, state] = await Promise.all([this.models(), this.request('get_state')]);
    return models.map((model) => ({
      id: `${model.provider}/${model.id}`,
      model: `${model.provider}/${model.id}`,
      name: typeof model.name === 'string' ? model.name : model.id,
      description: model.provider,
      isDefault: state.model?.id === model.id && state.model?.provider === model.provider,
      // Thinking levels are model-specific; do not invent them from the reasoning boolean.
      efforts: [],
    }));
  }
  async send(
    prompt: string,
    context?: string,
    selectedElement?: ElementRef,
    selection?: ModelSelection,
  ) {
    if (this.active || this.sending) throw new Error('请等待 Pi 当前任务完成，或先停止');
    if (!prompt.trim() || prompt.length > 20000 || (context?.length ?? 0) > 60000)
      throw new Error('Pi 消息格式或长度无效');
    let elementContext = '';
    this.sending = true;
    try {
      await this.prepare(selection);
      elementContext = await selectedElementContext(this.options, selectedElement);
    } finally {
      this.sending = false;
    }
    if (this.closed) throw new Error('Pi 会话已关闭');
    if (this.active) throw new Error('请等待 Pi 当前任务完成，或先停止');
    const done = new Promise<void>((resolve, reject) => {
      this.active = {
        id: randomUUID(),
        requested: selection?.model,
        resolve,
        reject,
        text: '',
        messageText: '',
        totals: unknownTokens(),
        cancelled: false,
        started: false,
        answered: false,
        missingTokens: new Set(),
      };
    });
    const run = this.active!;
    this.tools.clear();
    this.emit({
      type: 'run-started',
      threadId: this.id!,
      turnId: run.id,
      model: { requested: selection?.model, source: 'unconfirmed' },
      baseline: zeroTokens(),
    });
    this.emit({ type: 'status', status: 'thinking', label: 'Pi 已接收任务' });
    void this.request(
      'prompt',
      {
        message: [
          prompt,
          context ? `<task_context>\n${context}\n</task_context>` : '',
          elementContext,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
      30000,
    )
      .then((result) => {
        if (this.active !== run) return;
        if (result?.disposition !== 'started')
          this.shutdown('Pi 未为当前消息启动独立任务，已关闭连接');
      })
      .catch(() => {
        if (this.active === run) this.shutdown('Pi 拒绝了任务，请检查本机登录与模型配置');
      });
    return done;
  }
  async interrupt() {
    const run = this.active;
    if (!run) {
      if (this.sending) this.shutdown('Pi 会话已关闭');
      return;
    }
    run.cancelled = true;
    this.cancelRequests();
    this.emit({ type: 'status', status: 'waiting', label: '正在停止 Pi' });
    try {
      await this.request('clear_queue', {}, 3000);
      await this.request('abort', {}, 5000);
      if (this.active === run) this.finish('任务已停止');
    } catch {
      this.shutdown('无法确认 Pi 停止，已关闭本次进程');
    }
  }
  resolveApproval(id: string, approved: boolean) {
    const pending = this.requests.get(id);
    if (
      !pending ||
      pending.method !== 'confirm' ||
      pending.run !== this.active ||
      pending.run.cancelled ||
      typeof approved !== 'boolean'
    )
      throw new Error('Pi 审批已失效');
    this.write({ type: 'extension_ui_response', id, confirmed: approved });
    this.removeRequest(id);
  }
  resolveUserInput(id: string, answers: Record<string, string[]>) {
    const pending = this.requests.get(id);
    const value = answers[id];
    if (
      !pending ||
      pending.method === 'confirm' ||
      pending.run !== this.active ||
      pending.run.cancelled ||
      Object.keys(answers).length !== 1 ||
      !Array.isArray(value) ||
      value.length !== 1 ||
      typeof value[0] !== 'string' ||
      !value[0].length ||
      value[0].length > 20000 ||
      (pending.options && !pending.options.includes(value[0]))
    )
      throw new Error('Pi 提问已失效或回答无效');
    this.write({ type: 'extension_ui_response', id, value: value[0] });
    this.removeRequest(id);
  }
  private write(record: RecordValue) {
    if (!this.child || this.closed || !this.child.stdin.writable) throw new Error('Pi 连接已关闭');
    this.child.stdin.write(JSON.stringify(record) + '\n');
  }
  private request(type: string, data: RecordValue = {}, timeout = 15000): Promise<any> {
    const id = `athena-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi ${type} 超时`));
      }, timeout);
      this.pending.set(id, { type, resolve, reject, timer });
      try {
        this.write({ ...data, id, type });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private handle(record: RecordValue) {
    if (record.type === 'response') {
      const pending = this.pending.get(record.id);
      if (!pending || pending.type !== record.command) return;
      this.pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.success === true) pending.resolve(record.data);
      else pending.reject(new Error(`Pi ${pending.type} 失败，请在终端检查对应配置`));
      return;
    }
    if (
      record.type === 'extension_ui_request' &&
      record.method === 'notify' &&
      record.message === 'athena-permissions-v1'
    ) {
      this.permissionReady = true;
      return;
    }
    if (record.type === 'extension_error') {
      this.shutdown('Pi 扩展执行失败，已停止以保护授权边界');
      return;
    }
    if (record.type === 'extension_ui_request') {
      this.handleUI(record);
      return;
    }
    const run = this.active;
    if (!run) return;
    if (record.type === 'agent_start') run.started = true;
    if (!run.started) return;
    if (record.type === 'message_start' && record.message?.role === 'assistant') {
      run.messageText = '';
      if (text(record.message.model) && text(record.message.provider))
        this.emit({
          type: 'model',
          threadId: this.id!,
          turnId: run.id,
          model: {
            requested: run.requested,
            model: `${record.message.provider}/${record.message.model}`,
            source: 'cli-message',
          },
        });
    }
    if (record.type === 'message_update' && !run.cancelled) {
      const update = record.assistantMessageEvent;
      if (update?.type === 'text_delta' && typeof update.delta === 'string') {
        if (run.text.length + update.delta.length > 4 * 1024 * 1024) {
          this.shutdown('Pi 回复过长，已停止');
          return;
        }
        run.messageText += update.delta;
        run.text += update.delta;
        this.emit({ type: 'delta', text: update.delta });
      }
    }
    if (record.type === 'message_end' && record.message?.role === 'assistant') {
      const message = record.message;
      run.answered = true;
      if (['error', 'aborted', 'length'].includes(message.stopReason))
        run.failed =
          message.stopReason === 'aborted'
            ? '任务已停止'
            : 'Pi 模型未完成本轮回复，请检查本机登录、模型配置或输出限制';
      else run.failed = undefined;
      const full = Array.isArray(message.content)
        ? message.content
            .filter((part: RecordValue) => part.type === 'text' && typeof part.text === 'string')
            .map((part: RecordValue) => part.text)
            .join('')
        : '';
      if (!full.startsWith(run.messageText)) {
        this.shutdown('Pi 完整回复与流式输出不一致');
        return;
      }
      if (
        full.startsWith(run.messageText) &&
        full.length > run.messageText.length &&
        !run.cancelled
      ) {
        const delta = full.slice(run.messageText.length);
        if (run.text.length + delta.length > 4 * 1024 * 1024) {
          this.shutdown('Pi 回复过长，已停止');
          return;
        }
        run.text += delta;
        this.emit({ type: 'delta', text: delta });
      }
      const usage = message.usage;
      if (object(usage)) {
        const count = (value: unknown) =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
        const input = [usage.input, usage.cacheRead, usage.cacheWrite].map(count);
        const last: TokenCounts = {
          inputTokens: input.every((n) => n !== null)
            ? input.reduce<number>((a, b) => a + b!, 0)
            : null,
          outputTokens: count(usage.output),
          cachedInputTokens: count(usage.cacheRead),
          cacheWriteInputTokens: count(usage.cacheWrite),
          reasoningOutputTokens: null,
          totalTokens: count(usage.totalTokens),
        };
        for (const key of Object.keys(last) as (keyof TokenCounts)[]) {
          if (last[key] === null) {
            run.missingTokens.add(key);
            run.totals[key] = null;
          } else if (!run.missingTokens.has(key))
            run.totals[key] = (run.totals[key] ?? 0) + last[key]!;
        }
        this.emit({
          type: 'usage',
          threadId: this.id!,
          turnId: run.id,
          total: { ...run.totals },
          last,
        });
      }
    }
    if (
      record.type === 'tool_execution_start' &&
      text(record.toolCallId) &&
      text(record.toolName)
    ) {
      const call: ToolCall = {
        id: record.toolCallId,
        name: record.toolName,
        input: object(record.args) ? record.args : {},
        status: 'running',
      };
      this.tools.set(call.id, call);
      this.emit({ type: 'tool', call: { ...call } });
    }
    if (record.type === 'tool_execution_end') {
      const call = this.tools.get(record.toolCallId);
      if (call) {
        call.status = record.isError ? 'error' : 'done';
        this.emit({ type: 'tool', call: { ...call } });
      }
    }
    if (record.type === 'agent_settled')
      this.finish(
        run.cancelled || record.aborted
          ? '任务已停止'
          : (run.failed ?? (!run.answered ? 'Pi 未返回本轮回复，不能确认任务完成' : undefined)),
      );
  }
  private handleUI(record: RecordValue) {
    if (!text(record.id, 512) || !['confirm', 'select', 'input', 'editor'].includes(record.method))
      return;
    const run = this.active;
    if (!run || run.cancelled || this.requests.has(record.id)) {
      this.write({ type: 'extension_ui_response', id: record.id, cancelled: true });
      return;
    }
    const id = record.id;
    const pending: {
      method: string;
      run: Run;
      options?: string[];
      timer?: ReturnType<typeof setTimeout>;
    } = { method: record.method, run };
    if (record.method === 'select') {
      if (
        !Array.isArray(record.options) ||
        !record.options.length ||
        record.options.some((v: unknown) => !text(v, 20000))
      ) {
        this.write({ type: 'extension_ui_response', id, cancelled: true });
        return;
      }
      pending.options = [...record.options];
    }
    this.requests.set(id, pending);
    if (typeof record.timeout === 'number' && record.timeout > 0 && record.timeout <= 86400000)
      pending.timer = setTimeout(() => this.removeRequest(id), record.timeout);
    const title = typeof record.title === 'string' ? record.title.slice(0, 1000) : 'Pi 请求确认';
    if (record.method === 'confirm')
      this.emit({
        type: 'approval',
        request: {
          id,
          kind: 'other',
          title,
          detail: typeof record.message === 'string' ? record.message.slice(0, 20000) : '',
        },
      });
    else
      this.emit({
        type: 'user-input',
        request: {
          id,
          questions: [
            {
              id,
              header: 'Pi',
              question: title,
              isSecret: record.method !== 'select',
              options: pending.options?.map((label) => ({ label, description: '' })),
            },
          ],
        },
      });
    this.emit({ type: 'status', status: 'waiting', label: '等待你的确认' });
  }
  private removeRequest(id: string) {
    const pending = this.requests.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.requests.delete(id);
    this.emit({ type: 'request-resolved', id });
    if (this.active && !this.active.cancelled && !this.requests.size)
      this.emit({ type: 'status', status: 'working', label: 'Pi 继续执行' });
  }
  private cancelRequests() {
    for (const id of [...this.requests.keys()]) {
      if (!this.closed) {
        try {
          this.write({ type: 'extension_ui_response', id, cancelled: true });
        } catch {
          /* Broken stdin must not prevent fail-closed cleanup. */
        }
      }
      this.removeRequest(id);
    }
  }
  private finish(error?: string) {
    const run = this.active;
    if (!run) return;
    this.active = undefined;
    this.cancelRequests();
    if (error) {
      this.emit({ type: 'error', message: error });
      run.reject(new Error(error));
    } else {
      this.emit({ type: 'complete', text: run.text, sessionId: this.id });
      run.resolve();
    }
    this.emit({ type: 'status', status: 'idle' });
  }
  private shutdown(reason: string) {
    if (this.closed) return;
    this.cancelRequests();
    this.closed = true;
    this.startupAbort.abort();
    this.ready = false;
    void this.hostBridge?.close();
    this.hostBridge = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.finish(reason);
    const child = this.child;
    child?.stdin.end();
    const kill = (signal: NodeJS.Signals) => {
      if (!child?.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 1500);
    timer.unref();
    this.options.onClose?.(reason);
  }
  close() {
    this.shutdown('Pi 会话已关闭');
  }
}
