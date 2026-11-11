import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, AgentSessionOptions } from './agent-session';
import { selectedElementContext } from './agent-session';
import { HostToolBridge } from './host-tool-bridge';
import { cliEnvironment } from './agent-process';
import type { AgentEvent, BrowserTool, ElementRef, ToolCall } from '../shared/types';
import {
  unknownTokens,
  zeroTokens,
  type ModelOption,
  type ModelSelection,
  type TokenCounts,
} from '../shared/usage';

export type StreamCliId = 'claude' | 'gemini' | 'cursor';
export interface StreamCliSessionOptions extends AgentSessionOptions {
  cli: StreamCliId;
}
type Json = Record<string, any>;
const object = (value: unknown): value is Json =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(value);
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const contentText = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .filter((p) => object(p) && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
    : '';
interface Run {
  turnId: string;
  requested?: string;
  expectedSession?: string;
  child?: ChildProcessWithoutNullStreams;
  text: string;
  messageText: string;
  initialized: boolean;
  terminal?: Json;
  failure?: string;
  done: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  stopped: Promise<void>;
  settleStopped(): void;
  deadline?: ReturnType<typeof setTimeout>;
  startup?: ReturnType<typeof setTimeout>;
  escalation?: ReturnType<typeof setTimeout>;
  killStarted?: boolean;
  policyDirectory?: string;
  mcpConfiguration?: { command: string; args: string[]; env: Record<string, string> };
  cursorProjectDirectory?: string;
  cursorHome?: string;
  cursorConfigDirectory?: string;
  spawnDirectory?: string;
  promptPrefix?: string;
  finishing?: boolean;
  setupComplete?: boolean;
  supportsTrust?: boolean;
  workspaceTrusted?: boolean;
  workspaceTrust?: { id: string; resolve(): void };
}

/** 每轮使用独立原生 JSONL 进程，仅使用原生会话 ID 续聊。 */
export class StreamCliSession implements AgentSession {
  private id?: string;
  private ready = false;
  private closed = false;
  private sending = false;
  private selection?: ModelSelection;
  private active?: Run;
  private calls = new Map<string, ToolCall>();
  private hostBridge?: HostToolBridge;
  private cursorRuntimeDirectory?: string;

  constructor(private options: StreamCliSessionOptions) {
    if (!['claude', 'gemini', 'cursor'].includes(options.cli)) throw new Error('不支持的 CLI 协议');
    if (![options.workspace, options.executablePath].every((p) => path.isAbsolute(p)))
      throw new Error('CLI 与工作目录需要完整路径');
    if (
      options.sessionId &&
      (!identifier(options.sessionId) ||
        options.sessionId === 'latest' ||
        /^\d+$/.test(options.sessionId))
    )
      throw new Error('需要明确的原生会话 ID，不能使用最近会话或序号');
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
    if (this.closed) throw new Error('CLI 会话已关闭');
    if (this.options.cli === 'gemini' && this.options.tools.length)
      throw new Error('Gemini 尚未接通宿主工具');
    if (selection && this.active) throw new Error('任务进行中，不能切换 CLI 模型');
    if (
      this.options.tools.length &&
      (!this.options.mcpServerPath || !path.isAbsolute(this.options.mcpServerPath))
    )
      throw new Error('当前执行器缺少 Athena MCP 服务文件');
    if (
      selection &&
      (!selection.model.trim() ||
        selection.model.length > 256 ||
        /[\x00-\x1f]/.test(selection.model))
    )
      throw new Error('模型标识无效');
    if (
      selection?.effort &&
      (this.options.cli !== 'claude' ||
        !['low', 'medium', 'high', 'xhigh', 'max'].includes(selection.effort))
    )
      throw new Error('此 CLI 不支持所选推理强度');
    if (selection) this.selection = { ...selection };
    // No prompt (or model call) is used for preparation/discovery. Native startup is verified by send.
    this.ready = true;
  }
  async listModels(): Promise<ModelOption[]> {
    await this.prepare();
    return []; // No shared, authoritative structured model catalog for these three print protocols.
  }
  async send(
    prompt: string,
    context?: string,
    selectedElement?: ElementRef,
    selection?: ModelSelection,
  ) {
    if (this.active || this.sending) throw new Error('请等待当前 CLI 任务完成，或先停止');
    if (!prompt.trim() || prompt.length > 20000 || (context?.length ?? 0) > 60000)
      throw new Error('CLI 消息格式或长度无效');
    let elementContext = '';
    if (this.options.cli === 'gemini' && selectedElement)
      throw new Error('Gemini 尚未接通网页元素上下文');
    this.sending = true;
    try {
      await this.prepare(selection);
      elementContext = await selectedElementContext(this.options, selectedElement);
    } finally {
      this.sending = false;
    }
    if (this.closed) throw new Error('CLI 会话已关闭');
    let resolve!: () => void, reject!: (error: Error) => void, settleStopped!: () => void;
    const run: Run = {
      turnId: randomUUID(),
      requested: this.selection?.model,
      expectedSession: this.id,
      text: '',
      messageText: '',
      initialized: false,
      done: new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
      stopped: new Promise<void>((yes) => {
        settleStopped = yes;
      }),
      resolve: () => resolve(),
      reject: (e) => reject(e),
      settleStopped: () => settleStopped(),
    };
    this.active = run;
    this.calls.clear();
    this.emit({ type: 'status', status: 'starting', label: `${this.options.cli} 正在启动` });
    // Launch asynchronously so the returned rejection is attached before a setup failure can settle it.
    void this.launch(
      run,
      [prompt, context ? `<task_context>\n${context}\n</task_context>` : '', elementContext]
        .filter(Boolean)
        .join('\n\n'),
      this.selection,
    )
      .catch(() => this.stop(run, '无法启动本机 CLI，请检查安装与受限模式支持'))
      .finally(() => {
        run.setupComplete = true;
        if (this.active === run && run.failure && !run.child) this.finish(run, run.failure);
      });
    return run.done;
  }
  private async startToolBridge(run: Run) {
    if (!this.options.tools.length) return;
    if (!this.options.mcpServerPath || !path.isAbsolute(this.options.mcpServerPath))
      throw new Error('当前执行器缺少 Athena MCP 服务文件');
    this.hostBridge = new HostToolBridge(
      this.options.tools,
      (name, args) => {
        if (this.active !== run || run.failure || run.finishing || run.terminal || !run.initialized)
          return Promise.resolve({ text: '当前任务已停止或尚未就绪', isError: true });
        return this.options.callTool(name, args);
      },
      (event) => this.emit(event),
    );
    const endpoint = await this.hostBridge.start();
    run.mcpConfiguration = {
      command: process.execPath,
      args: [this.options.mcpServerPath],
      env: {
        WORKBENCH_MCP_URL: endpoint.url,
        WORKBENCH_MCP_TOKEN: endpoint.token,
        WORKBENCH_MCP_TOOLS: JSON.stringify(this.options.tools),
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
    };
  }
  private async privateDirectory(run: Run) {
    run.policyDirectory ??= await mkdtemp(path.join(os.tmpdir(), 'athena-cli-tools-'));
    return run.policyDirectory;
  }
  private async configureCursor(run: Run) {
    if (!run.mcpConfiguration) return;
    if (!this.options.toolRuntimeDirectory || !path.isAbsolute(this.options.toolRuntimeDirectory))
      throw new Error('Cursor 缺少 Athena 私有工具目录');
    let root = this.options.workspace;
    for (let current = root; ; current = path.dirname(current)) {
      try {
        await lstat(path.join(current, '.git'));
        root = current;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (path.dirname(current) === current) break;
    }
    for (let current = this.options.workspace; ; current = path.dirname(current)) {
      for (const file of ['mcp.json', 'hooks.json', 'cli.json']) {
        try {
          await lstat(path.join(current, '.cursor', file));
          throw new Error('Cursor 项目已有 MCP、hook 或 CLI 权限配置，不能隔离审批范围');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (current === root || path.dirname(current) === current) break;
    }
    await mkdir(this.options.toolRuntimeDirectory, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(this.options.toolRuntimeDirectory, 'cursor-'));
    this.cursorRuntimeDirectory = directory;
    const home = path.join(directory, 'home');
    const config = path.join(directory, 'config');
    await Promise.all([
      mkdir(path.join(home, '.cursor'), { recursive: true, mode: 0o700 }),
      mkdir(config, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      path.join(home, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { athena_workbench: run.mcpConfiguration } }),
      { mode: 0o600, flag: 'wx' },
    );
    const originalConfigDirectory =
      process.env.CURSOR_CONFIG_DIR ||
      (process.env.XDG_CONFIG_HOME
        ? path.join(process.env.XDG_CONFIG_HOME, 'cursor')
        : path.join(homedir(), '.cursor'));
    let original: Json = {};
    try {
      const value = JSON.parse(
        await readFile(path.join(originalConfigDirectory, 'cli-config.json'), 'utf8'),
      );
      if (!object(value)) throw new Error('Cursor 本机配置无效');
      original = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const retained = Object.fromEntries(
      ['model', 'hasChangedDefaultModel', 'maxMode', 'privacyCache', 'authInfo', 'network']
        .filter((key) => original[key] !== undefined)
        .map((key) => [key, original[key]]),
    );
    await writeFile(
      path.join(config, 'cli-config.json'),
      JSON.stringify({
        version: 1,
        editor: { vimMode: false },
        ...retained,
        approvalMode: 'allowlist',
        permissions: {
          allow: this.options.tools.map((tool) => `Mcp(athena_workbench:${tool.name})`),
          deny: [],
        },
      }),
      { mode: 0o600, flag: 'wx' },
    );
    // 只链接 CLI 自己管理的认证文件，不读取令牌；原生会话继续保存在原数据目录。
    if (process.platform !== 'win32') {
      const originalAuth =
        process.platform === 'darwin'
          ? path.join(homedir(), '.cursor', 'auth.json')
          : path.join(
              process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'),
              'cursor',
              'auth.json',
            );
      try {
        await lstat(originalAuth);
        const authDirectory =
          process.platform === 'darwin'
            ? path.join(home, '.cursor')
            : path.join(home, 'xdg', 'cursor');
        await mkdir(authDirectory, { recursive: true, mode: 0o700 });
        await symlink(originalAuth, path.join(authDirectory, 'auth.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    run.cursorProjectDirectory = this.options.workspace;
    run.cursorHome = home;
    run.cursorConfigDirectory = config;
    run.spawnDirectory = this.options.workspace;
  }
  private async arguments(run: Run, selection?: ModelSelection): Promise<string[]> {
    const resume = run.expectedSession ? ['--resume', run.expectedSession] : [];
    const model = selection ? ['--model', selection.model] : [];
    if (this.options.cli === 'claude') {
      let config = '{"mcpServers":{}}';
      if (run.mcpConfiguration) {
        const directory = await this.privateDirectory(run);
        config = path.join(directory, 'claude-mcp.json');
        await writeFile(
          config,
          JSON.stringify({ mcpServers: { athena_workbench: run.mcpConfiguration } }),
          {
            mode: 0o600,
          },
        );
      }
      return [
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--safe-mode',
        '--tools',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        config,
        ...(run.mcpConfiguration
          ? [
              '--allowedTools',
              ...this.options.tools.map((tool) => `mcp__athena_workbench__${tool.name}`),
            ]
          : []),
        '--permission-mode',
        'dontAsk',
        '--permission-prompts',
        'none',
        '--disable-slash-commands',
        '--no-chrome',
        ...resume,
        ...model,
        ...(selection?.effort ? ['--effort', selection.effort] : []),
      ];
    }
    if (this.options.cli === 'cursor') {
      await this.configureCursor(run);
      return [
        '--print',
        '--output-format',
        'stream-json',
        '--stream-partial-output',
        '--mode',
        'ask',
        ...(run.mcpConfiguration ? ['--approve-mcps'] : []),
        ...(run.workspaceTrusted && run.supportsTrust ? ['--trust'] : []),
        ...resume,
        ...model,
      ];
    }
    // Gemini ignores supplemental policies when system policies exist. Refuse instead of weakening them.
    const systemPolicies =
      process.platform === 'darwin'
        ? '/Library/Application Support/GeminiCli/policies'
        : process.platform === 'win32'
          ? 'C:\\ProgramData\\gemini-cli\\policies'
          : '/etc/gemini-cli/policies';
    try {
      if ((await readdir(systemPolicies)).some((name) => name.endsWith('.toml')))
        throw new Error('Gemini 系统策略不允许隔离工具');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Plan can fall back to default in user settings. Deny tools independently, at the admin tier.
    const directory = await this.privateDirectory(run);
    const policy = path.join(directory, 'deny-tools.toml');
    await writeFile(policy, '[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n', {
      mode: 0o600,
    });
    return [
      '--output-format',
      'stream-json',
      '--approval-mode',
      'plan',
      '--admin-policy',
      policy,
      '--extensions',
      'none',
      ...resume,
      ...model,
    ];
  }
  private async launch(run: Run, prompt: string, selection?: ModelSelection) {
    if (this.options.cli === 'cursor') {
      const help = await promisify(execFile)(this.options.executablePath, ['--help'], {
        timeout: 8000,
        maxBuffer: 256 * 1024,
        env: cliEnvironment(this.options.executablePath),
      });
      run.supportsTrust = help.stdout.includes('--trust');
      if (this.closed || run.failure) return;
      await new Promise<void>((resolve) => {
        const id = `cursor-workspace:${run.turnId}`;
        run.workspaceTrust = { id, resolve };
        run.deadline = setTimeout(
          () => this.stop(run, 'Cursor 工作目录确认已超时'),
          15 * 60 * 1000,
        );
        this.emit({ type: 'status', status: 'waiting', label: '等待确认 Cursor 工作目录' });
        this.emit({
          type: 'approval',
          request: {
            id,
            kind: 'other',
            title: '允许 Cursor 使用这个工作目录？',
            detail: `${this.options.workspace}\n\n仅限本次任务。Cursor 以 Ask 模式读取此目录，Athena 通过独立 MCP 连接 Neo；网页写入仍受 Athena 的任务范围和确认控制。`,
          },
        });
      });
      if (this.active !== run || this.closed || run.failure || !run.workspaceTrusted) return;
      clearTimeout(run.deadline);
    }
    await this.startToolBridge(run);
    const args = await this.arguments(run, selection);
    if (this.active !== run || this.closed || run.failure) {
      return;
    }
    // Prompt travels on stdin, never as an option/argv. Never answer native permission prompts here.
    const child = spawn(this.options.executablePath, args, {
      cwd: run.spawnDirectory ?? this.options.workspace,
      env: {
        ...process.env,
        PATH: `${path.dirname(this.options.executablePath)}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
        ...(this.options.cli === 'cursor' && run.cursorProjectDirectory
          ? {
              HOME: run.cursorHome!,
              XDG_CONFIG_HOME: path.join(run.cursorHome!, 'xdg'),
              CURSOR_CONFIG_DIR: run.cursorConfigDirectory!,
              CURSOR_DATA_DIR: process.env.CURSOR_DATA_DIR ?? path.join(homedir(), '.cursor'),
            }
          : {}),
      },
      detached: process.platform !== 'win32',
      stdio: 'pipe',
    });
    run.child = child;
    let diagnostic: 'quota' | 'authentication' | undefined;
    let diagnosticTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      // Classify bounded diagnostics without exposing provider text, headers or credentials.
      diagnosticTail = (diagnosticTail + chunk.toString('utf8')).slice(-2048);
      if (
        /usage limit (?:reached|exceeded)|quota (?:has been )?exceeded|insufficient_quota/i.test(
          diagnosticTail,
        )
      )
        diagnostic = 'quota';
      else if (
        /authentication required|not (?:logged|signed) in|please set an auth method/i.test(
          diagnosticTail,
        )
      )
        diagnostic ??= 'authentication';
    });
    const failureMessage = () =>
      diagnostic === 'quota'
        ? '当前模型服务额度已用尽，请检查账户额度后重试'
        : diagnostic === 'authentication'
          ? 'CLI 需要登录或 API 配置，请先在终端完成后重试'
          : 'CLI 执行失败，请在终端检查登录与模型配置';
    child.stdin.on('error', () => this.stop(run, 'CLI 输入连接中断'));
    child.on('error', () => this.stop(run, '无法启动本机 CLI，请检查安装'));
    let buffer = '';
    child.stdout.setEncoding('utf8');
    const parse = (line: string) => {
      if (!line.trim() || run.failure) return;
      try {
        const record: unknown = JSON.parse(line);
        if (!object(record)) throw new Error('invalid');
        this.handle(run, record);
      } catch {
        this.stop(run, 'CLI 返回无效的 JSONL 协议记录');
      }
    };
    child.stdout.on('data', (chunk: string) => {
      if (this.active !== run || run.failure) return;
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) {
        this.stop(run, 'CLI 协议记录过大');
        return;
      }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        parse(line);
      }
    });
    // Kill descendants even if the process-group leader exited first.
    child.on('exit', () => this.killGroup(run));
    child.on('close', (code, signal) => {
      if (this.active !== run) return;
      if (buffer.trim()) parse(buffer);
      const failure =
        run.failure ??
        (code !== 0 || signal
          ? failureMessage()
          : !run.initialized || !run.terminal
            ? 'CLI 未返回完整的本轮结果，不能确认任务完成'
            : undefined);
      this.finish(run, failure);
    });
    run.startup = setTimeout(
      () => this.stop(run, diagnostic ? failureMessage() : 'CLI 未及时返回原生会话，已停止'),
      this.options.cli === 'cursor' ? 60000 : 30000,
    );
    run.deadline = setTimeout(() => this.stop(run, 'CLI 任务超时，已停止'), 15 * 60 * 1000);
    child.stdin.end(run.promptPrefix ? `${run.promptPrefix}\n\n${prompt}` : prompt);
  }
  private initialize(run: Run, id: unknown) {
    if (!identifier(id) || (run.expectedSession && id !== run.expectedSession)) {
      this.stop(run, 'CLI 原生会话恢复失败或返回了其他会话');
      return;
    }
    if (run.initialized) {
      this.stop(run, 'CLI 重复初始化会话');
      return;
    }
    clearTimeout(run.startup);
    run.initialized = true;
    this.id = id;
    this.emit({
      type: 'run-started',
      threadId: id,
      turnId: run.turnId,
      model: { requested: run.requested, source: 'unconfirmed' },
      baseline: zeroTokens(),
    });
    this.emit({ type: 'status', status: 'thinking', label: `${this.options.cli} 正在处理` });
  }
  private delta(run: Run, value: unknown) {
    if (typeof value !== 'string' || !value || run.failure) return;
    if (run.text.length + value.length > 4 * 1024 * 1024) {
      this.stop(run, 'CLI 回复过长，已停止');
      return;
    }
    run.text += value;
    this.emit({ type: 'delta', text: value });
  }
  private model(run: Run, value: unknown) {
    if (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 256 &&
      !value.startsWith('<')
    )
      this.emit({
        type: 'model',
        threadId: this.id!,
        turnId: run.turnId,
        model: { model: value, requested: run.requested, source: 'cli-message' },
      });
  }
  private usage(run: Run, tokens: TokenCounts) {
    if (Object.values(tokens).some((v) => v !== null))
      this.emit({
        type: 'usage',
        threadId: this.id!,
        turnId: run.turnId,
        total: tokens,
        last: { ...tokens },
      });
  }
  private handle(run: Run, record: Json) {
    if (run.failure || run.finishing || this.active !== run) return;
    const cli = this.options.cli;
    if (
      record.type === 'control_request' ||
      record.type === 'approval_request' ||
      record.type === 'permission_request'
    ) {
      this.stop(run, 'CLI 请求了尚未桥接的原生审批，已停止');
      return;
    }
    if (record.type === 'error' && !(cli === 'gemini' && record.severity === 'warning')) {
      this.stop(run, 'CLI 报告本轮执行错误');
      return;
    }
    if (
      (cli === 'gemini' && record.type === 'init') ||
      (cli !== 'gemini' && record.type === 'system' && record.subtype === 'init')
    ) {
      this.initialize(run, record.session_id);
      return;
    }
    if (!run.initialized) {
      if (
        ['assistant', 'message', 'stream_event', 'result', 'tool_use', 'tool_call'].includes(
          record.type,
        )
      )
        this.stop(run, 'CLI 未先确认原生会话');
      return;
    }
    if (record.session_id !== undefined && record.session_id !== this.id) {
      this.stop(run, 'CLI 返回了其他会话的消息');
      return;
    }
    if (record.parent_tool_use_id) return; // No subagent text or hidden reasoning in the main answer.
    if (run.terminal) {
      if (record.type === 'result') this.stop(run, 'CLI 返回重复的最终结果');
      return;
    }
    if (record.type === 'result') {
      const success =
        cli === 'gemini'
          ? record.status === 'success' && !record.error
          : record.subtype === 'success' && record.is_error === false;
      const denied =
        Array.isArray(record.permission_denials) && record.permission_denials.length > 0;
      if (
        !success ||
        denied ||
        record.error ||
        record.aborted === true ||
        (cli === 'claude' &&
          ['max_tokens', 'refusal', 'tool_use', 'aborted', 'cancelled', 'error', 'length'].includes(
            record.stop_reason,
          ))
      ) {
        this.stop(run, denied ? 'CLI 工具权限被拒绝，本轮能力受限' : 'CLI 未成功完成本轮任务');
        return;
      }
      if ([...this.calls.values()].some((call) => call.status === 'running')) {
        this.stop(run, 'CLI 工具尚未完成，不能确认任务成功');
        return;
      }
    }
    if (cli === 'claude') this.claude(run, record);
    else if (cli === 'gemini') this.gemini(run, record);
    else this.cursor(run, record);
    if (record.type === 'result' && !run.failure) run.terminal = record; // Also requires a clean exit.
  }
  private claude(run: Run, r: Json) {
    if (r.type === 'system' && r.subtype === 'permission_denied') {
      this.stop(run, 'CLI 工具权限被拒绝，本轮能力受限');
      return;
    }
    if (r.type === 'stream_event') {
      const e = r.event;
      if (e?.type === 'message_start') {
        run.messageText = '';
        this.model(run, e.message?.model);
      }
      if (
        e?.type === 'content_block_delta' &&
        e.delta?.type === 'text_delta' &&
        typeof e.delta.text === 'string'
      ) {
        run.messageText += e.delta.text;
        this.delta(run, e.delta.text);
      }
    }
    if (r.type === 'assistant') {
      if (
        r.error ||
        ['max_tokens', 'refusal', 'aborted', 'cancelled', 'error', 'length'].includes(
          r.message?.stop_reason,
        )
      ) {
        this.stop(run, 'CLI 模型未完成本轮回复');
        return;
      }
      this.model(run, r.message?.model);
      const full = contentText(r.message?.content);
      if (full.startsWith(run.messageText)) this.delta(run, full.slice(run.messageText.length));
      run.messageText = '';
      if (
        r.message?.content?.some(
          (p: Json) =>
            p.type === 'tool_use' &&
            !this.options.tools.some((tool) => p.name === `mcp__athena_workbench__${tool.name}`),
        )
      )
        this.stop(run, 'CLI 返回了已禁用的工具调用');
    }
    if (r.type === 'result') {
      if (!run.text && typeof r.result === 'string') this.delta(run, r.result);
      if (object(r.usage)) {
        const u = r.usage,
          tokens = unknownTokens();
        const input = [
          count(u.input_tokens),
          count(u.cache_read_input_tokens),
          count(u.cache_creation_input_tokens),
        ];
        tokens.inputTokens = input.every((v) => v !== null)
          ? input.reduce<number>((a, b) => a + b!, 0)
          : null;
        tokens.outputTokens = count(u.output_tokens);
        tokens.cachedInputTokens = count(u.cache_read_input_tokens);
        tokens.cacheWriteInputTokens = count(u.cache_creation_input_tokens);
        tokens.totalTokens = count(u.total_tokens);
        this.usage(run, tokens);
      }
    }
  }
  private gemini(run: Run, r: Json) {
    if (r.type === 'message' && r.role === 'assistant' && typeof r.content === 'string') {
      if (r.delta === true) {
        run.messageText += r.content;
        this.delta(run, r.content);
      } else if (r.content.startsWith(run.messageText)) {
        this.delta(run, r.content.slice(run.messageText.length));
        run.messageText = r.content;
      } else this.stop(run, 'Gemini 完整文本与流式输出不一致');
    }
    if (r.type === 'tool_use') {
      this.stop(run, 'Gemini 返回了已禁用的工具调用');
      return;
    }
    if (r.type === 'result' && object(r.stats)) {
      const s = r.stats,
        tokens = unknownTokens();
      tokens.inputTokens = count(s.input_tokens);
      tokens.outputTokens = count(s.output_tokens);
      tokens.cachedInputTokens = count(s.cached);
      tokens.totalTokens = count(s.total_tokens);
      this.usage(run, tokens);
      // init.model can be an auto/router alias. Only per-model result accounting proves execution.
      if (object(s.models))
        for (const [model, usage] of Object.entries(s.models)) {
          if (object(usage) && (count(usage.total_tokens) ?? 0) > 0) this.model(run, model);
        }
    }
  }
  private cursor(run: Run, r: Json) {
    if (
      r.type === 'assistant' &&
      typeof r.timestamp_ms === 'number' &&
      r.model_call_id === undefined
    )
      this.delta(run, contentText(r.message?.content));
    if (r.type === 'tool_call') {
      if (
        typeof r.call_id !== 'string' ||
        !r.call_id.length ||
        r.call_id.length > 512 ||
        !object(r.tool_call)
      ) {
        this.stop(run, 'Cursor 工具记录格式无效');
        return;
      }
      const entries = Object.entries(r.tool_call);
      if (entries.length !== 1 || !object(entries[0][1])) {
        this.stop(run, 'Cursor 工具记录格式无效');
        return;
      }
      const [name, detail] = entries[0] as [string, Json];
      const isMcp = name === 'mcpToolCall';
      const mcpArgs = detail.args;
      if (
        isMcp &&
        (!object(mcpArgs) ||
          mcpArgs.providerIdentifier !== 'athena_workbench' ||
          mcpArgs.name !== `athena_workbench-${mcpArgs.toolName}` ||
          !this.options.tools.some((tool) => tool.name === mcpArgs.toolName) ||
          !object(mcpArgs.args))
      ) {
        this.stop(run, 'Cursor 返回了未授权的 MCP 工具');
        return;
      }
      const toolName = isMcp ? mcpArgs.toolName : name;
      if (r.subtype === 'started') {
        // 原生文件工具保持 Ask 模式；网页能力只接受本轮注册的 Athena 工具。
        if (
          ![
            'readToolCall',
            'lsToolCall',
            'grepToolCall',
            'globToolCall',
            'semSearchToolCall',
          ].includes(name) &&
          !isMcp
        ) {
          this.stop(run, 'Cursor 请求了只读适配之外的工具，已停止');
          return;
        }
        const call: ToolCall = {
          id: r.call_id,
          name: toolName,
          input: isMcp ? mcpArgs.args : object(detail.args) ? detail.args : {},
          status: 'running',
        };
        if (this.calls.has(call.id)) {
          this.stop(run, 'Cursor 返回了重复的工具调用');
          return;
        }
        this.calls.set(call.id, call);
        // 宿主桥负责网页工具的真实开始/结束事件，原生事件仅用于协议核对。
        if (!isMcp) this.emit({ type: 'tool', call: { ...call } });
      } else if (r.subtype === 'completed') {
        const call = this.calls.get(r.call_id);
        if (!call || call.name !== toolName || call.status !== 'running') {
          this.stop(run, 'Cursor 未返回匹配的工具开始记录');
          return;
        }
        const success = detail.result?.success;
        call.status =
          object(detail.result) &&
          (isMcp
            ? object(success) && success.isError !== true
            : object(success) || success === true || detail.result.isError === false)
            ? 'done'
            : 'error';
        if (!isMcp) this.emit({ type: 'tool', call: { ...call } });
        // MCP 正常返回的工具错误允许 Agent 观察和恢复；传输/权限失败则停止。
        if (call.status === 'error' && (!isMcp || !object(success)))
          this.stop(run, 'Cursor 原生工具执行失败');
      }
    }
    if (r.type === 'result' && typeof r.result === 'string') {
      if (r.result.startsWith(run.text)) this.delta(run, r.result.slice(run.text.length));
      else this.stop(run, 'Cursor 最终文本与流式输出不一致');
    }
    // Cursor's documented print result has no token usage or response-model evidence.
  }
  resolveApproval(id: string, approved: boolean): void {
    const run = this.active;
    const pending = run?.workspaceTrust;
    if (!run || this.closed || !pending || pending.id !== id) {
      if (id.startsWith('cursor-workspace:')) throw new Error('审批已失效');
      throw new Error('此 CLI 尚未接通原生工具审批');
    }
    run.workspaceTrust = undefined;
    this.emit({ type: 'request-resolved', id });
    if (approved) {
      run.workspaceTrusted = true;
      this.emit({ type: 'status', status: 'starting', label: 'Cursor 正在启动' });
    } else this.stop(run, '已拒绝 Cursor 使用此工作目录');
    pending.resolve();
  }
  resolveUserInput(_id: string, _answers: Record<string, string[]>): void {
    throw new Error('此 CLI 尚未接通原生提问');
  }
  async interrupt() {
    const run = this.active;
    if (!run) {
      if (this.sending) this.close();
      return;
    }
    this.stop(run, '任务已停止');
    await run.stopped;
  }
  private signal(run: Run, signal: NodeJS.Signals) {
    const child = run.child;
    if (!child?.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* Group already exited. */
    }
  }
  private killGroup(run: Run) {
    if (run.killStarted || !run.child?.pid) return;
    run.killStarted = true;
    this.signal(run, 'SIGTERM');
    run.escalation = setTimeout(() => {
      this.signal(run, 'SIGKILL');
      if (this.active === run && run.failure) this.finish(run, run.failure);
    }, 1500);
    run.escalation.unref();
  }
  private stop(run: Run, reason: string) {
    if (this.active !== run) return;
    run.failure ??= reason;
    if (run.workspaceTrust) {
      const pending = run.workspaceTrust;
      run.workspaceTrust = undefined;
      this.emit({ type: 'request-resolved', id: pending.id });
      pending.resolve();
    }
    this.killGroup(run);
    if (!run.child && run.setupComplete) this.finish(run, run.failure);
  }
  private async removePolicy(run: Run) {
    if (run.policyDirectory) await rm(run.policyDirectory, { recursive: true, force: true });
  }
  private finish(run: Run, failure?: string) {
    if (this.active !== run || run.finishing) return;
    if (!run.child && !run.setupComplete) return;
    run.finishing = true;
    clearTimeout(run.startup);
    clearTimeout(run.deadline);
    // Do not cancel escalation: surviving descendants must still receive SIGKILL after leader exit.
    void this.finishAfterCleanup(run, failure);
  }
  private async finishAfterCleanup(run: Run, failure?: string) {
    let cleanupFailed = false;
    try {
      await this.hostBridge?.close();
    } catch {
      cleanupFailed = true;
    }
    this.hostBridge = undefined;
    try {
      await this.removePolicy(run);
    } catch {
      cleanupFailed = true;
    }
    if (this.cursorRuntimeDirectory) {
      try {
        await rm(this.cursorRuntimeDirectory, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
      this.cursorRuntimeDirectory = undefined;
    }
    if (cleanupFailed)
      failure = [failure, '本机工具运行时清理未完成，请检查 Athena 私有运行目录后再继续。']
        .filter(Boolean)
        .join('；');
    if (this.active !== run) return;
    this.active = undefined;
    if (run.workspaceTrust) {
      const pending = run.workspaceTrust;
      run.workspaceTrust = undefined;
      this.emit({ type: 'request-resolved', id: pending.id });
      pending.resolve();
    }
    if (failure) {
      this.closed = true;
      this.ready = false;
      this.emit({ type: 'error', message: failure });
      run.reject(new Error(failure));
      this.options.onClose?.(failure);
    } else {
      this.emit({ type: 'complete', text: run.text, sessionId: this.id });
      run.resolve();
    }
    this.emit({ type: 'status', status: 'idle' });
    run.settleStopped();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.active) this.stop(this.active, 'CLI 会话已关闭');
    else this.options.onClose?.('CLI 会话已关闭');
  }
}
