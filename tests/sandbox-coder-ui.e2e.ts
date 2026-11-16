/** Actual Electron + a real Coder deployment: the user connects Coder in settings, creates
 * sandboxes from a template, stops, starts, keeps and deletes them, and disconnects.
 * No model is involved. Run after npm run build, with the variables of tests/coder-live.test.ts:
 *   ATHENA_TEST_CODER_URL=… ATHENA_TEST_CODER_TOKEN_FILE=… npx tsx tests/sandbox-coder-ui.e2e.ts
 * The connection is handed over in the environment, so the keychain is not involved.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { CoderApi } from '../src/main/coder-api';
import type { SandboxInstancesState } from '../src/shared/sandbox';

const url = process.env.ATHENA_TEST_CODER_URL,
  tokenFile = process.env.ATHENA_TEST_CODER_TOKEN_FILE;
if (!url || !tokenFile) {
  console.log('SKIP: set ATHENA_TEST_CODER_URL and ATHENA_TEST_CODER_TOKEN_FILE');
  process.exit(0);
}
const token = (await readFile(tokenFile, 'utf8')).trim();
const api = new CoderApi(new URL(url).origin, token, fetch);
const account = (await api.me()).username;
const wanted = process.env.ATHENA_TEST_CODER_TEMPLATE;
const template = (await api.templates()).find((item) => !wanted || item.name === wanted);
assert.ok(template, 'the deployment has no such template');
const environment = 'Coder · ' + (template.display_name || template.name);

const root = process.cwd();
await mkdir(path.join(root, '.runtime'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.runtime/sandbox-coder-'));
const profile = path.join(directory, 'profile'),
  workspace = path.join(directory, 'workspace');
await mkdir(profile);
await mkdir(workspace);
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: { workspace, agent: 'claude' },
    conversations: [],
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
const output = path.join(root, 'test-results/sandbox-coder-ui');
await mkdir(output, { recursive: true });
const launch = (extra: Record<string, string>) => {
  const env: NodeJS.ProcessEnv = { ...process.env, WORKBENCH_USER_DATA_DIR: profile, ...extra };
  delete env.WORKBENCH_DEV_SERVER_URL;
  return electron.launch({
    args: [path.join(root, 'tests/electron-background.cjs')],
    cwd: root,
    env: Object.fromEntries(
      Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
    ),
  });
};
/** What Coder itself says about the workspaces of this profile, by name. */
const mine = async () => {
  const owner = (await readFile(path.join(profile, 'sandboxes/coder-owner'), 'utf8')).trim();
  return new Map(
    (await api.workspaces())
      .filter((item) => item.name.startsWith(`athena-${owner}-`))
      .map((item) => [item.name, `${item.latest_build.transition} ${item.latest_build.status}`]),
  );
};
const errors: string[] = [];
const open = async (app: Awaited<ReturnType<typeof launch>>) => {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate('window.__name = fn => fn');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 960));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '沙箱' }).click();
  return page;
};

// Not connected: the form is there, and a wrong token is refused without anything being stored.
let app = await launch({});
try {
  const page = await open(app);
  const section = page.getByRole('region', { name: 'Coder', exact: true });
  const connect = section.getByRole('button', { name: '连接', exact: true });
  await expect(connect).toBeDisabled();
  await expect(section.getByText('已连接')).toHaveCount(0);
  await section.getByRole('textbox', { name: 'Coder 地址' }).fill(url);
  await section.getByLabel('Coder 令牌').fill('not-a-token');
  const boxes = await section
    .locator('.sandbox-coder-connect')
    .locator('.input, button[type="submit"]')
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
  await connect.click();
  await expect(page.locator('.sandbox-settings').getByRole('alert')).toContainText(
    '令牌无效或已过期',
  );
  await expect(section.getByText('已连接')).toHaveCount(0);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'not-connected.png') });
  await assert.rejects(stat(path.join(profile, 'coder/connection.json')));
} finally {
  await app.close();
}

