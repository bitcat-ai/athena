/** The start page as the browser pane shows it at the default window size: real Electron, Chrome
 * and agent-browser. No model, Feishu or user credentials are used.
 * Run after npm run build: npx tsx tests/start-page.e2e.ts
 */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import { nodeShebang } from './node-script';
import type { AppSnapshot, ElementQueryResult, ElementRef } from '../src/shared/types';

const root = process.cwd();
await access(path.join(root, 'dist/main/main.cjs'));
await mkdir(path.join(root, 'test-results'), { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), 'athena-start-page-'));
const profile = path.join(directory, 'profile');
const bin = path.join(directory, 'bin');
await mkdir(bin, { recursive: true });
await seedLegacyWorkspace(profile);
for (const name of ['codex', 'claude', 'opencode', 'gemini'])
  await writeFile(path.join(bin, name), `${nodeShebang()}\nconsole.log('${name} fixture');\n`, {
    mode: 0o700,
  });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  WORKBENCH_USER_DATA_DIR: profile,
};
for (const key of [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'WORKBENCH_DEV_SERVER_URL',
])
  delete env[key];

// A hidden run must not take the keyboard from whoever is working on this Mac: the window is
// never activated, where hiding it after the fact would leave the application in front.
const hidden = process.env.WORKBENCH_HIDE_TEST_WINDOW === '1';
const quiet = path.join(directory, 'quiet-window.cjs');
await writeFile(
  quiet,
  String.raw`
const { BrowserWindow } = require('electron');
const { showInactive, hide } = BrowserWindow.prototype;
BrowserWindow.prototype.show = function () {
  this.webContents.setBackgroundThrottling(false);
  showInactive.call(this);
  hide.call(this);
};
BrowserWindow.prototype.focus = function () {};
`,
);

const app = await electron.launch({
  args: hidden ? ['-r', quiet, '.'] : ['.'],
  cwd: root,
  env: Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
});
const errors: string[] = [];
const checks: string[] = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
  const pageText = () =>
    page.evaluate(
      async () =>
        JSON.parse((await window.workbench.invoke<{ text: string }>('browser:snapshot')).text)
          .text as string,
    );
  const find = async (selector: string): Promise<ElementRef> => {
    const element = await page.evaluate(
      async (selector) =>
        (await window.workbench.invoke<ElementQueryResult>('browser:query', { selector }))
          .elements[0],
      selector,
    );
    assert.ok(element?.bounds, `Missing start page element: ${selector}`);
    return element;
  };
  /** Clicks where the element is drawn in the pane, the way a person would. */
  const click = async (selector: string) => {
    const { bounds } = await find(selector);
    const frame = (await snapshot()).browserFrame!;
    const surface = await page.locator('.browser-surface').boundingBox();
    assert.ok(bounds && surface);
    await page.mouse.click(
      surface.x + ((bounds.x + bounds.width / 2) * surface.width) / frame.width,
      surface.y + ((bounds.y + bounds.height / 2) * surface.height) / frame.height,
    );
  };

  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 45_000 })
    .toBe('ready');
  await expect
    .poll(async () => (await snapshot()).browser.title, { timeout: 15_000 })
    .toBe('Athena · 从想法开始');
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const frame = (await window.workbench.invoke<AppSnapshot>('app:snapshot')).browserFrame;
          const surface = document.querySelector('.browser-surface')!.getBoundingClientRect();
          return frame ? Math.abs(frame.width - Math.floor(surface.width)) : Infinity;
        }),
      { timeout: 15_000 },
    )
    .toBeLessThanOrEqual(1);
  checks.push('The browser opens on the start page');

  const origin = new URL((await snapshot()).browser.url).origin;
  for (const [file, type] of [
    ['/portrait.webp', 'image/webp'],
    ['/athena.png', 'image/png'],
  ]) {
    const response = await fetch(origin + file);
    assert.equal(response.status, 200, file);
    assert.equal(response.headers.get('content-type'), type);
    assert.ok((await response.arrayBuffer()).byteLength > 10_000, file);
  }
  assert.equal((await fetch(origin + '/elsewhere')).status, 404);
  checks.push('The page’s portrait and icon come from the app itself; nothing else is served');

  // Everything the person is invited to use first is on screen without scrolling.
  const frame = (await snapshot()).browserFrame!;
  for (const selector of ['#headline', '#title', '#title-form button', '#status', '#theme']) {
    const { bounds } = await find(selector);
    assert.ok(bounds);
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= frame.width, `${selector} is cut off`);
    assert.ok(
      bounds.y >= 0 && bounds.y + bounds.height <= frame.height,
      `${selector} is below the first screen (${bounds.y + bounds.height} > ${frame.height})`,
    );
  }
  const [field, button] = [await find('#title'), await find('#title-form button')];
  assert.equal(field.bounds!.y, button.bounds!.y, 'the field and its button share one row');
  await page.screenshot({
    path: path.join(root, 'test-results/start-page.png'),
    animations: 'disabled',
  });
  checks.push(
    `The headline, the title field and its button fit the first screen of a ${frame.width}×${frame.height} pane`,
  );

  // Picking the headline takes the headline itself: nothing lies over it.
  await page.getByRole('button', { name: '选取元素', exact: true }).click();
  await click('#headline');
  const token = page.locator('.composer .element-token');
  await expect(token).toContainText('ele1');
  await expect(token.locator('.element-token-body')).toHaveAttribute('title', /^h1\b/);
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  await composer.focus();
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await expect(token).toHaveCount(0);
  checks.push('The headline can be picked as an element');

  await click('#title-form button');
  await expect.poll(pageText).toContain('先写下你想用的标题。');
  await click('#title');
  await expect(page.getByRole('textbox', { name: '网页键盘输入' })).toBeFocused();
  await page.keyboard.type('A new beginning with Athena');
  await click('#title-form button');
  await expect.poll(pageText).toContain('标题已更新：A new beginning with Athena');
  await expect.poll(async () => (await find('#headline')).text).toBe('A new beginning with Athena');
  checks.push('Typing a title and pressing 应用标题 in the pane rewrites the headline');

  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        pane: [frame.width, frame.height],
        checks,
        screenshot: 'test-results/start-page.png',
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
