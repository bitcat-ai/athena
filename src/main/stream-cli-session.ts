import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, opendir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, AgentSessionOptions } from './agent-session';
import { unavailableProviderSkillDiscovery } from '../shared/provider-skills';
import type { AgentEvent, BrowserTool, ElementRef, ToolCall } from '../shared/types';
import { selectProviderSkills } from './skill-injection';
import type { ProviderSkill, ProviderSkillDiscovery } from '../shared/skills';
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
  workspaceTrusted?: boolean;
  workspaceTrust?: { id: string; resolve(): void };
}

// Deliberately a small YAML subset: no aliases, tags, merges or executable configuration.
// Unsupported frontmatter is skipped rather than accidentally exposing a hidden skill.
function cursorSkillMetadata(text: string): { description: string; userInvocable: boolean; cliVisible: boolean } | undefined {
  const result = { description: '未提供描述', userInvocable: true, cliVisible: true };
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return result;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return;
  const scalar = (value: string) => {
    const raw = value.trim();
    if (raw.startsWith('"')) {
      try { const parsed: unknown = JSON.parse(raw); return typeof parsed === 'string' ? parsed : undefined; } catch { return; }
    }
    if (/^'([^']|'')*'$/.test(raw)) return raw.slice(1, -1).replace(/''/g, "'");
    if (/[\[\]{}&*!|>]/.test(raw)) return;
    return raw.replace(/\s+#.*$/, '').trim();
  };
  let section = '';
  let surfaces: string[] | undefined;
  let descriptionLines: string[] | undefined;
  const keys = new Set<string>();
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (descriptionLines && /^\s+/.test(line)) { descriptionLines.push(line.trim()); result.description = descriptionLines.join(' '); continue; }
    descriptionLines = undefined;
    if (/^\s*\t/.test(line)) return;
    if (section === 'surfaces' && /^\s+-\s+/.test(line)) {
      const value = scalar(line.replace(/^\s+-\s+/, ''));
      if (value === undefined) return;
      surfaces!.push(value);
      continue;
    }
    const entry = /^( *)([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (!entry) return;
    const [, indent, key, raw] = entry;
    if (!indent) {
      if (keys.has(key)) return;
      keys.add(key);
      section = key;
      if (key === 'description' && /^[|>][-+]?$/.test(raw)) { descriptionLines = []; result.description = ''; }
      else if (key === 'description') { const value = scalar(raw); if (value === undefined) return; result.description = value || result.description; }
      else if (key === 'user-invocable') {
        const value = scalar(raw)?.toLowerCase();
        if (!value || !['true', 'false', 'yes', 'no', 'on', 'off', '1', '0'].includes(value)) return;
        result.userInvocable = !['false', 'no', 'off', '0'].includes(value);
      } else if (key === 'metadata' && raw) return;
      else if (key === 'metadata' && !raw) section = 'metadata';
    } else if ((section === 'metadata' || section === 'surfaces') && key === 'surfaces') {
      if (surfaces) return;
      section = 'surfaces';
      if (!raw) surfaces = [];
      else {
        const values = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1).split(',') : [raw];
        const parsed = values.map(scalar);
        if (parsed.some((value) => value === undefined)) return;
        surfaces = parsed.flatMap((value) => value!.split(',')).filter(Boolean);
      }
    }
  }
  result.cliVisible = !surfaces?.length || surfaces.some((value) => value.trim().toLowerCase() === 'cli');
  return result;
}

