/** Opt-in real CLI -> host -> agent-browser test. Two model turns, isolated app/browser data. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';

if (process.env.ATHENA_TEST_PAGE_PREVIEW !== '1')
  throw new Error('Set ATHENA_TEST_PAGE_PREVIEW=1 to run this real model check');
const root = process.cwd();
const directory = await mkdtemp('/tmp/athena-preview-');
const output = path.resolve('test-results/page-preview-live');
await mkdir(output, { recursive: true });
await seedLegacyWorkspace(directory);
const data = JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8'));
data.settings.agent = 'claude';
data.settings.pagePreview = true;
data.settings.modelSelections = { claude: { model: 'sonnet', effort: 'low' } };
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
const checks: Record<string, unknown> = {};
try {
  const page = await application.firstWindow();
  await page.evaluate(() => {
    (window as any).__previewEvents = [];
    window.workbench.onEvent((event) => {
      if (event.type === 'agent:event')
        (window as any).__previewEvents.push({ at: Date.now(), ...event });
    });
  });
  const snapshot = () => page.evaluate(() => window.workbench.invoke<any>('app:snapshot'));
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 40000 })
    .toBe('ready');
  const models = await page.evaluate(() =>
    window.workbench.invoke<any[]>('models:list', { agent: 'claude' }),
  );
  assert.ok(models.some((model) => model.model === 'haiku'));
  assert.ok(models.some((model) => model.model === 'sonnet'));
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  const startedAt = Date.now();
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  await composer.fill(
    '请在当前浏览器生成一个 SORA COFFEE 咖啡店落地页：奶油白与咖啡棕配色，首屏包含品牌名、主标题「把日常，慢慢冲好」、简短介绍和「探索咖啡」按钮。下面补充三款咖啡简介。不需要后端或真实提交。完成后简短说明页面效果。',
  );
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const events = () => page.evaluate(() => (window as any).__previewEvents as any[]);
  await expect
    .poll(
      async () =>
        (await events()).some(
          (row) => row.event.type === 'tool' && row.event.call.name === 'workbench_preview_draft',
        ),
      { timeout: 20000 },
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await events()).find(
          (row) =>
            row.event.type === 'tool' &&
            row.event.call.name === 'workbench_preview_draft' &&
            row.event.call.status !== 'running',
        ),
      { timeout: 45000 },
    )
    .not.toBeUndefined();
  const worker = (await events()).find(
    (row) =>
      row.event.type === 'tool' &&
      row.event.call.name === 'workbench_preview_draft' &&
      row.event.call.status !== 'running',
  )!;
  const receipt = JSON.parse(worker.event.call.output);
  checks.worker = receipt;
  assert.equal(receipt.status, 'rendered', JSON.stringify(receipt));
  checks.firstVisibleMs = receipt.firstVisibleAt - startedAt;
  const firstPage = await page.evaluate(() => window.workbench.invoke<any>('browser:snapshot'));
  assert.match(firstPage.text, /SORA COFFEE|把日常/);
  await page.screenshot({ path: path.join(output, 'first-visible.png') });
  await expect
    .poll(
      async () => (await events()).some((row) => ['complete', 'error'].includes(row.event.type)),
      { timeout: 150000 },
    )
    .toBe(true);
  const final = await snapshot();
  const conversation = final.conversations.find((item: any) =>
    item.messages.some(
      (message: any) => message.role === 'user' && message.text.includes('SORA COFFEE'),
    ),
  );
  const assistant = conversation.messages.findLast((message: any) => message.role === 'assistant');
  checks.totalMs = Date.now() - startedAt;
  checks.model = assistant.model;
  checks.phase = assistant.phase;
  checks.toolTimeline = assistant.tools?.map((tool: any) => ({
    name: tool.name,
    status: tool.status,
    startedAt: tool.startedAt,
    durationMs: tool.durationMs,
  }));
  assert.equal(assistant.status, 'done', assistant.failure || assistant.text);
  const primaryStart = (await events()).find((row) => row.event.type === 'run-started');
  assert.ok(
    primaryStart && primaryStart.at < worker.at,
    'primary must start before the worker finishes',
  );
  const finalPage = await page.evaluate(() => window.workbench.invoke<any>('browser:snapshot'));
  assert.match(finalPage.text, /SORA COFFEE/);
  assert.match(finalPage.text, /探索咖啡/);
  checks.pageText = JSON.parse(finalPage.text).text;
  const usage = await page.evaluate(() => window.workbench.invoke<any>('usage:snapshot'));
  checks.usage = usage.records.map((record: any) => ({
    id: record.id,
    status: record.status,
    model: record.model,
    requestedModel: record.requestedModel,
    observed: record.observed,
    tokens: record.tokens,
  }));
  assert.ok(
    usage.records.some((record: any) => record.id.endsWith(':preview') && record.observed),
    'worker usage must be recorded',
  );
  await page.screenshot({ path: path.join(output, 'completed.png') });
  console.log(
    JSON.stringify({
      firstVisibleMs: checks.firstVisibleMs,
      totalMs: checks.totalMs,
      requestedWorkerModel: receipt.requestedModel,
      actualWorkerModel: receipt.actualModel,
      mainModel: assistant.model,
      checks: [
        'real CLI',
        'parallel startup',
        'actual DOM insertion',
        'continued page completion',
        'separate usage',
      ],
    }),
  );
} catch (error) {
  const page = await application.firstWindow();
  checks.error = error instanceof Error ? error.message : String(error);
  checks.events = await page.evaluate(() => (window as any).__previewEvents).catch(() => []);
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await page.evaluate(() => window.workbench.invoke('conversation:stop')).catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'report.json'), JSON.stringify(checks, null, 2));
  await application.close();
  await rm(directory, { recursive: true, force: true });
}
