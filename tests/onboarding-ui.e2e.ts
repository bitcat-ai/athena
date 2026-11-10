/** Real React UI with a controlled host protocol; never installs, logs in, or calls a model. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { uiBrowserExecutable } from './ui-browser';
import { chromium, expect, type Page } from '@playwright/test';
import { createServer, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { OnboardingState } from '../src/shared/onboarding';

const output = path.resolve('test-results/design-release/onboarding-ui');
await mkdir(output, { recursive: true });
const initial: OnboardingState = {
  version: 1,
  sessionId: 'fixture-host',
  revision: 0,
  status: 'new',
  stage: 'welcome',
  requiresSetup: true,
  coreReady: false,
  codex: { status: 'unchecked' },
  workspace: { path: '/fixture/original', status: 'unchecked' },
  browser: { status: 'unchecked' },
};
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '/src/renderer/App';
import '/src/renderer/styles.css';
const mode=new URL(location.href).searchParams.get('mode')||'fresh';
const initial=${JSON.stringify(initial)};
if(mode==='legacy'){initial.status='legacy';initial.requiresSetup=false;initial.coreReady=true;initial.codex={status:'ready',path:'/fixture/codex'};initial.workspace.status='ready';initial.browser.status='ready';}
if(mode==='deferred'){initial.status='deferred';initial.stage='codex';initial.codex={status:'missing'};}
const fixture=window.__onboardingFixture={mode,state:initial,calls:[],listeners:[],ready:false,pendingSnapshots:[],nextOperation:1,cancelPick:false,exitDeferred:false};
fixture.snapshot={localUser:{name:'Fixture User'},settings:{workspace:'/fixture/original',agent:'codex'},agents:[],codexConnection:{status:'idle'},browser:{status:'missing',engine:'browseros',tabs:[],url:'',title:'',loading:false,canGoBack:false,canGoForward:false,recording:false,inspecting:false},neo:{status:'stopped'},feishu:{status:'disconnected',paired:false},recordings:[],conversations:mode==='legacy'?[{id:'existing',title:'已有工作',workspace:'/fixture/original',updatedAt:Date.now(),messages:[]}]:[]};
fixture.emit=event=>{for(const listener of fixture.listeners)listener(event)};
fixture.sync=()=>{
 const codex={id:'codex',name:'Codex',available:fixture.state.codex.status==='ready',supported:true,path:fixture.state.codex.path};
 const others=(fixture.state.agents||[]).filter(agent=>agent.id!=='codex'&&agent.id!==fixture.state.executor?.id);
 if(fixture.state.executor?.id&&fixture.state.executor.id!=='codex')others.push(fixture.state.executor);
 fixture.state.agents=[codex,...others];fixture.state.selectedAgent ||= 'codex';
 if(fixture.state.selectedAgent==='codex')fixture.state.executor=codex;
 fixture.snapshot.onboarding=structuredClone(fixture.state);fixture.snapshot.agents=structuredClone(fixture.state.agents);fixture.snapshot.settings.agent=fixture.state.selectedAgent;
 if(fixture.state.workspace.status==='ready'){fixture.snapshot.settings.workspace=fixture.state.workspace.path;fixture.snapshot.settings.workspaceMode=fixture.state.workspace.mode;}
 fixture.snapshot.browser.status=fixture.state.browser.status==='ready'?'ready':'missing';
};
fixture.getSnapshot=()=>{fixture.sync();return structuredClone(fixture.snapshot)};
fixture.release=()=>{fixture.ready=true;for(const resolve of fixture.pendingSnapshots)resolve(fixture.getSnapshot());fixture.pendingSnapshots=[]};
fixture.update=patch=>{for(const[key,value]of Object.entries(patch)){if(value&&typeof value==='object'&&!Array.isArray(value)&&['codex','workspace','browser','login'].includes(key))fixture.state[key]={...fixture.state[key],...value};else fixture.state[key]=value;}fixture.state.revision++;fixture.sync();fixture.emit({type:'onboarding:state',state:structuredClone(fixture.state)});return structuredClone(fixture.state)};
fixture.begin=(kind,message,patch={})=>fixture.update({...patch,operation:{id:'op-'+fixture.nextOperation++,kind,phase:'starting',message,cancelable:true}});
fixture.late=state=>fixture.emit({type:'onboarding:state',state});
window.workbench={async invoke(command,payload){
 fixture.calls.push({command,payload});
 if(command==='app:snapshot')return fixture.ready?fixture.getSnapshot():new Promise(resolve=>fixture.pendingSnapshots.push(resolve));
 if(command==='app:copy'){if(fixture.failCopy)throw new Error('Clipboard unavailable');return true;}
 if(command==='onboarding:open')return fixture.update({status:'in-progress',stage:fixture.mode==='legacy'?'welcome':fixture.state.stage,error:undefined});
 if(command==='onboarding:refresh'){
  const begun=fixture.begin('detect','正在核对本机 Codex',{status:'in-progress',stage:'codex',plan:undefined,error:undefined,codex:{status:'checking'}});if(fixture.holdNextRefresh){fixture.holdNextRefresh=false;return new Promise(resolve=>{fixture.releaseRefresh=()=>resolve(begun)});}return begun;
 }
 if(command==='onboarding:agent')return fixture.update({selectedAgent:payload.id,executor:fixture.state.agents.find(agent=>agent.id===payload.id)});
 if(command==='onboarding:workspace/skip')return fixture.begin('workspace-check','正在准备对话空间…',{stage:'workspace'});
 if(command==='onboarding:plan-install')return fixture.update({plan:{id:'plan-'+fixture.state.revision,kind:payload.kind,version:'fixture-version',sourceUrl:'https://github.com/openai/codex/releases/download/fixture/codex.tar.gz',destination:'/fixture/user/bin/codex',sha256:'a'.repeat(64),changes:['安装用户目录中的 CLI','保留已有登录配置','检查可执行程序启动','不修改其他客户端凭据'],expiresAt:Date.now()+60000},error:undefined});
 if(command==='onboarding:install'){
  if(fixture.state.plan?.id!==payload.planId)throw new Error('安装计划已失效');
  const kind=fixture.state.plan.kind;return fixture.begin(kind==='browser'?'prepare-browser':'install-codex','正在下载官方分发',{plan:undefined});
 }
 if(command==='onboarding:login/start')return fixture.begin('login','等待官方登录结果',{login:{canReopen:true}});
 if(command==='onboarding:login/reopen')return fixture.update({login:{canReopen:true}});
 if(command==='onboarding:cancel'){
  if(fixture.state.operation?.id!==payload.operationId)throw new Error('这次操作已经结束');
  return fixture.update({operation:undefined,login:undefined,codex:fixture.state.codex.status==='checking'?{status:'unchecked'}:fixture.state.codex});
 }
 if(command==='onboarding:workspace/pick'){
  if(fixture.cancelPick){fixture.cancelPick=false;return fixture.update({workspace:{candidate:undefined}});}
  return fixture.update({stage:'workspace',workspace:{candidate:{id:'candidate-1',path:'/fixture/projects/selected'},error:undefined}});
 }
 if(command==='onboarding:workspace/confirm'){
  if(fixture.state.workspace.candidate?.id!==payload.candidateId)throw new Error('目录候选已失效');
  return fixture.begin('workspace-check','正在检查目录访问',{stage:'workspace'});
 }
 if(command==='onboarding:browser/prepare')return fixture.begin('prepare-browser','正在启动网页工具',{stage:'browser',browser:{status:'preparing'}});
 if(command==='onboarding:complete')return fixture.begin('detect','正在核对最终准备状态',{stage:'ready'});
 if(command==='onboarding:defer')return fixture.update({operation:undefined,login:undefined,status:fixture.mode==='legacy'?'legacy':'deferred'});
 if(command==='browser:element-details')return structuredClone(fixture.element);
 if(command==='conversation:new'){
  const conversation={id:'new-'+fixture.calls.length,title:'新对话',workspace:fixture.snapshot.settings.workspace,updatedAt:Date.now(),messages:[]};
  fixture.snapshot.conversations.unshift(conversation);
  fixture.emit({type:'conversation:updated',conversation:structuredClone(conversation)});
  return conversation;
 }
 if(command==='conversation:send')return {conversationId:payload.id||'submitted-in-new-project'};
 if(command==='models:list')return [];
 if(command==='conversation:prepare')return {status:'ready',conversationId:payload.conversationId};
 if(command==='share:state')return {active:false,participants:[]};
 if(command==='usage:snapshot')return {records:[],since:Date.now(),updatedAt:Date.now()};
 if(command==='neo:records')return [];
 if(command==='browser:resize')return payload;
 return true;
},onEvent(listener){fixture.listeners.push(listener);return()=>{fixture.listeners=fixture.listeners.filter(item=>item!==listener)}}};
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(App)));
`;
const plugin: Plugin = {
  name: 'onboarding-ui-fixture',
  resolveId(id) {
    if (id === '/onboarding-entry.js') return '\0onboarding-entry';
  },
  load(id) {
    if (id === '\0onboarding-entry') return entry;
  },
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith('/?') && request.url !== '/') return next();
      response.setHeader('content-type', 'text/html');
      response.end(
        await server.transformIndexHtml(
          '/index.html',
          '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/onboarding-entry.js"></script>',
        ),
      );
    });
  },
};
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: path.join(output, '.vite-cache'),
  appType: 'custom',
  logLevel: 'error',
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: {
    include: [
      'react',
      'react-dom/client',
      'react/jsx-runtime',
      'motion/react',
      '@heroui/react',
      '@heroui-pro/react',
    ],
  },
  plugins: [react(), tailwindcss(), plugin],
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
const errors: string[] = [];
const checks: string[] = [];
let activePage: Page | undefined;
const createPage = async (mode = 'fresh', dark = false, animate = false) => {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    reducedMotion: animate ? 'no-preference' : 'reduce',
    ...(animate
      ? { recordVideo: { dir: path.join(output, 'video'), size: { width: 1280, height: 800 } } }
      : {}),
  });
  activePage = page;
  await page.addInitScript('window.__name = value => value;');
  if (dark) await page.addInitScript(() => localStorage.setItem('athena.appearance', 'dark'));
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.goto(`http://127.0.0.1:${port}/?mode=${mode}`);
  return page;
};
const update = (page: Page, patch: object) =>
  page.evaluate((patch) => (window as any).__onboardingFixture.update(patch), patch);
const calls = (page: Page, command: string) =>
  page.evaluate(
    (command) =>
      (window as any).__onboardingFixture.calls.filter((item: any) => item.command === command),
    command,
  );
const current = (page: Page) => page.locator('.onboarding-message.is-current');
try {
  const page = await createPage();
  await expect(page.getByRole('status')).toHaveText('正在打开工作区…');
  assert.equal((await calls(page, 'models:list')).length, 0);
  await page.evaluate(() => (window as any).__onboardingFixture.release());
  await expect(current(page).getByRole('heading')).toHaveText('hello, Athena.');
  await expect(page.locator('.onboarding-progress-track')).toHaveAttribute('aria-valuenow', '1');
  await expect(page.locator('.app-workbench')).toHaveCount(0);
  for (const key of ['n', 'l', 't', 'w', 'k', 'b'])
    await page.evaluate(
      (key) =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true }),
        ),
      key,
    );
  assert.equal((await calls(page, 'models:list')).length, 0);
  assert.equal((await calls(page, 'conversation:new')).length, 0);
  await expect(page.getByRole('dialog', { name: '搜索对话' })).toHaveCount(0);
  const geometry = await page.evaluate(() => {
    const speaker = document.querySelector('.onboarding-message-heading')!;
    const logo = speaker.querySelector('img')!;
    const title = speaker.querySelector('h1')!;
    return {
      transcriptWidth: document.querySelector('.onboarding-transcript')!.getBoundingClientRect()
        .width,
      logo: logo.getBoundingClientRect().toJSON(),
      title: title.getBoundingClientRect().toJSON(),
      fontSize: getComputedStyle(title).fontSize,
      lineHeight: getComputedStyle(title).lineHeight,
      cssAnimation: getComputedStyle(speaker).animationName,
      animationDuration: getComputedStyle(speaker).animationDuration,
      transform: getComputedStyle(speaker).transform,
    };
  });
  assert.equal(geometry.transcriptWidth, 760);
  assert.equal(geometry.logo.width, 132);
  assert.ok(
    Math.abs(
      geometry.title.x + geometry.title.width / 2 - geometry.logo.x - geometry.logo.width / 2,
    ) < 1,
  );
  assert.ok(geometry.title.top >= geometry.logo.bottom);
  assert.ok(parseFloat(geometry.fontSize) >= 68);
  assert.ok(parseFloat(geometry.animationDuration) <= 0.08);
  assert.equal(geometry.transform, 'none');
  await page.screenshot({ path: path.join(output, 'welcome.png') });
  checks.push(
    'Fresh snapshot gate mounts no workbench or ModelPicker; shortcuts do not mutate hidden UI; welcome geometry and reduced motion match the contract',
  );

  await page.getByRole('button', { name: '你能帮我做什么？', exact: true }).click();
  await page.evaluate(() => {
    (window as any).__onboardingFixture.holdNextRefresh = true;
  });
  await page.getByRole('button', { name: '开始配置', exact: true }).click();
  await expect(current(page)).toContainText('正在核对本机 Codex');
  await update(page, {
    operation: undefined,
    codex: { status: 'missing' },
  });
  await expect(current(page)).toContainText('先准备一位 AI Agent。');
  await page.evaluate(() => (window as any).__onboardingFixture.releaseRefresh());
  await expect(current(page)).toContainText('先准备一位 AI Agent。');
  await page.getByRole('button', { name: '准备安装 Codex', exact: true }).click();
  await expect(current(page)).toContainText('/fixture/user/bin/codex');
  await expect(current(page)).toContainText('待服务器确认');
  await expect(page.locator('.onboarding-message.user')).toHaveCount(3);
  await expect(page.locator('.is-history .onboarding-actions')).toHaveCount(0);
  await page.setViewportSize({ width: 900, height: 760 });
  const scroll = page.locator('.onboarding-scroll');
  await expect
    .poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThan(3);
  await expect(page.locator('.onboarding')).toHaveAttribute('data-scrolled', 'false');
  await page.screenshot({ path: path.join(output, 'install-plan-900.png') });
  const atBottom = await scroll.evaluate((node) => node.scrollTop);
  await scroll.dispatchEvent('wheel', { deltaY: -40 });
  await scroll.evaluate((node) => {
    node.scrollTop -= 40;
  });
  await expect(page.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
  const manualPosition = await scroll.evaluate((node) => node.scrollTop);
  assert.ok(atBottom - manualPosition >= 35);
  await update(page, {});
  assert.ok(
    Math.abs((await scroll.evaluate((node) => node.scrollTop)) - manualPosition) <= 2,
    'A small upward scroll must not be overwritten by a host update',
  );
  await page.getByRole('button', { name: '回到最新', exact: true }).click();
  await page.getByRole('button', { name: '下载并安装', exact: true }).click();
  const operationCount = await page.locator('.onboarding-message.assistant').count();
  const installing = await page.evaluate(() =>
    structuredClone((window as any).__onboardingFixture.state),
  );
  await update(page, {
    operation: {
      ...installing.operation,
      phase: 'download',
      message: '正在下载官方分发',
      receivedBytes: 1024,
    },
  });
  await update(page, {
    operation: {
      ...installing.operation,
      phase: 'verify',
      message: '正在校验下载文件',
      receivedBytes: 2048,
      totalBytes: 2048,
    },
  });
  assert.equal(
    await page.locator('.onboarding-message.assistant').count(),
    operationCount,
    'Progress callbacks update one operation card',
  );
  await page.getByRole('button', { name: '取消安装', exact: true }).click();
  await expect(current(page)).toContainText('这次先停在这里。');
  await page.evaluate(
    (old) =>
      (window as any).__onboardingFixture.late({
        ...old,
        codex: { status: 'ready' },
        coreReady: true,
      }),
    installing,
  );
  await expect(current(page)).toContainText('这次先停在这里。');
  checks.push(
    'Actions become read-only history; plan shows actual metadata without invented totals; current long plan is not blurred; small upward scroll stays put; progress is in-place; older command responses and cancelled late events cannot regress the current state',
  );

  await page.getByRole('button', { name: '重新检查', exact: true }).click();
  await update(page, {
    operation: undefined,
    codex: { status: 'ready', path: '/fixture/codex' },
    stage: 'workspace',
  });
  await expect(current(page)).toContainText('连接好了。');
  await expect(current(page).locator('.onboarding-status-label')).toHaveText('已连接');
  await expect(page.getByRole('progressbar', { name: '准备步骤' })).toHaveAttribute(
    'aria-valuetext',
    '第 2 步，共 4 步：连接',
  );
  assert.equal((await calls(page, 'onboarding:login/start')).length, 0);
  await page.getByRole('button', { name: '查看连接详情', exact: true }).click();
  await expect(current(page)).toContainText('/fixture/codex');
  await page.getByRole('button', { name: '登录 Codex 账号', exact: true }).click();
  await expect(current(page)).toContainText('我在这里等你。');
  await expect(page.getByRole('button', { name: '取消登录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重新打开登录页', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'onboarding:login/reopen')).length).toBe(1);
  await expect(current(page)).toContainText('我在这里等你。');
  const later = page.getByRole('button', { name: '跳过设置', exact: true });
  await later.focus();
  await update(page, { operation: undefined, login: undefined });
  await expect(current(page)).toContainText('连接好了。');
  await expect(later).toBeFocused();
  assert.equal((await calls(page, 'onboarding:login/start')).length, 1);
  await page.getByRole('button', { name: '查看连接详情', exact: true }).click();
  await expect(current(page)).toContainText('/fixture/codex');
  await page.getByRole('button', { name: '返回准备', exact: true }).click();
  await page.evaluate(() => {
    (window as any).__onboardingFixture.cancelPick = true;
  });
  await page.getByRole('button', { name: '选择项目文件夹', exact: true }).click();
  await expect(current(page)).toContainText('我们在哪里开始？');
  assert.equal(
    await page.evaluate(() => (window as any).__onboardingFixture.snapshot.settings.workspace),
    '/fixture/original',
  );
  await page.getByRole('button', { name: '选择项目文件夹', exact: true }).click();
  await expect(current(page)).toContainText('/fixture/projects/selected');
  assert.equal(
    await page.evaluate(() => (window as any).__onboardingFixture.snapshot.settings.workspace),
    '/fixture/original',
  );
  await page.getByRole('button', { name: '使用这个目录', exact: true }).click();
  await expect(current(page)).toContainText('我确认一下，这个文件夹能不能使用。');
  await update(page, {
    operation: undefined,
    workspace: { status: 'error', error: '此目录当前不可写' },
  });
  await expect(current(page)).toContainText('此目录当前不可写');
  await page.getByRole('button', { name: '重试访问', exact: true }).click();
  await update(page, {
    operation: undefined,
    coreReady: true,
    stage: 'browser',
    workspace: {
      status: 'ready',
      path: '/fixture/projects/selected',
      candidate: undefined,
      error: undefined,
    },
  });
  await expect(current(page)).toContainText('接下来，把网页也接上。');
  checks.push(
    'A detected runtime is connected without any login step; signing in is optional from the connection details and returns to the connected state; footer focus is retained; connected/details remain reachable; directory cancel and candidate selection do not commit; access failure is recoverable',
  );

  await page.getByRole('button', { name: '准备浏览器', exact: true }).click();
  await expect(current(page)).toContainText('我正在打开我们的第一页，稍等一下。');
  await update(page, { operation: undefined, browser: { status: 'ready' }, stage: 'ready' });
  await expect.poll(async () => (await calls(page, 'onboarding:complete')).length).toBe(1);
  await expect(page.locator('.onboarding')).toBeVisible();
  await expect(page.locator('.app-workbench')).toHaveCount(0);
  await expect(current(page)).toHaveAttribute('data-screen', 'ready');
  await expect(current(page)).toContainText('准备好了，轮到你的想法。');
  await expect(current(page).locator('.onboarding-activity')).toHaveCount(0);
  await expect(current(page).locator('.onboarding-actions')).toHaveCount(0);
  await expect(
    page.locator('.onboarding-message.assistant + .onboarding-message.assistant'),
  ).toHaveCount(0);
  await update(page, {
    operation: undefined,
    status: 'complete',
    requiresSetup: false,
    coreReady: true,
    stage: 'ready',
  });
  await expect(page.locator('.onboarding')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '今天想完成什么？' })).toBeVisible();
  await expect(page.locator('.workspace-selector')).toContainText('selected');
  assert.equal((await calls(page, 'conversation:new')).length, 0);
  assert.equal((await calls(page, 'conversation:send')).length, 0);
  assert.equal((await calls(page, 'onboarding:complete')).length, 1);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator('.browser-toggle')).toHaveAttribute('aria-label', '收起浏览器');
  await expect
    .poll(() =>
      page.locator('.workspace-panels').evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBe(808);
  await expect
    .poll(() =>
      page.locator('.browser-drawer').evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBe(390);
  await page.keyboard.press('Meta+b');
  await expect
    .poll(() =>
      page.locator('.workspace-panels').evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBe(1024);
  await expect
    .poll(() =>
      page.locator('.browser-drawer').evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBe(512);
  await page.keyboard.press('Meta+b');
  await expect
    .poll(() =>
      page.locator('.browser-drawer').evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBe(390);
  checks.push(
    'Athena never speaks twice in a row: the automatic final check is silent and leaves the ready message as the last one',
    'Automatic handoff waits for the matching asynchronous complete event, then enters the workbench and refreshes actual directory/agent state without creating or sending a conversation; the newly mounted panel ResizeObserver tracks 1024px viewport and sidebar changes',
  );
  await page.close();

  const skip = await createPage('fresh', true);
  await skip.evaluate(() => (window as any).__onboardingFixture.release());
  await expect(skip.locator('html')).toHaveAttribute('data-theme', 'dark');
  await skip.getByRole('button', { name: '开始配置', exact: true }).click();
  await update(skip, {
    operation: undefined,
    codex: { status: 'ready' },
    workspace: { status: 'ready' },
    coreReady: true,
    stage: 'browser',
  });
  await skip.getByRole('button', { name: '选择 Codex', exact: true }).click();
  await skip.getByRole('button', { name: '以后再说', exact: true }).click();
  await update(skip, {
    operation: undefined,
    status: 'complete',
    requiresSetup: false,
    coreReady: true,
    browser: { status: 'deferred' },
    stage: 'ready',
  });
  await expect(skip.locator('.onboarding')).toHaveCount(0);
  await expect(skip.locator('.app-workbench')).toBeVisible();
  await expect(skip.locator('.browser-drawer')).toHaveAttribute('aria-hidden', 'true');
  await skip.screenshot({ path: path.join(output, 'browser-deferred-ready.png') });
  checks.push(
    'Optional browser skip waits for its real completion and enters the workbench without opening an unprepared browser',
  );
  await skip.close();

  const legacy = await createPage('legacy');
  await legacy.evaluate(() => (window as any).__onboardingFixture.release());
  await expect(legacy.locator('.onboarding')).toHaveCount(0);
  await expect(legacy.locator('.app-workbench')).toBeVisible();
  await legacy.getByRole('button', { name: '展开浏览器', exact: true }).click();
  const draft = legacy.getByRole('textbox', { name: '发送给 Agent 的任务' });
  await draft.fill('保留已有用户的草稿');
  await legacy.locator('.sidebar-settings').click();
  await legacy.getByRole('button', { name: '重新查看引导', exact: true }).click();
  await expect(current(legacy)).toContainText('欢迎回来，我们接着来。');
  await expect(legacy.locator('.app-workbench')).toHaveAttribute('inert', '');
  assert.equal(await legacy.locator('.app-workbench').count(), 1);
  assert.equal(
    await legacy
      .locator('.workspace-panels')
      .evaluate((node) => (node as HTMLElement).style.getPropertyValue('--browser-drawer-width')),
    '620px',
  );
  await legacy.evaluate(() => {
    const fixture = (window as any).__onboardingFixture;
    fixture.emit({
      type: 'conversation:updated',
      conversation: {
        ...fixture.snapshot.conversations[0],
        messages: [
          {
            id: 'live-update',
            role: 'assistant',
            text: '引导期间收到的实时结果',
            status: 'done',
            createdAt: Date.now(),
          },
        ],
      },
    });
  });
  await legacy.getByRole('button', { name: '跳过设置', exact: true }).click();
  await expect(legacy.locator('.onboarding')).toHaveCount(0);
  await expect(legacy.locator('.settings-workspace')).toBeVisible();
  await legacy.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(draft).toHaveText('保留已有用户的草稿');
  await expect(legacy.getByText('引导期间收到的实时结果', { exact: true })).toBeVisible();
  await expect(legacy.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  assert.equal((await calls(legacy, 'conversation:stop')).length, 0);
  assert.equal((await calls(legacy, 'conversation:new')).length, 0);
  checks.push(
    'Legacy profiles bypass onboarding; manually reopening keeps the mounted workbench inert, and deferring restores settings/current conversation/draft without revoking readiness or overwriting a newer conversation event with the exit snapshot',
  );
  await legacy.close();

  const transfer = await createPage('legacy');
  await transfer.evaluate(() => (window as any).__onboardingFixture.release());
  const transferDraft = transfer.getByRole('textbox', { name: '发送给 Agent 的任务' });
  await transferDraft.fill('项目 A 的任务草稿');
  await transfer.evaluate(() => {
    const fixture = (window as any).__onboardingFixture;
    fixture.element = {
      ref: 'element-A',
      tabId: 'tab-A',
      frameId: 'frame-A',
      documentId: 'document-A',
      nodeId: 'node-A',
      tag: 'button',
      role: 'button',
      name: '项目 A 按钮',
      textContent: '原始文字',
      editableText: true,
      attributes: {},
      ancestors: [],
      computed: {
        color: '#171717',
        'background-color': '#ffffff',
        'font-size': '14px',
        'border-radius': '8px',
        width: '120px',
        height: '40px',
      },
      bounds: { x: 10, y: 10, width: 120, height: 40 },
    };
    fixture.snapshot.browser = {
      ...fixture.snapshot.browser,
      status: 'ready',
      activeTabId: 'tab-A',
      selectedElement: fixture.element,
      previewEdits: [
        {
          editId: 'preview-A',
          tabId: 'tab-A',
          frameId: 'frame-A',
          documentId: 'document-A',
          nodeId: 'node-A',
          changes: { styles: { color: '#123456' } },
        },
      ],
    };
    fixture.emit({ type: 'browser:state', state: structuredClone(fixture.snapshot.browser) });
  });
  await transfer.getByRole('button', { name: '元素检查器', exact: true }).click();
  await transfer.getByRole('button', { name: '修改源码', exact: true }).click();
  await expect(transfer.locator('.composer .element-token')).toContainText('项目 A 按钮');
  await transfer.getByRole('button', { name: '元素检查器', exact: true }).click();
  await transfer.getByRole('tab', { name: '内容', exact: true }).click();
  await transfer
    .getByRole('textbox', { name: '元素文字', exact: true })
    .fill('项目 A 未提交的元素文字');
  await transfer.locator('.sidebar-settings').click();
  await transfer.getByRole('button', { name: '重新查看引导', exact: true }).click();
  await transfer.getByRole('button', { name: '跳过设置', exact: true }).click();
  await transfer.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(transferDraft).toContainText('项目 A 的任务草稿');
  await expect(transfer.locator('.composer .element-token')).toContainText('项目 A 按钮');
  await expect(transfer.getByRole('textbox', { name: '元素文字', exact: true })).toHaveValue(
    '项目 A 未提交的元素文字',
  );
  await transfer.locator('.sidebar-settings').click();
  await transfer.getByRole('button', { name: '重新查看引导', exact: true }).click();
  await transfer.getByRole('button', { name: '重新检查', exact: true }).click();
  await update(transfer, {
    operation: undefined,
    coreReady: false,
    codex: { status: 'ready' },
    workspace: { status: 'error', error: '项目 A 目录已移动' },
    stage: 'workspace',
  });
  await transfer.getByRole('button', { name: '重新选择目录', exact: true }).click();
  await expect(current(transfer)).toContainText('切换项目会清除当前草稿和页面源码上下文');
  await transfer.getByRole('button', { name: '使用这个目录', exact: true }).click();
  await update(transfer, {
    operation: undefined,
    coreReady: true,
    workspace: {
      status: 'ready',
      path: '/fixture/projects/selected',
      candidate: undefined,
      error: undefined,
    },
    stage: 'ready',
  });
  await transfer.getByRole('button', { name: '进入 Athena', exact: true }).click();
  await update(transfer, {
    operation: undefined,
    status: 'complete',
    requiresSetup: false,
    coreReady: true,
    stage: 'ready',
  });
  await expect(transfer.locator('.onboarding')).toHaveCount(0);
  await transfer.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(transferDraft).toHaveText('');
  await expect(transfer.locator('.composer .element-token')).toHaveCount(0);
  await expect(transfer.locator('.element-workspace')).toBeHidden();
  await expect(transfer.locator('.topbar-title')).toContainText('新对话');
  await transferDraft.fill('项目 B 的新任务');
  const unsent = transfer.getByRole('button', { name: '未发送草稿', exact: true });
  await expect(unsent).toHaveAttribute('aria-current', 'page');
  assert.equal((await calls(transfer, 'conversation:new')).length, 0);
  await transfer.keyboard.press('Meta+n');
  const savedChat = transfer.locator('.conversation-link').filter({ hasText: '新对话' });
  await expect(savedChat).toHaveAttribute('aria-current', 'page');
  await expect(transferDraft).toHaveText('');
  await transferDraft.fill('另一段对话的草稿');
  await unsent.click();
  await expect(transferDraft).toHaveText('项目 B 的新任务');
  await savedChat.click();
  await expect(transferDraft).toHaveText('另一段对话的草稿');
  await unsent.click();
  await expect(transferDraft).toHaveText('项目 B 的新任务');
  await transferDraft.press('Enter');
  await expect(unsent).toHaveCount(0);
  const submitted = (await calls(transfer, 'conversation:send')).at(-1);
  assert.equal(submitted.payload.id, undefined);
  assert.equal(submitted.payload.text, '项目 B 的新任务');
  assert.equal(submitted.payload.selectedRef, undefined);
  assert.equal(submitted.payload.context, undefined);
  assert.equal((await calls(transfer, 'conversation:new')).length, 1);
  checks.push(
    'Unchanged workspace preserves chat draft, selected element and inspector draft; confirmed A-to-B switch clears all temporary source context without inventing a conversation, and the next send contains no A reference',
    'The first draft in the new workspace stays reachable after creating and switching chats. Sending it without a host ID removes its local sidebar entry.',
  );
  await transfer.close();

  const deferred = await createPage('deferred');
  await deferred.evaluate(() => (window as any).__onboardingFixture.release());
  await expect(deferred.locator('.onboarding')).toHaveCount(0);
  await expect(deferred.getByRole('button', { name: '继续准备', exact: true })).toBeVisible();
  await deferred.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill('尚未准备好');
  await expect(deferred.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  await deferred.getByRole('button', { name: '继续准备', exact: true }).click();
  await expect(deferred.locator('.onboarding')).toBeVisible();
  checks.push(
    'Deferred fresh setup is non-blocking to the workbench but cannot send before core readiness; Continue reopens the actual preparation flow',
  );
  await deferred.close();

  const cursor = await createPage();
  await cursor.evaluate(() => (window as any).__onboardingFixture.release());
  await cursor.getByRole('button', { name: '开始配置', exact: true }).click();
  const cursorInfo = {
    id: 'cursor',
    name: 'Cursor Agent',
    available: true,
    supported: true,
    path: '/fixture/Cursor Agent/bin/cursor-agent',
  };
  await update(cursor, {
    operation: undefined,
    selectedAgent: 'cursor',
    executor: cursorInfo,
    agents: [cursorInfo],
  });
  await cursor.getByRole('button', { name: '选择 Cursor Agent', exact: true }).click();
  await expect(current(cursor).getByRole('heading')).toHaveText('已找到本机 Cursor Agent。');
  await expect(current(cursor).locator('.onboarding-status-label')).toHaveText('已连接');
  await expect(current(cursor).locator('.onboarding-status-icon > svg')).toHaveCount(1);
  await expect(current(cursor).locator('.onboarding-status-icon > img')).toHaveCount(0);
  await expect(cursor.getByRole('progressbar', { name: '准备步骤' })).toHaveAttribute(
    'aria-valuenow',
    '2',
  );
  await expect(cursor.getByRole('progressbar', { name: '准备步骤' })).toHaveAttribute(
    'aria-valuetext',
    '第 2 步，共 4 步：连接',
  );
  await expect(cursor.locator('.onboarding-step-number')).toHaveCount(0);
  await expect(cursor.locator('.onboarding-footer ol')).toHaveCount(0);
  await expect(cursor.locator('.onboarding')).not.toContainText('登录');
  await cursor.screenshot({ path: path.join(output, 'cursor-connected.png') });
  await cursor.setViewportSize({ width: 1060, height: 760 });
  await expect(cursor.locator('.onboarding-top-progress')).toBeInViewport();
  const skipSetup = cursor.getByRole('button', { name: '跳过设置', exact: true });
  await expect(skipSetup).toBeInViewport();
  const skipStyle = await skipSetup.evaluate((node) => ({
    background: getComputedStyle(node).backgroundColor,
    height: node.getBoundingClientRect().height,
  }));
  assert.ok(skipStyle.height >= 44);
  await expect(
    current(cursor).getByRole('button', { name: '先不选文件夹', exact: true }),
  ).toBeInViewport();
  await cursor.screenshot({ path: path.join(output, 'cursor-connected-1060.png') });
  await cursor.getByRole('button', { name: '查看连接详情', exact: true }).click();
  await expect(current(cursor)).toContainText('/fixture/Cursor Agent/bin/cursor-agent');
  await expect(cursor.getByRole('button', { name: '登录 Codex 账号', exact: true })).toHaveCount(0);
  await cursor.getByRole('button', { name: '返回准备', exact: true }).click();
  assert.equal((await calls(cursor, 'onboarding:login/start')).length, 0);
  await expect(cursor.locator('.is-history .onboarding-actions')).toHaveCount(0);
  checks.push(
    'A detected Cursor Agent is connected at once: no login state, login command or login action is shown, and its details list only the local path',
  );
  await cursor.getByRole('button', { name: '先不选文件夹', exact: true }).click();
  await update(cursor, {
    operation: undefined,
    coreReady: true,
    workspace: { status: 'ready', mode: 'personal', path: '/fixture/personal' },
  });
  await expect(current(cursor)).toContainText('进入工作台后新建一个 Codex 对话');
  checks.push(
    'A selected non-Codex Agent can prepare the browser without being promised unsupported Agent browser tools',
  );
  await cursor.close();

  const darkCursor = await createPage('fresh', true);
  await darkCursor.evaluate(() => (window as any).__onboardingFixture.release());
  await darkCursor.getByRole('button', { name: '开始配置', exact: true }).click();
  await update(darkCursor, {
    operation: undefined,
    selectedAgent: 'cursor',
    executor: { ...cursorInfo, path: undefined },
    agents: [cursorInfo],
  });
  await darkCursor.getByRole('button', { name: '选择 Cursor Agent', exact: true }).click();
  await expect(darkCursor.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(current(darkCursor).getByRole('heading')).toHaveText('已找到本机 Cursor Agent。');
  await darkCursor.screenshot({ path: path.join(output, 'cursor-connected-dark.png') });
  checks.push('A detected Cursor Agent without a reported path is connected in dark mode');
  await darkCursor.getByRole('button', { name: '跳过设置', exact: true }).click();
  await expect(darkCursor.locator('.onboarding')).toHaveCount(0);
  await expect(darkCursor.getByRole('button', { name: '继续准备', exact: true })).toBeVisible();
  await darkCursor.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill('准备完成后再发送');
  await expect(darkCursor.getByRole('button', { name: '发送任务', exact: true })).toBeDisabled();
  const deferredCursor = await darkCursor.evaluate(() => (window as any).__onboardingFixture.state);
  assert.equal(deferredCursor.status, 'deferred');
  assert.equal(deferredCursor.selectedAgent, 'cursor');
  assert.equal(deferredCursor.workspace.status, 'unchecked');
  assert.equal((await calls(darkCursor, 'onboarding:defer')).length, 1);
  assert.equal((await calls(darkCursor, 'conversation:send')).length, 0);
  checks.push(
    'Skip exits setup, preserves the selected CLI, and keeps sending disabled until the workspace is ready',
  );
  await darkCursor.close();

  const flow = await createPage('fresh', false, true);
  const video = flow.video();
  await flow.evaluate(() => (window as any).__onboardingFixture.release());
  await expect(current(flow).getByRole('heading')).toHaveText('hello, Athena.');
  await expect(flow.locator('.onboarding')).toHaveAttribute('data-intro-ready', 'false');
  await expect(flow.getByRole('button', { name: '开始配置', exact: true })).toHaveCount(0);
  await expect(flow.getByRole('button', { name: '开始配置', exact: true })).toBeVisible();
  await flow.screenshot({ path: path.join(output, 'welcome-motion.png') });
  const motionSamples = flow.evaluate(
    () =>
      new Promise<Array<{ t: number; logoWidth: number; userX?: number }>>((resolve) => {
        const samples: Array<{ t: number; logoWidth: number; userX?: number }> = [];
        const started = performance.now();
        const sample = () => {
          const logo = document
            .querySelector('.is-welcome .onboarding-message-heading img')!
            .getBoundingClientRect();
          const user = document.querySelector('.onboarding-message.user')?.getBoundingClientRect();
          samples.push({ t: performance.now() - started, logoWidth: logo.width, userX: user?.x });
          if (performance.now() - started < 1000) requestAnimationFrame(sample);
          else resolve(samples);
        };
        requestAnimationFrame(sample);
      }),
  );
  await flow.getByRole('button', { name: '开始配置', exact: true }).click();
  await expect(current(flow)).toHaveAttribute('data-screen', 'detecting');
  await expect(flow.getByRole('group', { name: '本机 AI Agent' })).toHaveCount(0);
  const samples = await motionSamples;
  await expect(current(flow).locator('.onboarding-status-card')).toHaveCount(0);
  await expect(current(flow).locator('.onboarding-activity-row')).toBeVisible();
  await expect(
    current(flow).getByRole('button', { name: '取消这次操作', exact: true }),
  ).toBeVisible();
  await flow.screenshot({ path: path.join(output, 'detecting-conversation.png') });
  assert.ok(
    samples.some((sample) => sample.logoWidth > 80),
    'The large logo is preserved at the start of the transition',
  );
  assert.ok(
    samples.some((sample) => sample.logoWidth > 42 && sample.logoWidth < 125),
    'The portrait must visibly shrink through intermediate sizes',
  );
  assert.ok(
    samples.at(-1)!.logoWidth <= 41,
    'The portrait settles into a compact conversation avatar',
  );
  const userPositions = samples.flatMap((sample) =>
    sample.userX === undefined ? [] : [sample.userX],
  );
  assert.ok(
    Math.max(...userPositions) - Math.min(...userPositions) > 30,
    'The selected option moves into a right-aligned user message',
  );
  await update(flow, {
    operation: undefined,
    codex: { status: 'ready', path: '/fixture/codex' },
    agents: [
      {
        id: 'claude',
        name: 'Claude Code',
        available: true,
        supported: true,
      },
      {
        id: 'cursor',
        name: 'Cursor Agent',
        available: true,
        supported: true,
      },
      { id: 'opencode', name: 'OpenCode', available: true, supported: false },
      { id: 'gemini', name: 'Gemini CLI', available: false, supported: true },
    ],
  });
  const capsules = flow.getByRole('group', { name: '本机 AI Agent' });
  await expect(capsules.getByRole('button')).toHaveCount(4);
  await expect(capsules.locator('.agent-icon')).toHaveCount(4);
  await expect(capsules.getByRole('button', { name: '选择 OpenCode', exact: true })).toBeDisabled();
  await expect(capsules.getByRole('button', { name: '选择 Gemini CLI', exact: true })).toHaveCount(
    0,
  );
  await expect
    .poll(() =>
      capsules
        .locator(':scope > div')
        .evaluateAll((nodes) =>
          nodes.every(
            (node) =>
              Number(getComputedStyle(node).opacity) >= 0.99 &&
              getComputedStyle(node).transform === 'none',
          ),
        ),
    )
    .toBe(true);
  await flow.screenshot({ path: path.join(output, 'agent-capsules.png') });
  await capsules.getByRole('button', { name: '选择 Codex', exact: true }).click();
  await flow.getByRole('button', { name: '先不选文件夹', exact: true }).click();
  assert.equal((await calls(flow, 'onboarding:workspace/pick')).length, 0);
  await update(flow, {
    operation: undefined,
    coreReady: true,
    stage: 'browser',
    workspace: { status: 'ready', mode: 'personal', path: '/fixture/personal' },
  });
  await flow.getByRole('button', { name: '准备浏览器', exact: true }).click();
  const history = flow.locator('.onboarding-scroll');
  await history.dispatchEvent('wheel', { deltaY: -300 });
  await history.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(flow.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
  await update(flow, { operation: undefined, browser: { status: 'ready' }, stage: 'ready' });
  await flow.waitForTimeout(1100);
  assert.equal(
    (await calls(flow, 'onboarding:complete')).length,
    0,
    'Reading earlier messages pauses the automatic handoff',
  );
  await flow.getByRole('button', { name: '回到最新', exact: true }).click();
  await expect.poll(async () => (await calls(flow, 'onboarding:complete')).length).toBe(1);
  await expect(flow.getByRole('button', { name: '进入 Athena', exact: true })).toHaveCount(0);
  await flow.screenshot({ path: path.join(output, 'ready-final-check.png') });
  await expect(
    flow.locator('.onboarding-message.assistant + .onboarding-message.assistant'),
  ).toHaveCount(0);
  await expect(flow.locator('.app-workbench')).toHaveCount(0);
  await history.dispatchEvent('wheel', { deltaY: -300 });
  await history.evaluate((node) => {
    node.scrollTop = 0;
  });
  await expect(flow.getByRole('button', { name: '回到最新', exact: true })).toBeVisible();
  await update(flow, { operation: undefined, status: 'complete', requiresSetup: false });
  await flow.waitForTimeout(1100);
  await expect(flow.locator('.onboarding')).toBeVisible();
  await expect(flow.locator('.app-workbench')).toHaveCount(0);
  assert.equal(
    (await calls(flow, 'onboarding:complete')).length,
    1,
    'Reading during final verification preserves completion without submitting it again',
  );
  await flow.getByRole('button', { name: '回到最新', exact: true }).click();
  await expect(flow.locator('.app-workbench')).toHaveAttribute('data-onboarding-enter', 'true');
  await expect(flow.locator('.app-workbench')).toHaveAttribute('inert', '');
  await expect(flow.locator('.browser-drawer')).toHaveClass(/is-open/);
  await expect(flow.locator('.onboarding')).toHaveCount(0);
  await expect(flow.locator('.workspace-selector')).toContainText('不绑定文件夹');
  await expect(flow.locator('.browser-toggle')).toHaveAttribute('aria-label', '收起浏览器');
  assert.equal((await calls(flow, 'conversation:send')).length, 0);
  await flow.screenshot({ path: path.join(output, 'workspace-handoff.png') });
  await writeFile(path.join(output, 'motion-samples.json'), JSON.stringify(samples, null, 2));
  await flow.close();
  await video?.saveAs(path.join(output, 'onboarding-flow.webm'));
  checks.push(
    'Animated welcome reveals options after its introduction; logo and chosen reply move continuously into conversation; detected agents have icon capsules; project-free setup hands off to the visible browser without a task submission',
  );

  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        passed: true,
        source: 'controlled-onboarding-host-protocol',
        realInstalls: 0,
        realLogins: 0,
        realModelCalls: 0,
        geometry,
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: path.join(output, 'failure.png') });
    console.log(
      JSON.stringify({
        errors,
        calls: await activePage.evaluate(() =>
          (window as any).__onboardingFixture?.calls.slice(-10),
        ),
      }),
    );
  }
  throw error;
} finally {
  await browser.close();
  await server.close();
}
