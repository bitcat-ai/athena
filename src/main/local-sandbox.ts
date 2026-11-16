import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { discoverExecutables, executableDirectories } from './agent-discovery';
import { redact } from './sandbox-client';
import {
  PREVIEW_PORT,
  SandboxRuntime,
  type LocalSandboxUpdate,
  type RunningSandbox,
  type SandboxArtifact,
  type SandboxCallContext,
} from './sandbox-runtime';
import type { BrowserTool } from '../shared/types';

export type { LocalSandboxUpdate, SandboxArtifact, SandboxCallContext } from './sandbox-runtime';

const exec = promisify(execFile);
const label = 'app.athena.sandbox';
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const localSandboxTools: BrowserTool[] = [
  {
    name: 'athena_sandbox_status',
    description: '查看本对话的独立 Docker 沙箱。它不挂载本机项目、登录凭据或 Docker socket。',
    inputSchema: object({}),
  },
  {
    name: 'athena_sandbox_write',
    description:
      '在本对话沙箱 /workspace 内写入源码和构建配置。缺少沙箱时自动创建；文件写入发生在容器内部。',
    inputSchema: object(
      {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: object(
            {
              path: {
                type: 'string',
                maxLength: 300,
                description:
                  '相对 /workspace 的路径，例如 repo/backend/pom.xml。不得以 / 开头或包含 ..。',
              },
              content: { type: 'string' },
            },
            ['path', 'content'],
          ),
        },
      },
      ['files'],
    ),
  },
  {
    name: 'athena_sandbox_exec',
    description:
      '在独立沙箱 /workspace 执行安装、检查和构建命令；不存在时自动创建。长命令返回 command_id，必须查看最终退出码；不在用户 Mac 的项目里执行。',
    inputSchema: object(
      {
        command: {
          type: 'string',
          maxLength: 4000,
          description:
            '最多 4000 字符。较长源码请用 athena_sandbox_write，文件 path 使用相对 /workspace 的路径。',
        },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 3600 },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 30 },
      },
      ['command'],
    ),
  },
  {
    name: 'athena_sandbox_command',
    description: '读取或停止本对话沙箱命令；结果未知时先查询，不重放有副作用的命令。',
    inputSchema: object(
      {
        command_id: { type: 'string' },
        stop: { type: 'boolean' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 30 },
      },
      ['command_id'],
    ),
  },
  {
    name: 'athena_sandbox_service_start',
    description:
      '启动沙箱应用预览或 API 服务。命令必须监听 0.0.0.0:$PORT（4173）；健康检查通过后返回仅本机可访问的 URL，可交给网页工具打开并验收。',
    inputSchema: object({ command: { type: 'string' }, health_path: { type: 'string' } }, [
      'command',
    ]),
  },
  {
    name: 'athena_sandbox_artifact',
    description:
      '导出沙箱中的真实文件，核对大小和 SHA-256 后记录产物。path 使用相对 /workspace 的路径，例如 frontend.tar.gz 或 dist/index.html，不要传绝对路径。',
    inputSchema: object({ path: { type: 'string' } }, ['path']),
  },
];
export const isLocalSandboxTool = (name: string) =>
  localSandboxTools.some((tool) => tool.name === name);
export const readOnlySandboxCall = (name: string, args: Record<string, unknown>) =>
  name === 'athena_sandbox_status' || (name === 'athena_sandbox_command' && args.stop !== true);
