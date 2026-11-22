// Build first. Two real Electron hosts share only this test's temporary Chrome profile.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';
import { CdpConnection } from '../src/main/browser-cdp';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import { until } from './web-fixture';

const electron: string = createRequire(import.meta.url)('electron');
const directory = await mkdtemp(path.join(tmpdir(), 'athena-dev-browser-handoff-'));
const profile = path.join(directory, 'browser', 'agent-browser-profile');
const reports = new Map<string, URLSearchParams>();
const server = createServer((request, response) => {
  const url = new URL(request.url!, 'http://fixture');
  if (url.pathname === '/report') {
    reports.set(url.searchParams.get('host')!, url.searchParams);
    response.writeHead(204).end();
    return;
  }
  // Report through the same preload IPC and browser bridge as the normal desktop renderer.
  response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><script>
    const host = location.pathname.slice(1);
    let reported = false;
    async function report(browser) {
      if (reported || !['ready', 'error'].includes(browser.status)) return;
      reported = true;
      const fields = new URLSearchParams({host, status: browser.status, tab: browser.activeTabId || '', url: browser.url, error: browser.error || ''});
      if (host === 'second' && browser.status === 'ready') {
        try {
          const query = await window.workbench.invoke('browser:query', {selector:'#pending-draft'});
          fields.set('draft', query.elements[0]?.value || '');
        } catch (error) { fields.set('error', String(error)); }
      }
      await fetch('/report?' + fields);
    }
    window.workbench.onEvent(event => { if (event.type === 'browser:state') void report(event.state); });
    window.workbench.invoke('app:snapshot').then(s => report(s.browser));
  </script>`);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const origin = 'http://127.0.0.1:' + address.port;
let child: ChildProcess | undefined;
let exit: Promise<unknown[]> | undefined;
let page: CdpConnection | undefined;
let occupied: Server | undefined;

async function launch(host: string) {
  child = spawn(electron, ['tests/electron-background.cjs'], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: {
      ...process.env,
      WORKBENCH_USER_DATA_DIR: directory,
      WORKBENCH_DEV_SERVER_URL: origin + '/' + host,
    },
  });
  exit = once(child, 'exit');
  await until(() => reports.has(host) || child?.exitCode != null, 'renderer browser status', 30000);
  const report = reports.get(host);
  assert.equal(report?.get('status'), 'ready', report?.get('error') || 'host did not report ready');
  return report!;
}
async function stop(command: string, code: number) {
  child!.send(command);
  await until(() => child!.exitCode !== null || child!.signalCode !== null, 'host exit', 15000);
  assert.deepEqual(await exit, [code, null]);
}
const lockPid = async () =>
  Number((await readlink(path.join(profile, 'SingletonLock'))).split('-').at(-1));

try {
  await seedLegacyWorkspace(directory);
  const first = await launch('first');
  const pid = await lockPid();
  const port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  page = await CdpConnection.connect(
    targets.find((t: { id: string }) => t.id === first.get('tab')).webSocketDebuggerUrl,
  );
  await page.call('Runtime.evaluate', {
    expression:
      "const draft = document.body.appendChild(document.createElement('textarea')); draft.id = 'pending-draft'; draft.value = 'written, still unsaved';",
  });
  await stop('athena:dev-reload', 75);
  const second = await launch('second');
  assert.equal(await lockPid(), pid);
  assert.equal(second.get('tab'), first.get('tab'));
  const welcome = new URL(first.get('url')!);
  assert.equal(second.get('url'), welcome.href);
  for (const [route, file] of [
    ['/', 'demo.html'],
    ['/portrait.webp', 'athena-portrait.webp'],
  ]) {
    const served = await fetch(new URL(route, welcome));
    assert.equal(served.status, 200);
    assert.deepEqual(
      Buffer.from(await served.arrayBuffer()),
      await readFile(path.join('resources', file)),
    );
  }
  assert.equal(
    second.get('draft'),
    'written, still unsaved',
    second.get('error') || 'draft feedback was lost',
  );
  await stop('athena:dev-stop', 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

  occupied = createServer((_request, response) => response.end('another local service'));
  await new Promise<void>((resolve, reject) => {
    occupied!.once('error', reject);
    occupied!.listen(Number(welcome.port), '127.0.0.1', resolve);
  });
  const third = await launch('third');
  assert.notEqual(third.get('url'), welcome.href);
  assert.equal(await (await fetch(welcome)).text(), 'another local service');
  assert.deepEqual(
    Buffer.from(await (await fetch(third.get('url')!)).arrayBuffer()),
    await readFile('resources/demo.html'),
  );
  await stop('athena:dev-stop', 0);
  console.log(
    'Hot reload preserved the Chrome process, tab, draft and welcome assets. Normal quit released Chrome. A busy welcome port fell back safely.',
  );
} finally {
  page?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    if (child.connected) child.send('athena:dev-stop');
    await Promise.race([exit, wait(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  // A failed adoption can leave the test's detached browser alive after both hosts exit.
  try {
    const [port, target] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8'))
      .trim()
      .split('\n');
    const browser = await CdpConnection.connect('ws://127.0.0.1:' + port + target);
    try {
      await browser.call('Browser.close');
    } finally {
      browser.close();
    }
  } catch {}
  occupied?.closeAllConnections();
  if (occupied?.listening) await new Promise<void>((resolve) => occupied!.close(() => resolve()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}
