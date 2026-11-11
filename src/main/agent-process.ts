import { spawn } from 'node:child_process';
import path from 'node:path';

/** A local CLI runs with the user's own environment: its provider keys and configuration are its business. */
export function cliEnvironment(executable: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
  };
}

/** Read-only CLI metadata queries; callers never pass user prompts or tool commands. */
export function readCliOutput(
  executable: string,
  workspace: string,
  args: string[],
  input: string,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error('CLI 信息读取已取消'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: workspace,
      env: { ...cliEnvironment(executable), NO_COLOR: '1', NO_OPEN_BROWSER: '1' },
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let failure: string | undefined;
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* The process group has already exited. */
      }
    };
    const stop = (message: string) => {
      failure ??= message;
      kill();
    };
    const cancel = () => stop('CLI 信息读取已取消');
    const timer = setTimeout(() => stop('读取 CLI 信息超时，请检查连接后刷新'), 20000);
    signal.addEventListener('abort', cancel, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (failure) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > 4 * 1024 * 1024) stop('CLI 信息返回过大');
    });
    child.stderr.resume(); // Provider diagnostics may contain credentials.
    child.stdin.on('error', () => stop('CLI 信息查询连接中断'));
    child.on('error', () => stop('无法启动 CLI 查询'));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      kill();
      if (failure || code !== 0)
        reject(new Error(failure || '读取 CLI 信息失败，请在终端检查登录与服务配置'));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}
