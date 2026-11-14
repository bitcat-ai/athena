/** Isolated renderer → IPC → fake app-server test of the message queue. No model, Feishu or user
 * credentials are used.
 * Run after npm run build: npx tsx tests/message-queue.e2e.ts
 */
import assert from 'node:assert/strict';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import type { AppSnapshot } from '../src/shared/types';

const root = process.cwd();
await access(path.join(root, 'dist/main/main.cjs'));
await mkdir(path.join(root, '.runtime'), { recursive: true });
await mkdir(path.join(root, 'test-results'), { recursive: true });
const temporary = await mkdtemp(path.join(root, '.runtime/message-queue-test-'));
const bin = path.join(temporary, 'bin');
const dataDir = path.join(temporary, 'user-data');
await seedLegacyWorkspace(dataDir);
const protocolLog = path.join(temporary, 'protocol.jsonl');
const release = path.join(temporary, 'release-turn');
await mkdir(bin, { recursive: true });
await writeFile(protocolLog, '');

// A turn whose prompt starts with "hold" runs until the test releases it; any other answers at once.
const fakeCodex = path.join(bin, 'codex');
await writeFile(
  fakeCodex,
  `#!${process.execPath}\n` +
    String.raw`
import fs from 'node:fs';
import readline from 'node:readline';

const log = process.env.WORKBENCH_QUEUE_LOG;
const control = process.env.WORKBENCH_QUEUE_RELEASE;
const record = value => fs.appendFileSync(log, JSON.stringify(value) + '\n');
if (process.argv.includes('--version')) { console.log('codex-cli queue-fixture'); process.exit(0); }
if (process.argv[2] === 'login' && process.argv[3] === 'status') {
  console.error('Logged in using isolated test fixture'); process.exit(0);
}
if (process.argv[2] !== 'app-server') process.exit(2);

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => send({ method, params });
let threads = 0;
let turns = 0;
let running;
let poll;

function finish(turn, text, status = 'completed') {
  clearInterval(poll);
  if (running === turn) running = undefined;
  const { threadId, id: turnId } = turn;
  event('item/agentMessage/delta', { threadId, turnId, itemId: 'answer-' + turnId, delta: text });
  event('item/completed', { threadId, turnId, item: { id: 'answer-' + turnId, type: 'agentMessage', text } });
  event('turn/completed', { threadId, turnId, turn: { id: turnId, status, items: [] } });
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const params = request.params || {};
  if (request.method === 'initialize') return send({ id: request.id, result: { userAgent: 'queue-fake-codex' } });
  if (request.method === 'thread/start')
    return send({ id: request.id, result: { thread: { id: 'queue-thread-' + process.pid + '-' + (++threads) } } });
  if (request.method === 'thread/resume')
    return send({ id: request.id, result: { thread: { id: params.threadId } } });
  if (request.method === 'turn/start') {
    const prompt = params.input[0].text.split('\n')[0];
    const turn = { id: 'queue-turn-' + process.pid + '-' + (++turns), threadId: params.threadId, prompt };
    running = turn;
    record({ event: 'turn', prompt, threadId: turn.threadId });
    send({ id: request.id, result: { turn: { id: turn.id, status: 'inProgress' } } });
    event('turn/started', { threadId: turn.threadId, turnId: turn.id, turn: { id: turn.id, status: 'inProgress' } });
    if (!prompt.startsWith('hold')) return setTimeout(() => finish(turn, '已完成：' + prompt), 150);
    poll = setInterval(() => {
      if (!fs.existsSync(control)) return;
      fs.unlinkSync(control);
      finish(turn, '已完成：' + prompt);
    }, 20);
    return;
  }
  if (request.method === 'turn/interrupt') {
    record({ event: 'interrupt', prompt: running?.prompt });
    send({ id: request.id, result: {} });
    if (running) finish(running, '任务已停止', 'interrupted');
    return;
  }
  // Anything else, such as Skill discovery, is refused at once instead of left to time out.
  if (request.method && request.id !== undefined)
    send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
}).on('close', () => { clearInterval(poll); process.exit(0); });
`,
);
await chmod(fakeCodex, 0o700);
for (const name of ['claude', 'opencode', 'gemini']) {
  const executable = path.join(bin, name);
  await writeFile(
    executable,
    `#!${process.execPath}\nconsole.log('${name} isolated queue fixture');\n`,
  );
  await chmod(executable, 0o700);
}

const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
  WORKBENCH_USER_DATA_DIR: dataDir,
  WORKBENCH_QUEUE_LOG: protocolLog,
  WORKBENCH_QUEUE_RELEASE: release,
};
for (const key of [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'WORKBENCH_DEV_SERVER_URL',
])
  delete env[key];

