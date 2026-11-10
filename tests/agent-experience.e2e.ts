/** Packaged, real CLI/Neo integration. All pages, files and app data belong to this test. */
import assert from 'node:assert/strict';
import { chooseOption } from './ui-choices';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import { complexWorkflowFixture } from './complex-workflow-fixture';
import { summarizeUsage, type ModelOption, type UsageSnapshot } from '../src/shared/usage';
import type { AppSnapshot, ChatMessage } from '../src/shared/types';

const root = process.cwd();
const directory = await mkdtemp(path.resolve('.runtime/agent-experience-'));
await seedLegacyWorkspace(path.join(directory, 'data'));
const output = path.resolve(
  process.env.ATHENA_EXPERIENCE_OUTPUT || 'test-results/agent-experience/packaged',
);
await mkdir(output, { recursive: true });
const site = await complexWorkflowFixture();
let app: ElectronApplication | undefined;
let page!: Page;
const errors: string[] = [];
const checks: string[] = [];
const results: Record<string, unknown> = {};
const binary = path.resolve(
  process.env.ATHENA_APP_EXECUTABLE ||
    'release/agent-experience/mac-arm64/Athena.app/Contents/MacOS/Athena',
);
const invoke = <T = any>(action: string, payload?: unknown): Promise<T> =>
  page.evaluate(({ action, payload }) => window.workbench.invoke<T>(action, payload), {
    action,
    payload,
  });
const snapshot = () => invoke<AppSnapshot>('app:snapshot');
const usage = () => invoke<UsageSnapshot>('usage:snapshot');
const assistant = async (id?: string) =>
  (await snapshot()).conversations
    .flatMap((c) => c.messages)
    .filter((m) => m.role === 'assistant' && (!id || id === m.id))
    .sort((a, b) => a.createdAt - b.createdAt)
    .at(-1)!;
