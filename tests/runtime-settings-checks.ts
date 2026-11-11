import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

/** Exercises the real App with the homepage fixture; no CLI or model requests leave the page. */
export async function checkRuntimeSettings(page: Page) {
  const output = path.resolve('test-results/runtime-settings');
  await mkdir(output, { recursive: true });
  await page.reload();
  await expect(page.getByRole('status')).toContainText('正在打开工作区');
  await page.evaluate(() => {
    const f = (window as any).__homeFixture;
    const model = (id: string) => ({
      id,
      model: id,
      name: id,
      description: '',
      isDefault: false,
      efforts: [],
    });
    f.runtimeModels = { claude: [model('claude-one'), model('claude-two')], pi: [] };
    Object.assign(f.snapshot.agents[1], {
      available: true,
      supported: true,
      version: 'claude-fixture-2',
      path: '/Users/example/.local/share/runtime/very-long-installation-location/bin/claude',
    });
    f.snapshot.agents.push({
      id: 'pi',
      name: 'Pi',
      available: true,
      supported: true,
      path: '/fixture/bin/pi',
    });
    f.snapshot.conversations = [
      {
        id: 'runtime-conversation',
        title: '检查当前页面与项目配置',
        agent: 'claude',
        workspace: f.snapshot.settings.workspace,
        updatedAt: Date.now(),
        modelSelection: { model: 'claude-one' },
        messages: [
          {
            id: 'runtime-answer',
            role: 'assistant',
            text: '已检查页面。',
            status: 'done',
            createdAt: Date.now(),
            model: { model: 'claude-executed', source: 'cli-message' },
          },
        ],
      },
    ];
    f.release();
  });
  await page.locator('.sidebar-settings').click();
  const current = page.locator('.agent-connection-card');
  const defaults = page.getByRole('region', { name: '新对话默认配置', exact: true });
  const chooseDefault = page.locator('[data-choice-label="新对话默认运行时"]');
  const currentModel = current.getByRole('button', { name: '选择模型', exact: true });
  const switchRuntime = current.getByRole('button', { name: '切换当前运行时', exact: true });
  const defaultModel = defaults.getByRole('button', { name: '选择模型', exact: true });
  const heading = current.getByRole('heading', { level: 4 });
  const state = () => page.evaluate(() => (window as any).__homeFixture.snapshot);
  const setDefault = async (name: string) => {
    await chooseDefault.click();
    await page.getByRole('option', { name, exact: true }).click();
  };
  const closeModels = async () => {
    await page.getByRole('button', { name: '关闭模型选择', exact: true }).click();
  };
  await expect(heading).toHaveText('Claude Code');
  await expect(current).toContainText('claude-fixture-2');
  await expect(current.locator('code')).toContainText('/bin/claude');
  await expect(current).not.toContainText('Codex');
  await expect(current.locator('.runtime-execution-model')).toContainText('claude-executed');
  await expect(chooseDefault).toContainText('Codex');
  await expect(currentModel).toContainText('claude-one');
  await currentModel.click();
  await page.getByRole('option', { name: 'claude-two', exact: true }).click();
  await expect(currentModel).toContainText('claude-two');
  await closeModels();
  let snapshot = await state();
  assert.equal(snapshot.conversations[0].modelSelection.model, 'claude-two');
  assert.equal(snapshot.settings.agent, 'codex');
  assert.equal(snapshot.settings.modelSelections?.claude, undefined);
  await expect(current.locator('.runtime-execution-model')).toContainText('claude-executed');

  await chooseDefault.click();
  await expect(page.getByRole('option', { name: /^OpenCode/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.keyboard.press('Escape');
  await setDefault('Pi');
  await expect(chooseDefault).toContainText('Pi');
  await expect(heading).toHaveText('Claude Code');
  await defaultModel.click();
  await expect(page.locator('.model-control-status')).toContainText('当前没有可选模型');
  await expect(page.locator('.model-controls').getByRole('option')).toHaveCount(0);
  await closeModels();
  await setDefault('Claude Code');
  await defaultModel.click();
  await page.getByRole('option', { name: 'claude-one', exact: true }).click();
  await expect(defaultModel).toContainText('claude-one');
  await closeModels();
  snapshot = await state();
  assert.equal(snapshot.settings.modelSelections.claude.model, 'claude-one');
  assert.equal(snapshot.conversations[0].modelSelection.model, 'claude-two');
  await expect(currentModel).toContainText('claude-two');

  // A requested model is not execution evidence, and a previous turn must not fill the gap.
  await page.evaluate(() => {
    const f = (window as any).__homeFixture;
    const c = f.snapshot.conversations[0];
    c.messages.push({
      id: 'new-turn',
      role: 'assistant',
      text: '',
      createdAt: Date.now(),
      status: 'streaming',
      model: { requested: 'claude-two', model: 'unconfirmed-value', source: 'unconfirmed' },
    });
    f.emit({ type: 'conversation:updated', conversation: structuredClone(c) });
  });
  await expect(current.locator('.runtime-execution-model')).toHaveText('本轮执行模型CLI 未报告');
  await expect(chooseDefault).toBeDisabled();
  await expect(switchRuntime).toBeDisabled();
  await currentModel.click();
  await expect(page.getByRole('option', { name: 'claude-one', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await closeModels();
  await page.evaluate(() => {
    const f = (window as any).__homeFixture;
    const c = f.snapshot.conversations[0];
    c.messages.at(-1).status = 'done';
    f.emit({ type: 'conversation:updated', conversation: structuredClone(c) });
    f.failAgentSave = true;
  });
  await setDefault('Pi');
  await expect(page.getByRole('region', { name: '应用提醒', exact: true })).toContainText(
    '无法保存默认运行时',
  );
  await expect(chooseDefault).toContainText('Claude Code');
  assert.equal((await state()).settings.agent, 'claude');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.evaluate(() => {
    (window as any).__homeFixture.failAgentSave = false;
  });
  await setDefault('Pi');

  for (const [width, theme] of [
    [1440, 'light'],
    [1060, 'light'],
    [1060, 'dark'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((value) => {
      document.documentElement.classList.toggle('dark', value === 'dark');
      document.documentElement.dataset.theme = value;
    }, theme);
    await page.locator('.settings-workspace').evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(heading).toBeVisible();
    for (const node of [current, defaults])
      assert.ok(await node.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
    await page.screenshot({ path: path.join(output, `${width}-${theme}.png`) });
  }
  await page.locator('.runtime-installations summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.agent-setting-row').filter({ hasText: 'Claude Code' })).toBeVisible();
  await page.keyboard.press('Enter');

  // Missing legacy executor metadata must continue to resolve to Codex, regardless of defaults.
  await page.evaluate(() => {
    const f = (window as any).__homeFixture;
    const c = f.snapshot.conversations[0];
    delete c.agent;
    delete c.modelSelection;
    f.emit({ type: 'conversation:updated', conversation: structuredClone(c) });
  });
  await expect(heading).toHaveText('Codex');
  await expect(chooseDefault).toContainText('Pi');
  await expect(current.locator('code')).toContainText('/fixture/bin/codex');
  const calls = await page.evaluate(() => (window as any).__homeFixture.calls);
  assert.ok(
    calls.some(
      (c: any) =>
        c.action === 'settings:model' &&
        c.payload.agent === 'claude' &&
        c.payload.conversationId === 'runtime-conversation',
    ),
  );
  assert.ok(
    calls.some(
      (c: any) =>
        c.action === 'settings:model' &&
        c.payload.agent === 'claude' &&
        c.payload.conversationId === undefined,
    ),
  );

  await switchRuntime.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: '切换当前运行时', exact: true });
  await expect(menu.getByRole('menuitem', { name: 'OpenCode', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(menu.getByRole('menuitem', { name: 'Codex', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.screenshot({ path: path.join(output, 'switch-menu-dark.png') });
  await page.evaluate(() => {
    (window as any).__homeFixture.failRuntimeSwitch = true;
  });
  await menu.getByRole('menuitem', { name: 'Claude Code', exact: true }).click();
  await expect(page.getByRole('region', { name: '应用提醒', exact: true })).toContainText(
    '无法切换运行时',
  );
  await expect(heading).toHaveText('Codex');
  assert.equal((await state()).conversations.length, 1);
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.evaluate(() => {
    (window as any).__homeFixture.failRuntimeSwitch = false;
  });

  await switchRuntime.click();
  await menu.getByRole('menuitem', { name: 'Claude Code', exact: true }).click();
  await expect(heading).toHaveText('Claude Code');
  snapshot = await state();
  const newId = snapshot.conversations[0].id;
  assert.equal(snapshot.conversations.length, 2);
  assert.equal(snapshot.conversations[0].agent, 'claude');
  assert.equal(snapshot.conversations[1].id, 'runtime-conversation');
  assert.equal(snapshot.conversations[1].messages.length, 2);
  assert.equal(snapshot.settings.agent, 'pi');
  await expect(current.locator('.runtime-execution-model')).toHaveCount(0);

  // An unused, unbound conversation can switch directly without adding another history entry.
  await switchRuntime.click();
  await menu.getByRole('menuitem', { name: 'Pi', exact: true }).click();
  await expect(heading).toHaveText('Pi');
  snapshot = await state();
  assert.equal(snapshot.conversations.length, 2);
  assert.equal(snapshot.conversations[0].id, newId);
  assert.equal(snapshot.conversations[0].agent, 'pi');
  await expect(current.locator('code')).toHaveText('/fixture/bin/pi');
}
