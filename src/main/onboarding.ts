import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { cliEnvironment } from './agents';
import type { AgentInfo, Settings } from '../shared/types';
import type {
  OnboardingInstallKind,
  OnboardingInstallPlan,
  OnboardingOperation,
  OnboardingProgress,
  OnboardingStage,
  OnboardingState,
} from '../shared/onboarding';

const exec = promisify(execFile);
export const ONBOARDING_CODEX_VERSION = '0.166.0';
const BROWSER_VERSION = '0.51.2.3';
const BROWSER_DIGESTS: Record<string, string> = {
  arm64: '71de41267c6a9bd991c2d560125304082aa32a45a86f572fd819ce6e521e8a56',
  x64: '8eb7626cdc291ace6e70b19dc6dc8d1999a4a0492a0d13ee580a6a06ed3a14b6',
};
const STAGES: OnboardingStage[] = ['welcome', 'codex', 'workspace', 'browser', 'ready'];
type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;
type Context = {
  signal: AbortSignal;
  check(): void;
  phase(
    phase: string,
    message: string,
    bytes?: { receivedBytes: number; totalBytes?: number },
  ): void;
};
interface Options {
  directory: string;
  existingData: boolean;
  progress?: OnboardingProgress;
  initialAgents: AgentInfo[];
  settings(): Settings;
  isBusy(): boolean;
  probeAgents(): Promise<AgentInfo[]>;
  onAgents(agents: AgentInfo[]): void;
  pickWorkspace(): Promise<string | undefined>;
  commitWorkspace(directory: string, mode?: Settings['workspaceMode']): Promise<void>;
  saveProgress(progress: OnboardingProgress | undefined): Promise<void>;
  discoverBrowser(): Promise<string | undefined>;
  browserReady(): boolean;
  prepareBrowser(
    binary: string | undefined,
    signal: AbortSignal,
    phase: Context['phase'],
  ): Promise<void>;
  openExternal(url: string): Promise<void>;
  onState(state: OnboardingState): void;
  download?: Fetcher;
  platform?: NodeJS.Platform;
  arch?: string;
}
interface Operation {
  id: string;
  key: string;
  kind: OnboardingOperation['kind'];
  controller: AbortController;
  promise: Promise<void>;
}

export function managedCodexPath(directory: string, arch: string = process.arch): string {
  return path.join(
    directory,
    'runtime',
    'codex',
    `${ONBOARDING_CODEX_VERSION}-${arch}`,
    'bin',
    'codex',
  );
}
function storedProgress(value: OnboardingProgress | undefined): OnboardingProgress | undefined {
  if (value?.version !== 1 || !['in-progress', 'deferred', 'complete'].includes(value.status))
    return;
  // Earlier versions stored a separate login stage; it resumes at the CLI step.
  const stage = (value.stage as string) === 'login' ? 'codex' : value.stage;
  return STAGES.includes(stage) ? { ...structuredClone(value), stage } : undefined;
}
async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function safeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/\S+/g, '官方登录页面')
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9_.-]+/g, '[hidden]')
    .slice(0, 800);
}
export async function checkWorkspace(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error('请选择完整的工作目录路径');
  if (!(await stat(directory)).isDirectory()) throw new Error('所选路径不是文件夹');
  await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  // Read the directory, rather than treating a picker response as an OS permission grant.
  const { opendir } = await import('node:fs/promises');
  const handle = await opendir(directory);
  await handle.close();
}

export class OnboardingRuntime {
  private state: OnboardingState;
  private progress?: OnboardingProgress;
  private operation?: Operation;
  private cancellation?: Promise<OnboardingState>;
  private loginUrl?: string;
  private changedConfiguration = false;
  private readonly legacy: boolean;
  private readonly download: Fetcher;
  private disposed = false;

