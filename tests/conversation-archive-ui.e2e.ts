/** 会话归档、恢复与删除的隔离界面检查：宿主桥是替身，不调用 CLI、模型，也不发送消息。 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createServer, type Plugin } from 'vite';
import { uiBrowserExecutable } from './ui-browser';

const output = path.resolve('test-results/conversation-archive');
await mkdir(output, { recursive: true });
const now = Date.now();
const workspace = '/workspace/athena';
const failedText = '调研页面没有响应，本轮未完成。';
const turn = (id: string, question: string, answer: string, status = 'done') => [
  { id: `${id}-u`, role: 'user', text: question, createdAt: now, status: 'done' },
  { id: `${id}-a`, role: 'assistant', text: answer, createdAt: now, status, tools: [] },
];
const snapshot = {
  localUser: { name: 'alina' },
  settings: { workspace, agent: 'codex' },
  agents: [
    {
      id: 'codex',
      name: 'Codex',
      available: true,
      supported: true,
      authentication: 'ready',
      path: '/fixture/bin/codex',
      version: 'fixture-version',
    },
  ],
  codexConnection: { status: 'ready', conversationId: 'plan' },
  browser: {
    status: 'ready',
    engine: 'browseros',
    tabs: [],
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    recording: false,
    inspecting: false,
  },
  neo: { status: 'stopped' },
  feishu: { status: 'disconnected', paired: false },
  recordings: [],
  conversations: [
    {
      id: 'plan',
      title: '整理发布计划',
      updatedAt: now,
      workspace,
      agentSessionId: 'thread-plan',
      messages: turn('plan', '整理这次发布的计划', '计划已整理：先核对改动，再发布。'),
    },
    {
      id: 'review',
      title: '核对界面改动',
      updatedAt: now - 1000,
      workspace,
      agentSessionId: 'thread-review',
      messages: turn('review', '核对侧栏的界面改动', '侧栏改动已核对。'),
    },
    {
      id: 'running',
      title: '进行中的任务',
      updatedAt: now - 2000,
      workspace,
      messages: turn('running', '继续检查', '部分回答', 'streaming'),
    },
    {
      id: 'old',
      title: '上周的调研',
      updatedAt: now - 3000,
      workspace,
      archivedAt: now - 500,
      // 最近一轮只失败、没有回答：归档后只展示原因，不提供重试。
      messages: turn('old', '调研归档方案', failedText, 'error').map((message) =>
        message.role === 'assistant' ? { ...message, failure: failedText } : message,
      ),
    },
    {
      id: 'other',
      title: '其他目录的对话',
      updatedAt: now - 4000,
      workspace: '/workspace/other',
      archivedAt: now - 600,
      messages: turn('other', '另一个项目', '另一个项目的回答。'),
    },
  ],
};
// 替身宿主把对话记录存进 localStorage，页面重新加载相当于应用重启后读回已保存的记录。
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '/src/renderer/App';
import '/src/renderer/styles.css';
const saved=localStorage.getItem('archive-fixture-host');
const fixture=window.__archiveFixture={snapshot:saved?JSON.parse(saved):${JSON.stringify(snapshot)},listeners:[],calls:[],refuse:''};
const persist=()=>localStorage.setItem('archive-fixture-host',JSON.stringify(fixture.snapshot));
fixture.persist=persist;
const emit=(event)=>fixture.listeners.forEach((fn)=>fn(event));
const fail=(message)=>{throw new Error("Error invoking remote method 'workbench:invoke': Error: "+message)};
// 与宿主一致：归档或删除后，这段对话不再占用 CLI 连接。
const release=(id)=>{
 if(fixture.snapshot.codexConnection?.conversationId!==id)return;
 fixture.snapshot.codexConnection={status:'idle'};
 emit({type:'codex:state',state:{status:'idle'}});
};
window.workbench={
 async invoke(action,payload){
  fixture.calls.push({action,payload});
  if(action==='app:snapshot')return structuredClone(fixture.snapshot);
  if(action==='conversation:archive'){
   if(fixture.refuse)fail(fixture.refuse);
   const item=fixture.snapshot.conversations.find((entry)=>entry.id===payload.conversationId);
   if(!item)fail('找不到这个对话');
   if(payload.archived)item.archivedAt=item.archivedAt??Date.now();else delete item.archivedAt;
   if(payload.archived)release(item.id);
   persist();
   const copy=structuredClone(item);
   emit({type:'conversation:updated',conversation:copy});
   return copy;
  }
  if(action==='conversation:delete'){
   if(fixture.refuse)fail(fixture.refuse);
   if(!fixture.snapshot.conversations.some((entry)=>entry.id===payload.conversationId))fail('找不到这个对话');
   fixture.snapshot.conversations=fixture.snapshot.conversations.filter((entry)=>entry.id!==payload.conversationId);
   release(payload.conversationId);
   persist();
   return true;
  }
  if(action==='conversation:prepare'){
   const item=fixture.snapshot.conversations.find((entry)=>entry.id===payload.conversationId);
   if(!item)fail('找不到这个对话');
   if(item.archivedAt)fail('这个对话已归档，恢复后才能继续');
   fixture.snapshot.codexConnection={status:'ready',conversationId:payload.conversationId};
   return fixture.snapshot.codexConnection;
  }
  if(action==='codex:update-status')return {status:'unknown'};
  if(action==='models:list')return [{model:'fixture-model',name:'Fixture Model',efforts:[{id:'low',description:'Low'}],defaultEffort:'low'}];
  if(action==='share:state')return {active:false,participants:[]};
  if(action==='usage:snapshot')return {records:[],since:Date.now(),updatedAt:Date.now()};
  if(action==='neo:records')return [];
  return true;
 },
 onEvent(fn){fixture.listeners.push(fn);return()=>{fixture.listeners=fixture.listeners.filter(item=>item!==fn)}}
};
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
`;
const fixture: Plugin = {
  name: 'conversation-archive-fixture',
  resolveId(id) {
    if (id === '/conversation-archive-entry.js') return '\0conversation-archive-entry';
  },
  load(id) {
    if (id === '\0conversation-archive-entry') return entry;
  },
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/') return next();
      response.setHeader('content-type', 'text/html');
      response.end(
        await server.transformIndexHtml(
          '/index.html',
          '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/conversation-archive-entry.js"></script>',
        ),
      );
    });
  },
};
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: path.join(output, '.vite-cache'),
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: {
    entries: ['src/renderer/main.tsx'],
    include: [
      'react',
      'react-dom/client',
      'react/jsx-runtime',
      'motion/react',
      '@heroui/react',
      '@heroui-pro/react',
    ],
  },
  appType: 'custom',
  logLevel: 'error',
  plugins: [react(), tailwindcss(), fixture],
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
const browser = await chromium.launch({
  executablePath: uiBrowserExecutable(),
  headless: true,
  args: [
    '--disable-browseros-server',
    '--disable-browseros-server-updater',
    '--disable-browseros-extensions',
    '--browseros-disable-url-overrides',
    '--use-mock-keychain',
    '--disable-sync',
  ],
});
const checks: string[] = [];
const errors: string[] = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  page.setDefaultTimeout(8000);
  await page.addInitScript('window.__name = (value) => value;');
  page.on('pageerror', (error) => errors.push(error.message));
  // React 的告警走 console.error；隔离页面没有 favicon，浏览器自动请求它得到的 404 不属于被测界面。
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico'))
      errors.push(message.text());
  });
  const calls = (action: string) =>
    page.evaluate(
      (name) =>
        (window as any).__archiveFixture.calls
          .filter((call: any) => call.action === name)
          .map((call: any) => call.payload),
      action,
    );
  const callCount = () => page.evaluate(() => (window as any).__archiveFixture.calls.length);
  const preparedSince = (start: number, id: string) =>
    page.evaluate(
      ([from, conversationId]) =>
        (window as any).__archiveFixture.calls
          .slice(from as number)
          .filter(
            (call: any) =>
              call.action === 'conversation:prepare' &&
              call.payload.conversationId === conversationId,
          ).length,
      [start, id] as const,
    );
  const refuse = (message: string) =>
    page.evaluate((value) => {
      (window as any).__archiveFixture.refuse = value;
    }, message);
  const toast = page.locator('.app-toast');
  const label = page.locator('.sidebar-section-label');
  // 一行里除了标题还可能有状态回声（如“运行中”），这里只读标题。
  const listed = async () =>
    (await page.locator('.conversation-list .conversation-link > span').allInnerTexts()).map(
      (text) => text.trim(),
    );
  const row = (title: string) => page.locator('.conversation-row', { hasText: title });
  const rowLink = (title: string) => row(title).locator('.conversation-link');
  const menuTrigger = (title: string) =>
    page.getByRole('button', { name: `对话操作：${title}`, exact: true });
  const menu = page.getByRole('menu', { name: /^对话操作：/ });
  const menuItem = (name: string) => menu.getByRole('menuitem', { name, exact: true });
  const showArchived = page.getByRole('button', { name: '已归档', exact: true });
  const showOpen = page.getByRole('button', { name: '返回对话列表', exact: true });
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务', exact: true });
  const current = page.locator('.conversation-link[aria-current="page"] > span');
  const dialog = page.getByRole('alertdialog');
  const archivedNotice = page.locator('.archived-notice');
  const opacity = (title: string) =>
    menuTrigger(title).evaluate((node) => getComputedStyle(node).opacity);
  const choose = async (title: string, item: string) => {
    await menuTrigger(title).click();
    await menuItem(item).click();
  };
  const focusedConversation = () =>
    page.evaluate(() => {
      const node = document.activeElement;
      return node?.matches('.conversation-link')
        ? (node.querySelector(':scope > span')?.textContent ?? '').trim()
        : null;
    });
  const header = (name: string) =>
    page.evaluate((text) => {
      const centre = (rect: DOMRect) => (rect.top + rect.bottom) / 2;
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('.sidebar-section-label')!);
      const toggle = [...document.querySelectorAll('.athena-sidebar button')].find(
        (button) => (button.textContent ?? '').trim() === text,
      )!;
      const sidebar = document.querySelector('.athena-sidebar')!.getBoundingClientRect();
      const box = toggle.getBoundingClientRect();
      return {
        offset: Math.abs(centre(range.getBoundingClientRect()) - centre(box)),
        height: box.height,
        inside: box.left >= sidebar.left && box.right <= sidebar.right,
      };
    }, name);
  /** 弹层的进入动画结束后再截图。 */
  const steady = () => expect(page.locator('[data-entering]')).toHaveCount(0);
  const settle = async () => {
    await expect(toast).toBeVisible();
    await expect.poll(() => toast.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
  };

  await page.goto(`http://127.0.0.1:${port}`);
  await expect(page.locator('article.message')).toHaveCount(2);
  assert.deepEqual(await listed(), ['整理发布计划', '核对界面改动', '进行中的任务']);
  await expect(label).toHaveText('对话');
  await expect(current).toHaveText('整理发布计划');
  await expect(showArchived).toBeVisible();
  const mainHeader = await header('已归档');
  assert.ok(mainHeader.offset <= 1.5, 'the archived entry lines up with the list heading');
  assert.ok(mainHeader.inside && mainHeader.height <= 32, 'the archived entry fits the sidebar');
  await page.getByRole('button', { name: /搜索对话/ }).click();
  const search = page.getByPlaceholder('搜索当前工作区的对话');
  await search.fill('调研');
  await expect(page.getByText('没有找到相关对话')).toBeVisible();
  await search.fill('核对');
  await expect(
    page.getByRole('dialog', { name: '搜索对话' }).getByRole('menuitem', { name: /核对界面改动/ }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  checks.push(
    'Archived conversations are hidden from the main list and from search; the archived entry is offered because this workspace has archived conversations',
  );

  await page.mouse.move(800, 500);
  await expect.poll(() => opacity('核对界面改动')).toBe('0');
  await expect.poll(() => opacity('整理发布计划')).toBe('1');
  await row('核对界面改动').hover();
  await expect.poll(() => opacity('核对界面改动')).toBe('1');
  const geometry = await page.evaluate(() => {
    const box = (node: Element) => {
      const { top, right, bottom, left, width, height } = node.getBoundingClientRect();
      return { top, right, bottom, left, width, height };
    };
    return [...document.querySelectorAll('.conversation-row')].map((node) => ({
      row: box(node),
      link: box(node.querySelector('.conversation-link')!),
      title: box(node.querySelector('.conversation-link span')!),
      trigger: box(node.querySelector('button[aria-label^="对话操作："]')!),
    }));
  });
  assert.equal(geometry.length, 3);
  for (const item of geometry) {
    assert.equal(item.trigger.width, item.trigger.height, 'the row menu button stays square');
    assert.ok(
      Math.abs(
        item.trigger.top + item.trigger.height / 2 - (item.link.top + item.link.height / 2),
      ) <= 1,
      'the row menu button is vertically centred on its conversation',
    );
    assert.ok(
      item.trigger.left >= item.link.left && item.trigger.right <= item.link.right,
      'the row menu button sits inside the conversation row',
    );
    assert.ok(item.title.right <= item.trigger.left, 'the title never runs under the menu button');
  }
  await page.mouse.move(800, 500);
  checks.push(
    'Each conversation has its own menu button: always shown for the open conversation, revealed on hover or focus for the others, square and centred inside the row',
  );

  await menuTrigger('核对界面改动').focus();
  await expect.poll(() => opacity('核对界面改动')).toBe('1');
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText([/归档对话/, /删除对话/]);
  await steady();
  await page.screenshot({ path: path.join(output, 'row-menu.png') });
  await page.keyboard.press('Enter');
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toContainText('已归档对话');
  assert.deepEqual(await listed(), ['整理发布计划', '进行中的任务']);
  assert.deepEqual(await calls('conversation:archive'), [
    { conversationId: 'review', archived: true },
  ]);
  await expect(current).toHaveText('整理发布计划');
  await expect(page.locator('article.message')).toHaveCount(2);
  await expect.poll(focusedConversation).toBe('进行中的任务');
  checks.push(
    'Keyboard: Enter opens the row menu and archives another conversation; it leaves the main list, the open conversation stays selected and focus moves to the next conversation',
  );

  let mark = await callCount();
  await choose('整理发布计划', '归档对话');
  await expect(page.locator('.welcome h1')).toHaveText('今天想完成什么？');
  assert.deepEqual(await listed(), ['进行中的任务']);
  await expect(current).toHaveCount(0);
  await expect(composer).toBeVisible();
  await expect(page.locator('article.message')).toHaveCount(0);
  await settle();
  // 宿主事后再次报告这段已归档的记录（例如收尾写入）时，也不会把它重新打开。
  await page.evaluate(async () => {
    const host = (window as any).__archiveFixture;
    const conversation = host.snapshot.conversations.find((item: any) => item.id === 'plan');
    host.listeners.forEach((listener: any) =>
      listener({ type: 'conversation:updated', conversation: structuredClone(conversation) }),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.locator('.welcome h1')).toHaveText('今天想完成什么？');
  await expect(page.locator('article.message')).toHaveCount(0);
  checks.push(
    'Archiving the open conversation returns to the new-conversation view with nothing selected, and a later host update for the archived record does not reopen it',
  );

  await showArchived.click();
  await expect(label).toHaveText('已归档');
  assert.deepEqual(await listed(), ['整理发布计划', '核对界面改动', '上周的调研']);
  await expect(showOpen).toBeVisible();
  const archivedHeader = await header('返回对话列表');
  assert.ok(archivedHeader.offset <= 1.5, 'the way back lines up with the archived heading');
  assert.ok(archivedHeader.inside && archivedHeader.height <= 32, 'the way back fits the sidebar');
  await rowLink('整理发布计划').click();
  await expect(page.locator('article.message')).toHaveCount(2);
  await expect(composer).toHaveCount(0);
  await expect(archivedNotice).toContainText('这段对话已归档');
  await expect(archivedNotice.getByRole('button', { name: '恢复对话', exact: true })).toBeVisible();
  await expect(current).toHaveText('整理发布计划');
  await expect(page.locator('.agent-status-caption')).toHaveText('已登录');
  await page.waitForTimeout(300);
  assert.equal(
    await preparedSince(mark, 'plan'),
    0,
    'an archived conversation is never prepared for a CLI connection',
  );
  await page.screenshot({ path: path.join(output, 'archived-view.png') });
  const outcome = page.locator('.req.outcome');
  await rowLink('上周的调研').click();
  await expect(outcome).toContainText(failedText);
  await expect(outcome.getByRole('button')).toHaveCount(0);
  await expect(archivedNotice).toBeVisible();
  await rowLink('整理发布计划').click();
  await expect(outcome).toHaveCount(0);
  checks.push(
    'The archived view lists only this workspace’s archived conversations; an archived conversation opens read-only with a restore entry, is not prepared for the CLI and shows no ready connection; a failed last turn shows its reason without a retry',
  );

  mark = await callCount();
  await archivedNotice.getByRole('button', { name: '恢复对话', exact: true }).click();
  await expect(toast).toContainText('已恢复对话');
  await expect(label).toHaveText('对话');
  assert.deepEqual(await listed(), ['整理发布计划', '进行中的任务']);
  await expect(current).toHaveText('整理发布计划');
  await expect(composer).toBeVisible();
  assert.deepEqual((await calls('conversation:archive')).at(-1), {
    conversationId: 'plan',
    archived: false,
  });
  await expect.poll(() => preparedSince(mark, 'plan')).toBeGreaterThan(0);
  await expect(composer).toBeFocused();
  checks.push(
    'Restoring from the open archived conversation puts it back in the main list, keeps it open and makes it usable again with the task field focused',
  );

  await showArchived.click();
  assert.deepEqual(await listed(), ['核对界面改动', '上周的调研']);
  await page.getByRole('button', { name: /搜索对话/ }).click();
  await search.fill('进行中');
  await page
    .getByRole('dialog', { name: '搜索对话' })
    .getByRole('menuitem', { name: /进行中的任务/ })
    .click();
  await expect(label).toHaveText('对话');
  await expect(current).toHaveText('进行中的任务');
  checks.push(
    'Opening a conversation that is not archived while the archived list is shown brings the sidebar back to the main list',
  );

  await showArchived.click();
  assert.deepEqual(await listed(), ['核对界面改动', '上周的调研']);
  await menuTrigger('核对界面改动').click();
  await expect(menu.getByRole('menuitem')).toHaveText([/恢复对话/, /删除对话/]);
  await menuItem('恢复对话').click();
  await expect(label).toHaveText('对话');
  assert.deepEqual(await listed(), ['整理发布计划', '核对界面改动', '进行中的任务']);
  await expect(current).toHaveText('核对界面改动');
  await expect(page.locator('article.message')).toHaveCount(2);
  await expect(composer).toBeFocused();
  checks.push('The archived list offers restore from its row menu and opens the restored one');

  await choose('核对界面改动', '删除对话');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('删除这段对话？');
  await expect(dialog).toContainText('核对界面改动');
  await expect(dialog).toContainText(/CLI.*历史/);
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  assert.deepEqual(await calls('conversation:delete'), [], 'nothing is deleted before confirming');
  await steady();
  await page.screenshot({ path: path.join(output, 'delete-confirm.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(await calls('conversation:delete'), []);
  assert.deepEqual(await listed(), ['整理发布计划', '核对界面改动', '进行中的任务']);
  await expect(menuTrigger('核对界面改动')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(await calls('conversation:delete'), []);
  await choose('核对界面改动', '删除对话');
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '删除对话', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toContainText('已删除对话');
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(await calls('conversation:delete'), [{ conversationId: 'review' }]);
  assert.deepEqual(await listed(), ['整理发布计划', '进行中的任务']);
  await expect(page.locator('.welcome h1')).toHaveText('今天想完成什么？');
  await expect(current).toHaveCount(0);
  await expect.poll(focusedConversation).toBe('进行中的任务');
  checks.push(
    'Deleting asks for confirmation naming the conversation and what is kept; Escape and Cancel keep the record, focus returns to the row menu, and only the confirm button deletes it, clears the selection and hands focus to the next conversation',
  );

  mark = await callCount();
  await menuTrigger('进行中的任务').click();
  await expect(menuItem('归档对话')).toHaveAttribute('aria-disabled', 'true');
  await expect(menuItem('删除对话')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('.conversation-menu-note')).toHaveText('任务结束后才能归档或删除');
  await expect(page.locator('.conversation-menu-note')).toBeVisible();
  await steady();
  await page.screenshot({ path: path.join(output, 'running-menu.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await rowLink('进行中的任务').click();
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
  assert.equal(
    (await page.evaluate(
      (from) =>
        (window as any).__archiveFixture.calls
          .slice(from)
          .filter((call: any) => /conversation:(archive|delete|stop)/.test(call.action)).length,
      mark,
    )) as number,
    0,
    'opening the menu of a running conversation never archives, deletes or stops it',
  );
  checks.push(
    'A conversation whose task is running cannot be archived or deleted from its menu, the reason is shown, and the real stop control is unchanged',
  );

  await refuse('这个对话的任务还在进行，请先停止或等待完成后再归档');
  await choose('整理发布计划', '归档对话');
  await expect(toast).toHaveAttribute('role', 'alert');
  await expect(toast).toHaveText(/任务还在进行，请先停止或等待完成后再归档/);
  assert.deepEqual(await listed(), ['整理发布计划', '进行中的任务']);
  await refuse('这个对话的任务还在进行，请先停止或等待完成后再删除');
  await choose('整理发布计划', '删除对话');
  await dialog.getByRole('button', { name: '删除对话', exact: true }).click();
  await expect(toast).toHaveText(/任务还在进行，请先停止或等待完成后再删除/);
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(await listed(), ['整理发布计划', '进行中的任务']);
  await refuse('');
  checks.push(
    'When the host refuses an archive or delete, the reason is announced as an alert and the conversation stays in the list',
  );

  await choose('整理发布计划', '归档对话');
  await expect(toast).toContainText('已归档对话');
  await page.evaluate(() => {
    const host = (window as any).__archiveFixture;
    host.snapshot.codexConnection = { status: 'ready', conversationId: 'plan' };
    host.persist();
  });
  await page.reload();
  await expect(current).toHaveText('进行中的任务');
  assert.deepEqual(await listed(), ['进行中的任务']);
  await showArchived.click();
  assert.deepEqual(await listed(), ['整理发布计划', '上周的调研']);
  checks.push(
    'After a reload from the saved records the archived and deleted conversations stay archived and deleted, and an archived conversation is never opened by default',
  );

  await choose('上周的调研', '删除对话');
  await dialog.getByRole('button', { name: '删除对话', exact: true }).click();
  await expect(toast).toContainText('已删除对话');
  assert.deepEqual(await listed(), ['整理发布计划']);
  await expect(label).toHaveText('已归档');
  await choose('整理发布计划', '删除对话');
  await dialog.getByRole('button', { name: '删除对话', exact: true }).click();
  await expect(label).toHaveText('对话');
  await expect(showArchived).toHaveCount(0);
  await expect(showOpen).toHaveCount(0);
  assert.deepEqual(await listed(), ['进行中的任务']);
  checks.push(
    'Deleting works from the archived list too; when nothing is archived any more the sidebar returns to the main list and the archived entry disappears',
  );

  await page.evaluate(() => localStorage.removeItem('archive-fixture-host'));
  await page.reload();
  await expect(current).toHaveText('整理发布计划');
  await showArchived.click();
  assert.deepEqual(await listed(), ['上周的调研']);
  await choose('上周的调研', '删除对话');
  await dialog.getByRole('button', { name: '删除对话', exact: true }).click();
  await expect(label).toHaveText('对话');
  await choose('核对界面改动', '归档对话');
  await expect(toast).toContainText('已归档对话');
  await expect(label).toHaveText('对话');
  assert.deepEqual(await listed(), ['整理发布计划', '进行中的任务']);
  await expect(showArchived).toBeVisible();
  checks.push(
    'After the archived list empties, archiving another conversation keeps the main list in view',
  );

  await page.evaluate(() => localStorage.removeItem('archive-fixture-host'));
  await page.setViewportSize({ width: 1060, height: 700 });
  await page.evaluate(() => localStorage.setItem('athena.appearance', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('article.message')).toHaveCount(2);
  const narrow = await page.evaluate(() => {
    const list = document.querySelector('.conversation-list')!;
    const sidebar = document.querySelector('.athena-sidebar')!.getBoundingClientRect();
    return {
      overflow: list.scrollWidth - list.clientWidth,
      inside: [...document.querySelectorAll('.athena-sidebar button')].every((button) => {
        const { left, right } = button.getBoundingClientRect();
        return left >= sidebar.left && right <= sidebar.right;
      }),
    };
  });
  assert.ok(narrow.overflow <= 0, 'row menus must not add horizontal scrolling to the list');
  assert.ok(narrow.inside, 'sidebar controls stay inside the sidebar at the 1060px minimum window');
  await menuTrigger('整理发布计划').click();
  await expect(menu).toBeVisible();
  await steady();
  await page.screenshot({ path: path.join(output, 'row-menu-dark.png') });
  await menuItem('删除对话').click();
  await expect(dialog).toBeVisible();
  await steady();
  await page.screenshot({ path: path.join(output, 'delete-confirm-dark.png') });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  checks.push('The menu and the confirmation render with theme tokens in dark mode at 1060px');

  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        passed: true,
        source: 'controlled-renderer-host-fixture',
        realModelCalls: 0,
        realMessagesSent: 0,
        geometry,
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
} finally {
  await browser.close();
  await server.close();
}
