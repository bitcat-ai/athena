import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { AgentEvent } from '../src/shared/types';

export async function checkAppNotices(page: Page) {
  const output = path.resolve('test-results/app-notices');
  await mkdir(output, { recursive: true });
  const notice = page.getByRole('region', { name: '工作台提示', exact: true });
  // Requests live in the conversation that raised them; the notice area only reports app news.
  const cards = page.locator('.req');
  const conversations = page.locator('.conversation-list');
  const row = (title: RegExp) => conversations.locator('.conversation-link', { hasText: title });
  const close = notice.getByRole('button', { name: '收起提醒' });
  const update = notice.getByRole('button', { name: '查看更新说明' });
  const releaseUrl = 'https://github.com/openai/codex/releases/tag/rust-v0.102.0';
  const start = async (available: boolean) => {
    await page.reload();
    await expect(page.getByRole('status')).toContainText('正在打开工作区');
    await page.evaluate(
      ({ available, releaseUrl }) => {
        const f = (window as any).__homeFixture;
        f.snapshot.agents[0].version = 'codex-cli 0.101.0';
        f.updateStatus = available
          ? {
              status: 'available',
              installedVersion: '0.101.0',
              latestVersion: '0.102.0',
              releaseUrl,
            }
          : { status: 'unknown' };
        f.snapshot.conversations
          .find((c: { id: string }) => c.id === 'b')
          .messages.push({
            id: 'b2',
            role: 'assistant',
            status: 'done',
            text: '表单说明已核对。',
            createdAt: 1,
          });
        f.release();
      },
      { available, releaseUrl },
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__homeFixture.calls.some(
            (c: { action: string }) => c.action === 'codex:update-status',
          ),
        ),
      )
      .toBe(true);
  };
  const emit = (conversationId: string, messageId: string, event: AgentEvent) =>
    page.evaluate(
      (payload) => (window as any).__homeFixture.emit({ type: 'agent:event', ...payload }),
      { conversationId, messageId, event },
    );

  await page.setViewportSize({ width: 1060, height: 740 });
  await start(false);
  await expect(notice).toHaveCount(0);
  await start(true);
  await expect(update).toBeVisible();
  await expect(notice).toContainText('0.102.0');
  await page.screenshot({ path: path.join(output, 'update-light.png') });
  await page.getByRole('button', { name: '本机用户菜单' }).click();
  await page.getByRole('menuitem', { name: /外观/ }).hover();
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  await page
    .locator('.conversation-list')
    .getByRole('button', { name: /^检查网页表单/ })
    .click();
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  const draft = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  await draft.fill('保留草稿和输入焦点');

  const approval: AgentEvent = {
    type: 'approval',
    request: {
      id: 'approve',
      kind: 'command',
      title: '查看构建记录',
      detail: '读取本地项目的构建结果。',
    },
  };
  await emit('a', 'a1', approval);
  await emit('a', 'a1', approval);
  // Another conversation's request only marks its sidebar row. Focus, draft and notice stay put.
  await expect(row(/优化首页交互/).locator('em')).toHaveText('等你批准');
  await expect(row(/优化首页交互/).locator('.phase-glyph.g-wait.still')).toBeVisible();
  await expect(update).toBeVisible();
  await expect(draft).toBeFocused();
  await expect(cards).toHaveCount(0);
  const compact = await notice.boundingBox();
  const browser = await page.getByRole('region', { name: '浏览器', exact: true }).boundingBox();
  assert.ok(compact && browser && compact.x + compact.width <= browser.x + 1);
  assert.ok(await notice.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
  await row(/优化首页交互/).click();
  await expect(page.locator('.topbar-title')).toContainText('优化首页交互');
  const approvalCard = page.getByRole('group', { name: '查看构建记录' });
  await expect(cards).toHaveCount(1);
  await expect(approvalCard.getByRole('button', { name: '允许这次' })).toBeVisible();
  await expect(approvalCard.getByRole('button', { name: '拒绝' })).toBeVisible();
  // Focus rests on the card, not on a button, so a stray Enter or Space approves nothing.
  await expect(approvalCard).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(page.locator('.activity .act-title')).toHaveText('等待你的批准');
  const oneLine = (node: Element) => {
    const middles = [...node.children].map((child) => {
      const box = child.getBoundingClientRect();
      return Math.round(box.top + box.height / 2);
    });
    return (
      Math.max(...middles) - Math.min(...middles) <= 2 && node.scrollWidth <= node.clientWidth + 1
    );
  };
  assert.ok(await approvalCard.locator('.req-foot').evaluate(oneLine), 'approval footer wraps');
  await page.screenshot({ path: path.join(output, 'approval-dark-split.png') });
  await emit('a', 'a1', { type: 'request-resolved', id: 'approve' });
  await expect(cards).toHaveCount(0);
  await expect(row(/优化首页交互/).locator('em')).toHaveCount(0);
  await row(/检查网页表单/).click();
  const nextApproval = { ...approval, request: { ...approval.request, id: 'approve-again' } };
  await emit('a', 'a1', nextApproval);
  await expect(row(/优化首页交互/).locator('em')).toHaveText('等你批准');
  await expect(cards).toHaveCount(0);
  await row(/优化首页交互/).click();
  await expect(approvalCard).toContainText('读取本地项目的构建结果。');
  await emit('a', 'a1', { type: 'request-resolved', id: 'approve-again' });
  await expect(cards).toHaveCount(0);

  // The same request id in two conversations stays two separate requests.
  await emit('a', 'a1', {
    type: 'user-input',
    request: {
      id: 'rpc-1',
      questions: [{ id: 'ref', header: '记录', question: '请填写记录编号', isSecret: false }],
    },
  });
  await emit('b', 'b2', {
    type: 'approval',
    request: {
      id: 'rpc-1',
      kind: 'other',
      action: 'browser-help',
      title: '请在页面完成核对',
      detail: '核对记录编号后继续。',
    },
  });
  const question = page.getByRole('group', { name: '需要你的回答' });
  await expect(question.getByRole('textbox', { name: '请填写记录编号' })).toBeFocused();
  await expect(row(/检查网页表单/).locator('em')).toHaveText('等你操作');
  await emit('a', 'a1', { type: 'request-resolved', id: 'rpc-1' });
  await expect(cards).toHaveCount(0);
  await expect(row(/检查网页表单/).locator('em')).toHaveText('等你操作');
  await row(/检查网页表单/).click();
  await expect(page.locator('.topbar-title')).toContainText('检查网页表单');
  const handoff = page.getByRole('group', { name: '请在页面完成核对' });
  await expect(handoff).toContainText('核对记录编号后继续。');
  await expect(handoff).toBeFocused();
  await expect(handoff.locator('.req-foot').getByRole('button')).toHaveText([
    '停止处理',
    '去页面完成 ↗',
    '已完成，继续',
  ]);
  assert.ok(await handoff.locator('.req-foot').evaluate(oneLine), 'handoff footer wraps');
  await expect(page.locator('.browser-agent-status')).toContainText('等你在页面完成操作');
  await emit('b', 'b2', { type: 'complete' });
  await expect(cards).toHaveCount(0);
  await expect(row(/检查网页表单/).locator('em')).toHaveCount(0);
  await expect(update).toBeVisible();
  await update.click();
  await close.click();
  await expect(notice).toHaveCount(0);
  const actions: { action: string; payload?: { url?: string } }[] = await page.evaluate(
    () => (window as any).__homeFixture.calls,
  );
  assert.equal(
    actions.filter((c) => c.action === 'shell:openExternal' && c.payload?.url === releaseUrl)
      .length,
    1,
  );
  assert.ok(
    !actions.some((c) =>
      ['agent:approval', 'agent:user-input', 'conversation:send', 'conversation:stop'].includes(
        c.action,
      ),
    ),
  );

  await start(true);
  await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: '设置与连接', exact: true }).click();
  const settings = page.getByRole('region', { name: '设置与连接' });
  await settings.getByRole('button', { name: '查看更新说明' }).click();
  await expect(notice).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__homeFixture.calls.find(
            (c: { action: string }) => c.action === 'shell:openExternal',
          )?.payload,
      ),
    )
    .toEqual({ url: releaseUrl });
  await settings.getByRole('button', { name: '刷新 Agent 列表' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__homeFixture.calls.some(
          (c: { action: string; payload?: { refresh?: boolean } }) =>
            c.action === 'codex:update-status' && c.payload?.refresh,
        ),
      ),
    )
    .toBe(true);

  await page.reload();
  await expect
    .poll(() => page.evaluate(() => (window as any).__homeFixture?.pendingSnapshots.length))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const f = (window as any).__homeFixture;
    const pending = (id: string, action: string) => ({
      conversationId: 'a',
      messageId: 'a1',
      kind: 'approval',
      request: { id, kind: 'other', action, title: '核对构建结果', detail: '请确认是否继续读取。' },
    });
    f.snapshot.pendingRequests = [
      pending('finished', 'browser-help'),
      pending('waiting', 'browser-script'),
    ];
    f.snapshot.conversations
      .find((c: { id: string }) => c.id === 'b')
      .messages.push({ id: 'b2', role: 'assistant', status: 'streaming', text: '', createdAt: 1 });
    const question = {
      type: 'agent:event',
      conversationId: 'b',
      messageId: 'b2',
      event: {
        type: 'user-input',
        request: {
          id: 'just-arrived',
          questions: [{ id: 'note', header: '备注', question: '需要补充什么？', isSecret: false }],
        },
      },
    };
    f.emit(question);
    f.emit(question);
    f.emit({
      type: 'agent:event',
      conversationId: 'a',
      messageId: 'a1',
      event: { type: 'request-resolved', id: 'finished' },
    });
    f.release();
  });
  // Restored requests reach their rows without a notice, and a resolved one never comes back.
  await expect(notice).toHaveCount(0);
  await expect(row(/优化首页交互/).locator('em')).toHaveText('等你批准');
  await expect(row(/检查网页表单/).locator('em')).toHaveText('等你回答');
  await row(/优化首页交互/).click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText('核对构建结果');
  await expect(cards.getByRole('button', { name: '允许这次' })).toBeVisible();
}
