import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const busy = '另一个进程正在使用 Athena 的网页浏览器。请关闭使用同一工作区的 Athena 窗口后重试。';
const unavailable = '检测到上次使用的 Chrome，但暂时无法重新连接。请稍后重试。';

export async function lockBrowserProfile(directory: string) {
  if (process.platform !== 'darwin') return;
  try {
    // Darwin sys/fcntl.h O_EXLOCK. The kernel releases this lock even when Electron crashes.
    return await open(
      join(directory, 'browser-owner.lock'),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x20,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN') throw new Error(busy);
    throw error;
  }
}

export function chromeArguments(profile: string): string[] {
  return [
    '--headless=new',
    '--force-device-scale-factor=2',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=MediaRouter',
    '--disable-sync',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank',
  ];
}

export function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Reconnect only to an orphan of our own browser, including profiles created before host locking. */
export async function findOrphanChrome(
  profile: string,
  binary: string,
  previouslyOwnedPid?: number,
) {
  if (process.platform !== 'darwin') return;
  let lock: string;
  try {
    lock = await readlink(join(profile, 'SingletonLock'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const match = /^(.*)-(\d+)$/.exec(lock);
  if (!match || match[1] !== hostname()) throw new Error(busy);
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(busy);
  if (!processExists(pid)) return; // Chrome itself recovers obsolete singleton files.
  const options = { timeout: 2000, maxBuffer: 32 * 1024 };
  try {
    const { stdout } = await exec(
      '/bin/ps',
      ['-ww', '-p', String(pid), '-o', 'ppid=,uid=,command='],
      options,
    );
    const processInfo = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(stdout.trimEnd());
    if (!processInfo || Number(processInfo[2]) !== process.getuid!()) throw new Error(busy);
    const expected = [binary, ...chromeArguments(profile)].join(' ');
    if (
      processInfo[3] !== expected ||
      (Number(processInfo[1]) !== 1 &&
        !(pid === previouslyOwnedPid && Number(processInfo[1]) === process.pid))
    )
      throw new Error(busy);
    // The lock identifies the process. Its listening sockets identify the live endpoint,
    // even if a crash left DevToolsActivePort missing or out of date.
    const listener = await exec(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
      options,
    );
    for (const line of listener.stdout.split('\n')) {
      if (!/^n127\.0\.0\.1:\d+$/.test(line)) continue;
      const host = line.slice(1);
      try {
        const response = await fetch('http://' + host + '/json/version', {
          redirect: 'error',
          signal: AbortSignal.timeout(1500),
        });
        if (!response.ok) continue;
        const version = (await response.json()) as { webSocketDebuggerUrl?: string };
        const endpoint = new URL(version.webSocketDebuggerUrl ?? '');
        if (
          endpoint.origin === 'ws://' + host &&
          /^\/devtools\/browser\/[a-f\d-]{36}$/i.test(endpoint.pathname) &&
          !endpoint.username &&
          !endpoint.password &&
          !endpoint.search &&
          !endpoint.hash
        )
          return { pid, endpoint: endpoint.href };
      } catch {
        /* Other loopback listeners need not serve DevTools. */
      }
    }
    throw new Error(unavailable);
  } catch (error) {
    if (!processExists(pid)) return;
    throw new Error(error instanceof Error && error.message === busy ? busy : unavailable);
  }
}
