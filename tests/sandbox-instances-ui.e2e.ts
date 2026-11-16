/** Actual Electron + Docker: the user creates, stops, keeps and deletes sandboxes in settings.
 * No model is involved. Run after npm run build: npx tsx tests/sandbox-instances-ui.e2e.ts
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron, expect } from '@playwright/test';
import type { SandboxInstancesState } from '../src/shared/sandbox';

const docker = promisify(execFile);
const root = process.cwd();
await mkdir(path.join(root, '.runtime'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.runtime/sandbox-instances-'));
const profile = path.join(directory, 'profile'),
  workspace = path.join(directory, 'workspace');
await mkdir(profile);
await mkdir(workspace);
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: { workspace, agent: 'claude' },
    conversations: [
      {
        id: 'instances-check',
        title: '沙箱实例检查',
        agent: 'claude',
        workspace,
        messages: [],
        updatedAt: Date.now(),
      },
    ],
    recordings: [],
    onboarding: {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      workspaceConfirmed: workspace,
      browserDeferred: true,
    },
  }),
);
const env: NodeJS.ProcessEnv = { ...process.env, WORKBENCH_USER_DATA_DIR: profile };
delete env.WORKBENCH_DEV_SERVER_URL;
const app = await electron.launch({
  args: [path.join(root, 'tests/electron-background.cjs')],
  cwd: root,
  env: Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  ),
});
const output = path.join(root, 'test-results/sandbox-instances-ui');
await mkdir(output, { recursive: true });
/** Every sandbox directory of the isolated profile, which is also its container name. */
const containers = async () =>
  (
    await Promise.all(
      ['', 'frontend', 'backend'].map((part) =>
        readdir(path.join(profile, 'sandboxes', part)).catch(() => [] as string[]),
      ),
    )
  )
    .flat()
    .filter((entry) => entry.startsWith('athena-'));
const status = async (container: string) =>
  (
    await docker('docker', ['inspect', '--format', '{{.State.Status}}', container]).catch(() => ({
      stdout: 'missing',
    }))
  ).stdout.trim();
