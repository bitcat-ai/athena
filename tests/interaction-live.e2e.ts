/** Real Codex + web executor coexistence on a local page; uses existing login and a small model quota. */
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import { CdpConnection } from '../src/main/browser-cdp';
import type { AppSnapshot, ChatMessage } from '../src/shared/types';
import type { ModelOption, UsageSnapshot } from '../src/shared/usage';

const root = process.cwd();
const dir = await mkdtemp(path.resolve('.runtime/interaction-live-'));
await seedLegacyWorkspace(dir);
const out = process.env.ATHENA_LIVE_OUTPUT || 'test-results/interaction-refinement/live';
await mkdir(out, { recursive: true });
let released = false;
const site = createServer((request, response) => {
  if (request.url === '/state') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ready: released }));
    return;
  }
  response.setHeader('content-type', 'text/html;charset=utf-8');
  response.end(
    `<!doctype html><meta charset="utf-8"><title>资料核对</title><style>body{margin:0;min-height:6000px;font:16px system-ui;background:linear-gradient(#fff,#eef0f8)}button{position:fixed;top:24px;left:24px}main{padding:90px 24px}input{width:260px}section{position:fixed;top:140px;left:24px;background:white;padding:16px}</style><button id="view" onclick="this.textContent='已查看 '+(++window.clicks)">查看说明</button><main><h1>资料核对</h1><section><p id="status">资料准备中</p><label>核对结果 <input id="result" aria-label="核对结果"></label></section></main><script>window.clicks=0;setInterval(async()=>{const s=await(await fetch('/state')).json();if(s.ready)document.querySelector('#status').textContent='资料已就绪'},100)</script>`,
  );
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
let native: CdpConnection | undefined;
const evidence: Record<string, any> = { checks: [], localOnly: true, modelFixture: false };
try {
  const binary = process.env.ATHENA_APP_EXECUTABLE;
  app = await electron.launch({
    ...(binary ? { executablePath: binary } : {}),
    args: binary ? [] : ['.'],
    cwd: root,
    env: {
      ...process.env,
      WORKBENCH_USER_DATA_DIR: dir,
    },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const invoke = <T = any>(action: string, payload?: unknown) =>
    page.evaluate(({ action, payload }) => window.workbench.invoke<T>(action, payload), {
      action,
      payload,
    });
  const snapshot = () => invoke<AppSnapshot>('app:snapshot');
  const started = Date.now();
  await expect
    .poll(async () => (await snapshot()).codexConnection?.status, { timeout: 60000 })
    .toBe('ready');
  evidence.preSend = {
    elapsedMs: Date.now() - started,
    connection: (await snapshot()).codexConnection,
    sessions: (await snapshot()).conversations.map((c) => ({
      id: c.id,
      sessionId: c.agentSessionId,
      messages: c.messages.length,
    })),
  };
  assert(
    evidence.preSend.sessions.some((s: any) => s.sessionId && s.messages === 0),
    'Real CLI thread must exist before first send',
  );
  // Count future worker spawns only; do not inspect credentials or raw CLI messages.
  await app.evaluate(() => {
    const cp = process.getBuiltinModule('child_process');
    const original = cp.spawn;
    (globalThis as any).__newCodexWorkers = 0;
    cp.spawn = function (command: any, args: any, ...rest: any[]) {
      if (Array.isArray(args) && args[0] === 'app-server') (globalThis as any).__newCodexWorkers++;
      return Reflect.apply(original, cp, [command, args, ...rest]);
    } as typeof cp.spawn;
  });
  const catalog = await invoke<ModelOption[]>('models:list', { refresh: true });
  const model =
    catalog.find((m) => m.model === 'gpt-6.1-sol') ??
    catalog.find((m) => m.isDefault) ??
    catalog[0];
  assert(model);
  await invoke('settings:model', {
    model: model.model,
    effort: model.efforts.find((e) => e.id === 'low')?.id ?? model.defaultEffort,
  });
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await invoke('browser:navigate', { url });
  await expect(page.locator('.frame-loading')).toHaveCount(0, { timeout: 10000 });
  const [port] = (
    await readFile(path.join(dir, 'browser/agent-browser-profile/DevToolsActivePort'), 'utf8')
  ).split('\n');
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
  native = await CdpConnection.connect(targets.find((t) => t.url === url).webSocketDebuggerUrl);
  const read = async (expression: string) =>
    (await native!.call('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const latest = async (): Promise<ChatMessage> =>
    (await snapshot()).conversations
      .flatMap((c) => c.messages)
      .filter((m) => m.role === 'assistant')
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1)!;
  const prompt =
    '这是本地协作验收。先用 web_plan 记录读取资料、等待就绪、填写并核对三步。读取当前资料核对页面后，必须调用一次 web_wait 等待文本“资料已就绪”，timeout 20000 毫秒。我会在等待时滚动和点击页面；这不表示停止任务。若工具因人工操作提示旧观察失效，重新用 web_read/snapshot 读取并继续等待，勿放弃任务。资料就绪后，在“核对结果”输入框填写“协作继续通过”，再次读取，以实际原文和 observationId 写 web_checkpoint，并完成计划。仅使用 web_*，不用脚本或命令，不访问外站。';
  await page.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill(prompt);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await latest())?.tools?.some((t) => t.name === 'web_wait' && t.status === 'running'),
      { timeout: 120000 },
    )
    .toBe(true);
  const box = await page.locator('.browser-surface').boundingBox();
  assert(box);
  const interactionStart = Date.now();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7);
  await page.mouse.wheel(0, 140);
  await expect.poll(() => read('scrollY'), { timeout: 1000 }).toBeGreaterThan(100);
  await page.mouse.click(box.x + 52, box.y + 35);
  await expect.poll(() => read('window.clicks'), { timeout: 1000 }).toBe(1);
  assert.equal((await latest()).status, 'streaming');
  evidence.interaction = {
    elapsedMs: Date.now() - interactionStart,
    scrollY: await read('scrollY'),
    clicks: await read('window.clicks'),
    taskStatus: (await latest()).status,
  };
  released = true;
  await expect.poll(async () => (await latest()).status, { timeout: 180000 }).not.toBe('streaming');
  evidence.firstTurn = await latest();
  assert.equal(evidence.firstTurn.status, 'done', evidence.firstTurn.failure);
  assert.equal(await read('document.querySelector("#result").value'), '协作继续通过');
  assert(
    evidence.firstTurn.tools.filter((t: any) => ['web_read', 'web_snapshot'].includes(t.name))
      .length >= 2,
  );
  assert(
    evidence.firstTurn.execution?.some(
      (e: any) => e.kind === 'checkpoint' && e.status === 'succeeded',
    ),
  );
  evidence.checks.push(
    'Human wheel/click during a real model wait promptly reach the page; AI re-observes and finishes the requested edit',
  );
  await page.screenshot({ path: path.join(out, 'coexistence.png'), animations: 'disabled' });
  const firstId = evidence.firstTurn.id;
  await page
    .getByRole('textbox', { name: '发送给 Agent 的任务' })
    .fill('只回答：连接复用确认。不调用工具。');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(async () => (await latest()).id).not.toBe(firstId);
  await expect.poll(async () => (await latest()).status, { timeout: 120000 }).not.toBe('streaming');
  assert.equal((await latest()).status, 'done');
  evidence.newWorkersAfterReady = await app.evaluate(() => (globalThis as any).__newCodexWorkers);
  assert.equal(
    evidence.newWorkersAfterReady,
    0,
    'Model refresh and consecutive turns must reuse the initialized worker',
  );
  evidence.checks.push(
    'Real CLI initializes before first send; model refresh and two turns do not spawn another worker',
  );
  evidence.usage = await invoke<UsageSnapshot>('usage:snapshot');
  await page.getByRole('button', { name: '用量', exact: true }).click();
  await expect(page.getByTestId('usage-estimate')).not.toHaveText('暂无估算');
  await expect(page.getByText('API 等价估算', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: path.join(out, 'real-usage.png'), animations: 'disabled' });
  evidence.checks.push('Real returned token usage produces a labeled USD API-equivalent estimate');
  assert.deepEqual(errors, []);
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  if (app) {
    const page = await app.firstWindow();
    evidence.final = await page
      .evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'))
      .catch(() => undefined);
    await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  await writeFile(path.join(out, 'verification.json'), JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({ passed: evidence.passed, checks: evidence.checks, error: evidence.error }),
  );
  native?.close();
  await app?.close();
  await new Promise<void>((resolve) => site.close(() => resolve()));
  if (evidence.passed) await rm(dir, { recursive: true, force: true });
}