// A hidden run must not take the keyboard from whoever is working on this Mac: the window is
// never activated, where hiding it after the fact would leave the application in front.
const hidden = process.env.WORKBENCH_HIDE_TEST_WINDOW === '1';
const quiet = path.join(temporary, 'quiet-window.cjs');
await writeFile(
  quiet,
  String.raw`
const { BrowserWindow } = require('electron');
const { showInactive, hide } = BrowserWindow.prototype;
BrowserWindow.prototype.show = function () {
  this.webContents.setBackgroundThrottling(false);
  showInactive.call(this);
  hide.call(this);
};
BrowserWindow.prototype.focus = function () {};
`,
);

let application: ElectronApplication | undefined;
const errors: string[] = [];
const checks: string[] = [];
try {
  application = await electron.launch({
    args: hidden ? ['-r', quiet, '.'] : ['.'],
    cwd: root,
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByRole('heading', { name: '今天想完成什么？' })).toBeVisible();
  const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
  const initial = await snapshot();
  assert.equal(initial.agents.find((item) => item.id === 'codex')?.path, fakeCodex);
  assert.equal(initial.feishu.paired, false);
  assert.deepEqual(initial.queue, { items: [], paused: [] });

  // The two entries are named for what they open, in the sidebar and in the user menu.
  await expect(page.getByRole('button', { name: '用量', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '本机用户菜单' }).click();
  await expect(page.getByRole('menuitem', { name: '用量', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '设置', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('设置与连接')).toHaveCount(0);
  checks.push('The sidebar and the user menu offer 用量 and 设置');

  const field = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  const composer = page.locator('.composer');
  const sendButton = composer.locator('[data-slot="prompt-input-send"]');
  const card = page.getByRole('group', { name: '排队的消息' });
  const rows = card.locator('[data-slot="prompt-input-queue-item"]');
  const turns = async () =>
    (await readFile(protocolLog, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; prompt?: string })
      .filter((entry) => entry.event === 'turn')
      .map((entry) => entry.prompt);
  const queued = async () => (await snapshot()).queue?.items.map((item) => item.text);
  const streaming = async () =>
    (await snapshot()).conversations.filter((item) =>
      item.messages.some((message) => message.status === 'streaming'),
    ).length;

  await field.fill('hold 第一条');
  await expect(sendButton).toHaveAttribute('aria-label', '发送任务');
  await sendButton.click();
  await expect.poll(streaming, { timeout: 20_000 }).toBe(1);
  await expect.poll(turns).toEqual(['hold 第一条']);
  // With nothing typed the one button stops the task, as before.
  await expect(sendButton).toHaveAttribute('aria-label', '停止任务');
  await expect(composer.getByRole('button', { name: '停止任务', exact: true })).toHaveCount(1);
  await expect(card).toHaveCount(0);

  await field.fill('第二条：接着做');
  await expect(sendButton).toHaveAttribute('aria-label', '加入队列');
  const stopButton = composer.locator('.composer-stop');
  await expect(stopButton).toBeVisible();
  await expect(stopButton).toHaveAttribute('aria-label', '停止任务');
  const [stopBox, sendBox] = [await stopButton.boundingBox(), await sendButton.boundingBox()];
  assert.ok(stopBox && sendBox);
  assert.ok(Math.abs(stopBox.height - sendBox.height) <= 1, 'stop and send share one height');
  assert.ok(
    Math.abs(stopBox.y + stopBox.height / 2 - (sendBox.y + sendBox.height / 2)) <= 1,
    'stop and send share one centre line',
  );
  assert.ok(stopBox.x + stopBox.width <= sendBox.x, 'stop sits left of send without overlap');
  await field.press('Enter');
  await expect(rows).toHaveCount(1);
  await expect(field).toHaveText('');
  await field.fill('第三条');
  await sendButton.click();
  await field.fill('第四条');
  await field.press('Enter');
  await expect(rows).toHaveCount(3);
  assert.deepEqual(await queued(), ['第二条：接着做', '第三条', '第四条']);
  assert.deepEqual(await turns(), ['hold 第一条'], 'nothing is sent while the first turn runs');
  await expect(card.getByRole('status')).toContainText('3 条消息排队中');
  checks.push(
    'Enter and the send button queue messages while a turn runs; stop stays one press away',
  );

  // The card sits above the field, as wide as it, and nothing spills sideways.
  const shell = composer.locator('[data-slot="prompt-input-shell"]');
  const [cardBox, shellBox] = [await card.boundingBox(), await shell.boundingBox()];
  assert.ok(cardBox && shellBox);
  assert.ok(Math.abs(cardBox.x - shellBox.x) <= 1 && Math.abs(cardBox.width - shellBox.width) <= 1);
  assert.ok(cardBox.y + cardBox.height <= shellBox.y, 'the queue sits above the field');
  for (const row of await rows.all()) {
    const [edit, remove] = [
      await row.getByRole('button', { name: '取回编辑' }).boundingBox(),
      await row.getByRole('button', { name: '移出队列' }).boundingBox(),
    ];
    assert.ok(edit && remove);
    assert.ok(Math.abs(edit.height - remove.height) <= 1 && Math.abs(edit.y - remove.y) <= 1);
    assert.ok(remove.x + remove.width <= cardBox.x + cardBox.width, 'actions stay inside the card');
  }
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
    false,
  );
  await page.screenshot({
    path: path.join(root, 'test-results/message-queue.png'),
    animations: 'disabled',
  });

  // A queued message comes back into the field only when the field is free.
  await field.fill('正在写的草稿');
  await rows.nth(1).getByRole('button', { name: '取回编辑' }).click();
  await expect(rows).toHaveCount(3);
  await expect(field).toHaveText('正在写的草稿');
  await field.fill('');
  await rows.nth(1).getByRole('button', { name: '取回编辑' }).click();
  await expect(rows).toHaveCount(2);
  await expect(field).toHaveText('第三条');
  await expect(field).toBeFocused();
  await field.fill('第三条（改过）');
  await field.press('Enter');
  await rows.filter({ hasText: '第四条' }).getByRole('button', { name: '移出队列' }).click();
  await expect(rows).toHaveCount(2);
  assert.deepEqual(await queued(), ['第二条：接着做', '第三条（改过）']);
  checks.push('A queued message can be taken back, changed and queued again, or removed');

  // The first turn finishes: the queue drains in order, one turn per message.
  await writeFile(release, 'go');
  await expect
    .poll(turns, { timeout: 20_000 })
    .toEqual(['hold 第一条', '第二条：接着做', '第三条（改过）']);
  await expect.poll(streaming, { timeout: 20_000 }).toBe(0);
  await expect(card).toHaveCount(0);
  const first = (await snapshot()).conversations[0];
  assert.deepEqual(
    first.messages.filter((message) => message.role === 'user').map((message) => message.text),
    ['hold 第一条', '第二条：接着做', '第三条（改过）'],
  );
  assert.deepEqual(
    first.messages
      .filter((message) => message.role === 'assistant')
      .map((message) => [message.status, message.text]),
    [
      ['done', '已完成：hold 第一条'],
      ['done', '已完成：第二条：接着做'],
      ['done', '已完成：第三条（改过）'],
    ],
  );
  await expect(sendButton).toHaveAttribute('aria-label', '发送任务');
  checks.push('After the running turn finishes, queued messages are sent oldest first');

  // A stopped turn holds its queued messages until the user sends them on.
  await field.fill('hold 第五条');
  await field.press('Enter');
  await expect.poll(streaming, { timeout: 20_000 }).toBe(1);
  await field.fill('停止之后再发');
  await field.press('Enter');
  await expect(rows).toHaveCount(1);
  await expect(sendButton).toHaveAttribute('aria-label', '停止任务');
  await sendButton.click();
  await expect.poll(streaming, { timeout: 20_000 }).toBe(0);
  await expect(card.getByRole('status')).toContainText('上一轮没有完成，1 条消息暂未发送');
  await page.waitForTimeout(600);
  assert.equal((await turns()).includes('停止之后再发'), false, 'a stop does not send the queue');
  assert.deepEqual((await snapshot()).queue?.paused, [first.id]);
  await page.screenshot({
    path: path.join(root, 'test-results/message-queue-paused.png'),
    animations: 'disabled',
  });
  await card.getByRole('button', { name: '继续发送' }).click();
  await expect.poll(async () => (await turns()).at(-1)).toBe('停止之后再发');
  await expect.poll(streaming, { timeout: 20_000 }).toBe(0);
  await expect(card).toHaveCount(0);
  checks.push('After a stop the queue waits; 继续发送 sends it');

  // A message written in another conversation waits for the running one and then starts there.
  await field.fill('hold 第六条');
  await field.press('Enter');
  await expect.poll(streaming, { timeout: 20_000 }).toBe(1);
  await page.getByRole('button', { name: '新对话' }).first().click();
  await expect(card).toHaveCount(0);
  await field.fill('另一个对话的任务');
  await expect(sendButton).toHaveAttribute('aria-label', '加入队列');
  await field.press('Enter');
  await expect(rows).toHaveCount(1);
  const other = (await snapshot()).queue?.items[0].conversationId;
  assert.ok(other && other !== first.id);
  await writeFile(release, 'go');
  await expect
    .poll(async () => (await turns()).at(-1), { timeout: 20_000 })
    .toBe('另一个对话的任务');
  await expect.poll(streaming, { timeout: 20_000 }).toBe(0);
  const second = (await snapshot()).conversations.find((item) => item.id === other);
  assert.deepEqual(
    second?.messages.map((message) => [message.role, message.text]),
    [
      ['user', '另一个对话的任务'],
      ['assistant', '已完成：另一个对话的任务'],
    ],
  );
  assert.deepEqual((await snapshot()).queue, { items: [], paused: [] });
  checks.push('A message for another conversation is queued behind the running turn');

  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, checks, screenshot: 'test-results/message-queue.png' }, null, 2),
  );
} catch (error) {
  if (application) {
    try {
      await (
        await application.firstWindow()
      ).screenshot({
        path: path.join(root, 'test-results/message-queue-failure.png'),
        animations: 'disabled',
      });
    } catch {
      /* The isolated renderer may have already exited. */
    }
  }
  throw error;
} finally {
  await application?.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
