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
  const execution = page.getByRole('region', { name: '任务执行' });
  await expect(execution.getByRole('status')).toContainText('已停止');
  await expect(execution.getByRole('button', { name: '继续核对' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '状态' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '完成' })).toBeVisible();

  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await page
    .locator('.conversation-list')
    .getByRole('button', { name: '优化首页交互', exact: true })
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
  const request = page.getByRole('region', { name: 'Agent 待处理事项' });
  const review = page
    .getByRole('region', { name: '工作台提示' })
    .getByRole('button', { name: '去回答' });
  await expect(review).toBeVisible();
  await expect(request).toHaveCount(0);
  await expect(draft).toBeFocused();
  await page.keyboard.type('OK');
  await expect(draft).toHaveValue(before + 'OK');
  await review.press('Enter');
  await expect(page.locator('.topbar-title')).toContainText('核对记录');
  await expect(request.getByRole('textbox', { name: '记录名称' })).toBeFocused();
  await expect(request.getByRole('textbox', { name: '记录名称' })).toHaveValue('');
  await draft.fill(before);
  await expect
    .poll(async () => (await page.locator('.chat-scroll').boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(120);
  await expect
    .poll(async () => (await request.locator('.request-questions').boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(90);
  await execution.getByRole('button', { name: '处理请求' }).press('Enter');
  await expect(request.getByRole('textbox', { name: '记录名称' })).toBeFocused();
  const submit = request.getByRole('button', { name: '提交回答' });
  await expect(submit).toBeDisabled();
  const answers = { 记录名称: ['月报'], 核对范围: ['本月'], 备注: ['已确认'] };
  for (const [name, [value]] of Object.entries(answers))
    await request.getByRole('textbox', { name }).fill(value);
  await submit.press('Enter');
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
  await expect(execution.getByText('读取文件', { exact: true })).toBeVisible();
  await expect(execution.getByText('写入文件', { exact: true })).toBeVisible();
  await expect(execution.getByText('读取网页内容', { exact: true })).toHaveCount(0);
}
