import assert from 'node:assert/strict';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export async function checkLocalIntegrations(page: Page, checks: string[], output: string) {
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  const original = await composer.innerText();
  const sent = () =>
    page.evaluate(
      () =>
        (window as any).__homeFixture.calls.filter(
          (call: any) => call.action === 'conversation:send',
        ).length,
    );
  const before = await sent();
  await composer.fill('/mc');
  await expect(page.getByRole('menuitem', { name: /\/mcp/ })).toBeVisible();
  await composer.press('Enter');
  await expect(page.getByRole('heading', { name: 'MCP 服务', exact: true })).toBeVisible();
  const list = page.getByRole('list', { name: 'MCP 服务列表' });
  await expect(list).toContainText('Documentation');
  await page.evaluate(() => {
    (window as any).__homeFixture.failMcp = true;
  });
  await list.getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '连接失败' })).toBeVisible();
  await expect(list).toContainText('未连接');
  await page.evaluate(() => {
    (window as any).__homeFixture.failMcp = false;
  });
  await list.getByRole('button', { name: '连接', exact: true }).click();
  await expect(list).toContainText('已连接 · 5 个工具');
  await expect(list.getByRole('button', { name: '断开', exact: true })).toBeEnabled();
  await page.screenshot({ path: path.join(output, 'settings-mcp.png') });
  await list.getByRole('button', { name: '断开', exact: true }).click();
  await expect(list).toContainText('未连接');
  await page.getByRole('textbox', { name: '搜索 MCP 服务' }).fill('not-present');
  await expect(page.getByText('没有匹配的服务', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Skills', exact: true }).click();
  await page.getByRole('button', { name: '刷新 Skills', exact: true }).click();
  const skills = page.getByRole('list', { name: 'Skills 列表' });
  await expect(skills).toContainText('本机共享');
  await page.getByRole('textbox', { name: '搜索 Skills' }).fill('layout');
  await page.screenshot({ path: path.join(output, 'settings-skills.png') });
  await skills.getByRole('button', { name: '用于任务', exact: true }).click();
  await expect(composer.locator('.composer-skill-reference')).toHaveText('$layout');
  await expect(composer).toBeFocused();
  await composer.fill('/help');
  await composer.press('Enter');
  await expect(page.getByRole('dialog', { name: '命令与 Skills' })).toBeVisible();
  await page.getByRole('button', { name: '关闭命令帮助' }).click();
  await composer.fill('/model');
  await composer.press('Enter');
  await expect(page.locator('.model-controls')).toBeVisible();
  await page.keyboard.press('Escape');
  await composer.fill('/settings mcp');
  await composer.dispatchEvent('compositionstart');
  await composer.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    isComposing: true,
    keyCode: 229,
  });
  await expect(page.locator('.settings-workspace')).toHaveCount(0);
  await composer.dispatchEvent('compositionend');
  await composer.press('Enter');
  await expect(page.getByRole('heading', { name: 'MCP 服务', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 760, height: 900 });
  await expect(page.getByRole('textbox', { name: '搜索 MCP 服务' })).toBeVisible();
  const overflow = await page
    .locator('.settings-workspace')
    .evaluate((node) => node.scrollWidth > node.clientWidth + 1);
  assert.equal(overflow, false);
  await page.screenshot({ path: path.join(output, 'settings-mcp-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 1040 });
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  assert.equal(await sent(), before, 'commands must not become model messages');
  await composer.fill(original);
  checks.push(
    'Native command actions, model picker, Skills source selection, MCP connect/error/disconnect, IME safety and narrow settings verified without model messages',
  );
}
