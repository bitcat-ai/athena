import assert from 'node:assert/strict';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export async function checkChatLayout(page: Page, output: string) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.evaluate(() => localStorage.setItem('athena.appearance', 'light'));
  await page.reload();
  await page.evaluate(() => {
    const f = (window as any).__homeFixture;
    const item = f.snapshot.conversations.find((c: any) => c.id === 'home');
    item.title = '调整页面颜色';
    item.messages = [
      {
        id: 'chat-user',
        role: 'user',
        text: '[ele1] 改为蓝色',
        context: 'Selected page element',
        createdAt: 1,
        mentions: [{ token: '[ele1]', ref: 'fixture', tag: 'button', name: '应用标题' }],
      },
      {
        id: 'chat-reply',
        role: 'assistant',
        createdAt: 1,
        endedAt: 23001,
        status: 'done',
        phase: { kind: 'ended', outcome: 'succeeded' },
        webSessionId: 'chat-record',
        text: '已完成，Sir。「应用标题」按钮的背景已改为蓝色（`#2563eb`），白色文字保持不变。\n\n这只是当前页面的预览改动，可撤销，尚未写入源码。需要落到源码或换一种蓝，说一声即可。',
        tools: [
          'workbench_browser_query',
          'workbench_browser_inspect',
          'workbench_browser_edit',
        ].map((name, index) => ({
          id: 'chat-tool-' + index,
          name,
          input: { ref: 'fixture' },
          status: 'done',
        })),
      },
    ];
    f.release();
  });
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  const reply = page.locator('.message.assistant');
  const user = page.locator('.message.user');
  await expect(user.locator('.element-chip')).toContainText('应用标题');
  await expect(user.locator('.message-context')).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: '工作区视图' })).toBeHidden();
  await expect(page.getByRole('button', { name: '查看网页执行过程' })).toHaveCount(0);
  for (const width of [1600, 1060]) {
    await page.setViewportSize({ width, height: 900 });
    const boxes = await reply.evaluate((node) => {
      const bounds = (selector: string) => {
        const r = node.querySelector(selector)!.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
      };
      return {
        header: bounds('.act-summary'),
        brand: bounds('.assistant-label'),
        activity: bounds('.act'),
        copy: bounds('button[aria-label="复制回答"]'),
        body: bounds('.markdown'),
        progress: bounds('.tl-overview'),
      };
    });
    assert.ok(
      boxes.header.height <= 40,
      'Assistant identity, status and copy should occupy one row',
    );
    for (const item of [boxes.brand, boxes.activity, boxes.copy])
      assert.ok(item.top >= boxes.header.top - 1 && item.bottom <= boxes.header.bottom + 1);
    assert.ok(
      boxes.progress.top >= boxes.header.bottom && boxes.progress.top - boxes.header.bottom <= 16,
    );
    assert.ok(
      boxes.body.top >= boxes.progress.bottom && boxes.body.top - boxes.progress.bottom <= 16,
      JSON.stringify(boxes),
    );
    assert.ok(
      boxes.brand.right <= boxes.activity.left + 1 && boxes.activity.right <= boxes.copy.left + 1,
    );
    assert.equal(await reply.locator('button button').count(), 0);
    await page
      .locator('.conversation-column')
      .screenshot({ path: path.join(output, `chat-compact-${width}.png`), animations: 'disabled' });
  }
  await reply.locator('.act').click();
  await expect(reply.getByRole('button', { name: '查看网页执行过程' })).toBeVisible();
  await expect(reply.locator('.tl')).toBeVisible();
  await reply.locator('.act').click();
  await expect(reply.getByRole('button', { name: '查看网页执行过程' })).toHaveCount(0);
  await page.getByRole('button', { name: '元素检查器', exact: true }).click();
  await expect(page.getByRole('tablist', { name: '工作区视图' })).toBeVisible();
  await page.getByRole('tab', { name: '对话', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '元素', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('button', { name: '关闭元素检查器', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '发送给 Agent 的任务' })).toBeFocused();
  await expect(page.getByRole('tablist', { name: '工作区视图' })).toBeHidden();
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page
    .locator('.conversation-column')
    .screenshot({ path: path.join(output, 'chat-compact-dark.png'), animations: 'disabled' });
}
