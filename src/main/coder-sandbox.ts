import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { discoverExecutables, executableDirectories } from './agent-discovery';
import {
  CoderApi,
  CoderApiError,
  workspaceAgent,
  type CoderFetch,
  type CoderTransition,
  type CoderWorkspace,
} from './coder-api';
import { redact } from './sandbox-client';
import {
  PREVIEW_PORT,
  SandboxRuntime,
  type LocalSandboxUpdate,
  type RunningSandbox,
  type SandboxArtifact,
  type SandboxCallContext,
  type SandboxProcess,
} from './sandbox-runtime';

export interface CoderAccess {
  origin: string;
  token: string;
}
/** How Athena reaches into a workspace. The default goes through the `coder` command. */
export interface CoderTransport {
  /** Runs `script` with the workspace's shell, standard input and output attached. */
  shell(workspace: string, script: string): Promise<SandboxProcess>;
  /** Makes 127.0.0.1:`local` here reach 127.0.0.1:`remote` in the workspace until killed. */
  forward(workspace: string, local: number, remote: number): Promise<SandboxProcess>;
}
export interface CoderSandboxOptions {
  /** This profile's sandbox directory; exported artifacts are stored below it. */
  directory: string;
  /** Eight hex digits only this profile has, see `coderOwner`. They mark its workspaces. */
  owner: string;
  /** The athena-sandbox program that is copied into each workspace. */
  program: string;
  /** Address and token of the connected deployment, if there is one. */
  access: () => Promise<CoderAccess | undefined>;
  /** The Coder template a sandbox was created from, by sandbox id. */
  template: (id: string) => string | undefined;
  transport: CoderTransport;
  onArtifact: (turnId: string, artifact: SandboxArtifact) => void;
  onUpdate?: (update: LocalSandboxUpdate) => void;
  fetch?: CoderFetch;
  pollMs?: number;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** The account's login shell may be any; what Athena runs in a workspace is written for sh. */
const sh = (script: string) => `exec sh -c ${quote(script)}`;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('沙箱操作已停止'));
      },
      { once: true },
    );
  });
const inProgress = (status: string) =>
  ['pending', 'starting', 'stopping', 'deleting', 'canceling'].includes(status);
/** Running in the sense the pool counts: started, and not on its way down. */
export const coderRunning = (workspace: CoderWorkspace) =>
  workspace.latest_build.transition === 'start' && workspace.latest_build.status === 'running';
/**
 * The id that marks this profile's workspaces, made once and kept in `directory`. A Coder
 * account is shared by every machine its user signs in from, so the id is random: a second
 * machine, even one with the same profile path, never takes these workspaces for its own.
 */