app = await launch({ WORKBENCH_CODER_URL: url, WORKBENCH_CODER_TOKEN: token });
try {
  const page = await open(app);
  const instances = () =>
    page.evaluate(() => window.workbench.invoke<SandboxInstancesState>('sandbox:instances'));
  const panel = page.locator('.sandbox-settings');
  const section = page.getByRole('region', { name: 'Coder', exact: true });
  const count = panel.locator('.integration-count');
  const row = (name: string) => panel.getByRole('listitem').filter({ hasText: name });
  await expect(section).toContainText(`已连接 ${new URL(url).origin} · ${account}`);
  await expect(section.getByRole('textbox', { name: 'Coder 地址' })).toHaveCount(0);
  // The token of the environment is used for this run and neither stored nor passed on.
  await assert.rejects(stat(path.join(profile, 'coder/connection.json')));
  assert.deepEqual(
    await app.evaluate(() => [
      process.env.WORKBENCH_CODER_URL ?? null,
      process.env.WORKBENCH_CODER_TOKEN ?? null,
    ]),
    [null, null],
  );
  await expect(count).toHaveText('0 个沙箱');

  // Coder templates come first among the environments, so a new sandbox goes there.
  await expect(panel.locator('[data-choice-label="运行环境"]')).toContainText(environment);
  const name = panel.getByRole('textbox', { name: '沙箱名称' });
  await name.fill('支付页重构');
  await panel.getByRole('button', { name: '新建', exact: true }).click();
  await expect(row('支付页重构')).toContainText('运行中', { timeout: 300_000 });
  await expect(row('支付页重构')).toContainText(environment);
  await expect(row('支付页重构')).toContainText('自建');
  await name.fill('scratch');
  await name.press('Enter');
  await expect(row('scratch')).toContainText('运行中', { timeout: 300_000 });
  await expect(count).toHaveText('2 个沙箱，2 个运行中');
  assert.deepEqual([...(await mine()).values()], ['start running', 'start running']);
  await expect(row('scratch')).toContainText(/再闲置 (29|30) 分钟后停止/);
  await expect(row('scratch')).toContainText('再闲置 7 天后删除');
  const state = await instances();
  assert.deepEqual(
    state.instances.map((item) => item.provider),
    ['coder', 'coder'],
  );
  await page.screenshot({ path: path.join(output, 'two-running.png') });
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'connected.png') });

  // A local environment is still one choice away.
  await panel.locator('[data-choice-label="运行环境"]').click();
  await expect(page.getByRole('option', { name: '本机 · 基础 Node', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'environments.png') });
  await page.keyboard.press('Escape');

  await row('支付页重构').getByRole('button', { name: '停止', exact: true }).click();
  await expect(row('支付页重构')).toContainText('已停止', { timeout: 120_000 });
  await expect(count).toHaveText('2 个沙箱，1 个运行中');
  assert.deepEqual([...(await mine()).values()].sort(), ['start running', 'stop stopped']);
  await row('支付页重构').getByRole('button', { name: '启动', exact: true }).click();
  await expect(row('支付页重构')).toContainText('运行中', { timeout: 300_000 });
  assert.deepEqual([...(await mine()).values()], ['start running', 'start running']);

  await row('支付页重构').getByRole('button', { name: '保留', exact: true }).click();
  await expect(row('支付页重构')).toContainText('长期保留');

  // Deleting asks once more, then the workspace is gone from Coder.
  const remove = row('scratch').locator('.sandbox-remove');
  await remove.click();
  await expect(remove).toHaveText('确认删除文件');
  assert.equal((await mine()).size, 2);
  await remove.click();
  await expect(row('scratch')).toHaveCount(0, { timeout: 120_000 });
  await expect(count).toHaveText('1 个沙箱，1 个运行中');
  assert.deepEqual([...(await mine()).values()], ['start running']);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 700));
  await expect
    .poll(() =>
      panel
        .locator('.integration-list > li, .sandbox-create, .sandbox-coder .settings-value-row')
        .evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth + 1)),
    )
    .toBe(true);
  await page.screenshot({ path: path.join(output, 'narrow.png') });

  // Disconnecting says what happens to the sandbox, takes it off the list and leaves the
  // workspace on Coder, asked to stop.
  const disconnect = section.locator('.sandbox-remove');
  await disconnect.click();
  await expect(disconnect).toHaveText('确认断开');
  await expect(section.getByRole('status')).toContainText('1 个 Coder 沙箱从列表移除');
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'disconnect-notice.png') });
  await disconnect.click();
  await expect(section.getByRole('textbox', { name: 'Coder 地址' })).toBeVisible();
  await expect(count).toHaveText('0 个沙箱');
  await expect(panel.locator('[data-choice-label="运行环境"]')).not.toContainText('Coder');
  const left = await mine();
  assert.equal(left.size, 1);
  assert.match([...left.values()][0], /^stop /);
  assert.deepEqual(errors, []);
  console.log('PASS: Coder sandboxes are created, stopped, kept, deleted and disconnected');
} finally {
  await app.close();
  // Whatever is left belongs to this run's profile only.
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const left = await mine().catch(() => new Map<string, string>());
    if (!left.size || Date.now() > deadline) break;
    for (const item of await api.workspaces())
      if (
        left.has(item.name) &&
        !['pending', 'starting', 'stopping', 'deleting'].includes(item.latest_build.status)
      )
        await api.build(item.id, 'delete').catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.equal((await mine().catch(() => new Map())).size, 0);
}