async function discoverCursorSkills(workspace: string): Promise<ProviderSkillDiscovery> {
  const provider = { id: 'cursor', name: 'Cursor Agent' };
  const skills = new Map<string, ProviderSkill>();
  const diagnostics: ProviderSkillDiscovery['diagnostics'] = [];
  const warn = (code: ProviderSkillDiscovery['diagnostics'][number]['code'], message: string) => {
    if (!diagnostics.some((item) => item.code === code)) diagnostics.push({ code, message });
  };
  let entriesLeft = 10_000;
  let bytesLeft = 8_000_000;
  const seenRoots = new Set<string>();
  const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
  const home = path.resolve(os.homedir());
  const bases: string[] = [];
  // Nearest project roots win; user roots and Cursor's synced built-ins come last.
  for (let base = workspace; base !== home; base = path.dirname(base)) {
    bases.push(base);
    if (path.dirname(base) === base || bases.length >= 64) break;
  }
  bases.push(home);
  const roots = bases.flatMap((base) => ['.cursor', '.agents', '.codex', '.claude'].map((directory) => ({ base, relative: path.join(directory, 'skills') })));
  roots.push({ base: home, relative: path.join('.cursor', 'skills-cursor') });
  for (const { base, relative } of roots) {
    if (entriesLeft <= 0 || bytesLeft <= 0) break;
    let root: string;
    try {
      const canonicalBase = await realpath(base);
      root = path.join(canonicalBase, relative);
      if (await realpath(root) !== root) { warn('unsafe-path', '已跳过符号链接 Skill 根目录'); continue; }
      if (seenRoots.has(root)) continue;
      seenRoots.add(root);
    } catch (error) { if (!missing(error)) warn('unreadable-entry', '部分 Cursor Skill 根目录无法读取'); continue; }
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (entriesLeft <= 0 || bytesLeft <= 0) return;
      entriesLeft--;
      const entryPath = path.join(directory, 'SKILL.md');
      try {
        const info = await lstat(entryPath);
        if (info.isSymbolicLink()) warn('unsafe-path', '已跳过符号链接 Skill 文件');
        else if (info.isFile()) {
          if (info.size > 1_000_000 || info.size > bytesLeft) warn('oversized-entry', '已跳过超出读取预算的 Cursor Skill');
          else {
            const file = await open(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const opened = await file.stat();
              if (opened.isFile() && opened.size <= 1_000_000 && opened.size <= bytesLeft) {
                const buffer = Buffer.alloc(Math.min(1_000_001, bytesLeft + 1));
                let size = 0;
                while (size < buffer.length) {
                  const read = await file.read(buffer, size, buffer.length - size, null);
                  if (!read.bytesRead) break;
                  size += read.bytesRead;
                }
                bytesLeft -= Math.min(size, bytesLeft);
                if (size > opened.size) warn('unreadable-entry', 'Cursor Skill 在读取期间发生变化');
                else {
                  const contents = buffer.subarray(0, size);
                  const metadata = cursorSkillMetadata(contents.toString('utf8'));
                  const name = path.basename(directory);
                  if (!metadata) warn('invalid-metadata', '已跳过无法安全解析元数据的 Cursor Skill');
                  else if (metadata.cliVisible && identifier(name) && !skills.has(name)) skills.set(name, {
                    name, description: metadata.description, userInvocable: metadata.userInvocable,
                    providerPath: entryPath, contentHash: createHash('sha256').update(contents).digest('hex'), source: 'provider', provider,
                  });
                }
              }
            } finally { await file.close(); }
          }
        }
      } catch (error) { if (!missing(error)) warn('unreadable-entry', '部分 Cursor Skill 文件无法读取'); }
      if (depth >= 10) return;
      try {
        const children: string[] = [];
        const directoryHandle = await opendir(directory);
        for await (const entry of directoryHandle) {
          if (entriesLeft-- <= 0) break;
          if (entry.name === 'node_modules') continue;
          if (entry.isSymbolicLink()) { warn('unsafe-path', '已跳过符号链接 Skill 目录'); continue; }
          if (entry.isDirectory()) children.push(entry.name);
        }
        for (const child of children.sort()) {
          if (entriesLeft <= 0 || bytesLeft <= 0) break;
          const childPath = path.join(directory, child);
          if (await realpath(childPath) !== childPath) { warn('unsafe-path', '已跳过符号链接 Skill 目录'); continue; }
          await visit(childPath, depth + 1);
        }
      } catch (error) { if (!missing(error)) warn('unreadable-entry', '部分 Cursor Skill 目录无法读取'); }
    };
    await visit(root, 0);
  }
  if (entriesLeft <= 0 || bytesLeft <= 0) warn('capability-degraded', 'Cursor Skill 扫描达到本地安全预算，结果可能不完整');
  return { provider, source: 'provider', status: skills.size ? 'ready' : diagnostics.length ? 'unavailable' : 'empty', skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
}

