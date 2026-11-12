import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { discoverExecutables, executableDirectories } from './agent-discovery';
import { SandboxClient, redact } from './sandbox-client';
import type { BrowserTool, ToolResult } from '../shared/types';
import type { SandboxEventEnvelope } from '../shared/sandbox-protocol';
import type { SandboxConnectionStatus } from './sandbox-client';

export type LocalSandboxUpdate = { conversationId: string } & (
  | { type: 'connection'; status: SandboxConnectionStatus; name: string }
  | { type: 'event'; data: SandboxEventEnvelope['event'] }
  | { type: 'preview'; status: string; url: string }
  | { type: 'files'; paths: string[] }
  | { type: 'service-command'; command: string }
);

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
export interface SandboxCallContext {
  conversationId: string;
  turnId: string;
  signal: AbortSignal;
}
interface RunningSandbox {
  name: string;
  workspace: string;
  client: SandboxClient;
}
export interface SandboxArtifact {
  path: string;
  bytes: number;
  sha256: string;
}

const fileWriter = String.raw`
const fs=require('node:fs'),path=require('node:path');let raw='';
process.stdin.setEncoding('utf8');process.stdin.on('data',s=>raw+=s);process.stdin.on('end',()=>{
 const root='/workspace',files=JSON.parse(raw);
 for(const file of files){
  const target=path.resolve(root,file.path);if(!target.startsWith(root+'/'))throw Error('Path outside sandbox');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  if(!fs.realpathSync(path.dirname(target)).startsWith(root+'/')&&fs.realpathSync(path.dirname(target))!==root)throw Error('Invalid parent');
  if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('Symlink target');
  const temporary=target+'.'+require('node:crypto').randomUUID()+'.tmp';fs.writeFileSync(temporary,file.content,{flag:'wx'});fs.renameSync(temporary,target);
 }console.log(JSON.stringify({files:files.map(f=>f.path)}));
});`;
const fileReader = String.raw`
const fs=require('node:fs'),path=require('node:path'),target=fs.realpathSync(path.resolve('/workspace',process.argv[1]));
if(!target.startsWith('/workspace/'))throw Error('Path outside sandbox');const stat=fs.statSync(target);
if(!stat.isFile()||stat.size>16*1024*1024)throw Error('Artifact must be a file of at most 16 MiB');
console.log(JSON.stringify({bytes:stat.size,data:fs.readFileSync(target).toString('base64')}));`;

