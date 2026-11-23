import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { discoverExecutables, executableDirectories } from './agent-discovery';

export interface CoderCliOptions {
  /** Where a downloaded command is kept, one per deployment. Athena's own; nothing else uses it. */
  directory: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The `coder` command already on this machine, if there is one. */
  installed?: () => Promise<string | undefined>;
  platform?: NodeJS.Platform;
  arch?: string;
}

const MIN_BYTES = 1024 * 1024;
const MAX_BYTES = 400 * 1024 * 1024;
const systems: Partial<Record<NodeJS.Platform, string>> = { darwin: 'darwin', linux: 'linux' };
const machines: Record<string, string> = { arm64: 'arm64', x64: 'amd64' };

async function onThisMachine() {
  return (await discoverExecutables(['coder'], await executableDirectories()))[0];
}
async function usable(file: string) {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).size >= MIN_BYTES;
  } catch {
    return false;
  }
}

/**
 * The `coder` command for a deployment. One that is installed on this machine is used as it
 * is. Without one, the deployment's own build of the command is downloaded from the
 * deployment, which serves it for every platform at the version it runs itself: nobody has to
 * install anything before the first sandbox. The download needs no token, and it is the same
 * file Coder's own install script would fetch from that address.
 */
export function coderCli(options: CoderCliOptions) {
  const pending = new Map<string, Promise<string>>();
  const download = async (origin: string, file: string) => {
    const system = systems[options.platform ?? process.platform];
    const machine = machines[options.arch ?? process.arch];
    if (!system || !machine) throw new Error('这个 Coder 部署没有适用于本机系统的 coder 命令');
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const partial = `${file}.${process.pid}.part`;
    try {
      const response = await (options.fetch ?? fetch)(`${origin}/bin/coder-${system}-${machine}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!response.ok || !response.body) throw new Error(`部署返回 ${response.status}`);
      const hash = createHash('sha1');
      const output = createWriteStream(partial, { mode: 0o700 });
      let bytes = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if ((bytes += chunk.byteLength) > MAX_BYTES) throw new Error('文件大小超出预期');
          hash.update(chunk);
          if (!output.write(chunk))
            await new Promise<void>((resolve) => output.once('drain', resolve));
        }
      } finally {
        await new Promise<void>((resolve) => output.end(resolve));
      }
      if (bytes < MIN_BYTES) throw new Error('下载到的文件不完整');
      // Coder names the file's SHA-1 as its ETag. This catches a damaged or cut-off download;
      // it is no signature, since the same server states both.
      const stated = /^(?:W\/)?"([0-9a-f]{40})"$/i.exec(response.headers.get('etag') ?? '')?.[1];
      if (stated && stated.toLowerCase() !== hash.digest('hex'))
        throw new Error('下载到的文件与部署给出的校验值不一致');
      await chmod(partial, 0o755);
      await rename(partial, file);
      return file;
    } catch (error) {
      await rm(partial, { force: true });
      throw new Error(
        `这台 Mac 上没有 coder 命令，从 Coder 部署下载也没有成功（${
          error instanceof Error ? error.message : '网络不可用'
        }）。请检查网络后重试，或按 Coder 页面上的说明安装 Coder CLI`,
      );
    }
  };
  return async (origin: string): Promise<string> => {
    const installed = await (options.installed ?? onThisMachine)();
    if (installed) return installed;
    // One file per deployment: two deployments may run different versions.
    const file = path.join(
      options.directory,
      `coder-${createHash('sha256').update(origin).digest('hex').slice(0, 12)}`,
    );
    if (await usable(file)) return file;
    let task = pending.get(origin);
    if (!task) {
      task = download(origin, file).finally(() => pending.delete(origin));
      pending.set(origin, task);
    }
    return task;
  };
}
