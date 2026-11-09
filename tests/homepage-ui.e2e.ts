/** Isolated renderer regression: every host action is controlled; no CLI, model or messaging calls. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { uiBrowserExecutable } from './ui-browser';
import { chromium, expect } from '@playwright/test';
import { checkTaskPanels } from './task-panel-checks';
import { checkAppNotices } from './app-notice-checks';
import { createServer, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const output = path.resolve('test-results/design-release/homepage');
await mkdir(output, { recursive: true });
const longModelName = 'Codex Workspace Reasoning Extended';
const now = Date.now();
const snapshot = {
  localUser: { name: 'alina' },
  settings: { workspace: '/workspace/athena', agent: 'codex' },
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
    {
      id: 'claude',
      name: 'Claude Code',
      available: true,
      supported: false,
      path: '/fixture/bin/claude',
    },
    { id: 'opencode', name: 'OpenCode', available: false, supported: false },
    { id: 'gemini', name: 'Gemini CLI', available: false, supported: false },
  ],
  codexConnection: { status: 'ready', conversationId: 'home' },
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
    { id: 'home', title: '新对话', updatedAt: now, workspace: '/workspace/athena', messages: [] },
    {
      id: 'a',
      title: '优化首页交互',
      updatedAt: now - 1000,
      workspace: '/workspace/athena',
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          text: '核对无障碍键盘操作和按钮文案。',
          createdAt: now,
          status: 'done',
          tools: [{ id: 't1', name: 'fixture', input: 'private_tool_marker', status: 'completed' }],
        },
      ],
    },
    {
      id: 'b',
      title: '检查网页表单',
      updatedAt: now - 2000,
      workspace: '/workspace/athena',
      messages: [{ id: 'b1', role: 'user', text: '确认表单说明完整。', createdAt: now }],
    },
    {
      id: 'legacy',
      title: '旧任务',
      updatedAt: now - 3000,
      messages: [{ id: 'l1', role: 'user', text: '兼容旧记录', createdAt: now }],
    },
    {
      id: 'other',
      title: '其他项目匹配',
      updatedAt: now - 4000,
      workspace: '/workspace/other',
      messages: [{ id: 'o1', role: 'user', text: '无障碍键盘', createdAt: now }],
    },
  ],
};
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '/src/renderer/App';
import '/src/renderer/styles.css';
const fixture=window.__homeFixture={snapshot:${JSON.stringify(snapshot)},listeners:[],calls:[],pendingSnapshots:[],ready:false,failSend:false,folderChoice:null};
fixture.emit=event=>{for(const listener of fixture.listeners)listener(event)};
fixture.release=()=>{fixture.ready=true;for(const resolve of fixture.pendingSnapshots)resolve(structuredClone(fixture.snapshot));fixture.pendingSnapshots=[]};
fixture.browser=patch=>{Object.assign(fixture.snapshot.browser,patch);fixture.emit({type:'browser:state',state:structuredClone(fixture.snapshot.browser)})};
fixture.feishu=state=>fixture.emit({type:'feishu:state',state});
window.workbench={
 async invoke(action,payload){
  fixture.calls.push({action,payload});
  if(action==='app:snapshot')return fixture.ready?structuredClone(fixture.snapshot):new Promise(resolve=>fixture.pendingSnapshots.push(resolve));
  if(action==='codex:update-status')return fixture.updateStatus || {status:'unknown'};
  if(action==='models:list')return [{model:'fixture-model',name:${JSON.stringify(longModelName)},efforts:[{id:'low',description:'Low'},{id:'high',description:'High'}],defaultEffort:'low'}];
  if(action==='conversation:prepare')return {status:'ready',conversationId:payload.conversationId};
  if(action==='conversation:new'){const item={id:'new-'+fixture.calls.length,title:'新对话',updatedAt:Date.now(),workspace:fixture.snapshot.settings.workspace,agent:payload?.agent||fixture.snapshot.settings.agent,messages:[]};fixture.snapshot.conversations.unshift(item);return item;}
  if(action==='conversation:send'){
   if(fixture.failSend)throw new Error('测试发送失败，请稍后重试。');
   const item=fixture.snapshot.conversations.find(c=>c.id===payload.id);
   item.messages.push({id:'user-'+Date.now(),role:'user',text:payload.text,createdAt:Date.now()},{id:'assistant-'+Date.now(),role:'assistant',text:'',createdAt:Date.now(),status:'streaming'});
   fixture.emit({type:'conversation:updated',conversation:structuredClone(item)});
   if(fixture.holdSend)await new Promise(resolve=>fixture.releaseSend=resolve);
   return {conversationId:item.id};
  }
  if(action==='conversation:stop'){for(const item of fixture.snapshot.conversations){for(const message of item.messages)if(message.status==='streaming')message.status='done';fixture.emit({type:'conversation:updated',conversation:structuredClone(item)})}return true;}
  if(action==='settings:workspace'){if(!fixture.folderChoice)return null;fixture.snapshot.settings.workspace=fixture.folderChoice;return structuredClone(fixture.snapshot.settings);}
  if(action==='settings:agent'){fixture.snapshot.settings.agent=payload.id;return structuredClone(fixture.snapshot.settings);}
  if(action==='settings:model'){
    const selection={model:payload.model,effort:payload.effort};
    if(payload.conversationId!==undefined){
      const conversation=fixture.snapshot.conversations.find(item=>item.id===payload.conversationId);
      if(!conversation||payload.agent!==(conversation.agent||'codex'))throw Error('CLI 已改变');
      conversation.modelSelection=selection;
      fixture.emit({type:'conversation:updated',conversation});
    }else{
      const agent=payload.agent||fixture.snapshot.settings.agent;
      fixture.snapshot.settings.modelSelections??={};
      fixture.snapshot.settings.modelSelections[agent]=selection;
      if(agent==='codex')fixture.snapshot.settings.modelSelection=selection;
    }
    return structuredClone(fixture.snapshot.settings);
  }
  if(action==='agents:refresh')return fixture.snapshot.agents;
  if(action==='browser:inspect'){fixture.browser({inspecting:payload.enabled});return true;}
  if(action==='recording:start'){fixture.browser({recording:true});return true;}
  if(action==='browser:resize')return {width:payload.fitToWidth?Math.max(900,payload.width):payload.width,height:payload.height,tabId:payload.tabId};
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
  name: 'homepage-ui-fixture',
  resolveId(id) {
    if (id === '/homepage-entry.js') return '\0homepage-entry';
  },
  load(id) {
    if (id === '\0homepage-entry') return entry;
  },
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/') return next();
      response.setHeader('content-type', 'text/html');
      response.end(
        await server.transformIndexHtml(
          '/index.html',
          '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/homepage-entry.js"></script>',
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
    viewport: { width: 1600, height: 1000 },
    reducedMotion: 'reduce',
  });
  page.setDefaultTimeout(8000);
  await page.addInitScript('window.__name = (value) => value;');
  page.on('pageerror', (error) => errors.push(error.message));
  const calls = (action: string) =>
    page.evaluate(
      (name) => (window as any).__homeFixture.calls.filter((c: any) => c.action === name),
      action,
    );
  await page.goto(`http://127.0.0.1:${port}`);
  await expect(page.getByRole('status')).toContainText('正在打开工作区');
  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('dialog', { name: '搜索对话' })).toHaveCount(0);
  assert.equal((await calls('models:list')).length, 0);
  await page.evaluate(() => {
    const f = (window as any).__homeFixture;
    f.snapshot.conversations.unshift(f.snapshot.conversations.pop());
    f.snapshot.codexConnection = { status: 'ready', conversationId: 'other' };
    f.release();
  });
  await expect(page.getByRole('heading', { name: '今天想完成什么？' })).toBeVisible();
  await expect
    .poll(async () => (await calls('conversation:prepare')).at(-1)?.payload.conversationId)
    .toBe('home');
  assert(
    !(await calls('conversation:prepare')).some((c: any) => c.payload.conversationId === 'other'),
  );
  await expect(page.locator('.conversation-list')).not.toContainText('其他项目匹配');
  await expect(page.getByRole('button', { name: '本机用户菜单' })).toContainText('alina');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const geometry = await page.evaluate(() => {
    const info = (selector: string) => {
      const node = document.querySelector(selector)!;
      const b = node.getBoundingClientRect();
      const c = getComputedStyle(node);
      return {
        width: b.width,
        height: b.height,
        radius: c.borderRadius,
        border: c.borderLeftWidth,
        font: c.fontSize,
      };
    };
    return {
      sidebar: info('.athena-sidebar'),
      logo: info('.brand-mark'),
      welcomeLogo: info('.welcome-symbol'),
      title: info('.welcome h1'),
      composer: info('.composer'),
      shell: info('[data-slot="prompt-input-shell"]'),
    };
  });
  assert.equal(geometry.sidebar.width, 216);
  assert.equal(geometry.logo.width, 34);
  assert.equal(geometry.welcomeLogo.width, 56);
  assert.equal(geometry.title.font, '36px');
  assert.equal(geometry.composer.width, 760);
  assert.equal(geometry.shell.radius, '24px');
  assert.equal(geometry.shell.border, '0px');
  const toolbarBoxes = () =>
    page.locator('.composer-controls button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const { x, y, width, height } = button.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
  const wide = await toolbarBoxes();
  await expect(page.locator('.agent-picker img[data-agent="codex"]')).toBeVisible();
  assert.equal(wide.length, 4);
  assert.ok(wide.every((b) => b.height === 36 && Math.abs(b.y - wide[0].y) < 1));
  assert.equal(wide[0].width, wide[0].height, 'Add context must stay square');
  assert.equal(wide[3].width, wide[3].height, 'Send must stay square');
  checks.push('The four homepage toolbar controls share one center line and a 36px hit height');
  await page.screenshot({ path: path.join(output, 'home-light.png') });
  checks.push(
    'Initial snapshot gate prevents early model requests; actual local username/initial, 216px sidebar, 760px composer, 34/56px official logos, neutral borderless 24px surface',
  );

  const userMenu = page.getByRole('button', { name: '本机用户菜单' });
  await userMenu.click();
  await expect(page.locator('.local-user-menu')).toBeVisible();
  await expect(page.locator('.local-user-menu')).not.toContainText(/订阅|账户|登录/);
  await page.screenshot({ path: path.join(output, 'user-menu.png') });
  const appearance = async (label: string) => {
    if (!(await page.locator('.local-user-menu').isVisible())) await userMenu.click();
    await page.getByRole('menuitem', { name: /外观/ }).hover();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  };
  await appearance('深色');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('athena.appearance')), 'dark');
  await page.screenshot({ path: path.join(output, 'home-dark.png') });
  await appearance('跟随系统');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await appearance('浅色');
  checks.push(
    'User menu actions have no account features; light/dark/system preference is persisted and reacts to system changes',
  );

  await page.keyboard.press('Meta+k');
  const search = page.getByRole('searchbox', { name: '搜索对话标题或消息' });
  await search.fill('无障碍键盘');
  assert.equal((await page.locator('.conversation-search').boundingBox())?.width, 704);
  await expect(page.getByRole('menuitem', { name: /^优化首页交互/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^其他项目匹配/ })).toHaveCount(0);
  await page.screenshot({ path: path.join(output, 'search-results.png') });
  await search.fill('private_tool_marker');
  await expect(page.getByText('没有找到相关对话', { exact: true })).toBeVisible();
  await search.fill('兼容旧记录');
  await expect(page.getByRole('menuitem', { name: /^旧任务/ })).toBeVisible();
  await search.fill('优化首页');
  await search.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '搜索对话' })).toHaveCount(0);
  await expect(page.locator('.topbar-title')).toContainText('优化首页交互');
  checks.push(
    'Search matches visible message text and titles, limits current workspace while retaining legacy records, excludes raw tool payloads, and supports arrows/Enter/Escape',
  );

  const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  const conversationA = page.locator('.conversation-link').filter({ hasText: '优化首页交互' });
  const conversationB = page.locator('.conversation-link').filter({ hasText: '检查网页表单' });
  await composer.fill('A 的草稿');
  await conversationB.click();
  await expect(composer).toHaveValue('');
  await composer.fill('B 的草稿');
  await conversationA.click();
  await expect(conversationA).toHaveAttribute('aria-current', 'page');
  await expect(composer).toHaveValue('A 的草稿');
  await page.evaluate(() => {
    (window as any).__homeFixture.holdSend = true;
  });
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
  // A user can replace a submitted draft with the same words before its acknowledgement.
  await composer.fill('');
  await composer.fill('A 的草稿');
  await conversationB.click();
  await page.evaluate(() => {
    const f = (window as any).__homeFixture;
    f.holdSend = false;
    f.releaseSend();
  });
  await expect(conversationB).toHaveAttribute('aria-current', 'page');
  await expect(composer).toHaveValue('B 的草稿');
  const submitted = (await calls('conversation:send')).at(-1)?.payload;
  assert.equal(submitted.id, 'a');
  assert.equal(submitted.text, 'A 的草稿');
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await page.keyboard.press('Meta+n');
  await expect(composer).toHaveValue('');
  await conversationA.click();
  await expect(composer).toHaveValue('A 的草稿');
  checks.push(
    'Conversation drafts survive navigation and creating a chat; a delayed send leaves later edits and the current conversation intact',
  );

  await page.keyboard.press('Meta+n');
  const sendCount = (await calls('conversation:send')).length;
  await composer.fill('保留这段草稿');
  await page.evaluate(() => (window as any).__homeFixture.browser({ status: 'missing' }));
  await expect(page.getByRole('button', { name: /^选取并修改元素/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^录制一段操作/ })).toBeDisabled();
  await page.evaluate(() => (window as any).__homeFixture.browser({ status: 'ready' }));
  await page.getByRole('button', { name: /^查看当前页面/ }).press('Enter');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('保留这段草稿');
  await page.getByRole('button', { name: '收起浏览器', exact: true }).first().click();
  await userMenu.click();
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('.local-user-menu')))
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('.local-user-menu')).toBeHidden();
  await expect(composer).toHaveValue('保留这段草稿');
  await page.getByRole('button', { name: '添加网页上下文', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'context-menu.png') });
  await page.getByRole('menuitem', { name: '当前页面', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '当前页面', exact: true })).toHaveCount(0);
  await expect(composer).toHaveValue('保留这段草稿');
  assert.equal((await calls('conversation:send')).length, sendCount);
  await page.locator('.browser-keyboard').focus();
  await page.keyboard.press('Meta+k');
  await expect(page.getByRole('dialog', { name: '搜索对话' })).toBeVisible();
  await expect(search).toBeFocused();
  await page.keyboard.type('键盘');
  await expect(search).toHaveValue('键盘');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '搜索对话' })).toHaveCount(0);
  await expect(page.locator('.browser-keyboard')).toBeFocused();
  await page.evaluate(() => (window as any).__homeFixture.browser({ status: 'starting' }));
  await page.getByRole('button', { name: '添加网页上下文', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '选取页面元素', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByRole('menuitem', { name: '录制网页操作', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).__homeFixture.browser({ status: 'ready' }));
  await page.getByRole('button', { name: '添加网页上下文', exact: true }).click();
  await page.getByRole('menuitem', { name: '录制网页操作', exact: true }).click();
  await expect(page.locator('.composer-recording')).toContainText('录制中');
  assert.equal((await calls('recording:start')).length, 1);
  await page.evaluate(() => (window as any).__homeFixture.browser({ recording: false }));
  await page.getByRole('button', { name: '收起浏览器', exact: true }).first().click();
  checks.push(
    'Context actions preserve drafts, do not auto-send, gate element/recording on browser readiness and call existing recording action',
  );

  await composer.evaluate((node) =>
    node.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  assert.equal((await calls('conversation:send')).length, sendCount);
  await page.evaluate(() => {
    (window as any).__homeFixture.failSend = true;
  });
  await composer.press('Enter');
  await expect(page.getByRole('alert')).toContainText('测试发送失败');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await expect(composer).toHaveValue('保留这段草稿');
  await page.evaluate(() => {
    (window as any).__homeFixture.failSend = false;
  });
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeVisible();
  await page.keyboard.press('Meta+n');
  await composer.fill('下一段草稿');
  await expect(page.getByText('另一任务进行中', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect(composer).toHaveValue('下一段草稿');
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  checks.push(
    'IME confirmation does not submit; failed send retains draft; acknowledged send clears it; global busy switches to Stop and stopping preserves the next draft without queueing',
  );

  await page.locator('.sidebar-settings').click();
  await expect(page.locator('.settings-workspace')).toBeVisible();
  await expect(page.getByRole('heading', { name: '使用你已有的 Agent' })).toBeVisible();
  await expect(page.locator('.settings-workspace')).toContainText('/fixture/bin/codex');
  await expect(page.locator('.settings-workspace')).toContainText('Claude Code');
  const statusBadge = page.locator('.agent-connection-card .small-badge');
  await page.evaluate(() => {
    const f = (window as any).__homeFixture;
    f.emit({
      type: 'codex:state',
      state: { status: 'idle', conversationId: f.snapshot.conversations[0].id },
    });
    f.emit({ type: 'codex:state', state: { status: 'ready', conversationId: 'a' } });
  });
  await expect(statusBadge).toHaveText('已登录');
  await page.evaluate(() => {
    const fixture = (window as any).__homeFixture;
    fixture.emit({
      type: 'codex:state',
      state: {
        status: 'error',
        conversationId: fixture.snapshot.conversations[0].id,
        message: '本机连接测试错误',
      },
    });
  });
  await expect(page.locator('.agent-connection-card')).toContainText('连接失败');
  await page.evaluate(() =>
    (window as any).__homeFixture.emit({
      type: 'codex:state',
      state: { status: 'ready', conversationId: 'a' },
    }),
  );
  await expect(page.locator('.agent-connection-card').getByRole('alert')).toHaveText(
    '本机连接测试错误',
  );
  await page.evaluate(() => {
    const fixture = (window as any).__homeFixture;
    fixture.emit({
      type: 'codex:state',
      state: { status: 'ready', conversationId: fixture.snapshot.conversations[0].id },
    });
  });
  await expect(statusBadge).toHaveText('已就绪');
  assert.equal(
    await page
      .locator('.settings-workspace-card > .card__content')
      .evaluate((node) => getComputedStyle(node).flexDirection),
    'row',
  );
  assert.equal(await page.getByRole('dialog', { name: '设置与连接' }).count(), 0);
  await page.screenshot({ path: path.join(output, 'settings-agent.png') });
  await page.getByRole('tab', { name: '浏览器', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择 BrowserOS neo', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '飞书', exact: true }).click();
  await expect(page.getByRole('button', { name: '授权并选择机器人', exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as any).__homeFixture.feishu({ status: 'restoring', paired: false }),
  );
  await expect(page.getByRole('heading', { name: '正在恢复飞书连接' })).toBeVisible();
  await page.evaluate(() =>
    (window as any).__homeFixture.feishu({ status: 'error', paired: false, restoreFailed: true }),
  );
  await expect(page.getByRole('button', { name: '重试恢复连接' })).toBeVisible();
  await page.evaluate(() =>
    (window as any).__homeFixture.feishu({
      status: 'connected',
      paired: false,
      pairingCode: 'FIXTURE',
      appId: 'fixture-app',
    }),
  );
  await expect(page.getByRole('button', { name: '绑定 FIXTURE' })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'settings-feishu.png') });
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(composer).toHaveValue('下一段草稿');
  await page.locator('.sidebar-settings').click();
  await page.keyboard.press('Meta+l');
  await expect(page.locator('.settings-workspace')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '网页地址' })).toBeFocused();
  await page.locator('.topbar .browser-toggle').click();
  checks.push(
    'Settings occupies the main workspace, retains real provider detail, browser controls and Feishu disconnected/restoring/failed/pairing branches, and preserves draft on return',
  );

  const beforeCancel = (await calls('conversation:new')).length;
  await userMenu.click();
  await page.getByRole('menuitem', { name: /^选择工作目录/ }).click();
  assert.equal((await calls('conversation:new')).length, beforeCancel);
  await expect(composer).toHaveValue('下一段草稿');
  await page.evaluate(() => {
    (window as any).__homeFixture.folderChoice = '/workspace/next';
  });
  await userMenu.click();
  await page.getByRole('menuitem', { name: /^选择工作目录/ }).click();
  await expect(composer).toHaveValue('');
  await expect(page.locator('.workspace-selector')).toContainText('next');
  checks.push(
    'Cancelled workspace picker changes nothing; accepted workspace updates directory and creates a new conversation',
  );

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: path.join(output, 'home-1024.png') });
  assert.ok(
    await page.locator('.work-area').evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  );
  await page.keyboard.press('Meta+b');
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
  await page.keyboard.press('Meta+b');
  await expect(userMenu).toBeVisible();
  await page.locator('.sidebar-settings').click();
  await page.screenshot({ path: path.join(output, 'settings-1024.png') });
  assert.ok(
    await page
      .locator('.settings-workspace')
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  );
  checks.push(
    '1024px layout and sidebar keyboard toggle remain usable without horizontal overflow',
  );
  await page.setViewportSize({ width: 1060, height: 740 });
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await page.evaluate(() => {
    const tab = {
      id: 'blank',
      title: '新标签页',
      url: 'about:blank',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
    (window as any).__homeFixture.browser({
      tabs: [tab],
      activeTabId: tab.id,
      url: tab.url,
      title: tab.title,
    });
  });
  const composerShell = page.locator('.composer [data-slot="prompt-input-shell"]');
  const outline = () => composerShell.evaluate((node) => getComputedStyle(node).outline);
  const idleOutline = await outline();
  await composer.evaluate((node) => {
    node.dataset.pickerFocusCount = '0';
    node.addEventListener('focusin', () => {
      node.dataset.pickerFocusCount = String(Number(node.dataset.pickerFocusCount) + 1);
    });
  });
  const agentPicker = page.getByRole('button', { name: '选择 Agent', exact: true });
  const defaultChanges = (await calls('settings:agent')).length;
  await agentPicker.click();
  await page.getByRole('menuitem', { name: /^Codex/ }).click();
  await expect(agentPicker).toBeFocused();
  assert.equal(
    (await calls('settings:agent')).length,
    defaultChanges,
    'Reselecting the conversation CLI does not change the application default',
  );
  const agentOutline = await outline();
  const modelPicker = page.getByRole('button', { name: '选择模型', exact: true });
  await modelPicker.click();
  await page.locator('.model-controls').getByRole('heading', { name: '模型' }).click();
  await page.getByRole('option', { name: longModelName, exact: true }).click();
  await page.locator('.reasoning-slider .slider__track').click({ position: { x: 4, y: 12 } });
  await page.getByRole('slider', { name: '推理强度' }).press('End');
  await expect
    .poll(async () => (await calls('settings:model')).at(-1)?.payload)
    .toEqual({
      model: 'fixture-model',
      effort: 'high',
      agent: 'codex',
      conversationId: await page.evaluate(
        () => (window as any).__homeFixture.snapshot.conversations[0].id,
      ),
    });
  await page.screenshot({ path: path.join(output, 'composer-model-controls.png') });
  await page.getByRole('button', { name: '关闭模型选择' }).click();
  await expect(modelPicker).toBeFocused();
  assert.deepEqual(
    {
      draftFocusEvents: await composer.getAttribute('data-picker-focus-count'),
      agentOutline,
      modelOutline: await outline(),
    },
    { draftFocusEvents: '0', agentOutline: idleOutline, modelOutline: idleOutline },
    'Picker interactions keep keyboard focus in their controls and the draft shell visually idle',
  );
  await composer.click({ position: { x: 24, y: 20 } });
  await expect(composer).toBeFocused();
  assert.notEqual(await outline(), idleOutline);
  checks.push(
    'Agent and model selection leave the draft idle; clicking the writing area focuses it',
  );
  await expect(page.locator('.composer .model-picker-effort')).toBeVisible();
  const multiline = '请核对当前页面。\n列出需要确认的内容，\n保留草稿中的换行。';
  await composer.fill(multiline);
  assert.ok(
    await composer.evaluate((input) => {
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      const x = rect.x + parseFloat(style.paddingLeft) + parseFloat(style.fontSize);
      const y = rect.y + parseFloat(style.paddingTop) + parseFloat(style.lineHeight) / 2;
      return document.elementFromPoint(x, y) === input;
    }),
    'The toolbar must not intercept the first line of the draft',
  );
  const divider = page.getByRole('separator', { name: '调整浏览器宽度' });
  const dragDivider = async (x: number) => {
    const bounds = await divider.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, bounds.y + bounds.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  const measureSplit = async (state: string) => {
    const shell = await composerShell.boundingBox();
    const buttons = await toolbarBoxes();
    const browserPane = page.getByRole('region', { name: '浏览器', exact: true });
    const pane = await browserPane.boundingBox();
    const canvas = await page.locator('.browser-canvas-wrap').boundingBox();
    assert.ok(shell && pane && canvas);
    assert.equal(pane.y, 0, 'Browser chrome must start at the window top');
    const topbar = page.locator('.topbar');
    const title = await topbar.locator('.topbar-title').boundingBox();
    const actions = await topbar.locator('.topbar-actions').boundingBox();
    assert.ok(title && actions && title.width > 0 && title.x + title.width <= actions.x + 1);
    assert.ok(
      actions.x + actions.width <= pane.x + 1,
      'Title bar controls must fit the chat column',
    );
    await topbar.getByRole('button', { name: '收起浏览器', exact: true }).click({ trial: true });
    for (const name of ['新建标签页', '共享页面', '收起浏览器', '元素检查器', '选取元素', '录制']) {
      await browserPane.getByRole('button', { name, exact: true }).click({ trial: true });
    }
    await browserPane.getByRole('tab', { name: '新标签页' }).click({ trial: true });
    await browserPane.getByRole('textbox', { name: '网页地址' }).click({ trial: true });
    const zoomPicker = browserPane.getByRole('button', { name: '页面缩放' });
    await expect(zoomPicker).toHaveText(/适应宽度 · \d+%/);
    const zoom = await zoomPicker.evaluate((button) => {
      const value = button.querySelector('[data-slot="select-value"]')!;
      const arrow = button.querySelector('.select__indicator')!.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(value);
      const box = button.getBoundingClientRect();
      return {
        height: box.height,
        clipped: value.scrollWidth > value.clientWidth,
        gap: arrow.left - text.getBoundingClientRect().right,
        arrowWidth: arrow.width,
        arrowHeight: arrow.height,
        right: innerWidth - box.right,
        bottom: innerHeight - box.bottom,
      };
    });
    await expect(page.locator('.composer .model-picker-name')).toBeVisible();
    await expect(page.locator('.composer .model-picker-effort')).toBeVisible();
    await page.screenshot({
      path: path.join(output, `split-${state}.png`),
      animations: 'disabled',
    });
    return {
      state,
      shell,
      buttons,
      browserWidth: pane.width,
      browserTop: pane.y,
      zoom,
      chromeHeight: canvas.y - pane.y,
    };
  };
  const splits = [await measureSplit('default')];
  await dragDivider(1040);
  splits.push(await measureSplit('narrow-browser'));
  assert.equal(splits[1].browserWidth, 390);
  assert.ok(splits[1].browserWidth < splits[0].browserWidth, 'The divider must resize the browser');
  await page.evaluate(() => {
    const fixture = (window as any).__homeFixture;
    const [first] = fixture.snapshot.browser.tabs;
    const tabs = Array.from({ length: 8 }, (_, i) => ({
      ...first,
      id: 'page-' + i,
      title: '页面 ' + i,
    }));
    fixture.browser({ tabs: [first, ...tabs], activeTabId: tabs[7].id });
  });
  await expect(page.getByRole('tab', { name: '页面 7', exact: true })).toBeInViewport({
    ratio: 0.98,
  });
  await page.evaluate(() => {
    const fixture = (window as any).__homeFixture;
    const [first] = fixture.snapshot.browser.tabs;
    fixture.browser({ tabs: [first], activeTabId: first.id });
  });
  checks.push('A host-selected tab scrolls into view in the 390px browser pane');
  await dragDivider(280);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const stop = page.getByRole('button', { name: '停止任务', exact: true });
  await expect(stop).toBeVisible();
  await composer.fill(multiline);
  splits.push(await measureSplit('narrow-chat-stop'));
  await stop.click();
  await expect(composer).toHaveValue(multiline);
  await writeFile(path.join(output, 'split-layout.json'), JSON.stringify(splits, null, 2));
  for (const { state, shell, buttons, chromeHeight, zoom } of splits) {
    assert.ok(
      zoom.height === 22 &&
        !zoom.clipped &&
        zoom.gap >= 6 &&
        zoom.arrowWidth === 12 &&
        zoom.arrowHeight === 12 &&
        zoom.right >= 8 &&
        zoom.bottom >= 6,
      state + ': zoom label, arrow or window inset is cramped: ' + JSON.stringify(zoom),
    );
    assert.equal(buttons.length, 4);
    assert.ok(
      buttons.every(
        (b) =>
          b.x >= shell.x &&
          b.x + b.width <= shell.x + shell.width + 1 &&
          b.y >= shell.y &&
          b.y + b.height <= shell.y + shell.height + 1,
      ),
      state + ': toolbar escapes the composer',
    );
    assert.ok(
      buttons.every(
        (b, i) =>
          Math.abs(b.y - buttons[0].y) <= 1 &&
          b.height === 36 &&
          (!i || buttons[i - 1].x + buttons[i - 1].width <= b.x + 1),
      ),
      state + ': toolbar wraps or overlaps',
    );
    assert.equal(buttons[0].width, 36, state + ': add context is squeezed');
    assert.equal(buttons[3].width, 36, state + ': send/stop is squeezed');
    assert.ok(chromeHeight <= 126, state + ': browser controls take more than three compact rows');
  }
  checks.push(
    'At 1060px the split workspace keeps a long model, effort and Send/Stop in one row; the resizable browser leaves room for the page',
  );
  const main = await page.getByRole('main').boundingBox();
  assert.ok(main);
  for (const [button, panel] of [
    ['设置与连接', '设置与连接'],
    ['用量', '独立用量面板'],
  ]) {
    await page.getByRole('button', { name: button, exact: true }).click();
    const region = page.getByRole('region', { name: panel, exact: true });
    await expect(region).toBeVisible();
    const bounds = await region.boundingBox();
    assert.ok(
      bounds && Math.abs(bounds.x - main.x) <= 1 && Math.abs(bounds.width - main.width) <= 1,
      panel + ' must fill the workspace when opened from the split view',
    );
    await expect(page.locator('.topbar-title')).toContainText(button);
  }
  checks.push(
    'The browser starts at the top of the window; settings and usage reclaim the full workspace width',
  );
  await checkTaskPanels(page);
  checks.push(
    'Cancelled tasks retain their terminal state, tables render and requests preserve draft focus and history',
  );
  await checkAppNotices(page);
  checks.push(
    'App notices prioritize pending requests, preserve focus and reopen official update notes through the host',
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
