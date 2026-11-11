/** 复制消息的隔离界面检查：宿主桥是替身，不调用 CLI、模型、系统剪贴板，也不发送消息。 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createServer, type Plugin } from 'vite';
import { uiBrowserExecutable } from './ui-browser';

const output = path.resolve('test-results/message-copy');
await mkdir(output, { recursive: true });
const now = Date.now();
const userText =
  '请核对发布说明 https://example.com/release?tab=notes#top\n然后运行 `npm test`：\n```bash\nnpm run typecheck\n```';
const assistantText =
  '已核对，详见 [发布说明](https://example.com/release?tab=notes#top)。\n\n```ts\nconst total: number = 1;\n```\n\n- 行内 `code` 保持原样';
const feishuText = '总结文档 https://example.com/docs/guide';
const failedText = '页面没有响应，本轮未完成。';
const longText = '第一段\n\n' + '长回答内容。'.repeat(25_000) + '\n\n最后一段';
const hostFailure = '系统剪贴板没有保留这段内容，请重试';
const workspace = '/workspace/athena';
const snapshot = {
  localUser: { name: 'alina' },
  settings: { workspace, agent: 'codex' },
  agents: [
    {
      id: 'codex',
      name: 'Codex',
      available: true,
      supported: true,
      path: '/fixture/bin/codex',
      version: 'fixture-version',
    },
  ],
  codexConnection: { status: 'ready', conversationId: 'copy' },
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
      id: 'copy',
      title: '核对发布说明',
      updatedAt: now,
      workspace,
      messages: [
        {
          id: 'u1',
          role: 'user',
          text: userText,
          createdAt: now,
          status: 'done',
          source: 'desktop',
          context: 'private_context_marker',
        },
        {
          id: 'a1',
          role: 'assistant',
          text: assistantText,
          createdAt: now,
          status: 'done',
          tools: [
            {
              id: 't1',
              name: 'fixture_tool',
              input: 'private_tool_marker',
              status: 'done',
              output: 'private_tool_output_marker',
            },
          ],
        },
        {
          id: 'u2',
          role: 'user',
          text: feishuText,
          createdAt: now,
          status: 'done',
          source: 'feishu',
          context: 'private_context_marker',
        },
        {
          id: 'a2',
          role: 'assistant',
          text: failedText,
          createdAt: now,
          status: 'error',
          failure: failedText,
          tools: [],
        },
      ],
    },
    {
      id: 'streaming',
      title: '进行中的任务',
      updatedAt: now - 1000,
      workspace,
      messages: [
        { id: 'u3', role: 'user', text: '继续检查', createdAt: now, status: 'done' },
        {
          id: 'a3',
          role: 'assistant',
          text: '部分回答',
          createdAt: now,
          status: 'streaming',
          tools: [],
        },
      ],
    },
    {
      id: 'long',
      title: '很长的回答',
      updatedAt: now - 2000,
      workspace,
      messages: [
        { id: 'u4', role: 'user', text: '写一份很长的说明', createdAt: now, status: 'done' },
        {
          id: 'a4',
          role: 'assistant',
          text: longText,
          createdAt: now,
          status: 'done',
          tools: [],
        },
      ],
    },
  ],
};
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '/src/renderer/App';
import '/src/renderer/styles.css';
const fixture=window.__copyFixture={snapshot:${JSON.stringify(snapshot)},listeners:[],calls:[],failCopy:false};
window.workbench={
 async invoke(action,payload){
  fixture.calls.push({action,payload});
  if(action==='app:snapshot')return structuredClone(fixture.snapshot);
  if(action==='browser:start'){fixture.snapshot.browser.status='ready';return structuredClone(fixture.snapshot.browser);}
  if(action==='browser:new-tab'){
   if(fixture.failBrowser)throw new Error('请先停止共享再新建标签页');
   return {id:'linked-page',url:payload.url,title:'发布说明'};
  }
  if(action==='app:copy'){
   if(fixture.failCopy)throw new Error("Error invoking remote method 'workbench:invoke': Error: ${hostFailure}");
   return true;
  }
  if(action==='codex:update-status')return {status:'unknown'};
  if(action==='models:list')return [{model:'fixture-model',name:'Fixture Model',efforts:[{id:'low',description:'Low'}],defaultEffort:'low'}];
  if(action==='conversation:prepare')return {status:'ready',conversationId:payload.conversationId};
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
  name: 'message-copy-fixture',
  resolveId(id) {
    if (id === '/message-copy-entry.js') return '\0message-copy-entry';
  },
  load(id) {
    if (id === '\0message-copy-entry') return entry;
  },
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/') return next();
      response.setHeader('content-type', 'text/html');
      response.end(
        await server.transformIndexHtml(
          '/index.html',
          '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/message-copy-entry.js"></script>',
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
  const copies = () =>
    page.evaluate(() =>
      (window as any).__copyFixture.calls
        .filter((call: any) => call.action === 'app:copy')
        .map((call: any) => call.payload),
    );
  const failCopy = (fail: boolean) =>
    page.evaluate((value) => {
      (window as any).__copyFixture.failCopy = value;
    }, fail);
  const toast = page.locator('.app-toast');
  const copiedIcon = '[data-slot="chat-message-actions-copied-icon"]';
  const openConversation = (title: string) =>
    page.locator('.conversation-link', { hasText: title }).click();
  await page.goto(`http://127.0.0.1:${port}`);
  await expect(page.locator('article.message')).toHaveCount(4);

  const userMessage = page.locator('article.message.user').first();
  const assistantMessage = page.locator('article.message.assistant').first();
  const userCopy = userMessage.getByRole('button', { name: '复制消息', exact: true });
  const assistantCopy = assistantMessage.getByRole('button', { name: '复制回答', exact: true });
  const userActions = userMessage.locator('[data-slot="chat-message-actions"]');
  await expect(userCopy).toBeVisible();
  await expect(assistantCopy).toBeVisible();
  assert.ok(
    Number(await userActions.evaluate((node) => getComputedStyle(node).opacity)) >= 0.5,
    'the copy entry must be discoverable without hovering',
  );
  const geometry = await page.evaluate(() => {
    const box = (node: Element) => {
      const { top, right, bottom, left, width, height } = node.getBoundingClientRect();
      return { top, right, bottom, left, width, height };
    };
    const user = document.querySelector('article.message.user')!;
    const assistant = document.querySelector('article.message.assistant')!;
    return {
      bubble: box(user.querySelector('.chat-message__bubble')!),
      userCopy: box(user.querySelector('button[aria-label="复制消息"]')!),
      assistantCopy: box(assistant.querySelector('button[aria-label="复制回答"]')!),
    };
  });
  assert.ok(
    geometry.userCopy.top >= geometry.bubble.bottom,
    'the copy entry must not cover the message',
  );
  assert.ok(
    Math.abs(geometry.userCopy.right - geometry.bubble.right) <= 1,
    'the copy entry aligns with the right edge of the user message',
  );
  assert.equal(geometry.userCopy.width, geometry.userCopy.height, 'icon button stays square');
  assert.equal(geometry.userCopy.height, geometry.assistantCopy.height);
  assert.equal(geometry.userCopy.width, geometry.assistantCopy.width);
  await expect(userMessage).toContainText('已附加页面上下文');
  checks.push(
    'User messages and assistant answers both expose a visible copy button of the same size; the user entry sits under the bubble on its right edge',
  );

  await page.getByRole('button', { name: '展开浏览器', exact: true }).focus();
  let reached = false;
  for (let index = 0; index < 30 && !reached; index++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(
      () => document.activeElement?.getAttribute('aria-label') === '复制消息',
    );
  }
  assert.ok(reached, 'the user copy entry must be reachable with Tab');
  await expect.poll(() => userActions.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
  await page.keyboard.press('Enter');
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toContainText('已复制消息');
  await expect(toast).toBeVisible();
  await expect.poll(() => toast.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
  assert.deepEqual(await copies(), [{ text: userText }]);
  await expect(userCopy.locator(copiedIcon)).toBeVisible();
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    '复制消息',
    'copying keeps keyboard focus on the entry',
  );
  await page.screenshot({ path: path.join(output, 'user-copied.png') });
  checks.push(
    'Keyboard: Tab reaches the user copy entry, Enter copies the exact multi-line text with its link and code, feedback is announced as status and focus stays',
  );

  await assistantCopy.focus();
  await page.keyboard.press('Space');
  await expect(toast).toContainText('已复制回答');
  assert.deepEqual((await copies()).at(-1), { text: assistantText });
  await expect(assistantCopy.locator(copiedIcon)).toBeVisible();
  await expect(userCopy.locator(copiedIcon)).toHaveCount(0);
  checks.push(
    'Space copies the assistant answer as its Markdown source, keeping the link target and code fence; only the copied message shows the confirmation',
  );

  // 等上一次成功的已复制图标退场，之后的失败检查不重试：失败后任何时刻都不应出现已复制状态。
  await expect(page.locator(copiedIcon)).toHaveCount(1);
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await expect(page.locator(copiedIcon)).toHaveCount(0);
  await page.evaluate((selector) => {
    const seen = ((window as any).__copiedSeen = { count: 0 });
    new MutationObserver(() => {
      if (document.querySelector(selector)) seen.count++;
    }).observe(document.body, { childList: true, subtree: true });
  }, copiedIcon);
  await failCopy(true);
  await userCopy.click();
  await expect(toast).toHaveAttribute('role', 'alert');
  await expect(toast).toHaveText(new RegExp(`复制消息失败：${hostFailure}`));
  await expect(toast).toBeVisible();
  await page.screenshot({ path: path.join(output, 'copy-failed.png') });
  await assistantCopy.click();
  await expect(toast).toHaveText(new RegExp(`复制回答失败：${hostFailure}`));
  await page.waitForTimeout(400);
  assert.equal(
    await page.evaluate(() => (window as any).__copiedSeen.count),
    0,
    'a failed copy must never show the copied state, not even briefly',
  );
  assert.equal(await page.locator(copiedIcon).count(), 0);
  await failCopy(false);
  await userCopy.click();
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(userCopy.locator(copiedIcon)).toBeVisible();
  checks.push(
    'A rejected copy is announced as an alert naming the message kind and the host reason, never shows the copied state, and a later copy succeeds',
  );

  const feishuMessage = page.locator('article.message.user').nth(1);
  await expect(feishuMessage).toContainText('来自飞书');
  await feishuMessage.getByRole('button', { name: '复制消息', exact: true }).click();
  assert.deepEqual((await copies()).at(-1), { text: feishuText });
  const failedMessage = page.locator('article.message.assistant').nth(1);
  await expect(failedMessage).toContainText('任务未完成');
  const failedCopy = failedMessage.getByRole('button', { name: '复制回答', exact: true });
  // 只有失败原因的一轮没有回复正文：原因显示在结果卡片里，复制入口紧跟在卡片下方。
  const failedCard = failedMessage.locator('.req.outcome');
  await expect(failedCard).toContainText(failedText);
  assert.ok(
    (await failedCopy.boundingBox())!.y >=
      (await failedCard.boundingBox())!.y + (await failedCard.boundingBox())!.height,
    'the copy entry of a failed turn sits under its outcome card',
  );
  await failedCopy.click();
  assert.deepEqual((await copies()).at(-1), { text: failedText });
  await failedMessage.screenshot({ path: path.join(output, 'failed-copy.png') });
  assert.ok(
    !JSON.stringify(await copies()).includes('private_'),
    'attached context, tool input and tool output never enter the copied text',
  );
  checks.push(
    'Feishu and failed messages keep their labels and copy only the visible message text; page context and tool events are never included',
  );

  await page.setViewportSize({ width: 1060, height: 700 });
  const narrow = await page.evaluate(() => {
    const scroll = document.querySelector('.chat-scroll')!;
    const column = scroll.getBoundingClientRect();
    return {
      overflow: scroll.scrollWidth - scroll.clientWidth,
      inside: [...document.querySelectorAll('article.message.user button')].every((button) => {
        const { left, right } = button.getBoundingClientRect();
        return left >= column.left && right <= column.right;
      }),
    };
  });
  assert.ok(narrow.overflow <= 0, 'copy entries must not add horizontal scrolling');
  assert.ok(narrow.inside, 'copy entries stay inside the conversation column at 1060px');
  await page.setViewportSize({ width: 1280, height: 900 });
  checks.push('At the 1060px minimum window the entries stay inside the conversation column');

  await openConversation('进行中的任务');
  await expect(page.locator('article.message')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '复制回答', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制消息', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
  checks.push(
    'A streaming answer still has no copy entry and the stop control is unchanged; its user message can be copied',
  );

  await openConversation('很长的回答');
  await expect(page.locator('article.message')).toHaveCount(2);
  await page.getByRole('button', { name: '复制回答', exact: true }).click();
  await expect(toast).toContainText('已复制回答');
  assert.equal((await copies()).at(-1).text, longText);
  assert.ok(longText.length > 100_000);
  checks.push(`A ${longText.length}-character answer is handed to the host in full`);

  await page.evaluate(() => localStorage.setItem('athena.appearance', 'dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('article.message')).toHaveCount(4);
  await userMessage.hover();
  await expect(userCopy).toBeVisible();
  await page.screenshot({ path: path.join(output, 'user-copy-dark.png') });
  checks.push('The entry renders with theme tokens in dark mode');

  await page.clock.install();
  const draft = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  await draft.fill('提醒出现时保留这份草稿');
  const emitNotice = (message: string, level: 'info' | 'error' = 'info') =>
    page.evaluate(
      ({ message, level }) => {
        for (const listener of (window as any).__copyFixture.listeners)
          listener({ type: 'notice', message, level });
      },
      { message, level },
    );
  await emitNotice('连接状态已更新');
  await expect(toast).toBeVisible();
  await expect(draft).toBeFocused();
  const corner = await toast.boundingBox();
  assert.ok(corner && Math.abs(corner.y - 64) <= 1);
  assert.ok(corner && Math.abs(corner.x + corner.width - (page.viewportSize()!.width - 16)) <= 1);
  await page.screenshot({
    path: path.join(output, 'notification-top-right.png'),
    animations: 'disabled',
  });
  await page.clock.fastForward(2000);
  await emitNotice('连接状态已更新');
  await expect(toast).toHaveCount(1);
  await page.clock.fastForward(1500);
  await expect(toast).toHaveCount(0);
  const longError = '连接未成功，请检查当前网络后重试。'.repeat(60);
  await emitNotice(longError, 'error');
  await expect(toast).toHaveAttribute('role', 'alert');
  assert.ok(await toast.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
  assert.ok(await toast.evaluate((node) => node.scrollHeight > node.clientHeight));
  await expect(toast.getByRole('button', { name: '关闭提示' })).toBeInViewport();
  await toast.hover();
  await page.clock.fastForward(8000);
  await expect(toast).toBeVisible();
  await toast.focus();
  await page.mouse.move(8, 8);
  await page.clock.fastForward(8000);
  await expect(toast).toBeVisible();
  await page.screenshot({
    path: path.join(output, 'notification-long-error.png'),
    animations: 'disabled',
  });
  await toast.press('Escape');
  await expect(toast).toHaveCount(0);
  await expect(draft).toBeFocused();
  await expect(draft).toHaveText('提醒出现时保留这份草稿');
  assert.equal(
    await page.evaluate(
      () =>
        (window as any).__copyFixture.calls.filter(
          (call: any) => call.action === 'conversation:stop',
        ).length,
    ),
    0,
  );
  checks.push(
    'App reminders sit at the top right, preserve typing, merge repeats, pause for hover/focus, contain long errors and close with Escape without stopping the Agent',
  );

  const pageLink = page.getByRole('link', { name: '发布说明', exact: true });
  await pageLink.click();
  await expect(page.locator('.browser-drawer')).toHaveClass(/is-open/);
  let linkCalls = await page.evaluate(() =>
    (window as any).__copyFixture.calls.filter((call: any) =>
      ['browser:start', 'browser:new-tab', 'shell:openExternal'].includes(call.action),
    ),
  );
  assert.deepEqual(linkCalls, [
    { action: 'browser:new-tab', payload: { url: 'https://example.com/release?tab=notes#top' } },
  ]);
  await page.evaluate(() => {
    const fixture = (window as any).__copyFixture;
    fixture.calls = [];
    fixture.snapshot.browser.status = 'stopped';
    for (const listener of fixture.listeners)
      listener({ type: 'browser:state', state: structuredClone(fixture.snapshot.browser) });
  });
  await pageLink.click();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as any).__copyFixture.calls.filter(
            (call: any) => call.action === 'browser:new-tab',
          ).length,
      ),
    )
    .toBe(1);
  linkCalls = await page.evaluate(() =>
    (window as any).__copyFixture.calls.filter((call: any) =>
      ['browser:start', 'browser:new-tab', 'shell:openExternal'].includes(call.action),
    ),
  );
  assert.deepEqual(
    linkCalls.map((call: any) => call.action),
    ['browser:start', 'browser:new-tab'],
  );
  await page.evaluate(() => {
    (window as any).__copyFixture.failBrowser = true;
  });
  await pageLink.click();
  await expect(toast).toContainText('请先停止共享再新建标签页');
  assert.equal(
    await page.evaluate(
      () =>
        (window as any).__copyFixture.calls.filter(
          (call: any) => call.action === 'shell:openExternal',
        ).length,
    ),
    0,
  );
  checks.push(
    'Reply links open the Neo drawer and a new tab; a stopped browser starts first, and sharing rejection never falls back to the system browser',
  );

  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        passed: true,
        source: 'controlled-renderer-host-fixture',
        realModelCalls: 0,
        realMessagesSent: 0,
        systemClipboardWrites: 0,
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