/** One native JSONL print process per turn; only native IDs may be resumed. No host tool bridge. */
export class StreamCliSession implements AgentSession {
  private id?: string;
  private ready = false;
  private closed = false;
  private sending = false;
  private selection?: ModelSelection;
  private active?: Run;
  private calls = new Map<string, ToolCall>();

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
    return undefined;
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
      tools.length === 0 &&
      this.options.tools.length === 0
    );
  }
  private emit(event: AgentEvent) {
    this.options.onEvent(event);
  }
  async prepare(selection?: ModelSelection) {
    if (this.closed) throw new Error('CLI 会话已关闭');
    if (selection && this.active) throw new Error('任务进行中，不能切换 CLI 模型');
    if (this.options.tools.length)
      throw new Error('此 CLI 尚未接通宿主浏览器工具，请禁用浏览器能力');
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
  async discoverProviderSkills() {
    if (this.options.cli === 'cursor')
      return discoverCursorSkills(this.options.workspace);
    const provider = this.options.cli;
    const names = { claude: 'Claude Code', gemini: 'Gemini CLI' } as const;
    const reason = provider === 'claude'
      ? 'Claude Code discovery is unavailable while the selected safe-mode environment disables slash commands and file-reading tools.'
      : 'Gemini skill activation is blocked by the deny-all admin policy, and no safe discovery RPC is verified.';
    return unavailableProviderSkillDiscovery({ id: provider, name: names[provider] }, reason);
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
    skills: ProviderSkill[] = [],
  ) {
    if (this.active || this.sending) throw new Error('请等待当前 CLI 任务完成，或先停止');
    if (!prompt.trim() || prompt.length > 20000 || (context?.length ?? 0) > 60000)
      throw new Error('CLI 消息格式或长度无效');
    if (selectedElement) throw new Error('此 CLI 尚未接通所选网页元素');
    this.sending = true;
    try {
      await this.prepare(selection);
      if (this.options.cli === 'cursor' && (skills.length || /(^|\s)\$[a-zA-Z0-9]/.test(prompt))) {
        const discovery = await discoverCursorSkills(this.options.workspace);
        const selected = selectProviderSkills(discovery.skills, skills.map((skill) => skill.name), 'cursor', skills.map((skill) => ({
          name: skill.name, providerId: skill.provider.id, providerPath: skill.providerPath, contentHash: skill.contentHash,
        })));
        const invocable = new Set(discovery.skills.filter((skill) => skill.userInvocable).map((skill) => skill.name));
        prompt = prompt.replace(/(^|\s)\$([a-zA-Z0-9][a-zA-Z0-9._-]*)(?=\s|$)/g, (match, prefix: string, name: string) => invocable.has(name) ? `${prefix}/${name}` : match);
        if (selected.length) prompt = `${selected.map((skill) => `/${skill.name}`).join('\n')}\n\n${prompt}`;
      }
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
      [prompt, context ? `<task_context>\n${context}\n</task_context>` : '']
        .filter(Boolean)
        .join('\n\n'),
      this.selection,
    ).catch(() => this.stop(run, '无法启动本机 CLI，请检查安装与受限模式支持'));
    return run.done;
  }
  private async arguments(run: Run, selection?: ModelSelection): Promise<string[]> {
    const resume = run.expectedSession ? ['--resume', run.expectedSession] : [];
    const model = selection ? ['--model', selection.model] : [];
    if (this.options.cli === 'claude')
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
        '{"mcpServers":{}}',
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
    if (this.options.cli === 'cursor')
      return [
        '--print',
        '--output-format',
        'stream-json',
        '--stream-partial-output',
        '--mode',
        'ask',
        ...(run.workspaceTrusted ? ['--trust'] : []),
        ...resume,
        ...model,
      ];
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
    const directory = await mkdtemp(path.join(os.tmpdir(), 'athena-gemini-policy-'));
    run.policyDirectory = directory;
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
            detail: `${this.options.workspace}\n\n仅限本次任务。Cursor 将读取目录并加载项目配置；其中的 hooks 或 MCP 可能执行代码，请仅确认你信任的目录。模型仍以 Ask 只读模式运行。`,
          },
        });
      });
      if (this.active !== run || this.closed || !run.workspaceTrusted) return;
      clearTimeout(run.deadline);
    }
    const args = await this.arguments(run, selection);
    if (this.active !== run || this.closed) {
      await this.removePolicy(run);
      return;
    }
    // Prompt travels on stdin, never as an option/argv. Never answer native permission prompts here.
    const child = spawn(this.options.executablePath, args, {
      cwd: this.options.workspace,
      env: {
        ...process.env,
        PATH: `${path.dirname(this.options.executablePath)}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
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
    child.stdin.end(prompt);
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
    if (run.failure || this.active !== run) return;
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
      if (r.message?.content?.some((p: Json) => p.type === 'tool_use'))
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
      if (r.subtype === 'started') {
        // Ask mode is the authorization boundary; unknown/mutating tools are not accepted as supported.
        if (
          ![
            'readToolCall',
            'lsToolCall',
            'grepToolCall',
            'globToolCall',
            'semSearchToolCall',
          ].includes(name)
        ) {
          this.stop(run, 'Cursor 请求了只读适配之外的工具，已停止');
          return;
        }
        const call: ToolCall = {
          id: r.call_id,
          name,
          input: object(detail.args) ? detail.args : {},
          status: 'running',
        };
        this.calls.set(call.id, call);
        this.emit({ type: 'tool', call: { ...call } });
      } else if (r.subtype === 'completed') {
        const call = this.calls.get(r.call_id);
        if (!call || call.name !== name || call.status !== 'running') {
          this.stop(run, 'Cursor 未返回匹配的工具开始记录');
          return;
        }
        call.status =
          object(detail.result) && (object(detail.result.success) || detail.result.success === true)
            ? 'done'
            : 'error';
        this.emit({ type: 'tool', call: { ...call } });
        if (call.status === 'error') this.stop(run, 'Cursor 原生工具执行失败');
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
    this.killGroup(run);
    if (!run.child) this.finish(run, run.failure);
  }
  private async removePolicy(run: Run) {
    if (run.policyDirectory) await rm(run.policyDirectory, { recursive: true, force: true });
  }
  private finish(run: Run, failure?: string) {
    if (this.active !== run) return;
    clearTimeout(run.startup);
    clearTimeout(run.deadline);
    // Do not cancel escalation: surviving descendants must still receive SIGKILL after leader exit.
    this.active = undefined;
    if (run.workspaceTrust) {
      const pending = run.workspaceTrust;
      run.workspaceTrust = undefined;
      this.emit({ type: 'request-resolved', id: pending.id });
      pending.resolve();
    }
    void this.removePolicy(run).catch(() => {});
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
