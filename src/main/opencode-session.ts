import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AgentMcpServer } from './agent-mcp';
import { cliEnvironment, readCliOutput } from './agent-process';
import { discoverOpenCodeModels } from './cli-models';
import { browserToolsFingerprint } from './agents';
import {
  selectedElementContext,
  type AgentSession,
  type AgentSessionOptions,
} from './agent-session';
import type { AgentEvent, BrowserTool, ElementRef, ToolCall } from '../shared/types';
import { parseImages, type ImageAttachment } from '../shared/images';
import { unknownTokens, zeroTokens, type ModelOption, type ModelSelection } from '../shared/usage';

type Json = Record<string, any>;
const object = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 256): value is string =>
  typeof value === 'string' && !!value && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
interface Turn {
  id: string;
  text: string;
  started: boolean;
  cancelled: boolean;
  finishing: boolean;
}

function permissionMatches(pattern: string, name: string) {
  let p = 0,
    n = 0,
    star = -1,
    retry = 0;
  while (n < name.length) {
    if (pattern[p] === '?' || pattern[p] === name[n]) {
      p++;
      n++;
    } else if (pattern[p] === '*') {
      star = p++;
      retry = n;
    } else if (star >= 0) {
      p = star + 1;
      n = ++retry;
    } else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

/** OpenCode 1.x ACP, with a private mode whose native operations always require host approval. */
export class OpenCodeSession implements AgentSession {
  private child?: ChildProcessWithoutNullStreams;
  private startup?: Promise<void>;
  private closed = false;
  private id?: string;
  private nextId = 0;
  private active?: Turn;
  private selection?: ModelSelection;
  private models: ModelOption[] = [];
  private modelConfigId?: string;
  private imagesSupported = false;
  private metadata = new AbortController();
  private mode = `athena-${randomUUID()}`;
  private fingerprint: string;
  private bridge: AgentMcpServer;
  private pending = new Map<
    number,
    {
      resolve(value: Json): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
      method: string;
    }
  >();
  private approvals = new Map<
    string,
    { rpcId: number | string; allow: string; reject?: string; turn: Turn }
  >();
  private calls = new Map<string, ToolCall>();
  private hostCallIds = new Set<string>();

  constructor(private options: AgentSessionOptions) {
    if (!path.isAbsolute(options.workspace) || !path.isAbsolute(options.executablePath))
      throw new Error('CLI 与工作目录需要完整路径');
    if (options.sessionId && !/^ses_[a-zA-Z0-9]+$/.test(options.sessionId))
      throw new Error('需要明确的 OpenCode 原生会话 ID');
    if (options.tools.some((tool) => !/^[a-zA-Z0-9_]+$/.test(tool.name) || !tool.inputSchema))
      throw new Error('浏览器工具定义无效');
    this.fingerprint = browserToolsFingerprint(options.tools);
    this.bridge = new AgentMcpServer(
      options.tools,
      async (name, args) => {
        const turn = this.active;
        if (!turn?.started || turn.cancelled || turn.finishing || this.closed)
          throw new Error('任务未就绪');
        const result = await options.callTool(name, args);
        if (this.active !== turn || turn.cancelled || turn.finishing || this.closed)
          throw new Error('任务已停止');
        return result;
      },
      (call) => {
        if (this.active?.started && (!this.closed || call.status === 'error'))
          this.emit({ type: 'tool', call });
      },
    );
  }
  get sessionId() {
    return this.id;
  }
  get toolsFingerprint() {
    return this.fingerprint;
  }
  get replacedSessionId() {
    return undefined;
  }
  get isReady() {
    return !!this.id && !this.closed;
  }
  get isClosed() {
    return this.closed;
  }
  matchesConfiguration(workspace: string, executablePath: string, tools: BrowserTool[]) {
    return (
      workspace === this.options.workspace &&
      executablePath === this.options.executablePath &&
      browserToolsFingerprint(tools) === this.fingerprint
    );
  }
  private emit(event: AgentEvent) {
    this.options.onEvent(event);
  }
  async prepare(selection?: ModelSelection) {
    if (this.closed) throw new Error('OpenCode 会话已关闭');
    this.startup ??= this.start().catch((error) => {
      this.shutdown('OpenCode 初始化失败');
      throw error;
    });
    await this.startup;
    if (selection) {
      if (selection.effort || !this.models.some((model) => model.model === selection.model))
        throw new Error('所选模型不在 OpenCode 可用目录中');
      this.selection = { ...selection };
    }
  }
  private async start() {
    const read = (args: string[]) =>
      readCliOutput(
        this.options.executablePath,
        this.options.workspace,
        args,
        '',
        this.metadata.signal,
      );
    if (!/^1\./.test((await read(['--version'])).trim()))
      throw new Error('当前适配仅支持 OpenCode 1.x');
    let nativeConfig: Json, nativeAgent: Json;
    try {
      nativeConfig = JSON.parse(await read(['debug', 'config', '--pure']));
      const nativeMode = nativeConfig.default_agent ?? 'build';
      if (!text(nativeMode) || nativeMode.startsWith('-')) throw new Error();
      nativeAgent = JSON.parse(await read(['debug', 'agent', nativeMode, '--pure']));
    } catch {
      throw new Error('无法读取 OpenCode 原有权限配置，请在终端检查后刷新');
    }
    if (
      !Array.isArray(nativeAgent.permission) ||
      nativeAgent.permission.length > 4096 ||
      nativeAgent.permission.some(
        (rule: Json) =>
          !object(rule) ||
          !text(rule.permission) ||
          !text(rule.pattern, 2048) ||
          !['allow', 'ask', 'deny'].includes(rule.action),
      )
    )
      throw new Error('OpenCode 原有权限配置格式无效');
    const localTools = ['read', 'edit', 'bash', 'glob', 'grep', 'list', 'external_directory'];
    const permissions = Object.fromEntries(
      [...localTools, ...this.options.tools.map((tool) => `athena_${tool.name}`)].map((name) => {
        const patterns = new Map<string, string>([['*', 'ask']]);
        for (const rule of nativeAgent.permission) {
          if (!permissionMatches(rule.permission, name)) continue;
          patterns.delete(rule.pattern);
          patterns.set(
            rule.pattern,
            rule.action === 'deny' ? 'deny' : localTools.includes(name) ? 'ask' : rule.action,
          );
        }
        return [name, Object.fromEntries(patterns)];
      }),
    );
    if (this.options.tools.length) await this.bridge.start();
    if (this.closed) throw new Error('OpenCode 会话已关闭');
    const env = cliEnvironment(this.options.executablePath);
    let config: Json = {};
    if (env.OPENCODE_CONFIG_CONTENT) {
      try {
        config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
      } catch {
        throw new Error('OpenCode 环境配置不是有效 JSON');
      }
      if (!object(config)) throw new Error('OpenCode 环境配置格式无效');
    }
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      ...config,
      share: 'disabled',
      agent: {
        ...config.agent,
        [this.mode]: {
          description: 'Athena',
          mode: 'primary',
          hidden: false,
          permission: {
            '*': 'deny',
            ...permissions,
          },
        },
      },
    });
    this.child = spawn(
      this.options.executablePath,
      ['acp', '--pure', '--hostname', '127.0.0.1', '--port', '0'],
      {
        cwd: this.options.workspace,
        env,
        stdio: 'pipe',
        detached: process.platform !== 'win32',
      },
    );
    this.child.stderr.resume();
    this.child.on('error', () => this.shutdown('无法启动 OpenCode，请检查本机安装'));
    this.child.on('close', () => this.shutdown('OpenCode 连接已关闭'));
    this.child.stdin.on('error', () => this.shutdown('OpenCode 输入连接中断'));
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      if (this.closed) return;
      buffer += chunk;
      // ACP replays base64 image content when restoring a native session.
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        this.shutdown('OpenCode 协议记录过大');
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0 && !this.closed) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.handle(JSON.parse(line));
        } catch {
          this.shutdown('OpenCode ACP 协议格式无效');
        }
      }
    });
    const initialized = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agent-workbench', title: 'Athena', version: '0.9.0' },
    });
    if (initialized.protocolVersion !== 1 || !/^1\./.test(initialized.agentInfo?.version ?? ''))
      throw new Error('当前 OpenCode 版本不支持此适配器');
    this.imagesSupported = initialized.agentCapabilities?.promptCapabilities?.image === true;
    const bridge = this.options.tools.length ? this.bridge.definition() : undefined;
    const params = {
      cwd: this.options.workspace,
      mcpServers: bridge
        ? [
            {
              name: 'athena',
              command: bridge.command,
              args: bridge.args,
              env: Object.entries(bridge.env).map(([name, value]) => ({ name, value })),
            },
          ]
        : [],
    };
    let state: Json;
    if (this.options.sessionId) {
      if (!initialized.agentCapabilities?.loadSession)
        throw new Error('OpenCode 不支持恢复此会话，原记录仍保留');
      state = await this.request('session/load', { ...params, sessionId: this.options.sessionId });
      this.id = this.options.sessionId;
    } else {
      state = await this.request('session/new', params);
      if (!text(state.sessionId) || !/^ses_[a-zA-Z0-9]+$/.test(state.sessionId))
        throw new Error('OpenCode 未返回有效原生会话 ID');
      this.id = state.sessionId;
    }
    this.acceptModels(state);
    // Never use a native default mode: its saved permissions can bypass Athena approvals.
    await this.request('session/set_mode', { sessionId: this.id, modeId: this.mode });
  }
  private acceptModels(state: Json) {
    const config = state.configOptions?.find(
      (item: Json) => item.category === 'model' && item.type === 'select',
    );
    if (config) {
      if (!text(config.id) || !Array.isArray(config.options))
        throw new Error('OpenCode 模型目录格式无效');
      this.modelConfigId = config.id;
      const entries = config.options.flatMap((item: Json) => item.options ?? [item]);
      if (entries.length > 4096) throw new Error('OpenCode 模型目录返回过大');
      this.models = entries.map((item: Json) => {
        if (!text(item.value) || !text(item.name)) throw new Error('OpenCode 模型条目无效');
        return {
          id: item.value,
          model: item.value,
          name: item.name,
          description: text(item.description, 2000) ? item.description : '',
          isDefault: item.value === config.currentValue,
          efforts: [],
        };
      });
    } else if (Array.isArray(state.models?.availableModels)) {
      this.modelConfigId = undefined;
      if (state.models.availableModels.length > 4096) throw new Error('OpenCode 模型目录返回过大');
      this.models = state.models.availableModels.map((item: Json) => {
        if (!text(item.modelId) || !text(item.name)) throw new Error('OpenCode 模型条目无效');
        return {
          id: item.modelId,
          model: item.modelId,
          name: item.name,
          description: '',
          isDefault: item.modelId === state.models.currentModelId,
          efforts: [],
        };
      });
    } else throw new Error('OpenCode 未返回模型目录');
  }
  async listModels() {
    if (this.closed) throw new Error('OpenCode 会话已关闭');
    if (this.startup) {
      await this.startup;
      return this.models;
    }
    // Catalog probes must not create empty records in the user's native session history.
    return discoverOpenCodeModels(
      this.options.executablePath,
      this.options.workspace,
      this.metadata.signal,
    );
  }
  async send(
    prompt: string,
    context?: string,
    selected?: ElementRef,
    selection?: ModelSelection,
    images?: ImageAttachment[],
  ) {
    if (this.active || this.bridge.pendingCalls) throw new Error('请等待当前 OpenCode 任务完成');
    const attachments = parseImages(images);
    if (
      (!prompt.trim() && !attachments.length) ||
      prompt.length > 20000 ||
      (context?.length ?? 0) > 60000
    )
      throw new Error('任务格式或长度不正确');
    const turn: Turn = {
      id: randomUUID(),
      text: '',
      started: false,
      cancelled: false,
      finishing: false,
    };
    this.active = turn;
    this.calls.clear();
    this.hostCallIds.clear();
    try {
      await this.prepare(selection);
      if (turn.cancelled || this.closed) throw new Error('任务已停止');
      if (attachments.length && !this.imagesSupported)
        throw new Error('当前 OpenCode 不支持图片输入');
      const snapshot = await selectedElementContext(selected, this.options.inspectSelectedElement);
      if (this.selection) {
        const result = await this.request(
          this.modelConfigId ? 'session/set_config_option' : 'session/set_model',
          {
            sessionId: this.id,
            ...(this.modelConfigId
              ? { configId: this.modelConfigId, value: this.selection.model }
              : { modelId: this.selection.model }),
          },
        );
        if (result.configOptions || result.models) this.acceptModels(result);
      }
      if (turn.cancelled || this.closed) throw new Error('任务已停止');
      turn.started = true;
      this.emit({
        type: 'run-started',
        threadId: this.id!,
        turnId: turn.id,
        model: { requested: this.selection?.model, source: 'unconfirmed' },
        baseline: zeroTokens(),
      });
      this.emit({ type: 'status', status: 'thinking', label: 'OpenCode 已接收任务' });
      const content = [
        `<user_task>\n${prompt}\n</user_task>`,
        context ? `<task_context>\n${context}\n</task_context>` : '',
        snapshot ? `<selected_element_snapshot>\n${snapshot}\n</selected_element_snapshot>` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const result = await this.request(
        'session/prompt',
        {
          sessionId: this.id,
          prompt: [
            { type: 'text', text: content },
            ...attachments.map(({ data, mimeType }) => ({ type: 'image', data, mimeType })),
          ],
        },
        15 * 60 * 1000,
      );
      if (turn.cancelled || result.stopReason === 'cancelled') throw new Error('任务已停止');
      if (result.stopReason !== 'end_turn' || this.approvals.size || this.bridge.pendingCalls)
        throw new Error('OpenCode 未完成本轮任务');
      if (object(result.usage)) {
        const count = (value: unknown) =>
          typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
        const usage = result.usage;
        const input = [usage.inputTokens, usage.cachedReadTokens, usage.cachedWriteTokens].map(
          count,
        );
        const total = {
          ...unknownTokens(),
          inputTokens: input.every((value) => value !== null)
            ? input.reduce<number>((sum, value) => sum + value!, 0)
            : null,
          outputTokens: count(usage.outputTokens),
          totalTokens: count(usage.totalTokens),
          cachedInputTokens: count(usage.cachedReadTokens),
          cacheWriteInputTokens: count(usage.cachedWriteTokens),
          reasoningOutputTokens: count(usage.thoughtTokens),
        };
        this.emit({ type: 'usage', threadId: this.id!, turnId: turn.id, total, last: total });
      }
      this.emit({ type: 'complete', text: turn.text, sessionId: this.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OpenCode 执行失败';
      this.emit({ type: 'error', message });
      this.shutdown(message);
      throw error;
    } finally {
      this.cancelApprovals();
      if (this.active === turn) this.active = undefined;
      this.emit({ type: 'status', status: 'idle' });
    }
  }
  private handle(message: unknown) {
    if (!object(message) || message.jsonrpc !== '2.0') throw new Error();
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (pending.method === 'session/prompt' && this.active) this.active.finishing = true;
      if (message.error)
        pending.reject(new Error('OpenCode 请求失败，请检查本机登录、模型与服务配置'));
      else if (!object(message.result)) pending.reject(new Error('OpenCode 响应格式无效'));
      else pending.resolve(message.result);
      return;
    }
    const turn = this.active,
      params = message.params ?? {};
    if (message.id !== undefined) {
      if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id))) throw new Error();
      if (message.method !== 'session/request_permission') {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Client capability unavailable' },
        });
        return;
      }
      const deny = () => this.respond(message.id, { outcome: { outcome: 'cancelled' } });
      if (
        !turn?.started ||
        turn.cancelled ||
        turn.finishing ||
        params.sessionId !== this.id ||
        !Array.isArray(params.options)
      ) {
        deny();
        return;
      }
      if ([...this.approvals.values()].some((pending) => pending.rpcId === message.id))
        throw new Error();
      const allow = params.options.find((option: Json) => option.kind === 'allow_once');
      const reject = params.options.find((option: Json) => option.kind === 'reject_once');
      if (
        !text(allow?.optionId) ||
        !text(params.toolCall?.title, 1000) ||
        !object(params.toolCall.rawInput)
      ) {
        deny();
        return;
      }
      const input = {
        ...(this.calls.get(params.toolCall.toolCallId)?.input as Json | undefined),
        ...params.toolCall.rawInput,
      };
      if (!Object.keys(input).length) {
        deny();
        this.shutdown('OpenCode 未返回可确认的操作参数，已停止');
        return;
      }
      const detail = JSON.stringify(input, null, 2);
      if (detail.length > 12000) {
        deny();
        this.shutdown('OpenCode 操作参数过长，无法完整确认，已停止');
        return;
      }
      const id = `opencode-${randomUUID()}`;
      this.approvals.set(id, {
        rpcId: message.id,
        allow: allow.optionId,
        reject: text(reject?.optionId) ? reject.optionId : undefined,
        turn,
      });
      this.emit({
        type: 'approval',
        request: {
          id,
          title: `OpenCode · ${params.toolCall.title}`,
          detail,
          kind:
            params.toolCall.kind === 'execute'
              ? 'command'
              : params.toolCall.kind === 'edit'
                ? 'file'
                : 'other',
        },
      });
      this.emit({ type: 'status', status: 'waiting', label: '等待你的确认' });
      return;
    }
    if (message.method !== 'session/update' || params.sessionId !== this.id) return;
    const update = params.update;
    if (!object(update)) throw new Error();
    if (
      update.sessionUpdate === 'config_option_update' &&
      update.configOptions?.some((item: Json) => item.category === 'model')
    )
      this.acceptModels(update);
    if (!turn?.started || turn.cancelled || turn.finishing) return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      if (
        typeof update.content.text !== 'string' ||
        turn.text.length + update.content.text.length > 4 * 1024 * 1024
      )
        throw new Error();
      turn.text += update.content.text;
      this.emit({ type: 'delta', text: update.content.text });
    } else if (
      ['tool_call', 'tool_call_update'].includes(update.sessionUpdate) &&
      text(update.toolCallId)
    ) {
      if (this.options.tools.some((tool) => update.title === `athena_${tool.name}`))
        this.hostCallIds.add(update.toolCallId);
      if (this.hostCallIds.has(update.toolCallId)) return;
      const old = this.calls.get(update.toolCallId);
      const call: ToolCall = {
        id: `opencode-${update.toolCallId}`,
        name: text(update.title, 1000) ? update.title : old?.name || 'OpenCode tool',
        input: object(update.rawInput) ? update.rawInput : old?.input || {},
        status:
          update.status === 'completed' ? 'done' : update.status === 'failed' ? 'error' : 'running',
      };
      this.calls.set(update.toolCallId, call);
      this.emit({ type: 'tool', call });
    } else if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
      this.emit({
        type: 'plan',
        at: Date.now(),
        steps: update.entries
          .slice(0, 100)
          .filter((entry: Json) => text(entry.content, 2000))
          .map((entry: Json) => ({
            step: entry.content,
            status:
              entry.status === 'completed'
                ? 'completed'
                : entry.status === 'in_progress'
                  ? 'inProgress'
                  : 'pending',
          })),
      });
    }
  }
  resolveApproval(id: string, approved: boolean) {
    const pending = this.approvals.get(id);
    if (
      !pending ||
      pending.turn !== this.active ||
      pending.turn.cancelled ||
      pending.turn.finishing ||
      typeof approved !== 'boolean'
    )
      throw new Error('OpenCode 审批已失效');
    const optionId = approved ? pending.allow : pending.reject;
    this.approvals.delete(id);
    this.respond(pending.rpcId, {
      outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
    });
    this.emit({ type: 'request-resolved', id });
  }
  resolveUserInput() {
    throw new Error('OpenCode 未接入此类问题，请在对话中回复');
  }
  private cancelApprovals() {
    for (const [id, pending] of this.approvals) {
      this.respond(pending.rpcId, { outcome: { outcome: 'cancelled' } });
      this.emit({ type: 'request-resolved', id });
    }
    this.approvals.clear();
  }
  async interrupt() {
    if (this.active) this.active.cancelled = true;
    if (this.id)
      this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.id } });
    this.shutdown('任务已停止');
  }
  close() {
    this.shutdown('OpenCode 会话已关闭');
  }
  private shutdown(reason: string) {
    if (this.closed) return;
    this.metadata.abort();
    if (this.active) this.active.cancelled = true;
    this.cancelApprovals();
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.bridge.close();
    try {
      if (this.child?.pid && process.platform !== 'win32') process.kill(-this.child.pid, 'SIGKILL');
      else this.child?.kill('SIGKILL');
    } catch {
      /* Process already exited. */
    }
    this.options.onClose?.(reason);
  }
  private write(message: Json) {
    if (!this.closed) this.child?.stdin.write(JSON.stringify(message) + '\n');
  }
  private respond(id: string | number, result: Json) {
    this.write({ jsonrpc: '2.0', id, result });
  }
  private request(method: string, params: Json, timeout = 30000): Promise<Json> {
    if (this.closed || !this.child) return Promise.reject(new Error('OpenCode 连接不可用'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.shutdown('OpenCode 请求超时，已停止'), timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
}
