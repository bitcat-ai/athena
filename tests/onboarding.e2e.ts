/** Native onboarding integration: real CLI/readiness and filesystem, controlled directory picker; no model or login requests. */
import assert from 'node:assert/strict';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppSnapshot } from '../src/shared/types';

const root = process.cwd();
const directory = await mkdtemp(path.join(root, '.runtime/onboarding-native-'));
const profile = path.join(directory, 'new-profile');
const workspace = path.join(directory, 'project');
const output = path.join(root, 'test-results/onboarding-native');
await mkdir(workspace, { recursive: true });
await mkdir(output, { recursive: true });
const errors: string[] = [];
const checks: string[] = [];
let app: ElectronApplication | undefined;
let page!: Page;
const executable = process.env.ATHENA_TEST_APP;
async function launch(data: string) {
  app = await electron.launch({
    ...(executable ? { executablePath: executable } : {}),
    args: executable ? [] : ['.'],
    cwd: root,
    env: {
      ...process.env,
      WORKBENCH_USER_DATA_DIR: data,
      WORKBENCH_BROWSER_PATH: path.resolve(
        '../browseros-runtime/BrowserOS neo.app/Contents/MacOS/BrowserOS neo',
      ),
    },
  });
  page = await app.firstWindow();
  await page.evaluate('window.__name = (fn) => fn');
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    window.hide();
  });
}
const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
async function close() {
  await app?.close();
  app = undefined;
}
try {
  await launch(profile);
  await expect(page!.locator('.onboarding')).toBeVisible();
  await expect(page!.getByRole('heading', { name: 'hello, Athena.', exact: true })).toBeVisible();
  assert.equal((await snapshot()).conversations.length, 0);
  assert.deepEqual(
    (await snapshot()).agents,
    [],
    'First-use greeting appears before local CLI discovery',
  );
  await page!.screenshot({ path: path.join(output, 'welcome.png'), animations: 'disabled' });
  await close();
  await launch(profile);
  await expect(page!.locator('.onboarding')).toBeVisible();
  assert.equal((await snapshot()).conversations.length, 0);
  checks.push(
    'An unconfigured profile opens the local greeting; closing before interaction and reopening retains onboarding without inventing conversation history',
  );

  await page!.getByRole('button', { name: '开始配置', exact: true }).click();
  await expect
    .poll(async () => (await snapshot()).onboarding?.codex.status, { timeout: 20000 })
    .toBe('ready');
  await page!.getByRole('button', { name: '选择 Codex', exact: true }).click();
  await expect(page!.locator('.onboarding .is-current')).toHaveAttribute(
    'data-screen',
    /connected|folder/,
    { timeout: 20000 },
  );
  const before = (await snapshot()).settings.workspace;
  await app!.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, workspace);
  await page!.getByRole('button', { name: '选择项目文件夹', exact: true }).click();
  await expect
    .poll(async () => (await snapshot()).onboarding?.workspace.candidate?.path)
    .toBe(workspace);
  assert.equal(
    (await snapshot()).settings.workspace,
    before,
    'Choosing a candidate must not commit it',
  );
  await page!.getByRole('button', { name: '使用这个目录', exact: true }).click();
  await expect.poll(async () => (await snapshot()).onboarding?.workspace.status).toBe('ready');
  assert.equal((await snapshot()).settings.workspace, workspace);
  assert.equal((await snapshot()).onboarding?.coreReady, true);
  checks.push(
    'The installed Codex is probed without a model request; a real writable directory is committed only after candidate confirmation',
  );

  await page!.getByRole('button', { name: '准备浏览器', exact: true }).click();
  await expect
    .poll(async () => (await snapshot()).onboarding?.browser.status, { timeout: 150000 })
    .toBe('ready');
  await expect.poll(async () => (await snapshot()).neo?.status, { timeout: 150000 }).toBe('ready');
  await expect.poll(async () => (await snapshot()).browser.title).toBe('Athena · 从想法开始');
  await page!.screenshot({ path: path.join(output, 'ready.png'), animations: 'disabled' });
  await expect(page!.locator('.onboarding')).toHaveCount(0, { timeout: 30000 });
  await expect(page!.locator('.browser-drawer')).toHaveClass(/is-open/);
  await expect.poll(async () => (await snapshot()).browserFrame?.width ?? 0).toBeGreaterThan(0);
  const browserSnapshot = async () =>
    page.evaluate(async () =>
      JSON.parse((await window.workbench.invoke<{ text: string }>('browser:snapshot')).text),
    );
  const clickPageElement = async (selector: string) => {
    const target = await page.evaluate(async (selector) => {
      const result = await window.workbench.invoke<any>('browser:query', { selector });
      return result.elements[0];
    }, selector);
    assert.ok(target?.bounds, `Missing landing page element: ${selector}`);
    const frame = (await snapshot()).browserFrame!;
    const surface = await page.locator('.browser-surface').boundingBox();
    assert.ok(surface);
    await page.mouse.click(
      surface.x + ((target.bounds.x + target.bounds.width / 2) * surface.width) / frame.width,
      surface.y + ((target.bounds.y + target.bounds.height / 2) * surface.height) / frame.height,
    );
  };
  await clickPageElement('#title');
  await page.keyboard.type('A new beginning with Athena');
  await clickPageElement('#title-form button');
  await expect
    .poll(async () => (await browserSnapshot()).text)
    .toContain('标题已更新：A new beginning with Athena');
  await page.screenshot({ path: path.join(output, 'landing-interactive.png') });
  checks.push(
    'Completing setup opens the actual Athena landing page in the right browser; native mouse and keyboard change its title',
  );
  const composer = page!.getByRole('textbox', { name: '发送给 Agent 的任务' });
  await composer.fill('这是一份尚未发送的草稿');
  const conversationsBefore = (await snapshot()).conversations.map((item) => item.id);
  await page!.locator('.sidebar-settings').click();
  await page!.getByRole('button', { name: '重新查看引导', exact: true }).click();
  await expect(page!.locator('.onboarding')).toBeVisible();
  await page!.getByRole('button', { name: '跳过设置', exact: true }).click();
  await expect(page!.locator('.onboarding')).toHaveCount(0, { timeout: 30000 });
  await page!.getByRole('button', { name: '返回对话', exact: true }).click();
  await expect(composer).toHaveText('这是一份尚未发送的草稿');
  assert.deepEqual(
    (await snapshot()).conversations.map((item) => item.id),
    conversationsBefore,
  );
  checks.push(
    'Existing BrowserOS and Neo become ready; returning from reopened setup preserves the draft and conversation IDs',
  );
  await close();
  await launch(profile);
  await expect(page!.getByRole('textbox', { name: '发送给 Agent 的任务' })).toBeVisible();
  await expect(page!.locator('.onboarding')).toHaveCount(0, { timeout: 30000 });
  checks.push('A completed or deliberately deferred profile does not reopen setup on restart');
  await close();

  await launch(path.join(directory, 'browser-deferred-profile'));
  await page!.getByRole('button', { name: '开始配置', exact: true }).click();
  await page!.getByRole('button', { name: '选择 Codex', exact: true }).click();
  await page!.getByRole('button', { name: '先不选文件夹', exact: true }).click();
  await expect.poll(async () => (await snapshot()).onboarding?.workspace.mode).toBe('personal');
  await expect.poll(async () => (await snapshot()).onboarding?.workspace.status).toBe('ready');
  assert.equal((await snapshot()).settings.workspaceMode, 'personal');
  await page!.getByRole('button', { name: '以后再说', exact: true }).click();
  await expect(page!.locator('.onboarding')).toHaveCount(0, { timeout: 30000 });
  await page!.locator('.new-conversation').click();
  await expect
    .poll(async () => (await snapshot()).codexConnection?.status, { timeout: 60000 })
    .toBe('ready');
  assert.equal((await snapshot()).browser.status, 'missing');
  assert.equal((await snapshot()).neo?.status, 'stopped');
  assert.equal((await snapshot()).onboarding?.browser.status, 'deferred');
  checks.push(
    'Project-free setup uses the private workspace; skipping the optional browser keeps Neo stopped while a new conversation can prepare the real Codex connection',
  );
  await close();

  const legacyProfile = path.join(directory, 'legacy-profile');
  await mkdir(legacyProfile);
  await writeFile(
    path.join(legacyProfile, 'workspace.json'),
    JSON.stringify({
      settings: { workspace, agent: 'codex' },
      conversations: [
        {
          id: 'legacy-conversation',
          title: '已有项目对话',
          workspace,
          updatedAt: Date.now(),
          messages: [],
        },
      ],
      recordings: [],
    }),
  );
  await launch(legacyProfile);
  await expect(page!.getByRole('textbox', { name: '发送给 Agent 的任务' })).toBeVisible();
  await expect(page!.locator('.onboarding')).toHaveCount(0, { timeout: 30000 });
  assert.equal((await snapshot()).onboarding?.status, 'legacy');
  await page!.locator('.sidebar-settings').click();
  await page!.getByRole('button', { name: '重新查看引导', exact: true }).click();
  await expect(page!.locator('.onboarding')).toBeVisible();
  await page!.getByRole('button', { name: '跳过设置', exact: true }).click();
  await expect(page!.locator('.onboarding')).toHaveCount(0, { timeout: 30000 });
  assert.ok((await snapshot()).conversations.some((item) => item.id === 'legacy-conversation'));
  const saved = JSON.parse(await readFile(path.join(legacyProfile, 'workspace.json'), 'utf8'));
  assert.equal(saved.settings.workspace, workspace);
  checks.push(
    'A legacy workspace without an onboarding marker enters the existing app and can open/leave setup without losing its records',
  );
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    source: executable ? 'packaged-Electron' : 'Electron-build',
    realCodexProbe: true,
    realBrowserOS: true,
    directoryPicker: 'controlled result with real filesystem checks',
    realModelCalls: 0,
    realLoginAttempts: 0,
    realMessagesSent: 0,
    checks,
    errors,
  };
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  if (app) await page!.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await close();
}