export async function coderOwner(directory: string) {
  const file = path.join(directory, 'coder-owner');
  const read = async () => (await readFile(file, 'utf8')).trim();
  try {
    const saved = await read();
    if (/^[0-9a-f]{8}$/.test(saved)) return saved;
  } catch {
    // Not made yet.
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // `wx`: when two starts race, both end up with the id that was written first.
  await writeFile(file, randomBytes(4).toString('hex'), { mode: 0o600, flag: 'wx' }).catch(
    () => {},
  );
  const made = await read();
  if (!/^[0-9a-f]{8}$/.test(made)) {
    await writeFile(file, randomBytes(4).toString('hex'), { mode: 0o600 });
    return read();
  }
  return made;
}
const verbs: Record<CoderTransition, string> = { start: '启动', stop: '停止', delete: '删除' };

async function coderCommand() {
  const [found] = await discoverExecutables(['coder'], await executableDirectories());
  if (!found)
    throw new Error('这台 Mac 上没有找到 coder 命令。请按 Coder 页面上的说明安装 Coder CLI 后重试');
  return found;
}
/**
 * Reaches workspaces through ssh over the `coder` command installed on this machine. Address
 * and token travel in the child's environment only, and neither the user's own Coder login
 * nor their ssh configuration is read or changed: `configDirectory` is Athena's own.
 */
export function coderCliTransport(
  access: () => Promise<CoderAccess | undefined>,
  configDirectory: string,
  executable: () => Promise<string> = coderCommand,
): CoderTransport {
  const ssh = async (workspace: string, options: string[], script?: string) => {
    const current = await access();
    if (!current) throw new Error('尚未连接 Coder，请先在「设置 › 沙箱」填写地址和令牌');
    if (!/^[A-Za-z0-9-]{1,32}$/.test(workspace)) throw new Error('Coder 工作区名称无效');
    return {
      command: '/usr/bin/ssh',
      args: [
        '-F',
        '/dev/null',
        '-T',
        '-o',
        'BatchMode=yes',
        // The workspace is reached through Coder's own authenticated tunnel, and its ssh host
        // key is made anew with every start, so there is nothing stable to pin.
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'UserKnownHostsFile=/dev/null',
        '-o',
        'LogLevel=ERROR',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=3',
        '-o',
        // Never start a stopped workspace as a side effect: stopping is how sandboxes are recycled.
        `ProxyCommand=${quote(await executable())} ssh --stdio --disable-autostart ${workspace}`,
        ...options,
        '--',
        `coder.${workspace}`,
        ...(script === undefined ? [] : [script]),
      ],
      env: {
        ...process.env,
        CODER_URL: current.origin,
        CODER_SESSION_TOKEN: current.token,
        CODER_CONFIG_DIR: configDirectory,
        CODER_NO_VERSION_WARNING: 'true',
      },
      secrets: [current.token],
    };
  };
  return {
    shell: (workspace, script) => ssh(workspace, [], script),
    forward: (workspace, local, remote) =>
      ssh(workspace, [
        '-N',
        '-o',
        'ExitOnForwardFailure=yes',
        '-L',
        `127.0.0.1:${local}:127.0.0.1:${remote}`,
      ]),
  };
}

interface Forward {
  url: string;
  close(): void;
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
function reachable(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/**
 * Sandboxes that are Coder workspaces. Coder builds, starts, stops and deletes them; inside,
 * the same athena-sandbox daemon as in a local sandbox runs the commands. A workspace belongs
 * to this profile when its name starts with `prefix`, so no other workspace of the account is
 * ever stopped or deleted from here.
 */
export class CoderSandbox extends SandboxRuntime {
  private forwards = new Map<string, Promise<Forward>>();
  private closed = false;
  private used = false;
  protected readonly root = '工作区主目录';
  protected readonly rootSource = "fs.realpathSync(require('node:os').homedir())";
  // The daemon starts commands in the home directory, see `attachScript`.
  protected readonly cwd = undefined;
  constructor(private options: CoderSandboxOptions) {
    super(options.directory, options.onArtifact, options.onUpdate ?? (() => {}));
    if (!/^[0-9a-f]{8}$/.test(options.owner)) throw new Error('Coder 沙箱标识无效');
  }
  /** Workspace names start with this; Coder allows 32 letters, digits and single hyphens. */
  get prefix() {
    return `athena-${this.options.owner}-`;
  }
  private owns(name: string) {
    return name.startsWith(this.prefix) && /^[0-9a-f]{10}$/.test(name.slice(this.prefix.length));
  }
  containerName(id: string) {
    return this.prefix + createHash('sha256').update(id).digest('hex').slice(0, 10);
  }
  private async api(timeoutMs?: number) {
    const access = await this.options.access();
    if (!access) throw new Error('尚未连接 Coder，请先在「设置 › 沙箱」填写地址和令牌');
    this.used = true;
    return new CoderApi(access.origin, access.token, this.options.fetch ?? fetch, timeoutMs);
  }

  /**
   * Takes a workspace to where `want` leaves it and waits until it is there. A build that is
   * already in progress is waited out first, because Coder runs one build at a time.
   */
  private async settle(
    api: CoderApi,
    workspace: CoderWorkspace,
    want: CoderTransition,
    signal?: AbortSignal,
  ) {
    const deadline = Date.now() + (want === 'start' ? 15 : 10) * 60_000;
    let asked = false;
    for (;;) {
      if (signal?.aborted) throw new Error('沙箱操作已停止');
      const { status } = workspace.latest_build;
      if (status === 'deleted') {
        if (want === 'delete') return workspace;
        throw new Error('这个 Coder 工作区已被删除');
      }
      if (want === 'stop' && status === 'stopped') return workspace;
      if (want === 'start' && coderRunning(workspace)) {
        const agent = workspaceAgent(workspace);
        if (!agent) throw new Error('这个 Coder 模板没有定义 agent，Athena 无法连接它的工作区');
        // The startup script may still be installing what the sandbox needs.
        if (
          agent.status === 'connected' &&
          !['created', 'starting'].includes(agent.lifecycle_state ?? 'ready')
        )
          return workspace;
      } else if (!inProgress(status)) {
        if (asked)
          throw new Error(`Coder 工作区${verbs[want]}失败（${status}），请在 Coder 中查看构建日志`);
        try {
          await api.build(workspace.id, want);
          asked = true;
        } catch (error) {
          // Someone else started a build in the meantime; wait for that one, then look again.
          if (!(error instanceof CoderApiError) || error.status !== 409) throw error;
        }
      }
      if (Date.now() > deadline)
        throw new Error(`等待 Coder 工作区${verbs[want]}超时（当前 ${status}）`);
      await sleep(this.options.pollMs ?? 2000, signal);
      try {
        workspace = await api.workspace(workspace.id);
      } catch (error) {
        // Coder answers 410 for a workspace that was deleted, 404 for one it never had.
        if (
          want === 'delete' &&
          error instanceof CoderApiError &&
          [404, 410].includes(error.status)
        )
          return workspace;
        throw error;
      }
    }
  }

  async status(conversationId: string) {
    const name = this.containerName(conversationId);
    const workspace = await (await this.api()).workspaceByName(name);
    return {
      name,
      status: workspace?.latest_build.status ?? 'missing',
      isolation: 'coder',
      template: workspace?.template_display_name || workspace?.template_name,
      workspace: '~（Coder 工作区的主目录；命令从这里开始，文件路径相对它，没有 /workspace）',
    };
  }
  protected ensure(context: SandboxCallContext): Promise<RunningSandbox> {
    if (this.closed || context.signal.aborted) return Promise.reject(new Error('沙箱操作已停止'));
    const id = context.conversationId;
    const previous = this.entries.get(id);
    if (previous)
      return previous.then(async (entry) => {
        // A channel that answers its heartbeats proves the workspace is up.
        if (entry.client.state.status === 'ready') return entry;
        const workspace = await (await this.api()).workspaceByName(entry.name);
        if (this.closed || context.signal.aborted) throw new Error('沙箱操作已停止');
        if (workspace && coderRunning(workspace)) {
          await entry.client.connect();
          return entry;
        }
        if (this.entries.get(id) === previous) {
          entry.client.close();
          this.entries.delete(id);
        }
        return this.ensure(context);
      });
    const pending = this.start(context).catch((error) => {
      this.onUpdate({
        conversationId: id,
        type: 'connection',
        status: context.signal.aborted ? 'closed' : 'failed',
        name: this.containerName(id),
      });
      if (this.entries.get(id) === pending) this.entries.delete(id);
      throw error;
    });
    this.entries.set(id, pending);
    return pending;
  }
  private async start(context: SandboxCallContext): Promise<RunningSandbox> {
    const name = this.containerName(context.conversationId);
    this.onUpdate({
      conversationId: context.conversationId,
      type: 'connection',
      status: 'connecting',
      name,
    });
    const api = await this.api();
    let workspace = await api.workspaceByName(name);
    if (!workspace) {
      const template = this.options.template(context.conversationId);
      if (!template) throw new Error('这个沙箱没有记录 Coder 模板，请删除后重新创建');
      workspace = await api.createWorkspace(template, name);
    }
    await this.settle(api, workspace, 'start', context.signal);
    await this.install(name, context.signal);
    const client = await this.attach(
      context,
      name,
      await this.options.transport.shell(name, sh(attachScript)),
      'athena-coder',
      () => this.closed,
    );
    return { name, client };
  }
  /** Copies the bundled athena-sandbox into the workspace, replacing whatever version is there. */
  private async install(name: string, signal: AbortSignal) {
    const program = await readFile(this.options.program);
    try {
      await this.pipe(await this.options.transport.shell(name, sh(installScript)), program, {
        signal,
        timeout: 120_000,
        failure: '无法在 Coder 工作区安装 athena-sandbox',
      });
    } catch (error) {
      if (signal.aborted) throw new Error('沙箱操作已停止');
      if ((error as { code?: number }).code === 90)
        throw new Error(
          '这个 Coder 工作区里没有 Node.js 18 或更高版本，Athena 无法在其中工作。请换用带 Node.js 的模板',
        );
      throw new Error(`无法在 Coder 工作区安装 athena-sandbox：${(error as Error).message}`);
    }
  }
  protected async node(name: string, script: string, args: string[] = []) {
    return this.options.transport.shell(
      name,
      sh(`${findNode}; exec ${['node', '-e', script, '--', ...args].map(quote).join(' ')}`),
    );
  }
  protected previewUrl(name: string) {
    let pending = this.forwards.get(name);
    if (!pending) {
      pending = this.forward(name).catch((error) => {
        this.forwards.delete(name);
        throw error;
      });
      this.forwards.set(name, pending);
    }
    return pending.then((forward) => forward.url);
  }
  /** A loopback port here that leads to the workspace's preview port, for as long as it lasts. */
  private async forward(name: string): Promise<Forward> {
    const local = await freePort();
    const { command, args, env, secrets } = await this.options.transport.forward(
      name,
      local,
      PREVIEW_PORT,
    );
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-1000)));
    child.once('error', () => {});
    // When the forward ends, the next request for the preview opens a new one.
    child.once('close', () => this.forwards.delete(name));
    const deadline = Date.now() + 30_000;
    while (!(await reachable(local))) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
        child.kill();
        throw new Error(
          `无法把沙箱的预览端口转发到本机：${redact(stderr.trim(), secrets).slice(0, 300) || '超时'}`,
        );
      }
      await sleep(200);
    }
    return { url: `http://127.0.0.1:${local}`, close: () => child.kill() };
  }
  private closeForward(name: string) {
    const pending = this.forwards.get(name);
    this.forwards.delete(name);
    void pending?.then(
      (forward) => forward.close(),
      () => {},
    );
  }

  /** Starts the sandbox without running anything in it. */
  async open(context: SandboxCallContext) {
    return (await this.ensure(context)).name;
  }
  /** Every workspace of this profile on the connected deployment, by name, with its state. */
  async containers() {
    const workspaces = await (await this.api()).workspaces();
    return new Map(
      workspaces
        .filter((workspace) => this.owns(workspace.name))
        .map((workspace) => [
          workspace.name,
          coderRunning(workspace) ? 'running' : workspace.latest_build.status,
        ]),
    );
  }
  /** A workspace keeps its files on the deployment; nothing of it is stored on this machine. */
  async workspaces() {
    return [] as string[];
  }
  /** Stops one workspace, or deletes it together with its files. */
  async release(name: string, remove: boolean) {
    if (!this.owns(name)) throw new Error('这个沙箱不属于此 Athena 档案');
    for (const [id, pending] of this.entries)
      if (this.containerName(id) === name) {
        this.entries.delete(id);
        await pending.then(
          (entry) => entry.client.close(),
          () => {},
        );
      }
    this.closeForward(name);
    const api = await this.api();
    const workspace = await api.workspaceByName(name);
    if (workspace) await this.settle(api, workspace, remove ? 'delete' : 'stop');
  }
  /**
   * Lets go of every workspace of this profile: channels and forwards close, and what still
   * runs is asked to stop. The stop is not waited for, Coder finishes it on its own; nothing
   * is asked when the deployment cannot be reached.
   */
  async forget() {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map(async (pending) => (await pending).client.close()));
    for (const name of [...this.forwards.keys()]) this.closeForward(name);
    if (!this.used) return;
    try {
      const api = await this.api(5000);
      const running = (await api.workspaces()).filter(
        (workspace) =>
          this.owns(workspace.name) &&
          workspace.latest_build.transition === 'start' &&
          ['running', 'starting', 'pending'].includes(workspace.latest_build.status),
      );
      await Promise.allSettled(running.map((workspace) => api.build(workspace.id, 'stop')));
    } catch {
      // Not reachable now.
    }
  }
  /** Nothing recycles sandboxes while Athena is closed, so what still runs stops with it. */
  async dispose() {
    this.closed = true;
    await this.forget();
  }
}

