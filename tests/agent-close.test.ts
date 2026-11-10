import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeProcessGroup } from '../src/main/process-close';

test('关闭等待实际退出，不把发出 SIGTERM 视为已停止', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"], {
    detached: process.platform !== 'win32', stdio: 'pipe',
  });
  try {
    await once(child.stdout, 'data');
    await closeProcessGroup(child);
    assert.notEqual(child.signalCode, null);
    assert.throws(() => process.kill(child.pid!, 0), { code: 'ESRCH' });
    await closeProcessGroup(child);
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* 临时进程已退出。 */ }
  }
});

test('尚未创建进程时关闭等待立即完成', async () => {
  await closeProcessGroup(undefined);
});
