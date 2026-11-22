import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';
import { watchMain } from './build-main.mjs';

const server = await createServer({ server: { host: '127.0.0.1', port: 5173 } });
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
console.log(`Athena renderer: ${url}`);

const resourceRoots = ['resources', 'packages/athena-sandbox'].map(
  (p) => path.resolve(p) + path.sep,
);
let resourceRevision = 0;
let compiler, latest, child, timer;
let runningVersion,
  publishing = false,
  closing = false,
  waiting = false;

function schedule(delay = 100) {
  clearTimeout(timer);
  if (!closing)
    timer = setTimeout(
      () =>
        void update().catch((error) => {
          console.error('Athena dev build failed', error);
        }),
      delay,
    );
}

async function update() {
  if (closing || !latest || publishing) return;
  const files = latest;
  const version =
    files
      .filter((f) => f.path.endsWith('.cjs'))
      .map((f) => f.hash)
      .join('/') +
    ':' +
    resourceRevision;
  if (child) {
    if (version !== runningVersion && child.connected) child.send('athena:dev-reload', () => {});
    return;
  }
  publishing = true;
  try {
    // Publish a complete good build only after the old host has exited.
    for (const file of files) {
      const temporary = file.path + '.' + process.pid + '.tmp';
      await writeFile(temporary, file.contents);
      await rename(temporary, file.path);
    }
    if (closing || latest !== files) {
      schedule();
      return;
    }
    child = spawn(electron, ['.'], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, WORKBENCH_DEV_SERVER_URL: url },
    });
    runningVersion = version;
    waiting = false;
    console.log(`Athena dev host PID ${child.pid}`);
    child.on('message', (message) => {
      if (message !== 'athena:dev-busy') return;
      if (!waiting) console.log('Athena will reload when the current work is idle.');
      waiting = true;
      schedule(1000);
    });
    child.once('error', (error) => {
      console.error('Athena launch failed', error);
      void close(1);
    });
    child.once('exit', (code, signal) => {
      child = undefined;
      if (!closing && code === 75) schedule(0);
      else void close(code ?? (signal ? 1 : 0));
    });
  } finally {
    publishing = false;
  }
}

async function close(code) {
  closing = true;
  clearTimeout(timer);
  process.exitCode = code;
  await Promise.all([compiler?.dispose(), server.close()]);
}

for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    closing = true;
    clearTimeout(timer);
    if (child?.connected) child.send('athena:dev-stop', () => {});
    else if (child) child.kill('SIGTERM');
    else void close(0);
  });

server.watcher.add(resourceRoots.map((p) => p.slice(0, -1)));
server.watcher.on('all', (event, file) => {
  if (
    ['add', 'change', 'unlink'].includes(event) &&
    resourceRoots.some((p) => path.resolve(file).startsWith(p))
  ) {
    resourceRevision++;
    schedule();
  }
});
try {
  compiler = await watchMain((files) => {
    latest = files;
    schedule();
  });
  if (closing) await compiler.dispose();
} catch (error) {
  await close(1);
  throw error;
}
