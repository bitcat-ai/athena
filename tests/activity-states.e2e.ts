/** Isolated renderer regression for turn status: every phase, request and outcome, inline. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createServer, type Plugin } from 'vite';
import type { ChatMessage, PendingAgentRequest } from '../src/shared/types';
import { uiBrowserExecutable } from './ui-browser';

const output = path.resolve('test-results/activity-states');
await mkdir(output, { recursive: true });
const now = Date.now();
const longCommand =
  'pnpm --filter @athena/renderer exec vitest run src/renderer/activity --reporter=verbose --coverage';
const turn = (patch: Partial<ChatMessage>): ChatMessage => ({
  id: 'turn',
  role: 'assistant',
  text: '',
  createdAt: now - 38_000,
  status: 'streaming',
  model: { model: 'gpt-5.2-codex', effort: 'high', source: 'thread-response' },
  ...patch,
});
const command = (id: string, text: string, patch = {}) => ({
  id,
  name: 'commandExecution',
  input: { command: text },
  status: 'done' as const,
  startedAt: now - 30_000,
  durationMs: 4200,
  ...patch,
});
const turns: Record<string, ChatMessage> = {
  preparing: turn({ model: undefined }),
  thinking: turn({}),
  acting: turn({
    plan: [
      { step: '阅读首页结构', status: 'completed', startedAt: now - 36_000 },
      { step: '调整按钮文案并构建', status: 'inProgress', startedAt: now - 20_000 },
      { step: '核对页面效果', status: 'pending' },
    ],
    tools: [
      {
        id: 'read',
        name: 'workbench_browser_snapshot',
        input: { page: 1 },
        status: 'done',
        startedAt: now - 34_000,
        durationMs: 800,
      },
      command('build', longCommand, {
        status: 'running',
        startedAt: now - 9000,
        durationMs: undefined,
      }),
    ],
  }),
  approval: turn({ tools: [command('lint', 'npm run lint')] }),
  input: turn({ tools: [command('lint', 'npm run lint')] }),
  handoff: turn({ tools: [command('lint', 'npm run lint')] }),
  done: turn({
    status: 'done',
    text: '按钮文案已经改好，构建通过。',
    phase: { kind: 'ended', outcome: 'succeeded' },
    endedAt: now,
    plan: [{ step: '调整按钮文案并构建', status: 'completed', startedAt: now - 36_000 }],
    tools: [
      {
        id: 'edit',
        name: 'fileChange',
        input: { changes: { '/workspace/athena/src/renderer/Home.tsx': {} } },
        status: 'done',
        startedAt: now - 30_000,
        durationMs: 300,
      },
      command('build', 'npm run build', {
        output: 'built in 3.9s',
        exitCode: 0,
        startedAt: now - 20_000,
      }),
    ],
    requests: [
      {
        id: 'r1',
        kind: 'approval',
        summary: 'npm run build',
        resolution: 'approved',
        at: now - 22_000,
      },
    ],
    execution: [
      {
        id: 'check',
        taskId: 't',
        at: now - 6000,
        kind: 'checkpoint',
        status: 'succeeded',
        outcome: 'verified',
        summary: '按钮文案为「开始使用」',
        evidence: '开始使用',
      },
      {
        id: 'file',
        taskId: 't',
        at: now - 3000,
        kind: 'artifact',
        status: 'succeeded',
        artifact: { path: '/tmp/report.pdf', bytes: 48_213, sha256: 'x' },
      },
    ],
  }),
  blocked: turn({
    status: 'done',
    text: '我已经提交了表单，但没能在页面上确认结果。',
    phase: { kind: 'ended', outcome: 'blocked' },
    endedAt: now,
    tools: [
      {
        id: 'click',
        name: 'neo_act',
        input: { page: 1 },
        status: 'done',
        startedAt: now - 20_000,
        durationMs: 900,
      },
    ],
    execution: [
      {
        id: 'check',
        taskId: 't',
        at: now - 6000,
        kind: 'checkpoint',
        status: 'blocked',
        outcome: 'unknown',
        summary: '订单状态显示为「已提交」，且页面顶部出现提交成功的提示条',
      },
    ],
  }),
  failed: turn({
    status: 'error',
    text: 'Process exited with code 1',
    failure: 'Process exited with code 1',
    phase: { kind: 'ended', outcome: 'failed' },
    endedAt: now,
    tools: [
      command('lint', 'npm run lint'),
      command('test', longCommand, {
        status: 'error',
        exitCode: 1,
        output:
          'FAIL src/renderer/activity.test.ts\n  ✕ renders the row (12 ms)\n\nTests: 1 failed, 6 passed',
      }),
    ],
  }),
  cancelled: turn({
    status: 'done',
    text: '任务已停止',
    phase: { kind: 'ended', outcome: 'cancelled' },
    endedAt: now,
    tools: [
      command('lint', 'npm run lint'),
      command('build', 'npm run build', { status: 'running' }),
    ],
  }),
};
const pending = (state: string, value: object) =>
  ({ conversationId: state, messageId: `${state}-turn`, ...value }) as PendingAgentRequest;
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
      version: 'fixture',
    },
  ],
  codexConnection: { status: 'ready', conversationId: 'thinking' },
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
  conversations: Object.entries(turns).map(([id, message], index) => ({
    id,
    title: `状态 ${id}`,
    updatedAt: now - index,
    workspace: '/workspace/athena',
    // Ids are unique per conversation, as in the store, so expanded rows do not carry over.
    messages: [
      { id: `${id}-ask`, role: 'user', text: '调整首页按钮', createdAt: now - 40_000 },
      { ...message, id: `${id}-turn` },
    ],
  })),
  pendingRequests: [
    pending('approval', {
      kind: 'approval',
      request: {
        id: 'a',
        kind: 'command',
        title: '运行这条命令？',
        detail: longCommand,
        target: longCommand,
      },
    }),
    pending('input', {
      kind: 'input',
      request: {
        id: 'q',
        questions: [
          {
            id: 'env',
            header: '部署环境需要你来决定，这段说明很长很长很长很长很长很长',
            question: '要部署到哪个环境？',
            isSecret: false,
            isOther: true,
            options: [
              { label: '预发', description: '只影响内部测试' },
              { label: '生产', description: '对所有用户生效' },
            ],
          },
        ],
      },
    }),
    pending('handoff', {
      kind: 'approval',
      request: {
        id: 'h',
        kind: 'other',
        action: 'browser-help',
        title: '请完成登录验证',
        detail: '页面要求短信验证码，我无法代你完成。验证后回到这里继续。',
      },
    }),
  ],
};
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '/src/renderer/App';
import '/src/renderer/styles.css';
const fixture=window.__fixture={snapshot:${JSON.stringify(snapshot)},listeners:[],calls:[]};
fixture.emit=event=>{for(const listener of fixture.listeners)listener(event)};
window.workbench={
 async invoke(action,payload){
  fixture.calls.push({action,payload});
  if(action==='app:snapshot')return structuredClone(fixture.snapshot);
  if(action==='codex:update-status')return {status:'unknown'};
  if(action==='models:list')return [];
  if(action==='conversation:prepare')return {status:'ready',conversationId:payload.conversationId};
  if(action==='share:state')return {active:false,participants:[]};
  if(action==='usage:snapshot')return {records:[],since:Date.now(),updatedAt:Date.now()};
  if(action==='neo:records')return [];
  if(action==='browser:resize')return {width:payload.width,height:payload.height,tabId:payload.tabId};
  return true;
 },
 onEvent(fn){fixture.listeners.push(fn);return()=>{fixture.listeners=fixture.listeners.filter(item=>item!==fn)}}
};
createRoot(document.getElementById('root')).render(React.createElement(App));
`;
const fixture: Plugin = {
  name: 'activity-states-fixture',
  resolveId: (id) => (id === '/activity-entry.js' ? '\0activity-entry' : undefined),
  load: (id) => (id === '\0activity-entry' ? entry : undefined),
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/') return next();
      response.setHeader('content-type', 'text/html');
      response.end(
        await server.transformIndexHtml(
          '/index.html',
          '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/activity-entry.js"></script>',
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
const errors: string[] = [];
let checks = 0;
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  page.setDefaultTimeout(8000);
  await page.addInitScript('window.__name = (value) => value;');
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}`);
  const list = page.locator('.conversation-list');
  const open = async (state: string) => {
    await list.getByRole('button', { name: new RegExp(`^状态 ${state}`) }).click();
    await expect(page.locator('.topbar-title')).toContainText(`状态 ${state}`);
  };
  const activity = page.locator('.activity');
  const title = activity.locator('.act-title');
  const calls = (action: string) =>
    page.evaluate(
      (name) =>
        (window as any).__fixture.calls
          .filter((c: any) => c.action === name)
          .map((c: any) => c.payload),
      action,
    );
  /** Rows of controls and titles stay on one line and inside their box. */
  const assertSingleLines = async (label: string) => {
    const broken = await page.evaluate(() =>
      [
        ...document.querySelectorAll('.act, .req-head, .req-foot, .tl-row, .conversation-link'),
      ].flatMap((node) => {
        const middles = [...node.children]
          .filter((child) => (child as HTMLElement).offsetParent)
          .map((child) => {
            const box = child.getBoundingClientRect();
            return box.top + box.height / 2;
          });
        const wrapped = middles.length > 1 && Math.max(...middles) - Math.min(...middles) > 3;
        const overflow = node.scrollWidth > node.clientWidth + 1;
        return wrapped || overflow ? [`${node.className}: ${node.textContent}`] : [];
      }),
    );
    assert.deepEqual(broken, [], `${label}: rows must not wrap or overflow`);
  };

  // Running phases: one row, its own glyph, no card.
  const running = {
    preparing: ['正在连接', 'g-connect'],
    thinking: ['思考中', 'g-think'],
    acting: ['运行', 'g-run'],
  };
  for (const [state, [text, glyph]] of Object.entries(running)) {
    await open(state);
    await expect(title).toContainText(text);
    await expect(activity.locator(`.act > .phase-glyph.${glyph}`)).toBeVisible();
    await expect(page.locator('.req')).toHaveCount(0);
    checks++;
  }
  await expect(activity.locator('.act-target')).toHaveText(longCommand);
  await expect(activity.locator('.act-meta').first()).toHaveText('第 2 步');
  await activity.getByRole('button').first().click();
  await expect(activity.locator('.tl li.plan')).toHaveText([
    '阅读首页结构',
    '调整按钮文案并构建',
    '核对页面效果',
  ]);
  await expect(activity.locator('.tl li.plan.now')).toHaveText('调整按钮文案并构建');
  await expect(activity.locator('.tl-model')).toHaveText('gpt-5.2-codex');
  await assertSingleLines('acting');
  await page.screenshot({ path: path.join(output, 'acting-expanded.png') });
  // The sidebar repeats each conversation's state; requests and unverified results stand out.
  await expect(list.locator('.conversation-link em')).toHaveText([
    '运行中',
    '运行中',
    '运行中',
    '等你批准',
    '等你回答',
    '等你操作',
    '待核对',
  ]);
  checks++;

  // Requests: a card right under the row, with the composer left alone.
  await open('approval');
  const approval = page.getByRole('group', { name: '运行这条命令？' });
  await expect(title).toHaveText('等待你的批准');
  await expect(approval).toBeFocused();
  await expect(approval.locator('pre')).toHaveText(longCommand);
  await expect(page.locator('.composer-hint.is-waiting')).toBeVisible();
  await assertSingleLines('approval');
  await page.screenshot({ path: path.join(output, 'approval.png') });
  await page.keyboard.press('Escape');
  assert.deepEqual(await calls('agent:approval'), [
    { id: 'a', conversationId: 'approval', messageId: 'approval-turn', approved: false },
  ]);
  await page.keyboard.press('ControlOrMeta+Enter');
  assert.equal((await calls('agent:approval')).at(-1).approved, true);
  checks++;

  await open('input');
  const question = page.getByRole('group', { name: '需要你的回答' });
  await expect(title).toHaveText('等待你的回答');
  const submit = question.getByRole('button', { name: '提交回答' });
  await expect(submit).toBeDisabled();
  // Esc must not stop a task from a card that only asks a question.
  await question.press('Escape');
  assert.equal((await calls('conversation:stop')).length, 0);
  await question.getByRole('radio', { name: /自行填写/ }).click({ force: true });
  await question.getByRole('textbox', { name: '要部署到哪个环境？' }).fill('灰度');
  await expect(question.locator('.radio-button-group__item[data-selected]')).toHaveCSS(
    'box-shadow',
    /inset/,
  );
  await assertSingleLines('input');
  await page.screenshot({ path: path.join(output, 'input.png') });
  await submit.click();
  assert.deepEqual(await calls('agent:user-input'), [
    { id: 'q', conversationId: 'input', messageId: 'input-turn', answers: { env: ['灰度'] } },
  ]);
  checks++;

  await open('handoff');
  const handoff = page.getByRole('group', { name: '请完成登录验证' });
  await expect(title).toHaveText('等你在页面完成操作');
  await expect(handoff).toBeFocused();
  await assertSingleLines('handoff');
  await page.screenshot({ path: path.join(output, 'handoff.png') });
  await handoff.getByRole('button', { name: '去页面完成 ↗' }).click();
  await expect(page.getByRole('region', { name: '浏览器', exact: true })).toBeVisible();
  await expect(page.locator('.browser-agent-status')).toBeVisible();
  // With the browser open the chat is narrow: hints give way before any row wraps.
  await page.setViewportSize({ width: 1060, height: 800 });
  for (const state of ['approval', 'input', 'handoff', 'acting']) {
    await open(state);
    await assertSingleLines(`${state} narrow`);
    await page.screenshot({ path: path.join(output, `${state}-narrow.png`) });
  }
  await page.getByRole('button', { name: '收起浏览器', exact: true }).first().click();
  await page.setViewportSize({ width: 1440, height: 900 });
  checks++;

  // Endings: the row turns into a summary; only unverified and failed turns leave a card.
  await open('done');
  await expect(title).toHaveText('已完成');
  await expect(activity.locator('.act-meta')).toHaveText(['2 步', '核对 1 处', '1 个文件', '38s']);
  await expect(page.locator('.req')).toHaveCount(0);
  await expect(activity.locator('.act-body')).toHaveCount(0);
  await activity.getByRole('button').first().click();
  await expect(activity.locator('.tl')).toContainText('已允许 · npm run build');
  await expect(activity.locator('.tl')).toContainText('已核对 · 按钮文案为「开始使用」');
  await expect(activity.locator('.tl blockquote')).toHaveText('开始使用');
  await activity.getByRole('button', { name: '在 Finder 中显示 report.pdf' }).click();
  assert.deepEqual(await calls('artifact:reveal'), [
    { conversationId: 'done', messageId: 'done-turn', eventId: 'file' },
  ]);
  await activity.locator('.tl-row', { hasText: 'npm run build' }).click();
  await expect(activity.locator('.tl-detail')).toContainText('built in 3.9s');
  await assertSingleLines('done');
  await page.screenshot({ path: path.join(output, 'done-expanded.png') });
  checks++;

  await open('blocked');
  const blocked = page.locator('.req.outcome');
  await expect(title).toHaveText('结果待核对');
  await expect(blocked.locator('.req-head b')).toHaveText('1 处未能核对');
  await expect(blocked.locator('.req-foot').getByRole('button')).toHaveText([
    '标记为已完成',
    '查看网页 ↗',
    '再核对一次',
  ]);
  // The card follows the reply, never precedes it.
  assert.ok(
    await blocked.evaluate(
      (node) =>
        !!(
          node.compareDocumentPosition(document.querySelector('article.assistant .markdown')!) &
          Node.DOCUMENT_POSITION_PRECEDING
        ),
    ),
  );
  await assertSingleLines('blocked');
  await page.screenshot({ path: path.join(output, 'blocked.png') });
  // Only one task runs at a time, so a follow-up waits for the others; confirming does not.
  await expect(blocked.getByRole('button', { name: '再核对一次' })).toBeDisabled();
  await blocked.getByRole('button', { name: '标记为已完成' }).click();
  assert.deepEqual(await calls('conversation:confirm-outcome'), [
    { conversationId: 'blocked', messageId: 'blocked-turn' },
  ]);
  checks++;

  await open('failed');
  const failed = page.locator('.req.outcome');
  await expect(title).toHaveText('未完成');
  await expect(activity.locator('.act-meta').first()).toHaveText('完成 1 步');
  await expect(failed.locator('.req-head b')).toHaveText('第 2 步失败');
  await expect(failed.locator('.req-why')).toHaveText(`退出码 1 · ${longCommand}`);
  await expect(failed.locator('pre')).toContainText('Tests: 1 failed, 6 passed');
  // The bare failure text is not repeated as a reply.
  await expect(page.locator('article.assistant .markdown')).toHaveCount(0);
  await assertSingleLines('failed');
  await page.screenshot({ path: path.join(output, 'failed.png') });
  await failed.getByRole('button', { name: '查看完整输出' }).click();
  await expect(activity.locator('.tl-detail')).toContainText('FAIL src/renderer/activity.test.ts');
  await expect(failed.getByRole('button', { name: '修复并重试' })).toBeDisabled();
  checks++;

  await open('cancelled');
  await expect(title).toHaveText('已停止');
  await expect(activity.locator('.act-meta').first()).toHaveText('完成 1 步');
  await expect(page.locator('.req')).toHaveCount(0);
  await expect(page.locator('article.assistant .markdown')).toHaveCount(0);
  checks++;

  // A live turn: host phases drive the row, and the resolved request joins the record.
  await open('thinking');
  const emit = (event: object, state = 'thinking') =>
    page.evaluate(
      ([payload, id]) =>
        (window as any).__fixture.emit({
          type: 'agent:event',
          conversationId: id,
          messageId: `${id}-turn`,
          event: payload,
        }),
      [event, state] as const,
    );
  await emit({
    type: 'status',
    status: 'working',
    phase: { kind: 'verifying', checkpoint: '标题已更新' },
  });
  await expect(title).toHaveText('核对：标题已更新');
  await expect(activity.locator('.act > .phase-glyph.g-verify')).toBeVisible();
  await emit({ type: 'status', status: 'waiting', phase: { kind: 'stopping' } });
  await expect(title).toHaveText('正在停止');
  await emit({ type: 'complete', text: '好了。', phase: { kind: 'ended', outcome: 'succeeded' } });
  await expect(title).toHaveText('已完成');
  await expect(page.locator('article.assistant .markdown')).toHaveText('好了。');
  checks++;

  // Once nothing else is running, the outcome cards can start their follow-up.
  for (const state of ['preparing', 'acting', 'approval', 'input', 'handoff'])
    await emit(
      { type: 'complete', text: '好了。', phase: { kind: 'ended', outcome: 'succeeded' } },
      state,
    );
  await expect(list.locator('.conversation-link em')).toHaveText(['待核对']);
  await open('blocked');
  await page.getByRole('button', { name: '再核对一次' }).click();
  assert.deepEqual(await calls('conversation:follow-up'), [
    { conversationId: 'blocked', messageId: 'blocked-turn' },
  ]);
  checks++;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks, output }));
} finally {
  await browser.close();
  await server.close();
}
