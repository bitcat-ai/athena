/** Trying a page on with extreme content in the real app: the picker, the findings row, the marks on
 * the page and the hand-over to the composer. No model, Feishu or user credentials are used.
 * Run after a build: npx tsx tests/page-stress-ui.e2e.ts
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import type { AppSnapshot, ElementQueryResult } from '../src/shared/types';

const directory = await mkdtemp(path.join(tmpdir(), 'athena-stress-ui-'));
const profile = path.join(directory, 'profile');
const workspace = path.join(directory, 'workspace');
const output = path.resolve(process.env.ATHENA_TEST_OUTPUT || 'test-results/page-stress');
for (const folder of [profile, workspace, output]) await mkdir(folder, { recursive: true });
const site = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html;charset=utf-8');
  response.end(
    '<!doctype html><meta charset="utf-8"><title>Plans</title><style>body{margin:0;padding:40px;font:16px/1.4 sans-serif}nav{display:flex;gap:16px;margin-bottom:28px}nav a{display:block;width:84px;color:#333}h1{font-size:36px;margin:0 0 8px}#lead{max-width:520px;color:#555}.plans{display:flex;gap:16px;margin-top:24px}.plan{width:200px;border:1px solid #ddd;border-radius:12px;padding:16px}.plan b{display:block;white-space:nowrap}.price{display:inline-block;width:96px;overflow:hidden;white-space:nowrap;font-size:24px}.buy{display:block;width:120px;height:36px;margin-top:12px;overflow:hidden;white-space:nowrap}</style>' +
      '<nav><a href="#">Home</a><a href="#">Plans</a><a href="#">Docs</a></nav><h1 id="title">Simple pricing</h1><p id="lead">One plan for every team, billed monthly.</p>' +
      '<div class="plans"><div class="plan"><b>Starter</b><span class="price">$19</span><button class="buy">Start now</button></div><div class="plan"><b>Team</b><span class="price">$49</span><button class="buy">Start now</button></div></div>',
  );
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: { agent: 'codex', workspace },
    conversations: [
      { id: 'stress', title: 'Stress', agent: 'codex', workspace, messages: [], updatedAt: 1 },
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
  const text = async (selector: string) =>
    (await invoke<ElementQueryResult>('browser:query', { selector })).elements[0].text;
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 45_000 })
    .toBe('ready');
  await invoke('browser:navigate', { url });
  await expect.poll(async () => (await snapshot()).browser.title, { timeout: 20_000 }).toBe('Plans');

  await page.locator('button', { hasText: '打开浏览器' }).first().click();
  // The control sits in the status row, which stays one line with everything inside it.
  const tools = page.locator('.browser-status');
  const picker = page.locator('[data-choice-label="内容试穿"]');
  await expect(picker).toBeVisible();
  const row = (await tools.boundingBox())!;
  assert.ok(row.height <= 40, `the status row is one line (${row.height}px)`);
  for (const control of await tools.locator('button').all()) {
    const box = await control.boundingBox();
    if (box) assert.ok(box.x + box.width <= row.x + row.width + 1, 'no control is pushed out of the row');
  }
  const report = page.locator('.stress-report');
  await expect(report).toHaveCount(0);
  await page.screenshot({ path: path.join(output, 'before.png') });
  checks.push('The picker sits in the status row without wrapping it');

  await picker.click();
  await page.getByRole('option', { name: '超长内容' }).click();
  await expect(report).toBeVisible({ timeout: 10_000 });
  await expect(report.locator('.stress-report-lead')).toContainText('超长内容');
  await expect(report.locator('.stress-report-lead')).toContainText(/发现 \d+ 处问题/);
  await expect.poll(() => text('#title')).toBe('Simple pricing Simple pricing Simple pricing');
  const result = (await snapshot()).browser.stress!;
  assert.equal(result.kind, 'long');
  assert.ok(result.issues.some((issue) => issue.problem === 'clipped'), JSON.stringify(result.issues));
  assert.ok(result.issues.some((issue) => issue.problem === 'overflow'));
  assert.equal((await snapshot()).browser.previewEdits?.length ?? 0, 0, 'a trial is not a change to land');
  const box = (await report.boundingBox())!;
  assert.ok(box.height <= 40, `the findings are one row (${box.height}px)`);
  await expect(page.locator('.edit-timeline-label')).toContainText('内容试穿');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(output, 'long.png') });
  checks.push('Long content is applied, the weak spots are counted and the timeline names the trial');

  await report.locator('.stress-issue:not([disabled])').first().click();
  await report.getByRole('button', { name: '交给 Athena 修' }).click();
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  await expect(composer).toContainText('「超长内容」');
  await expect(composer).toContainText('内容被截断');
  checks.push('The findings go into the composer as a request, for the person to send');

  await picker.click();
  await page.getByRole('option', { name: '大数字' }).click();
  await expect(report.locator('.stress-report-lead')).toContainText('大数字');
  await expect.poll(() => text('.price')).toBe('$9,876,543,210');
  assert.equal(await text('#title'), 'Simple pricing', 'the earlier trial was taken back first');
  await page.screenshot({ path: path.join(output, 'numbers.png') });
  checks.push('Choosing another kind replaces the trial instead of stacking on it');

  await report.getByRole('button', { name: '恢复原样' }).click();
  await expect(report).toHaveCount(0);
  await expect.poll(() => text('.price')).toBe('$19');
  await expect(page.locator('.edit-timeline')).toHaveCount(0);
  checks.push('Restoring puts the page back and leaves nothing behind');
  assert.deepEqual(errors, []);
  for (const check of checks) console.log('PASS ' + check);
} finally {
  await app.close().catch(() => {});
  await new Promise<void>((resolve) => site.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
