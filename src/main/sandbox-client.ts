import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  MAX_LINE_BYTES,
  RpcNotification,
  RpcResponse,
  SANDBOX_PROTOCOL_VERSION,
  errorCodes,
  methods,
  type MethodParams,
  type MethodResult,
  type SandboxErrorReason,
  type SandboxEventEnvelope,
  type SandboxMethod,
} from '../shared/sandbox-protocol';

export type SandboxConnectionStatus =
  'idle' | 'connecting' | 'ready' | 'reconnecting' | 'failed' | 'closed';
export interface SandboxConnectionState {
  status: SandboxConnectionStatus;
  message?: string;
  attempt?: number;
  server?: MethodResult<'hello'>;
}

export interface SandboxClientOptions {
  /** SSH host alias from ~/.ssh/config; ignored when `command` is overridden. */
  host: string;
  clientVersion: string;
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  backoffMs?: number[];
  maxAttempts?: number;
  onState?: (state: SandboxConnectionState) => void;
  onEvent?: (envelope: SandboxEventEnvelope) => void;
  /** Local state may be stale: fetch sandboxes and active tasks again. */
  onResync?: () => void;
}

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly reason: SandboxErrorReason | 'CONNECTION_LOST' | 'TIMEOUT' | 'NOT_CONNECTED',
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
  /** The request may or may not have reached the sandbox. */
  get outcomeUnknown() {
    return this.reason === 'CONNECTION_LOST' || this.reason === 'TIMEOUT';
  }
}

interface Pending {
  method: SandboxMethod;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const reasonByCode = new Map<number, SandboxErrorReason>(
  Object.entries(errorCodes).map(([reason, code]) => [code, reason as SandboxErrorReason]),
);
const MAX_INVALID_MESSAGES = 20;
const STDERR_TAIL = 4096;

export function redact(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer [hidden]')
    .replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[hidden]')
    .replace(/\b(password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;&]+/gi, '$1=[hidden]');
}

export function sshArgs(host: string): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    // `--` stops a host value from being parsed as an ssh option.
    '--',
    host,
    // Non-interactive ssh skips profile files; user-level installs live in ~/.local/bin.
    'PATH="$HOME/.local/bin:$PATH"',
    'exec',
    'athena-sandbox',
    'attach',
    '--protocol',
    String(SANDBOX_PROTOCOL_VERSION),
  ];
}

/**
 * One control channel to one Linux host. Owns reconnects and event replay; it never
 * re-sends a side-effecting request on its own, because a lost reply does not mean the
 * sandbox did not act.
 */