  constructor(private options: Options) {
    this.progress = storedProgress(options.progress);
    this.legacy = options.existingData && !this.progress;
    this.download = options.download ?? fetch;
    this.state = {
      version: 1,
      sessionId: randomUUID(),
      revision: 0,
      status: this.legacy
        ? 'legacy'
        : options.existingData
          ? (this.progress?.status ?? 'in-progress')
          : 'new',
      stage: this.progress?.stage ?? 'welcome',
      requiresSetup: this.legacy
        ? false
        : (this.progress?.required ?? this.progress?.status !== 'complete'),
      coreReady: false,
      codex: { status: 'unchecked' },
      workspace: {
        path: options.settings().workspace,
        mode: options.settings().workspaceMode,
        status: 'unchecked',
      },
      browser: { status: this.progress?.browserDeferred ? 'deferred' : 'unchecked' },
    };
    this.acceptAgents(options.initialAgents);
  }
  getState(): OnboardingState {
    return structuredClone(this.state);
  }
  get blocksTasks() {
    return this.state.requiresSetup && !this.state.coreReady;
  }
  get changingEnvironment() {
    return Boolean(this.operation && this.operation.kind !== 'detect');
  }
  get allowsBrowserStartup() {
    return (
      !this.progress?.browserDeferred &&
      (!this.state.requiresSetup || this.state.browser.status === 'ready')
    );
  }
  private publish() {
    const selected = this.options.settings().agent;
    this.state.selectedAgent = selected;
    const cliReady =
      selected === 'codex'
        ? this.state.codex.status === 'ready'
        : this.state.executor?.id === selected &&
          this.state.executor.available &&
          this.state.executor.supported;
    this.state.coreReady = Boolean(cliReady && this.state.workspace.status === 'ready');
    this.state.revision++;
    if (!this.disposed) this.options.onState(this.getState());
  }
  private acceptAgents(agents: AgentInfo[]) {
    this.state.selectedAgent = this.options.settings().agent;
    this.state.agents = structuredClone(agents);
    this.state.executor = agents.find((item) => item.id === this.options.settings().agent);
    const codex = agents.find((item) => item.id === 'codex');
    this.state.codex = {
      status: codex?.available && codex.supported ? 'ready' : codex?.path ? 'error' : 'missing',
      path: codex?.path,
      version: codex?.version,
      detail: codex?.detail,
    };
  }
  private async persist() {
    const progress: OnboardingProgress = {
      version: 1,
      status:
        this.state.status === 'complete'
          ? 'complete'
          : this.state.status === 'deferred'
            ? 'deferred'
            : 'in-progress',
      stage: this.state.stage,
      required: this.state.requiresSetup,
      workspaceConfirmed: this.progress?.workspaceConfirmed,
      browserDeferred: this.progress?.browserDeferred,
    };
    if (this.legacy && !this.changedConfiguration && this.state.status !== 'complete') return;
    await this.options.saveProgress(progress);
    this.progress = progress;
  }
  private assertIdle() {
    if (this.options.isBusy()) throw new Error('请先结束当前任务或共享，再修改运行环境');
  }
  private begin(
    key: string,
    kind: Operation['kind'],
    phase: string,
    message: string,
    task: (context: Context) => Promise<void>,
    allowBusy = false,
  ): OnboardingState {
    if (this.disposed) throw new Error('首次准备已关闭');
    if (this.operation) {
      if (this.operation.key === key) return this.getState();
      throw new Error('请等待当前准备完成，或先取消这次操作');
    }
    if (!allowBusy) this.assertIdle();
    const operation: Operation = {
      id: randomUUID(),
      key,
      kind,
      controller: new AbortController(),
      promise: Promise.resolve(),
    };
    this.operation = operation;
    this.state.error = undefined;
    this.state.operation = { id: operation.id, kind, phase, message, cancelable: true };
    this.publish();
    const check = () => {
      operation.controller.signal.throwIfAborted();
      if (this.disposed || this.operation !== operation)
        throw new Error('准备状态已改变，请重新检查');
    };
    const context: Context = {
      signal: operation.controller.signal,
      check,
      phase: (phase, message, bytes) => {
        check();
        this.state.operation = {
          id: operation.id,
          kind,
          phase,
          message,
          cancelable: true,
          ...bytes,
        };
        this.publish();
      },
    };
    operation.promise = Promise.resolve()
      .then(() => task(context))
      .catch((error) => {
        if (this.operation !== operation || this.disposed) return;
        if (!operation.controller.signal.aborted) {
          this.state.error = safeError(error);
          if (kind === 'login') {
            this.loginUrl = undefined;
            this.state.login = undefined;
          }
          if (kind === 'prepare-browser')
            this.state.browser = {
              ...this.state.browser,
              status: 'error',
              error: this.state.error,
            };
          if (kind === 'workspace-check')
            this.state.workspace = { ...this.state.workspace, error: this.state.error };
        }
      })
      .finally(() => {
        if (
          this.operation === operation &&
          (!operation.controller.signal.aborted || this.disposed)
        ) {
          this.operation = undefined;
          this.state.operation = undefined;
          this.publish();
        }
      });
    return this.getState();
  }
  async settled() {
    await this.operation?.promise;
    return this.getState();
  }
  async initialize() {
    if (this.legacy || this.progress?.workspaceConfirmed === this.options.settings().workspace)
      await this.readWorkspace();
    this.state.browser.path = await this.options.discoverBrowser();
    if (this.options.browserReady()) this.state.browser.status = 'ready';
    this.publish();
  }
  private async readWorkspace() {
    const current = this.options.settings().workspace;
    this.state.workspace.path = current;
    this.state.workspace.mode = this.options.settings().workspaceMode;
    try {
      await checkWorkspace(current);
      this.state.workspace.status = 'ready';
      this.state.workspace.error = undefined;
    } catch (error) {
      this.state.workspace.status = 'error';
      this.state.workspace.error = safeError(error);
    }
  }
  private async probe(context: Context) {
    this.state.codex.status = 'checking';
    this.publish();
    const agents = await this.options.probeAgents();
    context.check();
    this.options.onAgents(agents);
    this.acceptAgents(agents);
    if (this.legacy || this.progress?.workspaceConfirmed === this.options.settings().workspace) {
      await this.readWorkspace();
      context.check();
    }
    this.publish();
  }
  private nextStage() {
    if (
      this.options.settings().agent === 'codex'
        ? this.state.codex.status !== 'ready'
        : !this.state.executor?.available || !this.state.executor.supported
    )
      return 'codex' as const;
    if (this.state.workspace.status !== 'ready') return 'workspace' as const;
    return this.state.browser.status === 'ready' ? ('ready' as const) : ('browser' as const);
  }
  async open() {
    if (this.operation) return this.getState();
    if (this.state.status === 'legacy' || this.state.status === 'complete')
      this.state.stage = 'welcome';
    this.state.status = 'in-progress';
    this.state.error = undefined;
    this.state.workspace.path = this.options.settings().workspace;
    await this.persist();
    this.publish();
    return this.getState();
  }
  refresh() {
    return this.begin(
      'refresh',
      'detect',
      'checking',
      '正在检查本机 CLI 与已确认的目录…',
      async (context) => {
        await this.probe(context);
        this.state.stage = this.nextStage();
        await this.persist();
        context.check();
      },
      true,
    );
  }
  private platform() {
    const platform = this.options.platform ?? process.platform,
      arch = this.options.arch ?? process.arch;
    if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch))
      throw new Error('当前安装支持 macOS Apple Silicon 和 Intel');
    return arch;
  }
  private async createPlan(kind: OnboardingInstallKind, context: Context) {
    const arch = this.platform();
    if (kind === 'codex') {
      await this.probe(context);
      if (this.state.codex.status === 'ready') {
        this.state.plan = undefined;
        this.state.stage = this.nextStage();
        return;
      }
    } else {
      const installed = await this.options.discoverBrowser();
      context.check();
      if (installed) {
        this.state.browser.path = installed;
        this.state.plan = undefined;
        return;
      }
    }
    let version = BROWSER_VERSION;
    let sourceUrl = `https://github.com/browseros-ai/BrowserOS/releases/download/browserclaw/v${version}/BrowserOS_neo_v${version}_${arch}.dmg`;
    let sha256 = BROWSER_DIGESTS[arch];
    let downloadBytes: number | undefined;
    let destination = path.join(this.options.directory, 'runtime', 'BrowserOS neo.app');
    if (kind === 'codex') {
      version = ONBOARDING_CODEX_VERSION;
      const asset = `codex-package-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin.tar.gz`;
      const root = `https://releases.openai.com/codex/releases/${version}`;
      const response = await this.download(`${root}/release.json`, {
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(30000)]),
      });
      if (!response.ok) throw new Error(`官方安装信息读取失败（${response.status}）`);
      const text = await response.text();
      context.check();
      if (text.length > 2_000_000) throw new Error('官方安装信息超出大小限制');
      const metadata = JSON.parse(text);
      const item = Array.isArray(metadata.assets)
        ? metadata.assets.find((value: any) => value?.name === asset)
        : undefined;
      if (
        metadata.tag_name !== `rust-v${version}` ||
        !/^sha256:[a-f0-9]{64}$/i.test(item?.digest ?? '')
      )
        throw new Error('官方安装信息缺少匹配版本的 SHA-256 校验值');
      sourceUrl = `${root}/${asset}`;
      sha256 = item.digest.slice(7).toLowerCase();
      if (item.size !== undefined) {
        if (!Number.isSafeInteger(item.size) || item.size <= 0 || item.size > 2_000_000_000)
          throw new Error('官方安装信息返回了无效的下载大小');
        downloadBytes = item.size;
      }
      if (downloadBytes === undefined) {
        try {
          const head = await this.download(sourceUrl, {
            method: 'HEAD',
            signal: AbortSignal.any([context.signal, AbortSignal.timeout(4000)]),
          });
          const length = Number(head.headers.get('content-length'));
          if (head.ok && Number.isSafeInteger(length) && length > 0 && length <= 2_000_000_000)
            downloadBytes = length;
        } catch {
          /* Size is optional; the confirmed digest remains mandatory. */
        }
        context.check();
      }
      destination = path.dirname(path.dirname(managedCodexPath(this.options.directory, arch)));
    }
    context.check();
    if (await exists(destination))
      throw new Error('私有安装目录已经存在，请重新检查；不会覆盖已有安装');
    this.state.plan = {
      id: randomUUID(),
      kind,
      version,
      sourceUrl,
      sha256,
      downloadBytes,
      destination,
      expiresAt: Date.now() + 15 * 60_000,
      changes:
        kind === 'codex'
          ? [
              '下载并校验 OpenAI 官方完整 Codex 包',
              '仅安装到 Athena 私有运行目录',
              '不修改全局 CLI、PATH、shell 配置或已有登录',
            ]
          : [
              '下载并校验官方 BrowserOS neo',
              '仅安装到 Athena 私有运行目录',
              '使用独立浏览器配置，不导入日常账号',
            ],
    };
  }
  planInstall(kind: OnboardingInstallKind) {
    if (!['codex', 'browser'].includes(kind)) throw new Error('安装类型无效');
    return this.begin(
      `plan:${kind}`,
      'detect',
      'planning-install',
      '正在核对官方安装来源与目标目录…',
      async (context) => {
        this.state.plan = undefined;
        await this.createPlan(kind, context);
        context.check();
      },
    );
  }
  private async downloadArchive(
    plan: OnboardingInstallPlan,
    destination: string,
    context: Context,
  ) {
    context.phase('downloading', `正在下载 ${plan.kind === 'codex' ? 'Codex' : 'BrowserOS neo'}…`, {
      receivedBytes: 0,
    });
    const response = await this.download(plan.sourceUrl, {
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(15 * 60_000)]),
    });
    if (!response.ok || !response.body) throw new Error(`下载失败（${response.status}）`);
    const length = Number(response.headers.get('content-length'));
    const totalBytes = Number.isSafeInteger(length) && length > 0 ? length : undefined;
    if (totalBytes && totalBytes > 2_000_000_000) throw new Error('下载文件超出大小限制');
    const file = await open(destination, 'wx', 0o600),
      hash = createHash('sha256');
    const reader = response.body.getReader();
    let receivedBytes = 0,
      last = 0;
    try {
      for (;;) {
        context.check();
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > 2_000_000_000) throw new Error('下载文件超出大小限制');
        hash.update(value);
        await file.writeFile(value);
        if (Date.now() - last > 150) {
          context.phase('downloading', '正在下载官方运行组件…', { receivedBytes, totalBytes });
          last = Date.now();
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      await file.close();
    }
    context.phase('verifying', '正在校验下载内容…', { receivedBytes, totalBytes });
    if (hash.digest('hex') !== plan.sha256)
      throw new Error('SHA-256 校验失败；下载内容没有安装或执行');
    context.check();
  }
  private async verifyCodex(root: string, context: Context) {
    const manifest = await readFile(path.join(root, 'codex-package.json'), 'utf8');
    if (!JSON.parse(manifest) || !manifest.trim().startsWith('{'))
      throw new Error('Codex 完整包信息无效');
    for (const relative of ['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg']) {
      const file = path.join(root, relative),
        resolved = await realpath(file);
      if (!resolved.startsWith((await realpath(root)) + path.sep))
        throw new Error('Codex 运行组件指向安装目录之外');
      await chmod(file, 0o755);
      await access(file, constants.X_OK);
    }
    if (manifest.includes('"execServer"'))
      await access(path.join(root, 'bin/codex-exec-server'), constants.X_OK);
    const binary = path.join(root, 'bin/codex');
    const result = await exec(binary, ['--version'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
      signal: context.signal,
      env: cliEnvironment(binary),
    });
    if (result.stdout.trim() !== `codex-cli ${ONBOARDING_CODEX_VERSION}`)
      throw new Error('安装后的 Codex 版本验证失败');
    context.check();
  }
  private async verifyBrowser(root: string, context: Context) {
    const { stdout } = await exec(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', path.join(root, 'Contents/Info.plist')],
      { signal: context.signal },
    );
    const plist = JSON.parse(stdout);
    if (
      plist.CFBundleIdentifier !== 'com.browseros.BrowserClaw' ||
      plist.CFBundleShortVersionString !== BROWSER_VERSION
    )
      throw new Error('BrowserOS 版本或应用身份不匹配');
    await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', root], {
      signal: context.signal,
    });
    await access(path.join(root, 'Contents/MacOS', plist.CFBundleExecutable), constants.X_OK);
    context.check();
  }
  install(planId: string) {
    const plan = this.state.plan;
    if (!plan || plan.id !== planId || plan.expiresAt < Date.now())
      throw new Error('安装确认已过期，请重新查看安装计划');
    return this.begin(
      `install:${plan.id}`,
      plan.kind === 'codex' ? 'install-codex' : 'prepare-browser',
      'checking',
      '正在重新检查安装环境…',
      async (context) => {
        if (plan.kind === 'codex') {
          await this.probe(context);
          if (this.state.codex.status === 'ready') {
            this.state.plan = undefined;
            this.state.stage = this.nextStage();
            return;
          }
        } else if (await this.options.discoverBrowser()) {
          context.check();
          this.state.plan = undefined;
          return;
        }
        if (await exists(plan.destination))
          throw new Error('安装目录已经存在；不会覆盖已有运行组件');
        const parent = path.dirname(plan.destination);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const temporary = await mkdtemp(path.join(parent, '.onboarding-'));
        const archive = path.join(
          temporary,
          plan.kind === 'codex' ? 'codex.tar.gz' : 'browser.dmg',
        );
        const staged = path.join(
          temporary,
          plan.kind === 'codex' ? 'package' : 'BrowserOS neo.app',
        );
        let mountpoint: string | undefined;
        try {
          await this.downloadArchive(plan, archive, context);
          context.phase('installing', '正在安装到 Athena 私有运行目录…');
          if (plan.kind === 'codex') {
            const { stdout } = await exec('/usr/bin/tar', ['-tzf', archive], {
              signal: context.signal,
              maxBuffer: 8 * 1024 * 1024,
            });
            if (
              stdout
                .split('\n')
                .filter(Boolean)
                .some((entry) => path.posix.isAbsolute(entry) || entry.split('/').includes('..'))
            )
              throw new Error('安装归档包含不安全路径');
            await mkdir(staged);
            await exec('/usr/bin/tar', ['-xzf', archive, '-C', staged], { signal: context.signal });
            context.phase('verifying', '正在验证 Codex 启动与完整组件…');
            await this.verifyCodex(staged, context);
          } else {
            mountpoint = path.join(temporary, 'mount');
            await mkdir(mountpoint);
            await exec(
              '/usr/bin/hdiutil',
              ['attach', '-readonly', '-nobrowse', '-mountpoint', mountpoint, archive],
              { signal: context.signal },
            );
            await exec(
              '/usr/bin/ditto',
              ['--noextattr', '--norsrc', path.join(mountpoint, 'BrowserOS neo.app'), staged],
              { signal: context.signal },
            );
            context.phase('verifying', '正在验证 BrowserOS 应用签名…');
            await this.verifyBrowser(staged, context);
          }
          context.check();
          if (await exists(plan.destination))
            throw new Error('目标目录在安装期间发生变化；已有文件未覆盖');
          await rename(staged, plan.destination);
          this.changedConfiguration = true;
          this.state.plan = undefined;
          if (plan.kind === 'codex') {
            await this.probe(context);
            this.state.stage = this.nextStage();
          } else {
            this.state.browser = { status: 'preparing', path: plan.destination };
            await this.options.prepareBrowser(plan.destination, context.signal, context.phase);
            context.check();
            if (!this.options.browserReady()) throw new Error('浏览器控制组件尚未就绪');
            this.state.browser = { status: 'ready', path: plan.destination };
            this.state.stage = this.nextStage();
            this.progress = {
              ...this.progress,
              version: 1,
              status: 'in-progress',
              stage: this.state.stage,
              browserDeferred: false,
            };
          }
          await this.persist();
          context.check();
        } finally {
          let detached = true;
          if (mountpoint) {
            try {
              await exec('/usr/bin/hdiutil', ['detach', mountpoint], { timeout: 15000 });
            } catch {
              detached = false;
            }
          }
          if (detached) await rm(temporary, { recursive: true, force: true });
        }
      },
    );
  }
  /**
   * Optional and only ever started by the user. Athena does not judge whether a login is needed;
   * the exit status of `codex login` is the whole verdict.
   */
  startLogin() {
    return this.begin(
      'login',
      'login',
      'waiting-login',
      '正在打开官方 Codex 登录…',
      async (context) => {
        await this.probe(context);
        if (this.state.codex.status !== 'ready' || !this.state.codex.path)
          throw new Error('请先安装并验证 Codex');
        this.loginUrl = undefined;
        this.state.login = { canReopen: false };
        context.phase('waiting-login', '请在系统浏览器完成官方 Codex 登录…');
        const executable = this.state.codex.path;
        await new Promise<void>((resolve, reject) => {
          const child = spawn(executable, ['login'], {
            cwd: this.options.directory,
            env: cliEnvironment(executable),
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
          });
          let buffer = '',
            killTimer: ReturnType<typeof setTimeout> | undefined;
          const kill = (signal: NodeJS.Signals) => {
            try {
              if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
              else child.kill(signal);
            } catch {
              /* This owned process may have already exited. */
            }
          };
          const cancel = () => {
            kill('SIGTERM');
            killTimer = setTimeout(() => kill('SIGKILL'), 1500);
            killTimer.unref();
          };
          const consume = (chunk: Buffer) => {
            buffer = (buffer + chunk.toString('utf8')).slice(-64 * 1024);
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const candidate = line.match(
                /https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/[^\s<>"']+/,
              )?.[0];
              if (!candidate || context.signal.aborted || this.disposed) continue;
              try {
                const url = new URL(candidate);
                if (url.username || url.password || url.protocol !== 'https:') continue;
                this.loginUrl = url.href;
                this.state.login = { canReopen: true };
                this.publish();
              } catch {
                /* Malformed diagnostics are not a login URL. */
              }
            }
          };
          child.stdout.on('data', consume);
          child.stderr.on('data', consume);
          context.signal.addEventListener('abort', cancel, { once: true });
          child.once('error', reject);
          child.once('close', (code) => {
            clearTimeout(killTimer);
            context.signal.removeEventListener('abort', cancel);
            if (context.signal.aborted) reject(new Error('本次登录已取消'));
            else if (code === 0) resolve();
            else reject(new Error('本次 Codex 登录未完成，可以重新登录'));
          });
          if (context.signal.aborted) cancel();
        });
        context.check();
        this.loginUrl = undefined;
        this.state.login = undefined;
        // Connections opened before this login reconnect to pick it up.
        await this.probe(context);
        this.changedConfiguration = true;
        this.state.stage = this.nextStage();
        await this.persist();
        context.check();
      },
    );
  }
  async reopenLogin() {
    if (
      this.operation?.kind !== 'login' ||
      !this.loginUrl ||
      this.operation.controller.signal.aborted
    )
      throw new Error('本次登录页面已失效，请重新发起登录');
    await this.options.openExternal(this.loginUrl);
    return this.getState();
  }
  pickWorkspace() {
    return this.begin(
      'workspace:pick',
      'workspace-check',
      'picking-directory',
      '请在系统选择器中选择项目目录…',
      async (context) => {
        this.state.stage = 'workspace';
        const selected = await this.options.pickWorkspace();
        context.check();
        if (selected) {
          if (!path.isAbsolute(selected)) throw new Error('系统选择器返回了无效目录');
          this.state.workspace.candidate = { id: randomUUID(), path: selected };
          this.state.workspace.error = undefined;
        }
      },
    );
  }
  confirmWorkspace(candidateId: string) {
    const candidate = this.state.workspace.candidate;
    if (!candidate || candidate.id !== candidateId) throw new Error('目录确认已失效，请重新选择');
    return this.begin(
      `workspace:${candidateId}`,
      'workspace-check',
      'checking-directory',
      '正在检查所选目录的访问范围…',
      async (context) => {
        await checkWorkspace(candidate.path);
        context.check();
        this.assertIdle();
        if (this.state.operation) this.state.operation.cancelable = false;
        this.publish();
        await this.options.commitWorkspace(candidate.path, 'project');
        this.changedConfiguration = true;
        this.state.workspace = { path: candidate.path, mode: 'project', status: 'ready' };
        this.progress = {
          ...this.progress,
          version: 1,
          status: 'in-progress',
          stage: this.state.stage,
          workspaceConfirmed: candidate.path,
        };
        context.check();
        this.state.stage = this.nextStage();
        await this.persist();
        context.check();
      },
    );
  }
  skipWorkspace() {
    return this.begin(
      'workspace:skip',
      'workspace-check',
      'preparing-personal-workspace',
      '正在准备对话空间…',
      async (context) => {
        const directory = path.join(this.options.directory, 'workspace');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await checkWorkspace(directory);
        context.check();
        this.assertIdle();
        if (this.state.operation) this.state.operation.cancelable = false;
        this.publish();
        await this.options.commitWorkspace(directory, 'personal');
        this.changedConfiguration = true;
        this.state.workspace = { path: directory, mode: 'personal', status: 'ready' };
        this.progress = {
          ...this.progress,
          version: 1,
          status: 'in-progress',
          stage: 'workspace',
          workspaceConfirmed: directory,
        };
        context.check();
        this.state.stage = this.nextStage();
        await this.persist();
        context.check();
      },
    );
  }
  prepareBrowser() {
    return this.begin(
      'browser:prepare',
      'prepare-browser',
      'checking-browser',
      '正在检查已有 BrowserOS neo…',
      async (context) => {
        const binary = await this.options.discoverBrowser();
        context.check();
        this.state.stage = 'browser';
        if (!binary) {
          this.state.browser = { status: 'missing' };
          await this.createPlan('browser', context);
          return;
        }
        this.state.browser = { status: 'preparing', path: binary };
        context.phase('starting', '正在准备浏览器与网页控制组件…');
        await this.options.prepareBrowser(binary, context.signal, context.phase);
        context.check();
        if (!this.options.browserReady()) throw new Error('浏览器控制组件尚未就绪');
        this.state.browser = { status: 'ready', path: binary };
        this.progress = {
          ...this.progress,
          version: 1,
          status: 'in-progress',
          stage: this.state.stage,
          browserDeferred: false,
        };
        this.state.stage = this.nextStage();
        await this.persist();
        context.check();
      },
    );
  }
  async cancel(operationId: string) {
    if (this.cancellation) return this.cancellation;
    const operation = this.operation;
    if (!operation || operation.id !== operationId) return this.getState();
    if (this.state.operation?.cancelable === false) {
      await operation.promise;
      return this.getState();
    }
    this.cancellation = (async () => {
      operation.controller.abort();
      this.loginUrl = undefined;
      this.state.login = undefined;
      if (operation.kind === 'install-codex' || operation.kind === 'prepare-browser')
        this.state.plan = undefined;
      if (operation.kind === 'workspace-check') this.state.workspace.candidate = undefined;
      if (this.state.operation)
        this.state.operation = {
          ...this.state.operation,
          phase: 'cancelling',
          message: '正在结束本次准备…',
          cancelable: false,
        };
      this.publish();
      await operation.promise;
      if (!this.disposed && this.operation === operation) {
        const agents = await this.options.probeAgents();
        if (!this.disposed && this.operation === operation) {
          this.options.onAgents(agents);
          this.acceptAgents(agents);
          if (operation.kind === 'prepare-browser' && !this.options.browserReady())
            this.state.browser.status = 'unchecked';
          this.state.error = undefined;
        }
      }
      if (this.operation === operation) {
        this.operation = undefined;
        this.state.operation = undefined;
      }
      this.publish();
      return this.getState();
    })().finally(() => {
      this.cancellation = undefined;
    });
    return this.cancellation;
  }
  async defer() {
    if (this.operation) await this.cancel(this.operation.id);
    this.state.status = this.legacy && !this.changedConfiguration ? 'legacy' : 'deferred';
    this.state.plan = undefined;
    this.state.workspace.candidate = undefined;
    this.loginUrl = undefined;
    this.state.login = undefined;
    if (this.state.requiresSetup && this.state.browser.status !== 'ready') {
      this.state.browser.status = 'deferred';
      this.progress = {
        ...this.progress,
        version: 1,
        status: 'deferred',
        stage: this.state.stage,
        browserDeferred: true,
      };
    }
    await this.persist();
    this.publish();
    return this.getState();
  }
  async complete() {
    if (this.operation?.kind === 'prepare-browser' && this.state.coreReady)
      await this.cancel(this.operation.id);
    return this.begin(
      'complete',
      'detect',
      'checking',
      '正在核对工作台准备结果…',
      async (context) => {
        await this.probe(context);
        if (!this.state.coreReady)
          throw new Error('所选 CLI 或工作目录尚未就绪，请完成准备或选择稍后设置');
        const browserDeferred = !this.options.browserReady();
        const progress: OnboardingProgress = {
          version: 1,
          status: 'complete',
          stage: 'ready',
          required: false,
          workspaceConfirmed: this.state.workspace.path,
          browserDeferred,
        };
        if (this.state.operation) this.state.operation.cancelable = false;
        this.publish();
        await this.options.saveProgress(progress);
        context.check();
        this.progress = progress;
        this.state.browser.status = browserDeferred ? 'deferred' : 'ready';
        this.state.status = 'complete';
        this.state.stage = 'ready';
        this.state.requiresSetup = false;
        this.state.plan = undefined;
        this.state.workspace.candidate = undefined;
      },
    );
  }
  async dispose() {
    this.disposed = true;
    this.loginUrl = undefined;
    this.operation?.controller.abort();
    await this.operation?.promise;
    await this.cancellation;
  }
}
