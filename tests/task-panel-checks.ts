import assert from 'node:assert/strict';
import { expect, type Page } from '@playwright/test';

export async function checkTaskPanels(page: Page) {
  await page.setViewportSize({ width: 1060, height: 700 });
  await page.reload();
  await page.evaluate(() => {
    const f = (window as any).__homeFixture;
    f.snapshot.conversations[0].title = '核对记录';
    f.snapshot.conversations[0].messages = [
      {
        id: 'reply',
        role: 'assistant',
        createdAt: 1,
        status: 'error',
        text: '| 记录 | 状态 |\n| --- | --- |\n| A | 完成 |',
        execution: [
          { id: 'help', kind: 'human-help', status: 'blocked', at: 1, taskId: 'task' },
          { id: 'stop', kind: 'cancelled', status: 'failed', at: 2, taskId: 'task' },
        ],
      },
    ];
    f.release();
  });
  const activity = page.locator('.activity');
  await expect(activity).toHaveAttribute('data-outcome', 'cancelled');
  await expect(activity.locator('.act-title')).toHaveText('已停止');
  // A stopped turn was the user's own call: it leaves no follow-up card behind.
  await expect(page.locator('.req')).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '状态' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '完成' })).toBeVisible();

  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await page
    .locator('.conversation-list')
    .getByRole('button', { name: /^优化首页交互/ })
    .click();
  const draft = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  const before = ['这段草稿', '属于当前对话', '请保留', '所有内容', '以及', '换行'].join('\n');
  await draft.fill(before);
  await page.evaluate(() => {
    const f = (window as any).__homeFixture;
    const task = f.snapshot.conversations[0];
    Object.assign(task.messages[0], { status: 'streaming', execution: [] });
    f.emit({ type: 'conversation:updated', conversation: structuredClone(task) });
    f.emit({
      type: 'agent:event',
      conversationId: task.id,
      messageId: 'reply',
      event: {
        type: 'user-input',
        request: {
          id: 'questionnaire',
          questions: ['记录名称', '核对范围', '备注'].map((id) => ({
            id,
            header: id,
            question: id,
            isSecret: false,
          })),
        },
      },
    });
  });
  // A request from another conversation never takes over: it shows in the sidebar and waits.
  const request = page.getByRole('group', { name: '需要你的回答' });
  const waitingRow = page.locator('.conversation-list').getByRole('button', { name: /^核对记录/ });
  await expect(waitingRow.locator('em')).toHaveText('等你回答');
  await expect(waitingRow.locator('.phase-glyph.g-wait.still')).toBeVisible();
  await expect(page.getByRole('region', { name: '工作台提示' })).toHaveCount(0);
  await expect(request).toHaveCount(0);
  await expect(draft).toBeFocused();
  await page.keyboard.type('OK');
  await expect(draft).toHaveText(before + 'OK', { useInnerText: true });
  const composerHeight = async () => (await page.locator('.composer').boundingBox())?.height ?? 0;
  await draft.fill('');
  const restingHeight = await composerHeight();
  await waitingRow.press('Enter');
  await expect(page.locator('.topbar-title')).toContainText('核对记录');
  await expect(activity.locator('.act-title')).toHaveText('等待你的回答');
  await expect(request).toHaveCount(1);
  await expect(request.locator('.req-why')).toHaveText('记录名称');
  // The card lands on its first field, and the composer keeps its size while a request is open.
  await expect(request.getByRole('textbox', { name: '记录名称' })).toBeFocused();
  await expect(request.getByRole('textbox', { name: '记录名称' })).toHaveValue('');
  await expect(page.locator('.composer-hint.is-waiting')).toHaveCount(1);
  assert.equal(await composerHeight(), restingHeight);
  const foot = request.locator('.req-foot');
  assert.ok(
    await foot.evaluate((node) => {
      const tops = [...node.children].map((child) =>
        Math.round(child.getBoundingClientRect().top + child.getBoundingClientRect().height / 2),
      );
      return Math.max(...tops) - Math.min(...tops) <= 2 && node.scrollWidth <= node.clientWidth + 1;
    }),
    'The request footer stays on one line',
  );
  const submit = request.getByRole('button', { name: '提交回答' });
  await expect(submit).toBeDisabled();
  const answers = { 记录名称: ['月报'], 核对范围: ['本月'], 备注: ['已确认'] };
  for (const [name, [value]] of Object.entries(answers))
    await request.getByRole('textbox', { name }).fill(value);
  // ⌘↩ submits from anywhere inside the card.
  await request.getByRole('textbox', { name: '备注' }).press('ControlOrMeta+Enter');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__homeFixture.calls.find(
            (c: { action: string }) => c.action === 'agent:user-input',
          )?.payload,
      ),
    )
    .toEqual({ id: 'questionnaire', conversationId: 'home', messageId: 'reply', answers });

  await page.evaluate(() => {
    const f = (window as any).__homeFixture;
    const conversation = f.snapshot.conversations.find(
      (item: { id: string }) => item.id === 'home',
    );
    conversation.agent = 'pi';
    Object.assign(conversation.messages[0], {
      status: 'done',
      tools: [
        { id: 'native-read', name: 'read', input: { path: 'evidence.txt' }, status: 'done' },
        { id: 'native-write', name: 'write', input: { path: 'evidence.txt' }, status: 'done' },
      ],
    });
    f.emit({ type: 'conversation:updated', conversation: structuredClone(conversation) });
  });
  await page.evaluate(() =>
    (window as any).__homeFixture.emit({
      type: 'agent:event',
      conversationId: 'home',
      messageId: 'reply',
      event: {
        type: 'request-resolved',
        id: 'questionnaire',
        resolved: {
          id: 'questionnaire',
          kind: 'input',
          summary: '记录名称',
          resolution: 'answered',
          at: 2,
        },
      },
    }),
  );
  await expect(request).toHaveCount(0);
  await expect(activity.locator('.act-title')).toHaveText('已完成');
  await expect(activity.locator('.act-meta')).toHaveText(['2 步', '1 个文件']);
  // Native tools read as verb plus target, and the handled request stays in the record.
  const row = activity.getByRole('button', { name: /已完成/ });
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  const titles = activity.locator('.tl-row .tl-title');
  await expect(titles).toHaveText(['读取', '写入']);
  await expect(activity.locator('.tl-row .tl-target')).toHaveText(['evidence.txt', 'evidence.txt']);
  await expect(activity.locator('.tl')).toContainText('已回答 · 记录名称');
  await expect(activity.getByText('读取网页内容', { exact: true })).toHaveCount(0);
  await activity.locator('.tl-row').first().focus();
  await page.keyboard.press('End');
  await expect(activity.locator('.tl-row').last()).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(activity.locator('.tl-row').first()).toBeFocused();
}
