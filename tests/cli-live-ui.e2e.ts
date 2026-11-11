/** Real Electron and local CLI sessions; only isolated text tasks and explicit workspace approvals. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import type { AgentId, AppSnapshot, ChatMessage } from '../src/shared/types';

const cli = process.env.WORKBENCH_LIVE_CLI as AgentId;
const permissionOnly = process.env.WORKBENCH_CLI_UI_CHECK === 'permissions';
const iconsOnly = process.env.WORKBENCH_CLI_UI_CHECK === 'icons';
if (!['codex', 'claude', 'gemini', 'cursor'].includes(cli) || (permissionOnly && cli !== 'cursor'))
  throw new Error(
    'Set WORKBENCH_LIVE_CLI=codex|claude|gemini|cursor; permissions-only applies to Cursor.',
  );
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), `athena-${cli}-ui-`)));
const userData = path.join(directory, 'profile');
await seedLegacyWorkspace(userData);
const saved = JSON.parse(await readFile(path.join(userData, 'workspace.json'), 'utf8'));
saved.settings.agent = cli;
saved.onboarding = {
  version: 1,
  status: 'complete',
  stage: 'ready',
  required: false,
  workspaceConfirmed: saved.settings.workspace,
  browserDeferred: true,
};
await writeFile(path.join(userData, 'workspace.json'), JSON.stringify(saved), { mode: 0o600 });
const output = path.resolve(
  'test-results/cli-validation',
  cli + (permissionOnly ? '-permissions' : iconsOnly ? '-icons' : '-ui'),
);
await mkdir(output, { recursive: true });
const marker = `athena-${randomUUID()}`;
const checks: string[] = [];
const errors: string[] = [];
let app: ElectronApplication | undefined;
let page!: Page;
let conversationId: string | undefined;
const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
const launch = async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, WORKBENCH_USER_DATA_DIR: userData },
    timeout: 30000,
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.hide();
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.locator('#composer-agent-name')).toBeAttached({ timeout: 30000 });
};
const close = async () => {
  await app?.close();
  app = undefined;
};
const reply = (state: AppSnapshot): ChatMessage | undefined =>
  state.conversations
    .find((c) => c.id === conversationId)
    ?.messages.findLast((m) => m.role === 'assistant');
const send = async (text: string) => {
  await page.getByRole('textbox', { name: '发送给 Agent 的任务', exact: true }).fill(text);
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect
    .poll(async () => {
      const state = await snapshot();
      const conversation = state.conversations.find(
        (c) => c.agent === cli && c.messages.some((m) => m.role === 'user' && m.text === text),
      );
      conversationId = conversation?.id;
      return Boolean(conversation);
    })
    .toBe(true);
};
const decideWorkspace = async (approved: boolean) => {
  const state = await snapshot();
  for (const pending of state.pendingRequests || []) {
    assert.equal(pending.kind, 'approval', 'Unexpected native user input');
    if (pending.kind !== 'approval') continue;
    assert.ok(pending.request.id.startsWith(`${cli}-workspace:`));
    assert.equal(pending.conversationId, conversationId);
    assert.ok(pending.request.detail.startsWith(`${saved.settings.workspace}\n`));
    const panel = page.locator('.req[data-request-key]');
    await expect(panel).toHaveAttribute(
      'data-request-key',
      JSON.stringify([pending.conversationId, pending.messageId, pending.request.id]),
    );
    await panel.getByRole('button', { name: approved ? '允许这次' : '拒绝', exact: true }).click();
    checks.push(
      approved
        ? 'Explicit Cursor workspace approval in the actual host UI'
        : 'Workspace denial is handled without starting a model turn',
    );
  }
};
const settle = async (previousId?: string) => {
  await expect
    .poll(
      async () => {
        await decideWorkspace(true);
        const result = reply(await snapshot());
        return result && result.id !== previousId && result.status !== 'streaming'
          ? result.status
          : 'waiting';
      },
      { timeout: 120000, intervals: [100, 250, 500] },
    )
    .toBe('done');
  return reply(await snapshot())!;
};
const deadline = setTimeout(() => {
  void app?.close().catch(() => {});
}, 300000);
try {
  await launch();
  const initial = await snapshot();
  const info = initial.agents.find((a) => a.id === cli);
  assert.ok(info?.available && info.supported, `${cli} is not ready`);
  await expect(page.locator('#composer-agent-name')).toHaveText(info.name);
  checks.push('The selected installed CLI is reflected in the actual composer');

  if (cli === 'claude' || iconsOnly) {
    await page.locator('.sidebar-settings').click();
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => localStorage.setItem('athena.appearance', theme), theme);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.locator('.sidebar-settings').click();
      await page.locator('.runtime-installations summary').click();
      const icons = page.locator('.agent-setting-row img.agent-icon');
      await expect(icons).toHaveCount(6);
      await expect
        .poll(() =>
          icons.evaluateAll((nodes) =>
            nodes.every(
              (node) =>
                (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0,
            ),
          ),
        )
        .toBe(true);
      await page.locator('.agent-setting-row').last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `agent-logos-${theme}.png`) });
    }
    await page.getByRole('button', { name: '返回对话', exact: true }).click();
    checks.push('All six CLI brand images load in light and dark app themes');
  }

  if (permissionOnly) {
    await send('Reply with only ATHENA_PERMISSION_CHECK. Do not use tools.');
    await expect.poll(async () => (await snapshot()).pendingRequests?.length || 0).toBe(1);
    await decideWorkspace(false);
    await expect.poll(async () => reply(await snapshot())?.status).toBe('error');
    assert.match(reply(await snapshot())?.failure || reply(await snapshot())?.text || '', /拒绝/);
    assert.equal(
      (await snapshot()).conversations.find((c) => c.id === conversationId)?.agentSessionId,
      undefined,
    );
    await send('Reply only after the workspace is approved.');
    await expect.poll(async () => (await snapshot()).pendingRequests?.length || 0).toBe(1);
    await page.getByRole('button', { name: '停止任务', exact: true }).click();
    await expect.poll(async () => (await snapshot()).pendingRequests?.length || 0).toBe(0);
    assert.equal(
      (await snapshot()).conversations.find((c) => c.id === conversationId)?.agentSessionId,
      undefined,
    );
    checks.push(
      'Stopping while workspace approval is pending clears the request and launches no CLI session',
    );
  } else if (!iconsOnly) {
    await send(
      `Remember this marker: ${marker}. Reply with only the exact marker. Do not use tools or read files.`,
    );
    const first = await settle();
    assert.ok(first.text.includes(marker));
    const nativeId = (await snapshot()).conversations.find(
      (c) => c.id === conversationId,
    )?.agentSessionId;
    assert.ok(nativeId);
    checks.push(
      'A real CLI response streams into the correct conversation with a native session ID',
    );
    await close();
    await launch();
    await send('Reply with only the exact marker from the previous turn. Do not use tools.');
    const resumed = await settle(first.id);
    assert.ok(resumed.text.includes(marker));
    assert.equal(
      (await snapshot()).conversations.find((c) => c.id === conversationId)?.agentSessionId,
      nativeId,
    );
    checks.push(
      'Restarting Electron resumes the original native session and recalls its earlier marker',
    );
    await send(
      'Without tools, count from 1 to 2000 with one integer on each line. Do not stop early.',
    );
    await expect
      .poll(
        async () => {
          await decideWorkspace(true);
          const result = reply(await snapshot());
          return result?.status === 'streaming' && result.text.length > 0;
        },
        { timeout: 120000, intervals: [100, 250] },
      )
      .toBe(true);
    const draft = page.getByRole('textbox', { name: '发送给 Agent 的任务', exact: true });
    await draft.fill('停止后保留的下一段草稿');
    await page.getByRole('button', { name: '停止任务', exact: true }).click();
    await expect.poll(async () => reply(await snapshot())?.status).not.toBe('streaming');
    await expect(draft).toHaveText('停止后保留的下一段草稿');
    const stopped = reply(await snapshot())!;
    await send(
      'Reply with only the original marker from before the counting task. Do not use tools.',
    );
    const recovered = await settle(stopped.id);
    assert.ok(recovered.text.includes(marker));
    assert.equal(
      (await snapshot()).conversations.find((c) => c.id === conversationId)?.agentSessionId,
      nativeId,
    );
    checks.push(
      'Stop ends the live turn, preserves the draft, and the same native session can continue afterward',
    );
    await page.screenshot({ path: path.join(output, 'conversation.png') });
  }
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    cli,
    scope: permissionOnly
      ? 'workspace-permission-ui-only'
      : iconsOnly
        ? 'brand-icons-ui-only'
        : 'real-native-conversation-ui',
    realModelTurns: permissionOnly || iconsOnly ? 0 : 4,
    checks,
    errors,
  };
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify({ cli, error: String(error), checks, errors }, null, 2),
  );
  await page!?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  clearTimeout(deadline);
  await close();
  await rm(directory, { recursive: true, force: true });
}