export class SandboxClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private invalid = 0;
  private stderr = '';
  private attempt = 0;
  private retryTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private missedPings = 0;
  private lastSeq?: number;
  private needsResync = false;
  private fatal?: { reason: string; message: string };
  private generation = 0;
  private current: SandboxConnectionState = { status: 'idle' };
  private readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(private readonly options: SandboxClientOptions) {
    if (!options.command && !/^[A-Za-z0-9._@:-]+$/.test(options.host))
      throw new Error('SSH 主机别名格式无效');
  }

  get state(): SandboxConnectionState {
    return this.current;
  }
  get latestSeq(): number | undefined {
    return this.lastSeq;
  }

  connect(): Promise<void> {
    if (this.current.status === 'ready') return Promise.resolve();
    if (this.current.status === 'closed') return Promise.reject(new Error('沙箱连接已关闭'));
    const waiting = new Promise<void>((resolve, reject) =>
      this.readyWaiters.push({ resolve, reject }),
    );
    if (this.current.status === 'idle' || this.current.status === 'failed') {
      this.attempt = 0;
      this.open('connecting');
    }
    return waiting;
  }

  close(): void {
    if (this.current.status === 'closed') return;
    clearTimeout(this.retryTimer);
    this.teardown('沙箱连接已关闭');
    this.setState({ status: 'closed' });
    this.settleWaiters(new Error('沙箱连接已关闭'));
  }

  request<M extends SandboxMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    if (this.current.status !== 'ready')
      return Promise.reject(new SandboxError('沙箱未连接', 'NOT_CONNECTED'));
    return this.call(method, params);
  }

  private call<M extends SandboxMethod>(
    method: M,
    params: MethodParams<M>,
    timeoutMs = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<MethodResult<M>> {
    const child = this.child;
    if (!child) return Promise.reject(new SandboxError('沙箱未连接', 'NOT_CONNECTED'));
    const checked = methods[method].params.safeParse(params);
    if (!checked.success) return Promise.reject(new Error(`${method} 参数无效`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SandboxError(`${method} 超时，结果未知`, 'TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        timer,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params: checked.data }) + '\n',
      );
    });
  }

  private open(status: 'connecting' | 'reconnecting') {
    const generation = ++this.generation;
    this.invalid = 0;
    this.stderr = '';
    this.fatal = undefined;
    this.setState({ status, attempt: this.attempt || undefined });
    const command = this.options.command ?? '/usr/bin/ssh';
    const args = this.options.args ?? sshArgs(this.options.host);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { env: this.options.env ?? process.env, stdio: 'pipe' });
    } catch (error) {
      this.lost(generation, `无法启动 ssh：${(error as Error).message}`, true);
      return;
    }
    this.child = child;
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (generation === this.generation) this.receive(line);
    });
    child.once('error', (error) => this.lost(generation, `无法启动 ssh：${error.message}`, true));
    child.once('close', (code) => this.exited(generation, code));
    void this.handshake(generation);
  }

  private async handshake(generation: number) {
    try {
      const hello = await this.call('hello', {
        protocol: SANDBOX_PROTOCOL_VERSION,
        client: { name: 'athena', version: this.options.clientVersion },
      });
      if (generation !== this.generation) return;
      if (hello.protocol !== SANDBOX_PROTOCOL_VERSION) {
        this.fatal = {
          reason: 'PROTOCOL_UNSUPPORTED',
          message: `沙箱协议版本 ${hello.protocol} 不兼容`,
        };
        this.child?.kill();
        return;
      }
      await this.subscribe(hello.latestSeq);
      if (generation !== this.generation) return;
      this.attempt = 0;
      this.setState({ status: 'ready', server: hello });
      this.startHeartbeat(generation);
      this.settleWaiters();
      if (this.needsResync) {
        this.needsResync = false;
        this.options.onResync?.();
      }
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof SandboxError && error.reason === 'PROTOCOL_UNSUPPORTED')
        this.fatal = {
          reason: error.reason,
          message: '沙箱协议版本不兼容，请升级 Athena 或沙箱组件',
        };
      this.child?.kill();
    }
  }

  private async subscribe(latestSeq: number) {
    if (this.lastSeq !== undefined) {
      try {
        await this.call('events.subscribe', { after: this.lastSeq });
        return;
      } catch (error) {
        if (!(error instanceof SandboxError) || error.reason !== 'EVENTS_EXPIRED') throw error;
      }
    }
    // Jumping to "now": cached state is untrusted until the caller refetches it. The cursor
    // moves before awaiting because replayed lines can be handled before this resumes.
    this.needsResync = true;
    this.lastSeq = latestSeq;
    await this.call('events.subscribe', { after: latestSeq });
  }

  private receive(line: string) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) return this.rejectMessage();
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return this.rejectMessage();
    }
    if (message && typeof message === 'object' && 'method' in message) {
      const parsed = RpcNotification.safeParse(message);
      if (!parsed.success) return this.rejectMessage();
      if (parsed.data.method === 'fatal') {
        this.fatal = parsed.data.params;
        return;
      }
      const envelope = parsed.data.params;
      if (this.lastSeq !== undefined && envelope.seq <= this.lastSeq) return;
      this.lastSeq = envelope.seq;
      this.options.onEvent?.(envelope);
      return;
    }
    const parsed = RpcResponse.safeParse(message);
    if (!parsed.success || typeof parsed.data.id !== 'number') return this.rejectMessage();
    const pending = this.pending.get(parsed.data.id);
    if (!pending) return;
    this.pending.delete(parsed.data.id);
    clearTimeout(pending.timer);
    if ('error' in parsed.data) {
      const { code, message: text, data } = parsed.data.error;
      const reason = reasonByCode.get(code) ?? 'INTERNAL';
      pending.reject(new SandboxError(redact(text), reason, data));
      return;
    }
    const result = methods[pending.method].result.safeParse(parsed.data.result);
    if (!result.success) {
      this.rejectMessage();
      pending.reject(new SandboxError(`${pending.method} 返回内容不符合协议`, 'INTERNAL'));
      return;
    }
    pending.resolve(result.data);
  }

  private rejectMessage() {
    // A peer that keeps sending non-protocol output is probably not sandboxd at all.
    if (++this.invalid >= MAX_INVALID_MESSAGES) {
      this.fatal ??= {
        reason: 'INTERNAL',
        message: '远端输出不是沙箱协议，请检查 athena-sandbox 是否正确安装',
      };
      this.child?.kill();
    }
  }

  private startHeartbeat(generation: number) {
    this.missedPings = 0;
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (generation !== this.generation) return;
      this.call('ping', {}, this.options.heartbeatTimeoutMs ?? 10_000).then(
        () => {
          this.missedPings = 0;
        },
        () => {
          if (generation === this.generation && ++this.missedPings >= 2) this.child?.kill();
        },
      );
    }, this.options.heartbeatMs ?? 15_000);
    this.heartbeat.unref();
  }

  private exited(generation: number, code: number | null) {
    if (generation !== this.generation) return;
    if (this.fatal) {
      const message =
        this.fatal.reason === 'DAEMON_UNAVAILABLE'
          ? `沙箱服务未运行：${redact(this.fatal.message)}`
          : redact(this.fatal.message);
      return this.lost(generation, message, true);
    }
    if (code === 127) return this.lost(generation, '远端未安装 athena-sandbox', true);
    const detail = redact(this.stderr.trim().split('\n').slice(-3).join(' ')).slice(0, 500);
    if (code === 255)
      return this.lost(
        generation,
        `SSH 连接失败${detail ? `：${detail}` : ''}。请先在终端确认 ssh ${this.options.host} 可以登录`,
        this.current.status === 'connecting',
      );
    this.lost(generation, detail ? `沙箱连接中断：${detail}` : '沙箱连接中断', false);
  }

  private lost(generation: number, message: string, permanent: boolean) {
    if (generation !== this.generation || this.current.status === 'closed') return;
    this.teardown(message);
    const backoff = this.options.backoffMs ?? [1000, 2000, 4000, 8000, 16_000, 30_000];
    const maxAttempts = this.options.maxAttempts ?? 8;
    if (permanent || this.attempt >= maxAttempts) {
      this.setState({ status: 'failed', message });
      this.settleWaiters(new Error(message));
      return;
    }
    const delay = backoff[Math.min(this.attempt, backoff.length - 1)];
    this.attempt++;
    this.setState({ status: 'reconnecting', message, attempt: this.attempt });
    this.retryTimer = setTimeout(() => this.open('reconnecting'), delay);
  }

  private teardown(message: string) {
    this.generation++;
    clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SandboxError(`${message}，${pending.method} 结果未知`, 'CONNECTION_LOST'));
    }
    this.pending.clear();
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill();
    }
  }

  private settleWaiters(error?: Error) {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) error ? waiter.reject(error) : waiter.resolve();
  }

  private setState(state: SandboxConnectionState) {
    this.current = state;
    this.options.onState?.(state);
  }
}
