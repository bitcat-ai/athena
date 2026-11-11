/** Actual Electron + installed Pi, isolated app data; real paid calls require explicit opt-in.
 * BrowserOS stays deferred. Only the temporary evidence.txt may be approved for read/write.
 * Claude is selected, not sent a model prompt. Legacy history is a clearly isolated fixture.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import type { AppSnapshot, ChatMessage, PendingAgentRequest } from '../src/shared/types';
import type { UsageSnapshot } from '../src/shared/usage';

if (process.env.WORKBENCH_LIVE_PI !== '1')
  throw new Error(
    'Set WORKBENCH_LIVE_PI=1 to authorize real Pi model calls. Run npm run build first.',
  );
const root = process.cwd();
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'athena-cli-ui-')));
const workspace = path.join(directory, 'project');
const userData = path.join(directory, 'profile');
const output = path.resolve('test-results/mainstream-cli-ui');
await mkdir(workspace);
await mkdir(userData);
await mkdir(output, { recursive: true });
const marker = `athena-${randomUUID()}`;
const legacy = {
  id: 'legacy-codex',
  title: '历史核对记录',
  workspace,
  updatedAt: 1,
  messages: [{ id: 'legacy-message', role: 'user', text: '请核对月报。', createdAt: 1 }],
};
await writeFile(
  path.join(userData, 'workspace.json'),
  JSON.stringify({
    settings: { workspace, agent: 'pi' },
    onboarding: {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      workspaceConfirmed: workspace,
      browserDeferred: true,
    },
    conversations: [legacy],
    recordings: [],
  }),
);
let app: ElectronApplication | undefined;
const evidence: {
  passed?: boolean;
  checks: string[];
  approvals: string[];
  model?: ChatMessage['model'];
  error?: string;
} = {
  checks: [],
  approvals: [],
};
const launch = async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: { ...process.env, WORKBENCH_USER_DATA_DIR: userData },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await expect(page.locator('#composer-agent-name')).toBeAttached({ timeout: 30000 });
  return page;
};
const deadline = setTimeout(() => {
  void app?.close().catch(() => {});
}, 240000);
try {
  let page = await launch();
  const invoke = <T>(action: string, payload?: unknown) =>
    page.evaluate(({ action, payload }) => window.workbench.invoke<T>(action, payload), {
      action,
      payload,
    });
  const snapshot = () => invoke<AppSnapshot>('app:snapshot');
  const initial = await snapshot();
  assert.equal(initial.settings.agent, 'pi');
  for (const id of ['pi', 'claude']) {
    const info = initial.agents.find((item) => item.id === id);
    assert.ok(info?.available && info.supported, `${id} is not ready for this check`);
  }
  await expect(page.locator('#composer-agent-name')).toHaveText('Codex');
  evidence.checks.push('Legacy conversation without agent stays Codex despite a Pi default');
  await page.keyboard.press('Meta+n');
  await expect(page.locator('#composer-agent-name')).toHaveText('Pi');
  let state = await snapshot();
  const piConversation = state.conversations.find((item) => item.agent === 'pi')!;
  assert.ok(piConversation);
  const piId = piConversation.id;
  evidence.checks.push('New conversation inherits the application default');

  await page.locator('.sidebar-settings').click();
  const defaultRuntime = page.locator('[data-choice-label="新对话默认运行时"]');
  await defaultRuntime.click();
  await page.getByRole('option', { name: 'Claude Code', exact: true }).click();
  await expect.poll(async () => (await snapshot()).settings.agent).toBe('claude');
  state = await snapshot();
  assert.equal(state.conversations.find((item) => item.id === piId)?.agent, 'pi');
  assert.equal(state.conversations.find((item) => item.id === legacy.id)?.agent, undefined);
  await defaultRuntime.click();
  for (const info of state.agents.filter((item) => !item.available || !item.supported))
    await expect(page.getByRole('option', { name: new RegExp(`^${info.name}`) })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  await page.keyboard.press('Escape');
  await expect(page.locator('.agent-connection-heading h4')).toHaveText('Pi');
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(page.locator('#composer-agent-name')).toHaveText('Pi');
  evidence.checks.push(
    'Changing the default does not rebind existing conversations; unavailable choices are disabled',
  );

  const draft = () => page.getByRole('textbox', { name: '发送给 Agent 的任务', exact: true });
  const send = async (text: string) => {
    await draft().fill(text);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
  };
  const approvalAllowed = (pending: PendingAgentRequest) => {
    if (pending.kind !== 'approval' || pending.conversationId !== piId) return false;
    try {
      const input = JSON.parse(pending.request.detail);
      return (
        /Pi · (write|read)$/.test(pending.request.title) &&
        typeof input.path === 'string' &&
        path.resolve(workspace, input.path) === path.join(workspace, 'evidence.txt') &&
        (!pending.request.title.endsWith('write') ||
          (typeof input.content === 'string' && input.content.trim() === marker))
      );
    } catch {
      return false;
    }
  };
  const waitForReply = async (previousAssistant?: string, allowFileTools = false) => {
    const until = Date.now() + 100000;
    while (Date.now() < until) {
      const state = await snapshot();
      for (const pending of state.pendingRequests ?? []) {
        const panel = page.locator('.req[data-request-key]');
        await expect(panel).toHaveAttribute(
          'data-request-key',
          JSON.stringify([pending.conversationId, pending.messageId, pending.request.id]),
        );
        const allowed = allowFileTools && approvalAllowed(pending);
        await panel
          .getByRole('button', { name: allowed ? '允许这次' : '拒绝', exact: true })
          .click();
        assert.ok(allowed, 'An unreviewed or out-of-scope native operation was denied');
        evidence.approvals.push(pending.kind === 'approval' ? pending.request.title : '');
        await expect
          .poll(
            async () =>
              (await snapshot()).pendingRequests?.some(
                (item) =>
                  item.conversationId === pending.conversationId &&
                  item.messageId === pending.messageId &&
                  item.request.id === pending.request.id,
              ) ?? false,
          )
          .toBe(false);
      }
      const reply = state.conversations
        .find((item) => item.id === piId)
        ?.messages.findLast((item) => item.role === 'assistant');
      if (reply && reply.id !== previousAssistant) {
        assert.notEqual(reply.status, 'error', reply.failure ?? 'Pi execution failed');
        if (reply.status === 'done') return reply;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error('Timed out waiting for the actual Pi UI task');
  };
  await send(
    `Use the write tool to create evidence.txt in the current directory containing exactly ${marker}. Then use the read tool to verify that file. Reply with the exact content. Do not use bash or access any other files.`,
  );
  const firstReply = await waitForReply(undefined, true);
  assert.equal((await readFile(path.join(workspace, 'evidence.txt'), 'utf8')).trim(), marker);
  assert.ok(firstReply.text.includes(marker));
  assert.ok(evidence.approvals.includes('Pi · write') && evidence.approvals.includes('Pi · read'));
  assert.equal(firstReply.model?.source, 'cli-message');
  assert.ok(firstReply.model?.model);
  evidence.model = firstReply.model;
  const activity = page.locator('.activity').last();
  await activity.locator('button.act').click();
  for (const verb of ['读取', '写入'])
    await expect(activity.locator('.tl-title', { hasText: verb }).first()).toBeVisible();
  await expect
    .poll(async () => (await snapshot()).codexConnection?.status, { timeout: 15000 })
    .toBe('ready');
  await expect(page.locator('.local-agent-status')).toContainText('已就绪');
  const usage = await invoke<UsageSnapshot>('usage:snapshot');
  assert.ok(
    usage.records.some(
      (record) => record.id === firstReply.id && record.agent === 'pi' && record.observed,
    ),
  );
  state = await snapshot();
  const nativeId = state.conversations.find((item) => item.id === piId)?.agentSessionId;
  assert.ok(nativeId);
  await page.screenshot({
    path: path.join(output, 'pi-approved-result.png'),
    animations: 'disabled',
  });
  evidence.checks.push(
    'Real Pi file write/read approved through actual UI buttons; reply, model metadata and usage reach the host',
  );

  await app!.close();
  app = undefined;
  page = await launch();
  await expect(page.locator('#composer-agent-name')).toHaveText('Pi');
  assert.equal((await snapshot()).settings.agent, 'claude');
  await send(
    'Without using any tools, reply with only the exact marker you wrote in evidence.txt in the previous turn.',
  );
  const resumed = await waitForReply(firstReply.id);
  assert.ok(
    resumed.text.includes(marker),
    'The actual native session did not recall the earlier marker',
  );
  assert.equal(
    (await snapshot()).conversations.find((item) => item.id === piId)?.agentSessionId,
    nativeId,
  );
  evidence.checks.push(
    'Application restart restores the same Pi native session despite a different default',
  );

  await send(
    'Without using tools, count from 1 to 2000, writing each integer on a separate line. Do not stop early.',
  );
  await expect
    .poll(
      async () => {
        const reply = (await snapshot()).conversations
          .find((item) => item.id === piId)
          ?.messages.findLast((item) => item.role === 'assistant');
        return (
          !!reply &&
          reply.id !== resumed.id &&
          reply.status === 'streaming' &&
          reply.text.trim().length > 0
        );
      },
      { timeout: 60000 },
    )
    .toBe(true);
  const nextDraft = '保留这段草稿，稍后继续核对。';
  await draft().fill(nextDraft);
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect
    .poll(
      async () => {
        const reply = (await snapshot()).conversations
          .find((item) => item.id === piId)
          ?.messages.findLast((item) => item.role === 'assistant');
        return reply?.status === 'error' && /停止/.test(reply.failure ?? '');
      },
      { timeout: 15000 },
    )
    .toBe(true);
  await expect(draft()).toHaveText(nextDraft);
  await expect(page.getByRole('button', { name: '发送任务', exact: true })).toBeEnabled();
  evidence.checks.push(
    'Actual UI Stop interrupts a streaming Pi task and preserves the next draft without queueing',
  );

  await page.getByRole('button', { name: '选择 Agent', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Claude Code/ }).click();
  await expect(page.locator('#composer-agent-name')).toHaveText('Claude Code');
  state = await snapshot();
  assert.equal(state.settings.agent, 'claude');
  assert.ok(
    state.conversations.some(
      (item) => item.agent === 'claude' && item.id !== piId && !item.messages.length,
    ),
  );
  assert.equal(state.conversations.find((item) => item.id === piId)?.agentSessionId, nativeId);
  assert.deepEqual(
    state.conversations.find((item) => item.id === legacy.id),
    legacy,
  );
  evidence.checks.push(
    'Switching CLI from an executed conversation creates a separate conversation and preserves original archives',
  );
  evidence.passed = true;
  console.log(JSON.stringify(evidence));
} catch (error) {
  evidence.passed = false;
  evidence.error = error instanceof Error ? error.message : String(error);
  const page = app?.windows()[0];
  if (page)
    await page
      .screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' })
      .catch(() => {});
  throw error;
} finally {
  clearTimeout(deadline);
  await app?.close().catch(() => {});
  await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  await rm(directory, { recursive: true, force: true });
}
