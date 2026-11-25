/** The edit timeline in the real app: a real page, real preview edits, the row in the browser pane.
 * No model, Feishu or user credentials are used. Run after a build:
 *   npx tsx tests/edit-timeline-ui.e2e.ts
 * ATHENA_TEST_ENTRY points at a background entry when the build lives outside this checkout.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import type { AppSnapshot, ElementQueryResult } from '../src/shared/types';

const directory = await mkdtemp(path.join(tmpdir(), 'athena-timeline-ui-'));
const profile = path.join(directory, 'profile');
const workspace = path.join(directory, 'workspace');
const output = path.resolve(process.env.ATHENA_TEST_OUTPUT || 'test-results/edit-timeline');
for (const folder of [profile, workspace, output]) await mkdir(folder, { recursive: true });
const site = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html;charset=utf-8');
  response.end(
    '<!doctype html><meta charset="utf-8"><title>Plans</title><style>body{margin:0;padding:48px;font:16px sans-serif}h1{font-size:40px;margin:0 0 12px}p{color:#555}#buy{margin-top:24px;padding:12px 20px}</style>' +
      '<h1 id="title">Simple pricing</h1><p id="lead">One plan for every team.</p><button id="buy">Start now</button>',
  );
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: { agent: 'codex', workspace },
    conversations: [
      { id: 'timeline', title: 'Timeline', agent: 'codex', workspace, messages: [], updatedAt: 1 },
    ],
    recordings: [],
    onboarding: {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      workspaceConfirmed: workspace,
    },
  }),
);

const app = await electron.launch({
  args: [process.env.ATHENA_TEST_ENTRY || 'tests/electron-background.cjs', '--use-mock-keychain'],
  cwd: process.cwd(),
  env: { ...process.env, WORKBENCH_DEV_SERVER_URL: '', WORKBENCH_USER_DATA_DIR: profile } as Record<
    string,
    string
  >,
});
const errors: string[] = [];
const checks: string[] = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate('globalThis.__name = value => value; void 0');
  const invoke = <T>(action: string, payload?: unknown) =>
    page.evaluate(
      ({ action, payload }) => window.workbench.invoke<T>(action, payload),
      { action, payload },
    ) as Promise<T>;
  const snapshot = () => invoke<AppSnapshot>('app:snapshot');
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 45_000 })
    .toBe('ready');
  await invoke('browser:navigate', { url });
  await expect.poll(async () => (await snapshot()).browser.title, { timeout: 20_000 }).toBe('Plans');
  const row = page.locator('.edit-timeline');
  await expect(row).toHaveCount(0);
  checks.push('A page without preview edits shows no timeline');

  const ref = async (selector: string) =>
    (await invoke<ElementQueryResult>('browser:query', { selector })).elements[0].ref;
  const text = async (selector: string) =>
    (await invoke<ElementQueryResult>('browser:query', { selector })).elements[0].text;
  await invoke('browser:edit', { ref: await ref('#title'), text: 'Pricing that scales' });
  await invoke('browser:edit', { ref: await ref('#title'), styles: { color: 'rgb(180, 30, 30)' } });
  await invoke('browser:edit', { ref: await ref('#buy'), text: 'Try it free' });

  await expect(row).toBeVisible();
  await expect(row.locator('.edit-timeline-mark')).toHaveCount(4);
  await expect(row.locator('.edit-timeline-count')).toHaveText('3 / 3');
  await expect(row.locator('.edit-timeline-label')).toContainText('你 · 改文字');
  const status = page.locator('.browser-status');
  const [rowBox, statusBox] = [(await row.boundingBox())!, (await status.boundingBox())!];
  assert.ok(rowBox.y + rowBox.height <= statusBox.y + 1, 'the timeline sits above the status row');
  assert.ok(rowBox.height <= 40, `the timeline is one row (${rowBox.height}px)`);
  await page.screenshot({ path: path.join(output, 'latest.png') });
  checks.push('Three edits give a one-row timeline with a mark for each and for the original page');

  // The arrow keys move one edit at a time; the page follows.
  const thumb = row.getByRole('slider');
  await thumb.focus();
  await thumb.press('ArrowLeft');
  await expect(row.locator('.edit-timeline-count')).toHaveText('2 / 3');
  await expect.poll(() => text('#buy')).toBe('Start now');
  assert.equal(await text('#title'), 'Pricing that scales');
  await expect(thumb).toHaveAttribute('aria-valuetext', /第 2 步，共 3 步/);
  await thumb.press('Home');
  await expect(row.locator('.edit-timeline-count')).toHaveText('0 / 3');
  await expect(row.locator('.edit-timeline-label')).toHaveText('原始页面');
  await expect.poll(() => text('#title')).toBe('Simple pricing');
  await page.screenshot({ path: path.join(output, 'original.png') });
  checks.push('Arrow keys and Home walk back through the edits and the page shows each point');

  // Dragging with the pointer does the same.
  const track = (await row.locator('.slider__track').boundingBox())!;
  await page.mouse.move(track.x + 2, track.y + track.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width, track.y + track.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(row.locator('.edit-timeline-count')).toHaveText('3 / 3');
  await expect.poll(() => text('#buy')).toBe('Try it free');
  assert.equal(await text('#title'), 'Pricing that scales');
  checks.push('Dragging to the end brings every edit back');

  // A new edit from an earlier point replaces what came after it.
  await thumb.focus();
  await thumb.press('ArrowLeft');
  await thumb.press('ArrowLeft');
  await expect(row.locator('.edit-timeline-count')).toHaveText('1 / 3');
  await expect.poll(() => text('#buy')).toBe('Start now');
  await invoke('browser:edit', { ref: await ref('#lead'), text: 'Pay for what you use.' });
  await expect(row.locator('.edit-timeline-count')).toHaveText('2 / 2');
  assert.equal((await snapshot()).browser.timeline?.entries.length, 2);
  checks.push('Editing from an earlier point drops the later edits');

  await invoke('browser:navigate', { url: url + '?next' });
  await expect(row).toHaveCount(0);
  checks.push('Leaving the page removes its timeline');
  assert.deepEqual(errors, []);
  for (const check of checks) console.log('PASS ' + check);
} finally {
  await app.close().catch(() => {});
  await new Promise<void>((resolve) => site.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
