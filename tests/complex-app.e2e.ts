/** Packaged app wiring, shared-control rejection, execution persistence and unknown-result status. */
import assert from 'node:assert/strict';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import { complexWorkflowFixture } from './complex-workflow-fixture';
import type { AppSnapshot, ChatMessage } from '../src/shared/types';
const root = process.cwd();
const directory = await mkdtemp(path.resolve('.runtime/complex-app-'));
await seedLegacyWorkspace(path.join(directory, 'data'));
const output = path.resolve('test-results/complex-agent/packaged');
await mkdir(output, { recursive: true });
const site = await complexWorkflowFixture();
let app: ElectronApplication | undefined;
let page!: Page;
const errors: string[] = [];
const start = async () => {
  app = await electron.launch({
    executablePath: path.resolve(
      'release/complex-agent/mac-arm64/Athena.app/Contents/MacOS/Athena',
    ),
    args: [],
    cwd: root,
    env: { ...process.env, WORKBENCH_USER_DATA_DIR: path.join(directory, 'data') },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.setBackgroundThrottling(false);
    w.hide();
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          async () => (await window.workbench.invoke<AppSnapshot>('app:snapshot')).web?.status,
        ),
      { timeout: 30000 },
    )
    .toBe('ready');
};
const invoke = <T = any>(action: string, payload?: unknown): Promise<T> =>
  page.evaluate(({ action, payload }) => window.workbench.invoke<T>(action, payload), {
    action,
    payload,
  });
const messages = () =>
  page.evaluate(async () =>
    (await window.workbench.invoke<AppSnapshot>('app:snapshot')).conversations
      .flatMap((c) => c.messages)
      .sort((a, b) => a.createdAt - b.createdAt),
  );
const waitResult = async (id: string) => {
  await expect
    .poll(async () => (await messages()).find((m) => m.id === id)?.status, { timeout: 180000 })
    .not.toBe('streaming');
  await expect
    .poll(async () => (await messages()).find((m) => m.id === id)?.execution?.at(-1)?.kind, {
      timeout: 10000,
    })
    .toBe('finished');
  return (await messages()).find((m) => m.id === id)!;
};
const send = async (text: string) => {
  await page.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect
    .poll(async () => (await messages()).filter((m) => m.role === 'assistant').at(-1)?.status)
    .toBe('streaming');
  return (await messages()).filter((m) => m.role === 'assistant').at(-1)!.id;
};
try {
  await start();
  await invoke('browser:navigate', { url: site.origin + '/policy' });
  await invoke('share:start', { address: '127.0.0.1', name: 'Local fixture host' });
  const rejectedConversation = await invoke('conversation:new');
  await invoke('conversation:send', { id: rejectedConversation.id, text: '读取当前页面。' });
  await expect
    .poll(async () => (await messages()).filter((m) => m.role === 'assistant').at(-1)?.status)
    .toBe('error');
  const rejected = (await messages()).filter((m) => m.role === 'assistant').at(-1)!;
  assert.match(rejected.text, /共享期间/);
  await invoke('share:stop');
  const fresh = await invoke('conversation:new');
  // Use the visible composer for a fresh conversation after the rejected start cleaned up.
  const normalId = await send(
    '请用 web_plan 记录一个读取国际配送规则的步骤；用 web_read 读取当前页，使用实际 observationId 和原文证据记录 web_checkpoint，再将计划更新为已完成。只做这些只读操作，最后简短报告规则。',
  );
  const normal = await waitResult(normalId);
  assert.equal(normal.status, 'done');
  assert(normal.plan?.some((s) => s.status === 'completed'));
  assert(normal.execution?.some((e) => e.kind === 'checkpoint' && e.status === 'succeeded'));
  assert(normal.execution?.some((e) => e.kind === 'plan'));
  assert(normal.tools?.every((t) => t.status === 'done'));
  await page.screenshot({ path: path.join(output, 'completed.png') });
  await invoke('conversation:new');
  const unknownId = await send(
    '这是等待失败状态的本地验收。只调用一次 web_wait，在当前页面等待文本 NEVER-APPEARS-7f33，timeout 为 50 毫秒。条件未匹配后不再调用任何工具，也不恢复，直接结束并说明条件未匹配。不要把任务说成成功。',
  );
  const unknown = await waitResult(unknownId);
  assert.equal(unknown.status, 'error', 'Host must not mark an unreconciled wait as done');
  assert(unknown.execution?.some((e) => e.kind === 'recovery' && e.status === 'blocked'));
  assert.match(unknown.text, /尚未核对/);
  await app!.close();
  app = undefined;
  const saved = JSON.parse(await readFile(path.join(directory, 'data/workspace.json'), 'utf8'));
  const savedMessages: ChatMessage[] = saved.conversations.flatMap((c: any) => c.messages);
  assert.deepEqual(
    savedMessages.find((m) => m.id === normalId)?.execution,
    JSON.parse(JSON.stringify(normal.execution)),
  );
  await start();
  const restarted = await messages();
  assert.deepEqual(
    restarted.find((m) => m.id === normalId)?.execution,
    JSON.parse(JSON.stringify(normal.execution)),
  );
  assert.equal(restarted.find((m) => m.id === unknownId)?.status, 'error');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'evidence.json'),
    JSON.stringify(
      {
        passed: true,
        packaged: true,
        realModelTurns: 2,
        sharedRejection: rejected,
        normal,
        unknown,
        restartPreserved: true,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      packaged: true,
      realModelTurns: 2,
      sharedRejection: true,
      planAndCheckpointsPersisted: true,
      unknownCompletionBlocked: true,
      restartPreserved: true,
    }),
  );
} finally {
  await app?.close();
  await site.close();
  await rm(directory, { recursive: true, force: true });
}