export class LocalSandbox {
  private entries = new Map<string, Promise<RunningSandbox>>();
  private commands = new Map<string, Array<{ conversationId: string; commandId: string }>>();
  private docker?: string;
  private owner: string;
  private closed = false;
  constructor(
    private directory: string,
    private program: string,
    private onArtifact: (turnId: string, artifact: SandboxArtifact) => void,
    private runtime?: { image: string; dockerfile: string },
    private onUpdate: (update: LocalSandboxUpdate) => void = () => {},
  ) {
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
  private async previewUrl(name: string) {
    const info = await this.inspect(name);
    const port = info?.NetworkSettings.Ports['4173/tcp']?.find(
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
  private ensure(context: SandboxCallContext): Promise<RunningSandbox> {
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
          '127.0.0.1::4173',
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
    const client = new SandboxClient({
      host: name,
      clientVersion: 'athena-local',
      command: await this.executable(),
      args: ['exec', '-i', name, 'node', '/opt/athena-sandbox.mjs', 'attach', '--protocol', '1'],
      heartbeatMs: 10_000,
      maxAttempts: 2,
      requestTimeoutMs: 30_000,
      onState: (state) =>
        this.onUpdate({
          conversationId: context.conversationId,
          type: 'connection',
          status: state.status,
          name,
        }),
      onEvent: (event) => {
        this.onUpdate({ conversationId: context.conversationId, type: 'event', data: event.event });
        if (
          event.event.type === 'service.state' &&
          event.event.service.status === 'healthy' &&
          event.event.service.port === 4173
        )
          void this.previewUrl(name)
            .then((url) => {
              if (!this.closed)
                this.onUpdate({
                  conversationId: context.conversationId,
                  type: 'preview',
                  status: 'healthy',
                  url,
                });
            })
            .catch(() => {});
      },
    });
    try {
      await client.connect();
      context.signal.throwIfAborted();
      const { services } = await client.request('service.list', {});
      const preview = services.find(
        (service) => service.port === 4173 && service.status === 'healthy',
      );
      if (preview)
        this.onUpdate({
          conversationId: context.conversationId,
          type: 'preview',
          status: 'healthy',
          url: await this.previewUrl(name),
        });
    } catch (error) {
      client.close();
      throw error;
    }
    return { name, workspace, client };
  }
  async write(context: SandboxCallContext, files: Array<{ path: string; content: string }>) {
    if (!Array.isArray(files) || !files.length || files.length > 20)
      throw new Error('一次写入 1–20 个文件');
    for (const file of files) {
      if (
        typeof file.path !== 'string' ||
        path.isAbsolute(file.path) ||
        file.path.split(/[\/\\]/).includes('..') ||
        !file.path ||
        file.path.length > 300 ||
        typeof file.content !== 'string' ||
        Buffer.byteLength(file.content) > 256_000
      )
        throw new Error(
          '文件路径须相对 /workspace（例如 repo/backend/pom.xml），不能是绝对路径或含 ..；单文件内容上限 256000 字节',
        );
    }
    if (Buffer.byteLength(JSON.stringify(files)) > 1024 * 1024)
      throw new Error('一次写入内容不能超过 1 MiB');
    const sandbox = await this.ensure(context),
      docker = await this.executable();
    return new Promise<unknown>((resolve, reject) => {
      const child = spawn(docker, ['exec', '-i', sandbox.name, 'node', '-e', fileWriter], {
        stdio: 'pipe',
        signal: context.signal,
        timeout: 15_000,
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout = (stdout + data).slice(-16000);
      });
      child.stderr.on('data', (data) => {
        stderr = (stderr + data).slice(-2000);
      });
      child.on('error', () => reject(new Error('沙箱文件写入被中断，请先核对文件再重试')));
      child.stdin.on('error', () => reject(new Error('沙箱写入通道已断开，请先核对文件再重试')));
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(redact(stderr) || '沙箱文件写入失败'));
        try {
          const result = JSON.parse(stdout);
          this.onUpdate({
            conversationId: context.conversationId,
            type: 'files',
            paths: files.map((file) => file.path),
          });
          resolve(result);
        } catch {
          reject(new Error('沙箱未返回有效写入结果，请先核对文件'));
        }
      });
      child.stdin.end(JSON.stringify(files));
    });
  }
  async run(context: SandboxCallContext, command: string, waitSeconds = 20, timeoutSeconds = 300) {
    if (typeof command !== 'string' || !command.trim() || command.length > 4000)
      throw new Error('命令长度需在 1–4000 字符之间');
    const sandbox = await this.ensure(context),
      commandId = `c_${randomUUID()}`;
    const owned = this.commands.get(context.turnId) ?? [];
    owned.push({ conversationId: context.conversationId, commandId });
    this.commands.set(context.turnId, owned);
    await sandbox.client.request('command.run', {
      commandId,
      command,
      cwd: '/workspace',
      timeoutSeconds,
    });
    return this.result(context, commandId, waitSeconds);
  }
  async result(context: SandboxCallContext, commandId: string, waitSeconds = 0, stop = false) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(commandId)) throw new Error('命令标识无效');
    const sandbox = await this.ensure(context);
    if (stop) await sandbox.client.request('command.stop', { commandId });
    const deadline = Date.now() + Math.min(30, Math.max(0, waitSeconds)) * 1000;
    for (;;) {
      if (context.signal.aborted) {
        await sandbox.client.request('command.stop', { commandId }).catch(() => {});
        throw new Error('沙箱命令已停止');
      }
      const result = await sandbox.client.request('command.get', { commandId, tailBytes: 16000 });
      if (result.command.status !== 'running' || Date.now() >= deadline)
        return result.command.status === 'running'
          ? {
              ...result,
              output: result.output.slice(-3000),
              truncated: result.truncated || result.output.length > 3000,
            }
          : result;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  async service(context: SandboxCallContext, command: string, healthPath = '/') {
    if (
      typeof command !== 'string' ||
      !command.trim() ||
      command.length > 4000 ||
      !healthPath.startsWith('/') ||
      healthPath.length > 500
    )
      throw new Error('预览服务参数无效');
    const sandbox = await this.ensure(context);
    const { service } = await sandbox.client.request('service.start', {
      name: 'preview',
      command,
      port: 4173,
      health: { path: healthPath, timeoutSeconds: 30 },
    });
    this.onUpdate({ conversationId: context.conversationId, type: 'service-command', command });
    const deadline = Date.now() + 35_000;
    for (;;) {
      if (context.signal.aborted) {
        await sandbox.client.request('service.stop', { serviceId: service.id }).catch(() => {});
        throw new Error('预览启动已停止');
      }
      const { services } = await sandbox.client.request('service.list', {});
      const current = services.find((item) => item.id === service.id);
      if (current?.status === 'healthy') {
        const url = await this.previewUrl(sandbox.name);
        const response = await fetch(url + healthPath, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error(`预览 HTTP ${response.status}`);
        this.onUpdate({
          conversationId: context.conversationId,
          type: 'preview',
          status: current.status,
          url,
        });
        return { ...current, url };
      }
      if (
        !current ||
        ['failed', 'unhealthy', 'stopped'].includes(current.status) ||
        Date.now() >= deadline
      )
        throw new Error('沙箱预览健康检查未通过');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  async artifact(context: SandboxCallContext, relative: string): Promise<SandboxArtifact> {
    if (
      typeof relative !== 'string' ||
      !relative ||
      path.isAbsolute(relative) ||
      relative.split(/[\/\\]/).includes('..')
    )
      throw new Error('产物必须位于沙箱工作目录内');
    const sandbox = await this.ensure(context);
    const value = JSON.parse(
      await this.command(
        ['exec', sandbox.name, 'node', '-e', fileReader, '--', relative],
        context.signal,
      ),
    );
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.length !== value.bytes || bytes.length > 16 * 1024 * 1024)
      throw new Error('产物内容校验失败');
    const target = path.join(this.directory, 'artifacts', randomUUID(), path.basename(relative));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
    const artifact = {
      path: target,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    this.onArtifact(context.turnId, artifact);
    return artifact;
  }
  async cancelTurn(turnId: string) {
    const owned = this.commands.get(turnId) ?? [];
    this.commands.delete(turnId);
    await Promise.allSettled(
      owned.map(async ({ conversationId, commandId }) => {
        const sandbox = await this.entries.get(conversationId);
        await sandbox?.client.request('command.stop', { commandId });
      }),
    );
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    context: SandboxCallContext,
  ): Promise<ToolResult> {
    let value: unknown;
    const integer = (key: string, fallback: number, max: number) => {
      const n = args[key] ?? fallback;
      if (!Number.isInteger(n) || Number(n) < 0 || Number(n) > max) throw new Error(`${key} 无效`);
      return Number(n);
    };
    if (name === 'athena_sandbox_status') value = await this.status(context.conversationId);
    else if (name === 'athena_sandbox_write')
      value = await this.write(context, args.files as Array<{ path: string; content: string }>);
    else if (name === 'athena_sandbox_exec')
      value = await this.run(
        context,
        args.command as string,
        integer('wait_seconds', 20, 30),
        integer('timeout_seconds', 300, 3600) || 300,
      );
    else if (name === 'athena_sandbox_command')
      value = await this.result(
        context,
        args.command_id as string,
        integer('wait_seconds', 0, 30),
        args.stop === true,
      );
    else if (name === 'athena_sandbox_service_start')
      value = await this.service(
        context,
        args.command as string,
        args.health_path as string | undefined,
      );
    else if (name === 'athena_sandbox_artifact')
      value = await this.artifact(context, args.path as string);
    else throw new Error('未知的沙箱工具');
    return {
      text: JSON.stringify(value),
      ...((value as any)?.command?.status === 'failed' ? { isError: true } : {}),
    };
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
