import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import type { BrowserRuntime } from './browser';
import { AgentBrowserSession } from './agent-browser-session';
import { TAB_GROUP_COLORS, webTools, type WebPage, type WebTool } from './agent-browser-tools';
import type { NativeNeoState, NeoSessionDetail, NeoSessionSummary } from '../shared/types';

// Pinned official release. Update the version and both upstream SHA-256 values together.
export const AGENT_BROWSER_VERSION = '0.42.0';
const releases: Record<string, string> = {
  arm64: 'b1b2946c95d218b035262483f2c6193e0f216c155c903bcc532ce47e29d8e72d',
  x64: '802883bc38519e550525f74bb3e7ca692029082bdd2b7c235c26167b130c8d66',
};
export type AgentBrowserDownload = (
  url: string,
  options: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer> }>;
export interface TabGroup {
  groupId: string;
  title: string;
  color: string;
  collapsed: boolean;
  pages: number[];
}

async function verified(file: string): Promise<string> {
  if (
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex') !== releases[process.arch]
  )
    throw new Error('网页执行组件完整性校验失败');
  await access(file, constants.X_OK);
  return file;
}

/** Resolves the unchanged official binary, downloading it once into the private cache. */
export async function ensureAgentBrowserBinary(
  cache: string,
  signal?: AbortSignal,
  download: AgentBrowserDownload = fetch,
): Promise<string> {
  const override = process.env.ATHENA_AGENT_BROWSER_PATH;
  if (override) {
    await access(path.resolve(override), constants.X_OK);
    return path.resolve(override);
  }
  if (process.platform !== 'darwin' || !releases[process.arch])
    throw new Error('当前网页执行组件支持 macOS Apple Silicon 和 Intel');
  const name = `agent-browser-darwin-${process.arch}`;
  if (process.resourcesPath) {
    // Signing the app re-signs this copy, so its bytes are covered by the app signature instead.
    const bundled = path.join(process.resourcesPath, 'agent-browser', name);
    try {
      await access(bundled, constants.X_OK);
      return bundled;
    } catch {
      /* Builds without the bundled copy use the private cache. */
    }
  }
  const installed = path.join(cache, AGENT_BROWSER_VERSION, name);
  for (const candidate of [
    path.resolve('.runtime/agent-browser', AGENT_BROWSER_VERSION, name),
    installed,
  ])
    try {
      return await verified(candidate);
    } catch {
      /* Install a verified binary below. */
    }
  await mkdir(path.dirname(installed), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(cache, '.install-'));
  try {
    const response = await download(
      `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${name}`,
      {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) throw new Error(`网页执行组件下载失败（${response.status}）`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== releases[process.arch])
      throw new Error('网页执行组件下载校验失败');
    const staged = path.join(temporary, name);
    await writeFile(staged, bytes, { mode: 0o755 });
    signal?.throwIfAborted();
    await rename(staged, installed);
    return await verified(installed);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Pinned native daemon adapter; Athena owns Chrome, approvals and task recovery. */
export class AgentBrowserServer {
  readonly tools: WebTool[] = webTools;
  binary = '';
  private state: NativeNeoState = { status: 'stopped' };
  private endpoint = '';
  private sessions = new Map<string, AgentBrowserSession>();
  private worker?: AgentBrowserWorker;
  private preparing?: Promise<AgentBrowserWorker>;
  private startup?: Promise<void>;
  private abort?: AbortController;
  private stopping = false;
  private pageIds = new Map<string, number>();
  private nextPageId = 0;
  private groups = new Map<string, Omit<TabGroup, 'pages'> & { targets: Set<string> }>();
  private nextGroupId = 0;
  constructor(
    readonly browser: BrowserRuntime,
    private options: {
      directory: string;
      download?: AgentBrowserDownload;
      onState: (state: NativeNeoState) => void;
      onDisconnect: () => void;
    },
  ) {}
  getState() {
    return { ...this.state };
  }
  private update(state: NativeNeoState) {
    this.state = state;
    this.options.onState(this.getState());
  }
  /** Verifies the component and warms one worker. Concurrent callers share the same preparation. */
  start(endpoint: string): Promise<void> {
    if (this.startup && this.endpoint === endpoint) return this.startup;
    const previous = this.startup;
    const abort = new AbortController();
    const startup = (async () => {
      await previous?.catch(() => {});
      const url = new URL(endpoint);
      if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port)
        throw new Error('网页执行器只连接 Athena 自有浏览器的本机调试端口');
      if (this.endpoint && this.endpoint !== endpoint) await this.stop();
      this.abort = abort;
      this.stopping = false;
      this.endpoint = endpoint;
      this.update({ status: 'starting' });
      try {
        await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
        this.binary = await ensureAgentBrowserBinary(
          path.join(this.options.directory, 'bin'),
          abort.signal,
          this.options.download,
        );
        const version = await this.version();
        if (version !== `agent-browser ${AGENT_BROWSER_VERSION}`)
          throw new Error(`需要 agent-browser ${AGENT_BROWSER_VERSION}，检测到 ${version}`);
        abort.signal.throwIfAborted();
        this.update({ status: 'ready', version: AGENT_BROWSER_VERSION });
        // The first task should not pay for the daemon start.
        void this.acquireWorker().catch(() => {});
      } catch (error) {
        if (this.abort === abort) {
          this.endpoint = '';
          this.update({
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    })().finally(() => {
      if (this.startup === startup) this.startup = undefined;
    });
    this.startup = startup;
    return startup;
  }
  private version(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ['--version'], {
        env: {},
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('网页执行组件版本检查超时'));
      }, 5000);
      let output = '';
      child.stdout.on('data', (data) => (output += data));
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output.trim());
        else reject(new Error('网页执行组件版本检查失败'));
      });
    });
  }
  isReady() {
    return (
      !this.stopping && this.state.status === 'ready' && this.browser.getState().status === 'ready'
    );
  }
  /** Page numbers stay stable for the lifetime of a tab and are never reused. */
  pages(): WebPage[] {
    const state = this.browser.getState();
    const open = new Set(state.tabs.map((tab) => tab.id));
    for (const [id, group] of this.groups) {
      for (const target of group.targets) if (!open.has(target)) group.targets.delete(target);
      if (!group.targets.size) this.groups.delete(id);
    }
    return state.tabs.map((tab) => {
      if (!this.pageIds.has(tab.id)) this.pageIds.set(tab.id, ++this.nextPageId);
      const pageId = this.pageIds.get(tab.id)!;
      const group = [...this.groups].find(([, item]) => item.targets.has(tab.id))?.[0];
      return {
        pageId,
        targetId: tab.id,
        tabId: pageId,
        // Athena shows one owned browser window.
        windowId: 1,
        ...(group ? { groupId: group } : {}),
        title: tab.title,
        url: tab.url,
        isActive: tab.id === state.activeTabId,
      };
    });
  }
  tabGroups(): TabGroup[] {
    const pages = this.pages();
    return [...this.groups].map(([groupId, group]) => ({
      groupId,
      title: group.title,
      color: group.color,
      collapsed: group.collapsed,
      pages: pages.filter((page) => group.targets.has(page.targetId)).map((page) => page.pageId),
    }));
  }
  /** A page belongs to one group at most; joining a group leaves the previous one. */
  groupPages(
    targets: string[],
    options: { groupId?: string; title?: string; color?: string },
  ): string {
    let groupId = options.groupId;
    if (groupId && !this.groups.has(groupId)) throw new Error('分组不存在，请重新读取分组');
    this.ungroupPages(targets.filter((target) => !this.groups.get(groupId!)?.targets.has(target)));
    if (!groupId) {
      groupId = `g${++this.nextGroupId}`;
      this.groups.set(groupId, {
        groupId,
        title: options.title ?? '',
        color: options.color ?? TAB_GROUP_COLORS[(this.nextGroupId - 1) % TAB_GROUP_COLORS.length],
        collapsed: false,
        targets: new Set(),
      });
    }
    const group = this.groups.get(groupId)!;
    for (const target of targets) group.targets.add(target);
    return groupId;
  }
  updateGroup(groupId: string, change: { title?: string; color?: string; collapsed?: boolean }) {
    const group = this.groups.get(groupId);
    if (!group) throw new Error('分组不存在，请重新读取分组');
    if (change.title !== undefined) group.title = change.title;
    if (change.color !== undefined) group.color = change.color;
    if (change.collapsed !== undefined) group.collapsed = change.collapsed;
  }
  ungroupPages(targets: string[]) {
    for (const [id, group] of this.groups) {
      for (const target of targets) group.targets.delete(target);
      if (!group.targets.size) this.groups.delete(id);
    }
  }
  groupTargets(groupId: string): string[] {
    const group = this.groups.get(groupId);
    if (!group) throw new Error('分组不存在，请重新读取分组');
    return [...group.targets];
  }
  /** One healthy daemon per owned browser; a dead or discarded one is replaced on demand. */
  acquireWorker(): Promise<AgentBrowserWorker> {
    if (this.stopping || !this.endpoint) return Promise.reject(new Error('网页执行器尚未连接'));
    if (this.worker?.alive) return Promise.resolve(this.worker);
    return (this.preparing ??= (async () => {
      await this.worker?.stop();
      const worker = new AgentBrowserWorker(this.binary, this.endpoint);
      this.worker = worker;
      try {
        await worker.start();
        if (this.stopping) throw new Error('网页执行器正在停止');
        return worker;
      } catch (error) {
        await worker.stop();
        throw error;
      }
    })().finally(() => {
      this.preparing = undefined;
    }));
  }
  /** The daemon could not be brought back; the user has to reconnect. */
  disconnected() {
    if (this.stopping || this.state.status !== 'ready') return;
    this.update({ status: 'error', error: '网页执行器无法启动，请重新连接浏览器' });
    this.options.onDisconnect();
  }
  async newSession(): Promise<AgentBrowserSession> {
    if (!this.isReady()) throw new Error('网页执行器尚未连接');
    if (this.sessions.size) throw new Error('上一个网页任务尚未结束');
    const client = new AgentBrowserSession(this, this.options.directory);
    this.sessions.set(client.id, client);
    try {
      await client.start();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  async cancel(id: string) {
    await this.sessions.get(id)?.cancel();
  }
  release(id: string) {
    this.sessions.delete(id);
  }
  async resolveHelp(id: string) {
    return { resolved: this.sessions.get(id)?.resolveHelp() ?? false };
  }
  async records(): Promise<NeoSessionSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.options.directory);
    } catch {
      return [];
    }
    const records = await Promise.all(
      files
        .filter((file) => /^ab-[a-f0-9-]{36}\.json$/.test(file))
        .map(async (file) => {
          try {
            return (
              JSON.parse(
                await readFile(path.join(this.options.directory, file), 'utf8'),
              ) as NeoSessionDetail
            ).session;
          } catch {
            return undefined;
          }
        }),
    );
    return records
      .filter((record): record is NeoSessionSummary => !!record)
      .sort((a, b) => b.startedAt - a.startedAt);
  }
  async detail(id: string): Promise<NeoSessionDetail> {
    if (!/^ab-[a-f0-9-]{36}$/.test(id)) throw new Error('无效的网页任务编号');
    return JSON.parse(await readFile(path.join(this.options.directory, id + '.json'), 'utf8'));
  }
  async stop() {
    this.stopping = true;
    this.abort?.abort();
    const results = await Promise.allSettled([
      ...Array.from(this.sessions.values(), (client) => client.close()),
    ]);
    await this.preparing?.catch(() => {});
    results.push(...(await Promise.allSettled([this.worker?.stop()])));
    this.worker = undefined;
    this.sessions.clear();
    this.groups.clear();
    this.endpoint = '';
    this.update({ status: 'stopped' });
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

export class AgentBrowserWorker {
  readonly id = 'ab-' + randomUUID();
  /** Private to this daemon; removed with it. */
  directory = '';
  private daemon?: ChildProcess;
  private sockets = new Set<Socket>();
  private stopped = false;
  private cancellation?: Promise<void>;
  constructor(
    private binary: string,
    private endpoint: string,
  ) {}
  get alive() {
    return (
      !this.stopped &&
      !!this.daemon?.pid &&
      this.daemon.exitCode === null &&
      this.daemon.signalCode === null
    );
  }
  private environment(): NodeJS.ProcessEnv {
    // No provider keys, personal agent-browser config, or inherited launch options.
    return {
      PATH: process.env.PATH,
      HOME: this.directory,
      TMPDIR: process.env.TMPDIR,
      AGENT_BROWSER_SOCKET_DIR: this.directory,
      AGENT_BROWSER_SESSION: this.id,
      AGENT_BROWSER_NO_AUTO_DIALOG: '1',
      // The release is pinned; the update lookup is a network request that stalls the first command.
      AGENT_BROWSER_NO_VERSION_CHECK: '1',
      AGENT_BROWSER_DAEMON: '1',
    };
  }
  async start() {
    // macOS Unix sockets have a 103-byte path limit; keep runtime paths short.
    const directory = await mkdtemp('/tmp/athena-ab-');
    this.directory = directory;
    this.check();
    this.daemon = spawn(this.binary, [], { env: this.environment(), stdio: 'ignore' });
    let startupError: Error | undefined;
    this.daemon.once('error', (error) => (startupError = error));
    const deadline = Date.now() + 5000;
    while (true) {
      this.check();
      if (startupError) throw startupError;
      if (this.daemon.exitCode !== null || this.daemon.signalCode !== null)
        throw new Error('网页执行器进程已退出');
      try {
        await access(path.join(directory, this.id + '.sock'));
        break;
      } catch {
        /* The daemon has not created its socket yet. */
      }
      if (Date.now() >= deadline) throw new Error('网页执行器启动超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await this.command({ action: 'launch', cdpUrl: this.endpoint, noAutoDialog: true });
  }
  private check() {
    if (this.stopped) throw new Error('网页执行器已停止');
  }
  /** One request per connection. A timeout leaves the result unknown, so the daemon is discarded. */
  async command(command: Record<string, unknown>, timeout = 35_000): Promise<any> {
    this.check();
    const id = randomUUID();
    // shortcut: the private socket protocol is pinned to 0.42.0; revalidate it before upgrading.
    const response: any = await new Promise((resolve, reject) => {
      const socket = createConnection(path.join(this.directory, this.id + '.sock'));
      this.sockets.add(socket);
      let output = '';
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.sockets.delete(socket);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(new Error('浏览器操作超时，结果未知，请先核对页面'));
        void this.stop().catch(() => {});
      }, timeout);
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(JSON.stringify({ id, ...command }) + '\n'));
      socket.on('data', (data) => {
        output += data;
        if (output.length > 8_000_000) {
          finish(new Error('浏览器返回内容过大'));
          return;
        }
        const end = output.indexOf('\n');
        if (end >= 0) {
          try {
            finish(undefined, JSON.parse(output.slice(0, end)));
          } catch (error) {
            finish(error);
          }
        }
      });
      socket.once('error', () => finish(new Error('浏览器连接已关闭，操作结果未知')));
      socket.once('close', () => finish(new Error('浏览器连接已关闭，操作结果未知')));
    });
    this.check();
    if (response.id !== id || typeof response.success !== 'boolean')
      throw new Error('网页执行器返回格式无效');
    if (!response.success) throw new Error(String(response.error || '网页操作失败'));
    return response.data ?? {};
  }
  stop(): Promise<void> {
    return (this.cancellation ??= this.stopInternal());
  }
  private async stopInternal() {
    this.stopped = true;
    for (const socket of this.sockets) socket.destroy();
    const child = this.daemon;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await ended;
    }
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}
