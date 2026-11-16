import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SandboxClient, redact } from './sandbox-client';
import type { ToolResult } from '../shared/types';
import type { SandboxEventEnvelope } from '../shared/sandbox-protocol';
import type { SandboxConnectionStatus } from './sandbox-client';

export type LocalSandboxUpdate = { conversationId: string } & (
  | { type: 'connection'; status: SandboxConnectionStatus; name: string }
  | { type: 'event'; data: SandboxEventEnvelope['event'] }
  | { type: 'preview'; status: string; url: string }
  | { type: 'files'; paths: string[] }
  | { type: 'service-command'; command: string }
);
export interface SandboxCallContext {
  conversationId: string;
  turnId: string;
  signal: AbortSignal;
}
export interface RunningSandbox {
  name: string;
  client: SandboxClient;
}
export interface SandboxArtifact {
  path: string;
  bytes: number;
  sha256: string;
}
/** A program to start, as `spawn` takes it. */
export interface SandboxProcess {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** Port inside every sandbox on which its preview service listens. */
export const PREVIEW_PORT = 4173;

// Both run with node inside the sandbox; `root` is JavaScript source for the directory that
// paths are relative to.
export const fileWriter = (root: string) => String.raw`
const fs=require('node:fs'),path=require('node:path');let raw='';
process.stdin.setEncoding('utf8');process.stdin.on('data',s=>raw+=s);process.stdin.on('end',()=>{
 const root=${root},files=JSON.parse(raw);
 for(const file of files){
  const target=path.resolve(root,file.path);if(!target.startsWith(root+'/'))throw Error('Path outside sandbox');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  if(!fs.realpathSync(path.dirname(target)).startsWith(root+'/')&&fs.realpathSync(path.dirname(target))!==root)throw Error('Invalid parent');
  if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('Symlink target');
  const temporary=target+'.'+require('node:crypto').randomUUID()+'.tmp';fs.writeFileSync(temporary,file.content,{flag:'wx'});fs.renameSync(temporary,target);
 }console.log(JSON.stringify({files:files.map(f=>f.path)}));
});`;
export const fileReader = (root: string) => String.raw`
const fs=require('node:fs'),path=require('node:path'),root=${root},target=fs.realpathSync(path.resolve(root,process.argv[1]));
if(!target.startsWith(root+'/'))throw Error('Path outside sandbox');const stat=fs.statSync(target);
if(!stat.isFile()||stat.size>16*1024*1024)throw Error('Artifact must be a file of at most 16 MiB');
console.log(JSON.stringify({bytes:stat.size,data:fs.readFileSync(target).toString('base64')}));`;

/**
 * What every kind of sandbox does the same way once its control channel is connected:
 * commands, the preview service, files in and artifacts out. Where the sandbox runs and how
 * it is reached is left to the subclass.
 */
export abstract class SandboxRuntime {
  protected entries = new Map<string, Promise<RunningSandbox>>();
  private commands = new Map<string, Array<{ conversationId: string; commandId: string }>>();
  constructor(
    protected directory: string,
    protected onArtifact: (turnId: string, artifact: SandboxArtifact) => void,
    protected onUpdate: (update: LocalSandboxUpdate) => void,
  ) {}
  /** What the tools call the directory that file paths are relative to. */
  protected abstract readonly root: string;
  /** JavaScript source for that directory, evaluated inside the sandbox. */
  protected abstract readonly rootSource: string;
  /** Where commands start; left to the sandbox's own daemon when undefined. */
  protected abstract readonly cwd: string | undefined;
  /** The running sandbox of a conversation or instance, started first when it has to be. */
  protected abstract ensure(context: SandboxCallContext): Promise<RunningSandbox>;
  /** A loopback URL on this machine that reaches the sandbox's preview port. */
  protected abstract previewUrl(name: string): Promise<string>;
  /** How to run node with `script` (and `args` after `--`) inside the sandbox. */
  protected abstract node(name: string, script: string, args?: string[]): Promise<SandboxProcess>;
  abstract status(conversationId: string): Promise<unknown>;

  /** Runs a program to its end, feeding `input` to it, and returns what it printed. */
  protected pipe(
    program: SandboxProcess,
    input: string | Buffer | undefined,
    options: { signal?: AbortSignal; timeout?: number; failure: string },
  ) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(program.command, program.args, {
        stdio: 'pipe',
        env: program.env,
        signal: options.signal,
        timeout: options.timeout ?? 15_000,
      });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        // An artifact of the largest size, base64 encoded, stays below this.
        if (stdout.length < 24 * 1024 * 1024) stdout += data;
      });
      child.stderr.on('data', (data) => {
        stderr = (stderr + data).slice(-2000);
      });
      child.on('error', () => reject(new Error(options.failure + '：操作被中断')));
      child.stdin.on('error', () => reject(new Error(options.failure + '：通道已断开')));
      child.on('close', (code) => {
        if (code === 0) return resolve(stdout);
        const error = new Error(redact(stderr).trim().slice(-1800) || options.failure);
        reject(Object.assign(error, { code }));
      });
      child.stdin.end(input);
    });
  }
  /** Opens the control channel of a started sandbox and reports what happens on it. */
  protected async attach(
    context: SandboxCallContext,
    name: string,
    program: SandboxProcess,
    clientVersion: string,
    isClosed: () => boolean,
  ) {
    const preview = (status: string) =>
      this.previewUrl(name).then((url) => {
        if (!isClosed())
          this.onUpdate({ conversationId: context.conversationId, type: 'preview', status, url });
      });
    const client = new SandboxClient({
      host: name,
      clientVersion,
      ...program,
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
          event.event.service.port === PREVIEW_PORT
        )
          void preview('healthy').catch(() => {});
      },
    });
    try {
      await client.connect();
      context.signal.throwIfAborted();
      const { services } = await client.request('service.list', {});
      if (services.some((service) => service.port === PREVIEW_PORT && service.status === 'healthy'))
        await preview('healthy');
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
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
          `文件路径须相对 ${this.root}（例如 repo/backend/pom.xml），不能是绝对路径或含 ..；单文件内容上限 256000 字节`,
        );
    }
    if (Buffer.byteLength(JSON.stringify(files)) > 1024 * 1024)
      throw new Error('一次写入内容不能超过 1 MiB');
    const sandbox = await this.ensure(context);
    let stdout: string;
    try {
      stdout = await this.pipe(
        await this.node(sandbox.name, fileWriter(this.rootSource)),
        JSON.stringify(files),
        { signal: context.signal, failure: '沙箱文件写入失败' },
      );
    } catch (error) {
      // Some of the files may already be in place.
      throw new Error(`${(error as Error).message}；请先核对文件再重试`);
    }
    try {
      const result: unknown = JSON.parse(stdout.slice(-16000));
      this.onUpdate({
        conversationId: context.conversationId,
        type: 'files',
        paths: files.map((file) => file.path),
      });
      return result;
    } catch {
      throw new Error('沙箱未返回有效写入结果，请先核对文件');
    }
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
      ...(this.cwd ? { cwd: this.cwd } : {}),
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
      port: PREVIEW_PORT,
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
      await this.pipe(
        await this.node(sandbox.name, fileReader(this.rootSource), [relative]),
        undefined,
        { signal: context.signal, timeout: 60_000, failure: '沙箱产物读取失败' },
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
}