const start = async () => {
  app = await electron.launch({
    executablePath: binary,
    args: [],
    cwd: root,
    env: { ...process.env, WORKBENCH_USER_DATA_DIR: path.join(directory, 'data') },
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.setBackgroundThrottling(false);
    w.hide();
  });
  await expect.poll(async () => (await snapshot()).neo?.status, { timeout: 30000 }).toBe('ready');
};
const send = async (text: string) => {
  const before = (await usage()).records.length;
  await page.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(async () => (await usage()).records.length).toBe(before + 1);
  return (await assistant()).id;
};
const waitResult = async (id: string) => {
  await expect
    .poll(async () => (await assistant(id))?.status, { timeout: 240000 })
    .not.toBe('streaming');
  await expect
    .poll(async () => (await usage()).records.find((r) => r.id === id)?.status, { timeout: 10000 })
    .not.toBe('running');
  await expect(page.getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0);
  return assistant(id);
};
const selectModel = async (model: ModelOption) => {
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  const option = page.getByRole('option', { name: model.name, exact: true });
  await expect(option).toBeEnabled({ timeout: 15000 });
  await option.click();
  await expect
    .poll(async () => (await snapshot()).settings.modelSelection?.model)
    .toBe(model.model);
  const effort = page.getByRole('slider', { name: '推理强度' });
  if (model.efforts.some((e) => e.id === 'low')) {
    if (model.efforts.length > 1) {
      await expect(effort).toBeEnabled();
      await effort.press('Home');
      for (let i = 0; i < model.efforts.findIndex((e) => e.id === 'low'); i++) {
        await expect(effort).toBeEnabled();
        await effort.press('ArrowRight');
      }
    } else if ((await snapshot()).settings.modelSelection?.effort !== 'low') {
      await page.getByRole('button', { name: '使用轻快', exact: true }).click();
    }
    await expect.poll(async () => (await snapshot()).settings.modelSelection?.effort).toBe('low');
  }
  await page.screenshot({ path: path.join(output, 'model-selection.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toBeFocused();
};
const takeScreenshot = (name: string) =>
  page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
try {
  await start();
  await page.getByRole('button', { name: '用量', exact: true }).click();
  await expect(page.getByTestId('usage-total')).toHaveText('未知');
  await expect(page.getByText('暂无用量记录', { exact: true })).toBeVisible();
  await takeScreenshot('usage-empty');
  checks.push('empty usage is unknown, no fabricated numbers or costs');
  await page.locator('button.new-conversation').click();
  const models = await invoke<ModelOption[]>('models:list');
  const first = models.find((m) => m.isDefault) ?? models[0];
  const second =
    models.find((m) => /luna/.test(m.model) && m.model !== first.model) ??
    models.find((m) => m.model !== first.model)!;
  await selectModel(first);
  await invoke('browser:navigate', { url: site.origin + '/policy' });
  const normalId = await send(
    `请执行这次本地网页验收：先用 neo_plan 记录三步“读取配送规则”“人工核对”“下载回执文件”。用 neo_read 读取当前页，以真实原文和 observationId 写 neo_checkpoint。然后必须调用 neo_request_human_help，请我核对当前规则，等待我点击“已完成，继续”。我交回后重新读取并核对。最后打开 ${site.origin}/receipts，读取空订单列表，从页面链接用 neo_download 下载 CSV（这是空表，下载即可，不要求再打开本地文件；不要创建订单）；将计划更新为完成并报告实际结果。仅使用 neo_*，不执行脚本或命令，不访问外站。`,
  );
  await expect
    .poll(async () => (await snapshot()).pendingRequests?.[0]?.kind, { timeout: 150000 })
    .toBe('approval');
  // The request sits in the conversation, right under the turn that raised it.
  await expect(page.locator('.activity').last()).toContainText('等你在页面完成操作');
  await expect(page.locator(".req[data-type='handoff']")).toBeVisible();
  await takeScreenshot('human-help');
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await expect(page.getByRole('option', { name: second.name, exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await assert.rejects(() => invoke('settings:model', { model: second.model }), /当前任务结束/);
  await page.getByRole('button', { name: '已完成，继续', exact: true }).click();
  const normal = await waitResult(normalId);
  assert.equal(normal.status, 'done');
  assert.equal(normal.model?.model, first.model);
  assert.equal(normal.model?.source, 'turn-context');
  assert(normal.plan?.every((s) => s.status === 'completed'));
  assert(normal.execution?.some((e) => e.kind === 'human-help' && e.status === 'succeeded'));
  assert(normal.execution?.filter((e) => e.kind === 'checkpoint').length! >= 2);
  const artifactEvent = normal.execution!.find((e) => e.kind === 'artifact')!;
  assert.ok(artifactEvent?.artifact);
  const artifact = artifactEvent.artifact;
  const content = await readFile(artifact.path, 'utf8');
  assert.match(content, /^id,customer,region,tax,shipping,contact,attachment/);
  await copyFile(artifact.path, path.join(output, 'receipt.csv'));
  await page
    .locator('.topbar-actions')
    .getByRole('button', { name: '收起浏览器', exact: true })
    .click();
  const activity = page.locator('.activity').last();
  await expect(activity).toContainText('已完成');
  await activity.locator('button.act').click();
  await activity.screenshot({
    path: path.join(output, 'execution-completed.png'),
    animations: 'disabled',
  });
  // Exercise the host's evidence check and OS dispatch without opening a Finder window over the user's work.
  await app!.evaluate(({ shell }) => {
    (globalThis as any).__revealed = [];
    shell.showItemInFolder = (file) => {
      (globalThis as any).__revealed.push(file);
    };
  });
  await page.getByRole('button', { name: /^在 Finder 中显示/ }).click();
  assert.deepEqual(await app!.evaluate(() => (globalThis as any).__revealed), [artifact.path]);
  await writeFile(artifact.path, content.replace('customer', 'CUSTOMER'));
  const conversationId = (await snapshot()).conversations.find((c) =>
    c.messages.some((m) => m.id === normalId),
  )!.id;
  await assert.rejects(
    () =>
      invoke('artifact:reveal', { conversationId, messageId: normalId, eventId: artifactEvent.id }),
    /内容已变化/,
  );
  await writeFile(artifact.path, content);
  await activity.locator('.tl-row').first().focus();
  await page.keyboard.press('Enter');
  await expect(activity.locator('.tl-detail')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(activity.locator('.tl-detail')).toHaveCount(0);
  checks.push(
    'real plan, host checkpoints, manual help round trip, artifact verification and keyboard tool details',
  );
  results.normal = normal;

  await selectModel(second);
  const unknownId = await send(
    '这是本地失败状态验收。仅调用一次 neo_wait，在当前页面等待文本 NEVER-EXISTS-51a，timeout=50 毫秒。条件未匹配后不再调用工具，不恢复；结束并如实说明未匹配。',
  );
  const unknown = await waitResult(unknownId);
  assert.equal(unknown.status, 'error');
  assert.equal(unknown.model?.model, second.model);
  await expect(page.locator('.activity').last()).toContainText('结果待核对');
  // Rechecking starts a new turn, so this run only confirms the offer is there.
  await expect(page.locator(".req.outcome[data-outcome='blocked']").getByRole('button')).toHaveText(
    ['标记为已完成', '查看网页 ↗', '再核对一次'],
  );
  await takeScreenshot('unresolved-result');
  results.unknown = unknown;
  checks.push(
    'actual selected second model; unknown result is not completion; the outcome card offers a recheck',
  );

  const cancelledId = await send(
    '请只调用 neo_request_human_help，请我核对当前页；保持等待，不自行确认完成。我会停止任务。',
  );
  await expect
    .poll(async () => (await snapshot()).pendingRequests?.[0]?.kind, { timeout: 120000 })
    .toBe('approval');
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  const cancelled = await waitResult(cancelledId);
  assert.equal(cancelled.status, 'error');
  assert.equal((await usage()).records.find((r) => r.id === cancelledId)?.status, 'cancelled');
  assert.equal((await snapshot()).pendingRequests?.length, 0);
  results.cancelled = cancelled;
  checks.push('cancel clears human help and retains observed usage');

  const before = await usage();
  const beforeSummary = summarizeUsage(before.records);
  assert.equal(before.records.length, 3);
  assert(before.records.every((r) => r.observed));
  await page.getByRole('button', { name: '用量', exact: true }).click();
  await expect(page.getByTestId('usage-total')).toHaveText(
    beforeSummary.amounts.totalTokens.value!.toLocaleString('zh-CN'),
  );
  await takeScreenshot('usage-wide');
  await chooseOption(page, '按模型筛选', first.model);
  await expect(page.getByTestId('usage-total')).toHaveText(
    before.records.find((r) => r.id === normalId)!.tokens.totalTokens!.toLocaleString('zh-CN'),
  );
  await chooseOption(page, '按模型筛选', '全部模型');
  await page.getByRole('tab', { name: '助手', exact: true }).click();
  await expect(page.getByRole('rowheader', { name: /Codex CLI/ })).toBeVisible();
  await page.getByRole('button', { name: '查看每日数据', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: '日期', exact: true })).toBeVisible();
  await chooseOption(page, '用量时间范围', '最近 7 天');
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 740));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.usage-panel').evaluate((node) => node.scrollTo(0, 0));
  await takeScreenshot('usage-narrow');
  assert.equal(
    await page.locator('.usage-panel').evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  assert.equal(
    await page.locator('.usage-panel').evaluate((node) => getComputedStyle(node).animationName),
    'none',
  );
  await page.locator('button.new-conversation').click();
  if ((await page.locator('.browser-drawer').getAttribute('aria-hidden')) === 'true')
    await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await takeScreenshot('composer-narrow');
  assert.equal(
    await page
      .locator('.composer-controls')
      .evaluate((node) => node.scrollWidth > node.clientWidth + 1),
    false,
  );
  checks.push('usage model/assistant/date filters, 7-day range, narrow window and reduced motion');
  await app!.close();
  app = undefined;
  const persisted = JSON.parse(await readFile(path.join(directory, 'data/usage.json'), 'utf8'));
  assert.deepEqual(summarizeUsage(persisted.records), beforeSummary);
  await start();
  const restored = await usage();
  assert.deepEqual(summarizeUsage(restored.records), beforeSummary);
  assert.equal((await snapshot()).settings.modelSelection?.model, second.model);
  const oldConversation = (await snapshot()).conversations.find((c) => c.id === conversationId)!;
  assert.deepEqual(
    oldConversation.messages.find((m) => m.id === normalId)?.execution,
    JSON.parse(JSON.stringify(normal.execution)),
  );
  await page.getByRole('button', { name: oldConversation.title, exact: true }).click();
  const resumedId = await send('只回复“恢复确认”，不调用任何工具。');
  const resumed = await waitResult(resumedId);
  assert.equal(resumed.status, 'done');
  assert.equal(resumed.model?.model, second.model);
  const final = await usage();
  const resumedUsage = final.records.find((r) => r.id === resumedId)!;
  assert.ok(
    resumedUsage.baseline?.inputTokens! > 0 &&
      resumedUsage.tokens.inputTokens! < resumedUsage.lastTotal?.inputTokens!,
  );
  assert.equal(resumedUsage.model, second.model);
  checks.push(
    'packaged restart preserves models, execution and exact totals; resumed turn excludes historical cumulative usage',
  );
  results.resumed = resumed;
  await invoke('share:start', { address: '127.0.0.1', name: 'Isolated acceptance' });
  await page.locator('button.new-conversation').click();
  const refusedId = await send('读取当前网页。');
  const refused = await waitResult(refusedId);
  assert.equal(refused.status, 'error');
  assert.match(refused.failure ?? refused.text, /共享期间/);
  await invoke('share:stop');
  const afterRefusal = await usage();
  assert.deepEqual(
    summarizeUsage(afterRefusal.records).amounts.totalTokens.value,
    summarizeUsage(final.records).amounts.totalTokens.value,
  );
  assert.equal(afterRefusal.records.find((r) => r.id === refusedId)?.observed, false);
  checks.push(
    'shared page still rejects Agent control; pre-model failures remain unknown usage, never zero',
  );
  results.sharedRefusal = refused;
  results.usage = afterRefusal;
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'evidence.json'),
    JSON.stringify(
      {
        passed: true,
        packaged: true,
        realModelTurns: 4,
        models: [first.model, second.model],
        checks,
        errors,
        ...results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks, errors }));
} catch (error) {
  await page
    ?.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' })
    .catch(() => {});
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      {
        error: String(error),
        checks,
        errors,
        ...results,
        snapshot: await snapshot()
          .then((value) => ({ ...value, share: undefined }))
          .catch(() => null),
        usage: await usage().catch(() => null),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app?.close();
  await site.close();
  await rm(directory, { recursive: true, force: true });
}