export class LocalSandbox extends SandboxRuntime {
  private docker?: string;
  private owner: string;
  private closed = false;
  protected readonly root = '/workspace';
  protected readonly rootSource = "'/workspace'";
  protected readonly cwd = '/workspace';
  constructor(
    directory: string,
    private program: string,
    onArtifact: (turnId: string, artifact: SandboxArtifact) => void,
    private runtime?: { image: string; dockerfile: string },
    onUpdate: (update: LocalSandboxUpdate) => void = () => {},
  ) {
    super(directory, onArtifact, onUpdate);
    this.owner = createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 16);
  }
  private async executable() {
    if (!this.docker) {
      [this.docker] = await discoverExecutables(['docker'], await executableDirectories());
      if (!this.docker) throw new Error('未找到 Docker，请安装并启动 Docker Desktop 后重试');
    }
    return this.docker;
  }
  private async command(args: string[], signal?: AbortSignal, timeout = 30_000) {
    try {
      const { stdout } = await exec(await this.executable(), args, {
        timeout,
        signal,
        maxBuffer: 24 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      if (signal?.aborted) throw new Error('沙箱操作已停止；有副作用的操作请先查询状态');
      const details = error as { stderr?: string; message?: string };
      throw new Error(redact(details.stderr || details.message || 'Docker 操作失败').slice(-1800));
    }
  }
  private name(id: string) {
    return `athena-${this.owner}-${createHash('sha256').update(id).digest('hex').slice(0, 10)}`;
  }
  private async inspect(name: string) {
    const found = await this.command([
      'container',
      'ls',
      '-a',
      '--filter',
      `name=^/${name}$`,
      '--format',
      '{{.Names}}',
    ]);
    if (!found.trim()) return undefined;
    const [info] = JSON.parse(await this.command(['inspect', name]));
    if (info.Config?.Labels?.[label] !== this.owner)
      throw new Error('同名容器不属于此 Athena 档案，已停止操作');
    return info;
  }
  protected async previewUrl(name: string) {
    const info = await this.inspect(name);
    const port = info?.NetworkSettings.Ports[`${PREVIEW_PORT}/tcp`]?.find(
      (binding: any) => binding.HostIp === '127.0.0.1',
    )?.HostPort;
    if (!/^\d+$/.test(port ?? '')) throw new Error('沙箱预览端口未绑定到本机');
    return `http://127.0.0.1:${port}`;
  }
  async status(conversationId: string) {
    const name = this.name(conversationId),
      info = await this.inspect(name);
    return {
      name,
      status: info?.State?.Status ?? 'missing',
      isolation: 'docker',
      workspace: '/workspace',
    };
  }
  protected ensure(context: SandboxCallContext): Promise<RunningSandbox> {
    if (this.closed || context.signal.aborted) return Promise.reject(new Error('沙箱操作已停止'));
    let pending = this.entries.get(context.conversationId);
    if (pending) {
      const previous = pending;
      return previous.then(async (entry) => {
        const info = await this.inspect(entry.name);
        if (this.closed || context.signal.aborted) throw new Error('沙箱操作已停止');
        if (info?.State?.Running) {
          await entry.client.connect();
          return entry;
        }
        if (this.entries.get(context.conversationId) !== previous)
          return this.entries.get(context.conversationId)!;
        entry.client.close();
        this.entries.delete(context.conversationId);
        return this.ensure(context);
      });
    }
    if (!pending) {
      pending = this.start(context).catch((error) => {
        this.onUpdate({
          conversationId: context.conversationId,
          type: 'connection',
          status: context.signal.aborted ? 'closed' : 'failed',
          name: this.name(context.conversationId),
        });
        this.entries.delete(context.conversationId);
        throw error;
      });
      this.entries.set(context.conversationId, pending);
    }
    return pending;
  }
  private async start(context: SandboxCallContext): Promise<RunningSandbox> {
    const name = this.name(context.conversationId);
    this.onUpdate({
      conversationId: context.conversationId,
      type: 'connection',
      status: 'connecting',
      name,
    });
    const workspace = path.join(this.directory, name, 'workspace');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    if (workspace.includes(',') || this.program.includes(','))
      throw new Error('沙箱路径不能包含逗号，请选择其他开发数据目录');
    const endpoint = (
      await this.command(
        ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
        context.signal,
      )
    ).trim();
    if (
      !endpoint.startsWith('unix://') ||
      (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://'))
    )
      throw new Error('自动沙箱仅使用本机 Docker，请选择本地 Docker context');
    let info = await this.inspect(name);
    if (!info) {
      const image = this.runtime?.image ?? 'node:24-alpine';
      if (
        !(await this.command(['image', 'ls', image, '--format', '{{.ID}}'], context.signal)).trim()
      )
        if (this.runtime)
          await this.command(
            [
              'build',
              '-t',
              image,
              '-f',
              this.runtime.dockerfile,
              path.dirname(this.runtime.dockerfile),
            ],
            context.signal,
            600_000,
          );
        else await this.command(['pull', image], context.signal, 180_000);
      await this.command(
        [
          'create',
          '--name',
          name,
          '--label',
          `${label}=${this.owner}`,
          '--init',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--pids-limit=256',
          this.runtime ? '--memory=2g' : '--memory=1g',
          '--cpus=2',
          '--user',
          `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,size=128m',
          '--mount',
          `type=bind,source=${workspace},target=/workspace`,
          '--mount',
          `type=bind,source=${await realpath(this.program)},target=/opt/athena-sandbox.mjs,readonly`,
          '--workdir',
          '/workspace',
          '--env',
          'HOME=/workspace/.home',
          '--env',
          'MAVEN_OPTS=-Duser.home=/workspace/.home',
          '--env',
          'ATHENA_SANDBOX_HOME=/workspace/.athena-state',
          '--env',
          'ATHENA_SANDBOX_REPOS=/workspace',
          '--publish',
          `127.0.0.1::${PREVIEW_PORT}`,
          image,
          'node',
          '/opt/athena-sandbox.mjs',
          'daemon',
        ],
        context.signal,
      );
      info = await this.inspect(name);
    }
    if (!info?.State?.Running) await this.command(['start', name], context.signal);
    context.signal.throwIfAborted();
    const client = await this.attach(
      context,
      name,
      {
        command: await this.executable(),
        args: ['exec', '-i', name, 'node', '/opt/athena-sandbox.mjs', 'attach', '--protocol', '1'],
      },
      'athena-local',
      () => this.closed,
    );
    return { name, client };
  }
  protected async node(name: string, script: string, args: string[] = []) {
    return {
      command: await this.executable(),
      args: ['exec', '-i', name, 'node', '-e', script, '--', ...args],
    };
  }
  /** Container names start with this; it tells this profile's sandboxes from any other's. */
  get prefix() {
    return `athena-${this.owner}-`;
  }
  private owns(name: string) {
    return name.startsWith(this.prefix) && /^[0-9a-f]{10}$/.test(name.slice(this.prefix.length));
  }
  containerName(id: string) {
    return this.name(id);
  }
  /** Starts the sandbox without running anything in it. */
  async open(context: SandboxCallContext) {
    return (await this.ensure(context)).name;
  }
  /** Every Athena sandbox container Docker knows, by name, with its state. */
  async containers() {
    const listed = await this.command([
      'container',
      'ls',
      '-a',
      '--filter',
      `label=${label}`,
      '--format',
      '{{.Names}}\t{{.State}}',
    ]);
    return new Map(
      listed
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\t') as [string, string]),
    );
  }
  /** Sandbox directories of this profile, whether or not a container still exists for them. */
  async workspaces() {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    return names.filter((name) => this.owns(name));
  }
  /** Stops one sandbox, or removes it together with its files. */
  async release(name: string, remove: boolean) {
    if (!this.owns(name)) throw new Error('这个沙箱不属于此 Athena 档案');
    for (const [id, pending] of this.entries)
      if (this.name(id) === name) {
        this.entries.delete(id);
        await pending.then(
          (entry) => entry.client.close(),
          () => {},
        );
      }
    if (await this.inspect(name))
      await this.command(remove ? ['rm', '--force', name] : ['stop', '--time', '2', name]);
    if (remove) await rm(path.join(this.directory, name), { recursive: true, force: true });
  }
  async dispose() {
    this.closed = true;
    await Promise.allSettled(
      [...this.entries.values()].map(async (pending) => {
        const entry = await pending;
        entry.client.close();
      }),
    );
    if (!this.docker) return;
    const names = (
      await this.command([
        'container',
        'ls',
        '--filter',
        `label=${label}=${this.owner}`,
        '--format',
        '{{.Names}}',
      ])
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    await Promise.allSettled(
      names.map(async (name) => {
        if (await this.inspect(name)) await this.command(['stop', '--time', '2', name]);
      }),
    );
  }
}
