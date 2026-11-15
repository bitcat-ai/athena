/** Opt-in real Codex + Electron + agent-browser, with parallel drafting explicitly disabled. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';

if (process.env.ATHENA_TEST_BROWSER_PROTOCOL !== '1')
  throw new Error('Set ATHENA_TEST_BROWSER_PROTOCOL=1 for this real model check');
const root = process.cwd();
const directory = await mkdtemp('/tmp/athena-protocol-');
const output = path.resolve('test-results/browser-protocol-live');
await mkdir(output, { recursive: true });
await seedLegacyWorkspace(directory);
const data = JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8'));
data.settings.pagePreview = false;
data.settings.modelSelection = { model: 'gpt-6.1-sol', effort: 'low' };
await writeFile(path.join(directory, 'workspace.json'), JSON.stringify(data), { mode: 0o600 });
const application = await electron.launch({
  args: [path.join(root, 'tests/electron-background.cjs')],
  cwd: root,
  env: {
    ...process.env,
    WORKBENCH_USER_DATA_DIR: directory,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  },
});
const report: Record<string, unknown> = {};
try {
  const page = await application.firstWindow();
  await page.evaluate(() => {
    const state = ((window as any).__protocol = {
      events: [] as any[],
      scrolled: false,
      scrolledNewPage: false,
      ignoredStaleInput: false,
      scrollError: '',
    });
    window.workbench.onEvent((event) => {
      if (event.type !== 'agent:event') return;
      state.events.push({ at: Date.now(), ...event });
      const item = event.event;
      if (
        !state.scrolled &&
        item.type === 'web-execution' &&
        item.event.kind === 'operation' &&
        item.event.tool === 'workbench_browser_create_page' &&
        item.event.status === 'running'
      ) {
        state.scrolled = true;
        void window.workbench
          .invoke('browser:input', { type: 'wheel', x: 180, y: 180, deltaX: 0, deltaY: 80 })
          .catch((error) => {
            if (/活动标签页已改变|画面已过期|旧标签页/.test(String(error)))
              state.ignoredStaleInput = true;
            else state.scrollError = String(error);
          });
      }
      if (
        !state.scrolledNewPage &&
        item.type === 'tool' &&
        item.call.name === 'workbench_browser_create_page' &&
        item.call.status === 'done'
      ) {
        void window.workbench
          .invoke('browser:input', { type: 'wheel', x: 180, y: 180, deltaX: 0, deltaY: 80 })
          .then(() => {
            state.scrolledNewPage = true;
          })
          .catch((error) => {
            state.scrollError = String(error);
          });
      }
    });
  });
  const snapshot = () => page.evaluate(() => window.workbench.invoke<any>('app:snapshot'));
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 40000 })
    .toBe('ready');
  const initial = await snapshot();
  report.originalTab = initial.browser.activeTabId;
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  const startedAt = Date.now();
  await page
    .getByRole('textbox', { name: '发送给 Agent 的任务' })
    .fill('直接在右侧浏览器中，为我构建一个台灯的landingpage，北欧极简风格，带一点杂志感');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          (window as any).__protocol.events.some((row: any) =>
            ['complete', 'error'].includes(row.event.type),
          ),
        ),
      { timeout: 180000 },
    )
    .toBe(true);
  const final = await snapshot();
  const conversation = final.conversations.find((item: any) =>
    item.messages.some((message: any) => message.role === 'user' && message.text.includes('台灯')),
  );
  const assistant = conversation.messages.findLast((message: any) => message.role === 'assistant');
  const live = await page.evaluate(() => (window as any).__protocol);
  report.totalMs = Date.now() - startedAt;
  report.model = assistant.model;
  report.phase = assistant.phase;
  report.tools = assistant.tools;
  report.execution = assistant.execution;
  report.scrolled = live.scrolled;
  report.scrollError = live.scrollError;
  report.ignoredStaleInput = live.ignoredStaleInput;
  report.scrolledNewPage = live.scrolledNewPage;
  assert.equal(assistant.status, 'done', assistant.failure || assistant.text);
  assert.equal(live.scrolled, true, 'the real app must exercise scroll during creation');
  assert.equal(live.scrollError, '');
  assert.equal(live.scrolledNewPage, true);
  const creates = assistant.tools.filter(
    (tool: any) => tool.name === 'workbench_browser_create_page' && tool.status === 'done',
  );
  assert.equal(creates.length, 1);
  assert.equal(creates[0].status, 'done');
  assert.ok(
    assistant.execution.some(
      (event: any) => event.kind === 'control' && event.control?.scope === 'viewport',
    ),
  );
  assert.ok(
    assistant.tools
      .filter((tool: any) => tool.status === 'error')
      .every((tool: any) => /^参数校验未通过，本次操作尚未执行/.test(tool.output)),
    'only correctable pre-dispatch validation may fail; no control or recovery loop',
  );
  assert.equal(
    assistant.tools.filter((tool: any) =>
      [
        'web_run',
        'web_evaluate_in_page',
        'commandExecution',
        'fileChange',
        'workbench_preview_draft',
      ].includes(tool.name),
    ).length,
    0,
  );
  assert.ok(final.browser.tabs.some((tab: any) => tab.id === report.originalTab));
  assert.notEqual(final.browser.activeTabId, report.originalTab);
  const content = await page.evaluate(() => window.workbench.invoke<any>('browser:snapshot'));
  const body = JSON.parse(content.text);
  report.pageText = body.text;
  assert.match(body.text, /灯|光|light|lamp/i);
  await page.screenshot({ path: path.join(output, 'completed.png') });
  console.log(
    JSON.stringify({
      passed: true,
      totalMs: report.totalMs,
      model: report.model,
      tools: assistant.tools.map((tool: any) => tool.name),
      controls: assistant.execution.filter((event: any) => event.kind === 'control').length,
    }),
  );
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  const page = await application.firstWindow();
  report.events = await page.evaluate(() => (window as any).__protocol).catch(() => undefined);
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await page.evaluate(() => window.workbench.invoke('conversation:stop')).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await application.close();
  await rm(directory, { recursive: true, force: true });
}
