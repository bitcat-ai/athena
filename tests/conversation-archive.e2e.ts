/** 会话归档与删除的宿主联调：真实 Electron、真实 IPC 与落盘，CLI 是本地脚本替身；不调用模型。
 * 先构建再运行：npm run build && npx tsx tests/conversation-archive.e2e.ts
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import type { AppSnapshot, Conversation } from '../src/shared/types';

const profile = await mkdtemp(path.join(tmpdir(), 'athena-conversation-archive-'));
const workspace = path.join(profile, 'workspace');
const bin = path.join(profile, 'bin');
const log = path.join(profile, 'calls');
await Promise.all([mkdir(workspace), mkdir(bin), writeFile(log, '')]);
// 替身 CLI：“hold” 任务一直执行到收到中断请求，其余任务立即完成；每个请求都记入日志。
const cli = path.join(bin, 'codex');
const script = path.join(bin, 'codex.cjs');
// Node 的安装路径可能带空格，不能直接写进 shebang，由 sh 转交。
await writeFile(cli, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
await writeFile(
  script,
  String.raw`
const fs = require('node:fs'), path = require('node:path');
const profile = process.env.WORKBENCH_USER_DATA_DIR;
if (process.argv.includes('--version')) {console.log('codex-fixture 1'); process.exit(0)}
if (process.argv.includes('status')) {console.error('Logged in using fixture'); process.exit(0)}
const send = (msg) => console.log(JSON.stringify(msg));
let thread = 'thread-' + process.pid, held;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line); const p=r.params || {};
 fs.appendFileSync(path.join(profile,'calls'),JSON.stringify({pid:process.pid,method:r.method,params:p})+'\n');
 const reply = result => send({id:r.id,result});
 const done = (turn,status) => send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status,items:[]}}});
 if(r.method==='initialize')return reply({userAgent:'fixture'});
 if(r.method==='thread/read')return reply({thread:{id:p.threadId,turns:[{id:'earlier-turn'}]}});
 if(r.method==='thread/resume')thread=p.threadId;
 if(['thread/resume','thread/start'].includes(r.method))return reply({thread:{id:thread}});
 if(r.method==='model/list')return reply({data:[{id:'fixture',model:'fixture'}],nextCursor:null});
 if(r.method==='turn/start') {
   const turn='turn-'+r.id;
   reply({turn:{id:turn,status:'inProgress'}});
   if(p.input[0].text==='hold')held=turn;else setTimeout(()=>done(turn,'completed'),5);
 }
 if(r.method==='turn/interrupt'){reply({});if(held)done(held,'interrupted');held=undefined}
});
`,
);
await chmod(cli, 0o700);
const conversation = (id: string, title: string, extra: Partial<Conversation> = {}) => ({
  id,
  title,
  updatedAt: 1,
  workspace,
  messages: [
    { id: `${id}-u`, role: 'user', text: '先前的任务', createdAt: 1, status: 'done' },
    { id: `${id}-a`, role: 'assistant', text: '先前的回答', createdAt: 1, status: 'done' },
  ],
  ...extra,
});
const saved = path.join(profile, 'workspace.json');
await writeFile(
  saved,
  JSON.stringify({
    settings: { agent: 'codex', workspace },
    onboarding: {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      browserDeferred: true,
      workspaceConfirmed: workspace,
    },
    recordings: [],
    conversations: [
      conversation('first-archived', '早先归档的对话', { archivedAt: 5 }),
      conversation('keep', '执行任务的对话'),
      conversation('shelve', '准备归档的对话'),
      conversation('remove', '准备删除的对话'),
      conversation('elsewhere', '其他目录的对话', { workspace: '/different-workspace' }),
    ],
  }),
);
const requests = async () =>
  (await readFile(log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const methods = async (name: string) => (await requests()).filter((r) => r.method === name);
/** 磁盘上保存的对话：编号 → 归档时间（未归档为 null）。 */
const onDisk = async () =>
  Object.fromEntries(
    (JSON.parse(await readFile(saved, 'utf8')).conversations as Conversation[]).map((item) => [
      item.id,
      item.archivedAt ?? null,
    ]),
  );
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: bin + path.delimiter + process.env.PATH,
  WORKBENCH_USER_DATA_DIR: profile,
};
delete env.WORKBENCH_DEV_SERVER_URL;
const launch = () =>
  electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