// Non-interactive ssh skips the profile files that version managers extend PATH in, so the
// usual per-user places are looked at when `node` is not found as it is.
const findNode =
  'command -v node >/dev/null 2>&1 || for d in "$HOME"/.nvm/versions/node/*/bin "$HOME/.volta/bin" "$HOME/.local/bin" /usr/local/bin; do if [ -x "$d/node" ]; then PATH="$d:$PATH"; fi; done';
// Beside the daemon's own state, and under its .mjs name: older Node versions take a file
// for an ES module by that name only.
const program = 'p="$HOME/.athena-sandbox/athena-sandbox.mjs"';
// The daemon treats the home directory as its one repository, so commands start there.
const attachScript = `${findNode}; ${program}; export ATHENA_SANDBOX_REPOS="$HOME"; exec node "$p" attach --protocol 1`;
const installScript = [
  'set -e',
  findNode,
  `node -e 'process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)' </dev/null 2>/dev/null || exit 90`,
  program,
  'mkdir -p "$HOME/.athena-sandbox"',
  'chmod 700 "$HOME/.athena-sandbox"',
  'cat > "$p.new"',
  // A daemon of another version would not match the program that attaches to it.
  'if [ -f "$p" ] && ! cmp -s "$p.new" "$p"; then node "$p" stop </dev/null >/dev/null 2>&1 || true; fi',
  'mv "$p.new" "$p"',
].join('\n');
