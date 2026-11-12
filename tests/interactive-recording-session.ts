/** A recording session controlled interactively through the real renderer, one user turn at a time. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from '@playwright/test';
import { startCustomerRuntime } from './customer-export-runtime';
import { startRepositoryRegistry } from './customer-export-registry';
import { fixtureLarkCli } from './frontend-build-fixture';

const root = process.cwd(),
  exec = promisify(execFile);
const source = path.resolve(
  process.env.ATHENA_CUSTOMER_SOURCE ?? '.runtime/customer-export-demo/repo',
);
const handbook = await readFile(path.join(source, 'docs/customer-handbook.md'), 'utf8');
const directory = await mkdtemp(path.join(root, '.runtime/interactive-recording/run-'));
const profile = path.join(directory, 'profile'),
  workspace = path.join(directory, 'workspace'),
  bin = path.join(directory, 'bin');
const output = path.join(root, 'output/interactive-workflow-' + path.basename(directory));
for (const folder of [profile, workspace, bin, output, path.join(output, 'raw-video')])
  await mkdir(folder, { recursive: true });
await writeFile(
  path.join(root, '.runtime/interactive-recording/current.json'),
  JSON.stringify({ directory, output }, null, 2),
);
const baseline = await startCustomerRuntime(source, path.join(directory, 'baseline'), 'baseline');
const registry = await startRepositoryRegistry(
  path.join(directory, 'registry'),
  source,
  baseline.frontendUrl,
);
const wiki = 'https://fixture.feishu.cn/wiki/CustomerGuide';
const fixture = path.join(directory, 'knowledge.json');
await writeFile(
  fixture,
  JSON.stringify({
    CustomerGuide: {
      title: 'Meridian 业务知识库（示例）',
      content:
        '这是本次演示的示例知识库。\n[客户工作台操作手册](https://fixture.feishu.cn/docx/CustomerHandbook)\n[开发环境约定](https://fixture.feishu.cn/docx/DevelopmentGuide)\n[供应商操作手册](https://fixture.feishu.cn/docx/SupplierHandbook)',
    },
    CustomerHandbook: {
      title: 'Meridian 客户工作台操作手册',
      content: handbook + '\n当前网站：' + baseline.frontendUrl,
    },
    DevelopmentGuide: {
      title: 'Meridian 开发环境约定',
      content:
        '前端使用 React/Vite/Node，源码目录 frontend；后端使用 Java21/Maven，目录 backend。前后端使用独立沙箱 target=frontend/backend。npm ci && npm run build；mvn -B -Dmaven.repo.local=/workspace/.m2 test package。首次安装依赖可使用较长命令时限。服务监听 0.0.0.0:$PORT，后端健康路径 /api/health。保持现有页面风格。用户确认后才能提交到测试分支；不合并 main、不发布生产。',
    },
    SupplierHandbook: {
      title: '供应商操作手册',
      content: '供应商模块为 suppliers，编号 S 开头。这份手册不适用于客户工作台。',
    },
  }),
);
await writeFile(path.join(bin, 'package.json'), '{"type":"commonjs"}');
await writeFile(path.join(bin, 'lark-cli'), fixtureLarkCli(process.execPath, fixture), {
  mode: 0o700,
});
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: {
      agent: 'claude',
      workspace,
      knowledgeRoot: wiki,
      modelSelections: { claude: { model: 'sonnet' } },
    },
    conversations: [
      {
        id: 'interactive-flow',
        title: '客户续约材料核对',
        agent: 'claude',
        workspace,
        messages: [],
        updatedAt: Date.now(),
      },
    ],
    recordings: [],
    onboarding: {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      workspaceConfirmed: workspace,
      browserDeferred: true,
    },
  }),
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: bin + path.delimiter + process.env.PATH,
  WORKBENCH_USER_DATA_DIR: profile,

  ATHENA_REPOSITORY_MCP_URL: registry.endpoint,
  ATHENA_REPOSITORY_MCP_TOKEN: registry.token,
};
delete env.WORKBENCH_DEV_SERVER_URL;
const startedAt = Date.now();
const app = await electron.launch({
  args: [path.join(root, 'tests/electron-background.cjs')],
  cwd: root,
  env: Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  ),
  recordVideo: { dir: path.join(output, 'raw-video'), size: { width: 1920, height: 1080 } },
});
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1920, 1080));
await page.evaluate('window.__name = fn => fn');
// Screen recording aid follows real renderer pointer events; it does not generate actions.
await page.evaluate(() => {
  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.dataset.recordingPointer = 'true';
  layer.style.cssText =
    'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:24px;height:32px;display:none;filter:drop-shadow(0 1px 2px #0005)';
  layer.innerHTML =
    '<svg viewBox="0 0 24 32" width="24" height="32"><path d="M3 2L3 25L9 20L14 30L18 28L13 18L21 17Z" fill="#18181b" stroke="white" stroke-width="1.8" stroke-linejoin="round"/></svg>';
  document.body.append(layer);
  const ring = document.createElement('div');
  ring.style.cssText =
    'position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;width:34px;height:34px;border:2px solid #17171766;border-radius:50%;display:none';
  document.body.append(ring);
  const events: Array<{ at: number; type: string; x: number; y: number; label: string }> = [];
  (window as any).__recordedPointerEvents = events;
  const record = (event: PointerEvent) => {
    events.push({
      at: Date.now(),
      type: event.type,
      x: event.clientX,
      y: event.clientY,
      label: (event.target as HTMLElement)?.getAttribute?.('aria-label') ?? '',
    });
    if (events.length > 15000) events.splice(0, 1000);
  };
  document.addEventListener(
    'pointermove',
    (event) => {
      layer.style.display = 'block';
      layer.style.transform = `translate(${event.clientX}px,${event.clientY}px)`;
      record(event);
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    (event) => {
      record(event);
      ring.style.display = 'block';
      ring.style.left = event.clientX - 17 + 'px';
      ring.style.top = event.clientY - 17 + 'px';
      ring.getAnimations().forEach((a) => a.cancel());
      ring.animate(
        [
          { transform: 'scale(.6)', opacity: 1 },
          { transform: 'scale(1.4)', opacity: 0 },
        ],
        { duration: 450, fill: 'forwards' },
      );
    },
    true,
  );
  document.addEventListener('pointerup', record, true);
});
let endpoint = '';
const listeners = (
  await exec('lsof', ['-nP', '-a', '-p', String(app.process().pid), '-iTCP', '-sTCP:LISTEN'])
).stdout;
for (const match of listeners.matchAll(/127\.0\.0\.1:(\d+)/g))
  try {
    const url = 'http://127.0.0.1:' + match[1];
    const data = await (
      await fetch(url + '/json/version', { signal: AbortSignal.timeout(1000) })
    ).json();
    if (data.Browser?.startsWith('Chrome/') && data.webSocketDebuggerUrl) {
      endpoint = url;
      break;
    }
  } catch {}
assert.ok(endpoint, 'Electron control endpoint missing');
const session = {
  directory,
  output,
  profile,
  workspace,
  endpoint,
  baselineUrl: baseline.frontendUrl,
  wiki,
  baseCommit: registry.base,
  source,
  startedAt,
  pid: app.process().pid,
};
await writeFile(path.join(directory, 'session.json'), JSON.stringify(session, null, 2));
await writeFile(
  path.join(root, '.runtime/interactive-recording/current.json'),
  JSON.stringify(session, null, 2),
);
console.log('READY', JSON.stringify(session));
let last = '';
try {
  for (;;) {
    const finish = await readFile(path.join(directory, 'finish.json'), 'utf8').catch(
      () => undefined,
    );
    if (finish) break;
    const state = await page.evaluate(() => window.workbench.invoke<any>('app:snapshot'));
    const message = state.conversations
      .find((c: any) => c.id === 'interactive-flow')
      ?.messages.filter((m: any) => m.role === 'assistant')
      .at(-1);
    const status = JSON.stringify({
      id: message?.id,
      status: message?.status,
      tool: message?.tools?.at(-1)?.name,
      toolStatus: message?.tools?.at(-1)?.status,
    });
    if (status !== last) {
      console.log(status);
      last = status;
    }
    await writeFile(path.join(directory, 'snapshot.json'), JSON.stringify(state, null, 2));
    await writeFile(
      path.join(output, 'registry-audit.json'),
      JSON.stringify(registry.audit, null, 2),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
} finally {
  const snapshot = await page
    .evaluate(() => window.workbench.invoke<any>('app:snapshot'))
    .catch(() => undefined);
  const pointerEvents = await page
    .evaluate(() => (window as any).__recordedPointerEvents)
    .catch(() => []);
  await writeFile(path.join(output, 'app-snapshot.json'), JSON.stringify(snapshot, null, 2));
  await writeFile(path.join(output, 'pointer-events.json'), JSON.stringify(pointerEvents));
  const video = page.video();
  await app.close();
  registry.close();
  await baseline.close();
  await writeFile(
    path.join(output, 'recording.json'),
    JSON.stringify(
      {
        ...session,
        finishedAt: Date.now(),
        rawVideo: video ? await video.path() : undefined,
        publication: registry.published,
      },
      null,
      2,
    ),
  );
  console.log('RECORDING SAVED', output);
}
