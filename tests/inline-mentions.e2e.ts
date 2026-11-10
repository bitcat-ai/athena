import { _electron as electron, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import type { BrowserFrame, ToolResult } from '../src/shared/types';

// Picking a page element embeds it in the composer as an inline [eleN] token instead of
// jumping to the 元素 tab or pinning an attachment above the text.
const root = process.cwd();
await mkdir(path.join(root, '.runtime'), { recursive: true });
const dataDir = await mkdtemp(path.join(root, '.runtime/ui-test-'));
await seedLegacyWorkspace(dataDir);
await mkdir(path.join(root, 'test-results'), { recursive: true });
const application = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    WORKBENCH_USER_DATA_DIR: dataDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
  },
});
const errors: string[] = [];
const checks: string[] = [];
try {
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByRole('heading', { name: '今天想完成什么？' })).toBeVisible();
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  const app = () => page.evaluate(async () => window.workbench.invoke<any>('app:snapshot'));
  await expect.poll(async () => (await app()).browser.status, { timeout: 30_000 }).toBe('ready');
  await expect
    .poll(async () => (await app()).browser.title, { timeout: 15_000 })
    .toContain('Athena · 从想法开始');
  const snapshot = async () =>
    page.evaluate(async () =>
      JSON.parse((await window.workbench.invoke<ToolResult>('browser:snapshot')).text),
    );
  const surface = page.locator('.browser-surface');
  const clickElement = async (element: any) => {
    await expect(page.locator('.frame-loading')).toHaveCount(0);
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const s = await window.workbench.invoke<any>('app:snapshot');
          const b = document.querySelector('.browser-surface')!.getBoundingClientRect();
          return Math.max(
            Math.abs(s.browserFrame.width - Math.floor(b.width)),
            Math.abs(s.browserFrame.height - Math.floor(b.height)),
          );
        }),
      )
      .toBeLessThanOrEqual(1);
    element = (await snapshot()).elements.find((item: any) => item.ref === element.ref) ?? element;
    const frame = (await app()).browserFrame as BrowserFrame;
    const box = await surface.boundingBox();
    if (!box || !element.bounds) throw new Error('Missing element bounds');
    await page.mouse.click(
      box.x + ((element.bounds.x + element.bounds.width / 2) * box.width) / frame.width,
      box.y + ((element.bounds.y + element.bounds.height / 2) * box.height) / frame.height,
    );
  };
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  const conversationTab = page.getByRole('tab', { name: '对话' });
  const tokens = page.locator('.composer .element-token');

  // 1. Pick → inline token, conversation tab stays selected, nothing submitted.
  await composer.focus();
  await composer.pressSequentially('我想在');
  await page.getByRole('button', { name: '选取元素', exact: true }).click();
  let state = await snapshot();
  const titleButton = state.elements.find(
    (item: any) => item.tag === 'button' && item.name === '应用标题',
  );
  await clickElement(titleButton);
  await expect(tokens).toHaveCount(1);
  await expect(tokens).toContainText('应用标题');
  await expect(tokens).toContainText('ele1');
  await expect(conversationTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: '元素检查器' })).toHaveCount(0);
  expect((await app()).conversations.flatMap((c: any) => c.messages)).toHaveLength(0);
  checks.push('Picking inserts [ele1] inline and keeps the conversation tab');

  // 2. Typing continues after the token; the caret landed after it.
  await expect(composer).toBeFocused();
  await composer.pressSequentially('里加一个按钮');
  await expect(composer).toHaveText(/^我想在.*应用标题.*ele1.*里加一个按钮$/);
  checks.push('Caret lands after the token so dictation continues inline');

  // 3. A second element gets [ele2]; re-picking the first one reuses [ele1].
  await page.getByRole('button', { name: '选取元素', exact: true }).click();
  state = await snapshot();
  const input = state.elements.find((item: any) => item.tag === 'input' && item.role === 'textbox');
  await clickElement(input);
  await expect(tokens).toHaveCount(2);
  await expect(tokens.nth(1)).toContainText('ele2');
  await page.getByRole('button', { name: '选取元素', exact: true }).click();
  await clickElement(titleButton);
  await expect(tokens).toHaveCount(2);
  checks.push('Distinct elements get distinct tokens; the same element reuses its token');

  // 4. The 元素 tab still works on demand and its source request mentions the element inline.
  await page.getByRole('button', { name: '元素检查器', exact: true }).click();
  await expect(page.getByRole('region', { name: '元素检查器' })).toBeVisible();
  await page.getByRole('button', { name: '修改源码' }).click();
  await expect(conversationTab).toHaveAttribute('aria-selected', 'true');
  await expect(tokens).toHaveCount(2);
  await expect(composer).toBeFocused();
  checks.push('Inspector opens only when asked; 修改源码 returns to the draft with the token kept');

  // 5. Tokens delete like text.
  await page.screenshot({ path: path.join(root, 'test-results/inline-mentions-draft.png') });
  await composer.focus();
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await expect(tokens).toHaveCount(0);
  await expect(composer).toHaveText('');
  checks.push('Tokens clear together with the text');

  // 6. The host re-resolves every token against the live page before a turn starts.
  const stale = await page.evaluate(async () =>
    window.workbench
      .invoke('conversation:send', {
        text: '看看 [ele1]',
        mentions: [{ token: '[ele1]', ref: 'missing-element' }],
      })
      .then(() => 'accepted')
      .catch((error: Error) => error.message),
  );
  expect(stale).toContain('[ele1] 已不在页面上');
  expect((await app()).conversations.flatMap((c: any) => c.messages)).toHaveLength(0);
  checks.push('Stale tokens are rejected before any turn starts');

  await page.screenshot({ path: path.join(root, 'test-results/inline-mentions.png') });
  expect(errors, errors.join('\n')).toHaveLength(0);
  await writeFile(
    path.join(root, 'test-results/inline-mentions.json'),
    JSON.stringify({ passed: true, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  const page = application.windows()[0];
  if (page)
    await page
      .screenshot({ path: path.join(root, 'test-results/inline-mentions-failure.png') })
      .catch(() => {});
  console.error(error);
  console.error(JSON.stringify({ passed: false, checks, errors }, null, 2));
  process.exitCode = 1;
} finally {
  await application.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}