const errors: string[] = [];
let created: string[] = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate('window.__name = fn => fn');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 960));
  const instances = () =>
    page.evaluate(() => window.workbench.invoke<SandboxInstancesState>('sandbox:instances'));

  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '沙箱' }).click();
  const panel = page.locator('.sandbox-settings');
  const count = panel.locator('.integration-count');
  const row = (name: string) => panel.getByRole('listitem').filter({ hasText: name });
  await expect(panel.getByRole('heading', { name: '沙箱', exact: true })).toBeVisible();
  await expect(count).toHaveText('0 个沙箱');
  await expect(panel.locator('.integration-empty')).toBeVisible();
  await page.screenshot({ path: path.join(output, 'empty.png') });

  // The three controls of the create row share one height and one centre line.
  const boxes = await panel
    .locator('.sandbox-create')
    .locator('.input, .choice-select-trigger, button[type="submit"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { height: box.height, centre: box.top + box.height / 2 };
      }),
    );
  assert.equal(boxes.length, 3);
  for (const box of boxes) {
    assert.ok(Math.abs(box.height - boxes[0].height) <= 1, JSON.stringify(boxes));
    assert.ok(Math.abs(box.centre - boxes[0].centre) <= 1, JSON.stringify(boxes));
  }

  const name = panel.getByRole('textbox', { name: '沙箱名称' });
  const submit = panel.getByRole('button', { name: '新建', exact: true });
  await expect(submit).toBeDisabled();
  await name.fill('支付页重构');
  await submit.click();
  await expect(row('支付页重构')).toContainText('运行中', { timeout: 120_000 });
  await expect(row('支付页重构')).toContainText('Node 前端');
  await expect(row('支付页重构')).toContainText('自建');
  await expect(name).toHaveValue('');

  await panel.locator('[data-choice-label="运行环境"]').click();
  await page.getByRole('option', { name: '基础 Node', exact: true }).click();
  await name.fill('scratch');
  await name.press('Enter');
  await expect(row('scratch')).toContainText('运行中', { timeout: 120_000 });
  await expect(count).toHaveText('2 个沙箱，2 个运行中');
  created = await containers();
  assert.equal(created.length, 2);
  assert.deepEqual(await Promise.all(created.map(status)), ['running', 'running']);
  await expect(row('scratch')).toContainText(/再闲置 (29|30) 分钟后停止/);
  await expect(row('scratch')).toContainText('再闲置 7 天后删除');
  await page.screenshot({ path: path.join(output, 'two-running.png') });

  await name.fill('Scratch');
  await submit.click();
  await expect(panel.getByRole('alert')).toContainText('已有名为');
  await name.fill('');

  // Each instance has its own preview window in the conversation that uses it.
  const web = (await instances()).instances.find((item) => item.name === '支付页重构')!;
  await page.evaluate(
    (target) =>
      window.workbench.invoke('sandbox:connect', { conversationId: 'instances-check', target }),
    web.id,
  );
  await expect(page.getByRole('region', { name: '支付页重构预览' })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'instance-preview-window.png') });
  const notice = page.getByRole('region', { name: '工作台提示' });
  if (await notice.isVisible()) {
    console.log('notice:', (await notice.innerText()).replace(/\s+/g, ' '));
    await page.getByRole('button', { name: '收起提醒', exact: true }).click();
  }
  await page
    .getByRole('region', { name: '支付页重构预览' })
    .getByRole('button', { name: '关闭预览' })
    .click();

  const webContainer = (await readdir(path.join(profile, 'sandboxes/frontend'))).find((entry) =>
    entry.startsWith('athena-'),
  )!;
  await row('支付页重构').getByRole('button', { name: '停止', exact: true }).click();
  await expect(row('支付页重构')).toContainText('已停止');
  assert.equal(await status(webContainer), 'exited');
  await expect(count).toHaveText('2 个沙箱，1 个运行中');
  await row('支付页重构').getByRole('button', { name: '启动', exact: true }).click();
  await expect(row('支付页重构')).toContainText('运行中', { timeout: 60_000 });
  assert.equal(await status(webContainer), 'running');

  await row('支付页重构').getByRole('button', { name: '保留', exact: true }).click();
  await expect(row('支付页重构')).toContainText('长期保留');
  await expect(row('支付页重构').getByRole('button', { name: '取消保留' })).toBeVisible();

  await panel.locator('[data-choice-label="多久不用后删除"]').click();
  await page.getByRole('option', { name: '14 天', exact: true }).click();
  await expect.poll(async () => (await instances()).policy.retainDays).toBe(14);
  await expect(row('scratch')).toContainText('再闲置 14 天后删除');

  // Deleting asks once more, then takes the container and the files with it.
  const remove = row('scratch').locator('.sandbox-remove');
  await remove.click();
  await expect(remove).toHaveText('确认删除文件');
  assert.equal((await containers()).length, 2);
  await remove.click();
  await expect(row('scratch')).toHaveCount(0);
  await expect(count).toHaveText('1 个沙箱，1 个运行中');
  assert.deepEqual(await containers(), [webContainer]);
  assert.deepEqual((await Promise.all(created.map(status))).sort(), ['missing', 'running']);
  await page.screenshot({ path: path.join(output, 'kept-one.png') });

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 700));
  await expect
    .poll(() =>
      panel
        .locator('.integration-list > li, .sandbox-create')
        .evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth + 1)),
    )
    .toBe(true);
  await page.screenshot({ path: path.join(output, 'narrow.png') });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.screenshot({ path: path.join(output, 'narrow-dark.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: sandbox instances are created, stopped, kept and deleted from settings');
} finally {
  await app.close();
  for (const container of new Set([...created, ...(await containers())]))
    await docker('docker', ['rm', '--force', container]).catch(() => {});
}
