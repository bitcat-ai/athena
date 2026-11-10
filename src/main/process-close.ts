import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** 仅处理宿主创建的独立进程组；无法确认退出时拒绝继续删除。 */
export async function closeProcessGroup(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid) return;
  if (process.platform === 'win32') throw new Error('当前平台无法确认 CLI 子进程全部退出');
  const group = -child.pid;
  const exists = () => {
    try { process.kill(group, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw new Error('无法确认 CLI 进程组状态');
    }
  };
  const signal = (value: NodeJS.Signals) => {
    try { process.kill(group, value); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('无法停止 CLI 进程组');
    }
  };
  signal('SIGTERM');
  const start = Date.now();
  let escalated = false;
  while (exists()) {
    const elapsed = Date.now() - start;
    if (!escalated && elapsed >= 1500) { signal('SIGKILL'); escalated = true; }
    if (elapsed >= 8000) throw new Error('无法确认 CLI 子进程已退出，请核实后重试');
    await delay(20);
  }
}
