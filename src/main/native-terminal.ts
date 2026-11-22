import { BrowserWindow, ipcMain } from 'electron';
import type { IPty } from 'node-pty';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { cliEnvironment } from './agent-process';
import { discoverExecutables, executableDirectories } from './agent-discovery';
import type { TerminalSize } from '../shared/native-terminal';

export async function otherNativeRuntimes() {
  const directories = await executableDirectories();
  const names: Record<string, string> = {
    grok: 'Grok CLI',
    amp: 'Amp',
    copilot: 'GitHub Copilot CLI',
    qwen: 'Qwen Code',
    aider: 'Aider',
    goose: 'Goose',
    droid: 'Droid',
  };
  const results = await Promise.all(
    Object.entries(names).map(async ([id, name]) => {
      const [executable] = await discoverExecutables([id], directories);
      return executable ? { id, name, executable } : undefined;
    }),
  );
  return results.filter((item) => item !== undefined);
}

function terminalSize(value: TerminalSize) {
  if (
    !value ||
    !Number.isInteger(value.cols) ||
    !Number.isInteger(value.rows) ||
    value.cols < 2 ||
    value.cols > 1000 ||
    value.rows < 1 ||
    value.rows > 500
  )
    throw new Error('无效的终端尺寸');
  return value;
}

interface NativeWindow {
  window: BrowserWindow;
  name: string;
  executable: string;
  workspace: string;
  started: boolean;
  pty?: IPty;
  pending: number;
}
const windows = new Map<number, NativeWindow>();
function sender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) {
  return event.senderFrame === event.sender.mainFrame ? windows.get(event.sender.id) : undefined;
}
/** forkpty gives this native session its own process group. Include foreground CLI helpers. */
function stopNativeGroup(pty: IPty, signal: NodeJS.Signals) {
  try {
    process.kill(-pty.pid, signal);
  } catch {
    pty.kill(signal);
  }
}
export function registerNativeTerminal() {
  ipcMain.handle('terminal:start', async (event, size) => {
    const target = sender(event);
    if (!target || target.started) throw new Error('此终端已关闭或已启动');
    const { cols, rows } = terminalSize(size);
    target.started = true;
    const [{ spawn }, dirs] = await Promise.all([import('node-pty'), executableDirectories()]);
    if (target.window.isDestroyed()) throw new Error('此终端已关闭');
    const pty = spawn(target.executable, [], {
      cols,
      rows,
      name: 'xterm-256color',
      cwd: target.workspace,
      env: {
        ...cliEnvironment(target.executable),
        PATH: [...new Set([path.dirname(target.executable), ...dirs])].join(path.delimiter),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });
    target.pty = pty;
    pty.onData((data) => {
      if (target.window.isDestroyed()) return;
      target.pending += data.length;
      if (target.pending > 256 * 1024) pty.pause();
      target.window.webContents.send('terminal:data', data);
    });
    pty.onExit(({ exitCode }) => {
      target.pty = undefined;
      if (!target.window.isDestroyed()) target.window.webContents.send('terminal:exit', exitCode);
    });
    return { name: target.name, workspace: target.workspace };
  });
  ipcMain.on('terminal:input', (event, data) => {
    if (typeof data === 'string' && data.length <= 65536) sender(event)?.pty?.write(data);
  });
  ipcMain.on('terminal:resize', (event, size) => {
    const pty = sender(event)?.pty;
    if (!pty) return;
    try {
      const { cols, rows } = terminalSize(size);
      pty.resize(cols, rows);
    } catch {
      /* A closing renderer can race the final resize. */
    }
  });
  ipcMain.on('terminal:ack', (event, count) => {
    const target = sender(event);
    if (!target?.pty || !Number.isSafeInteger(count) || count < 0 || count > target.pending) return;
    const paused = target.pending > 64 * 1024;
    target.pending -= count;
    if (paused && target.pending <= 64 * 1024) target.pty.resume();
  });
}

export async function openNativeTerminal(name: string, executable: string, workspace: string) {
  const window = new BrowserWindow({
    title: `${name} · 原生会话`,
    width: 1000,
    height: 720,
    minWidth: 480,
    minHeight: 320,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'native-terminal-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      partition: 'native-terminal-' + randomUUID(),
    },
  });
  const id = window.webContents.id;
  const target: NativeWindow = { window, name, executable, workspace, started: false, pending: 0 };
  windows.set(id, target);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (e) => e.preventDefault());
  window.webContents.on('will-redirect', (e) => e.preventDefault());
  window.webContents.on('render-process-gone', () => {
    if (!window.isDestroyed()) window.destroy();
  });
  window.once('closed', () => {
    windows.delete(id);
    if (target.pty) {
      stopNativeGroup(target.pty, 'SIGHUP');
      setTimeout(() => {
        try {
          if (target.pty) stopNativeGroup(target.pty, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }, 1200).unref();
    }
  });
  try {
    await window.loadFile(path.join(__dirname, '../renderer/terminal.html'));
    window.show();
    return true;
  } catch {
    if (!window.isDestroyed()) window.destroy();
    throw new Error('原生会话窗口无法启动');
  }
}