const checks: string[] = [];
const errors: string[] = [];
let application: ElectronApplication | undefined;
try {
  application = await launch();
  let page = await application.firstWindow({ timeout: 15000 });
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.message));
  const invoke = <T = any>(name: string, payload?: unknown) =>
    page.evaluate(({ name, payload }) => window.workbench.invoke<T>(name, payload), {
      name,
      payload,
    });
  const snapshot = () => invoke<AppSnapshot>('app:snapshot');
  const stored = async (id: string) => (await snapshot()).conversations.find((c) => c.id === id);
  const listed = async () =>
    (await page.locator('.conversation-list .conversation-link').allInnerTexts()).map((text) =>
      text.trim(),
    );
  const toast = page.locator('.app-toast');
  const menu = page.getByRole('menu', { name: /^对话操作：/ });
  const choose = async (title: string, item: string) => {
    await page.getByRole('button', { name: `对话操作：${title}`, exact: true }).click();
    await menu.getByRole('menuitem', { name: item, exact: true }).click();
  };
  const dialog = page.getByRole('alertdialog');
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务', exact: true });

  // 必须是替身 CLI：否则后面的任务会发给本机真实的 CLI。
  assert.equal((await snapshot()).agents.find((a) => a.id === 'codex')?.path, cli);
  await expect.poll(async () => (await snapshot()).codexConnection?.status).toBe('ready');
  assert.equal(
    (await snapshot()).codexConnection?.conversationId,
    'keep',
    'the archived conversation saved first is not opened or connected at startup',
  );
  assert.deepEqual(await listed(), ['执行任务的对话', '准备归档的对话', '准备删除的对话']);
  const before = await onDisk();
  assert.deepEqual(before, {
    'first-archived': 5,
    keep: null,
    shelve: null,
    remove: null,
    elsewhere: null,
  });
  checks.push('Startup skips the archived conversation and connects the first open one');

  await assert.rejects(
    invoke('conversation:archive', { conversationId: 'keep' }),
    /请求格式不正确/,
  );
  await assert.rejects(
    invoke('conversation:archive', { conversationId: 'missing', archived: true }),
    /找不到这个对话/,
  );
  await assert.rejects(
    invoke('conversation:delete', { conversationId: 'missing' }),
    /找不到这个对话/,
  );
  await assert.rejects(invoke('conversation:delete', {}), /文本格式或长度不正确/);
  assert.deepEqual(await onDisk(), before);
  checks.push('Malformed requests and unknown conversations are rejected and nothing is written');

  await composer.fill('hold');
  await composer.press('Enter');
  await expect.poll(async () => (await methods('turn/start')).length).toBe(1);
  const runner = (await methods('turn/start'))[0].pid as number;
  await expect.poll(async () => (await stored('keep'))?.messages.at(-1)?.status).toBe('streaming');
  await assert.rejects(
    invoke('conversation:archive', { conversationId: 'keep', archived: true }),
    /任务还在进行，请先停止或等待完成后再归档/,
  );
  await assert.rejects(
    invoke('conversation:delete', { conversationId: 'keep' }),
    /任务还在进行，请先停止或等待完成后再删除/,
  );
  await page.getByRole('button', { name: '对话操作：执行任务的对话', exact: true }).click();
  await expect(menu.getByRole('menuitem', { name: '归档对话', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(menu.getByRole('menuitem', { name: '删除对话', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  assert.equal((await stored('keep'))?.messages.at(-1)?.status, 'streaming');
  assert.equal((await stored('keep'))?.archivedAt, undefined);
  assert.equal((await methods('turn/interrupt')).length, 0, 'a refusal never stops the task');
  assert.ok(alive(runner));
  checks.push(
    'While its task runs a conversation cannot be archived or deleted, and the refusal leaves the task running',
  );

  await choose('准备归档的对话', '归档对话');
  await expect(toast).toContainText('已归档对话');
  assert.equal(typeof (await onDisk()).shelve, 'number');
  await choose('准备删除的对话', '删除对话');
  await expect(dialog).toContainText('准备删除的对话');
  assert.equal((await onDisk()).remove, null, 'nothing is deleted before confirming');
  await dialog.getByRole('button', { name: '删除对话', exact: true }).click();
  await expect(toast).toContainText('已删除对话');
  assert.equal('remove' in (await onDisk()), false);
  await assert.rejects(
    invoke('conversation:prepare', { conversationId: 'remove' }),
    /找不到这个对话/,
  );
  assert.equal((await stored('keep'))?.messages.at(-1)?.status, 'streaming');
  assert.equal((await methods('turn/interrupt')).length, 0);
  assert.ok(alive(runner));
  checks.push(
    'Other conversations can be archived and deleted meanwhile; both are saved to disk and the running task is untouched',
  );

  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect.poll(async () => (await methods('turn/interrupt')).length).toBe(1);
  await expect.poll(async () => (await stored('keep'))?.messages.at(-1)?.status).toBe('error');
  await choose('执行任务的对话', '归档对话');
  await expect(toast).toContainText('已归档对话');
  await expect(page.getByRole('heading', { name: '今天想完成什么？' })).toBeVisible();
  assert.equal(typeof (await onDisk()).keep, 'number');
  await expect.poll(async () => (await snapshot()).codexConnection?.status).toBe('idle');
  await expect.poll(() => alive(runner)).toBe(false);
  checks.push(
    'The real stop control ends the task; the conversation can then be archived, which releases its CLI connection',
  );

  const turns = (await methods('turn/start')).length;
  await assert.rejects(invoke('conversation:prepare', { conversationId: 'keep' }), /已归档/);
  assert.equal(
    (await snapshot()).codexConnection?.status,
    'idle',
    'a refused connection attempt is not reported as a failed connection',
  );
  await assert.rejects(invoke('conversation:send', { id: 'keep', text: 'again' }), /已归档/);
  assert.equal((await methods('turn/start')).length, turns);
  assert.equal((await stored('keep'))?.messages.length, 4, 'a refused send adds no message');
  checks.push('An archived conversation cannot be connected or sent to');

  await page.getByRole('button', { name: '已归档', exact: true }).click();
  assert.deepEqual(
    (await listed()).sort(),
    ['准备归档的对话', '执行任务的对话', '早先归档的对话'].sort(),
  );
  await page
    .locator('.conversation-row', { hasText: '执行任务的对话' })
    .locator('.conversation-link')
    .click();
  await page
    .locator('.archived-notice')
    .getByRole('button', { name: '恢复对话', exact: true })
    .click();
  await expect(toast).toContainText('已恢复对话');
  assert.equal((await onDisk()).keep, null);
  await expect
    .poll(async () => (await snapshot()).codexConnection)
    .toMatchObject({ status: 'ready', conversationId: 'keep' });
  assert.deepEqual(await listed(), ['执行任务的对话']);
  checks.push('Restoring makes the conversation usable again and reconnects its CLI session');

  const closing = await onDisk();
  assert.deepEqual(Object.keys(closing).sort(), ['elsewhere', 'first-archived', 'keep', 'shelve']);
  await application.close();
  application = await launch();
  page = await application.firstWindow({ timeout: 15000 });
  page.setDefaultTimeout(8000);
  page.on('pageerror', (error) => errors.push(error.message));
  await expect
    .poll(async () => (await snapshot()).codexConnection)
    .toMatchObject({ status: 'ready', conversationId: 'keep' });
  assert.deepEqual(
    Object.fromEntries(
      (await snapshot()).conversations.map((item) => [item.id, item.archivedAt ?? null]),
    ),
    closing,
  );
  assert.deepEqual(await listed(), ['执行任务的对话']);
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  assert.deepEqual((await listed()).sort(), ['准备归档的对话', '早先归档的对话'].sort());
  checks.push('After a restart the archived and deleted conversations stay archived and deleted');

  const sent = [...new Set((await requests()).map((r) => r.method as string))];
  assert.deepEqual(
    sent.filter((method) => /archive|delete|remove/i.test(method)),
    [],
    'archiving and deleting in Athena never ask the CLI to change its own history',
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, realModelCalls: 0, cliRequests: sent, checks }));
} finally {
  await application?.close();
  await rm(profile, { recursive: true, force: true });
}
