/** Isolated currency UI fixtures; no CLI, model call, or user data is involved. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { uiBrowserExecutable } from './ui-browser';
import { chromium, expect } from '@playwright/test';
import { createServer, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { zeroTokens, type UsageRecord } from '../src/shared/usage';

const output = path.resolve('test-results/interaction-refresh/usage');
await mkdir(output, { recursive: true });
const record = (id: string, model: string): UsageRecord => ({
  id,
  model,
  agent: 'codex',
  startedAt: Date.now(),
  status: 'completed',
  source: 'live',
  tokens: {
    ...zeroTokens(),
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cachedInputTokens: 600_000,
    cacheWriteInputTokens: 100_000,
    totalTokens: 1_100_000,
  },
  observed: true,
  partial: false,
  issues: [],
});
const complete = [record('sol', 'gpt-6.1-sol'), record('astra', 'gpt-6-astra')];
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {UsagePanel} from '/src/renderer/UsagePanel';
import '/src/renderer/styles.css';
const fixture=window.__usageFixture={records:${JSON.stringify(complete)},voice:undefined,listeners:[],external:[]};
window.workbench={async invoke(action,payload){if(action==='usage:snapshot')return {records:fixture.records,voice:fixture.voice,since:Date.now(),updatedAt:Date.now()};if(action==='shell:openExternal')fixture.external.push(payload.url);},onEvent(fn){fixture.listeners.push(fn);return()=>{fixture.listeners=fixture.listeners.filter(f=>f!==fn);}}};
fixture.replace=records=>{fixture.records=records;for(const fn of fixture.listeners)fn({type:'usage:updated'});};
createRoot(document.getElementById('root')).render(React.createElement(UsagePanel));
`;
const fixture: Plugin = {
  name: 'usage-currency-fixture',
  resolveId(id) {
    if (id === '/usage-entry.js') return '\0usage-entry';
  },
  load(id) {
    if (id === '\0usage-entry') return entry;
  },
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/') return next();
      response.setHeader('content-type', 'text/html');
      response.end(
        await server.transformIndexHtml(
          '/index.html',
          '<!doctype html><meta charset="utf-8"><style>#root{display:flex;max-width:1280px;margin:auto}</style><div id="root"></div><script type="module" src="/usage-entry.js"></script>',
        ),
      );
    });
  },
};
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: 'custom',
  logLevel: 'error',
  plugins: [react(), tailwindcss(), fixture],
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const address = server.httpServer!.address() as { port: number };
const browser = await chromium.launch({
  executablePath: uiBrowserExecutable(),
  headless: true,
  args: ['--use-mock-keychain', '--disable-sync'],
});
const checks: string[] = [];
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.setDefaultTimeout(8_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}`);
  const estimate = page.getByTestId('usage-estimate');
  await expect(estimate).toHaveText('$11.76');
  await expect(page.getByTestId('usage-total')).toHaveText('2,200,000');
  const main = await estimate.boundingBox(),
    secondary = await page.getByTestId('usage-total').boundingBox();
  assert(main && secondary && main.y < secondary.y, 'USD must be the first metric');
  await expect(page.getByRole('heading', { name: '每日估算 · USD' })).toBeVisible();
  const nativeChoices = await page.locator('select').evaluateAll((nodes) =>
    nodes.map((node) => {
      const helper = node.closest('[aria-hidden="true"]');
      const bounds = helper?.getBoundingClientRect();
      return node.tabIndex < 0 && Boolean(bounds && bounds.width <= 1 && bounds.height <= 1);
    }),
  );
  assert(
    nativeChoices.every(Boolean),
    'Only clipped, non-focusable autofill helpers may remain native',
  );
  checks.push('USD is primary; token counts are secondary; charts and group amounts use dollars');

  // Live voice is its own module: time and calls, never an amount of money.
  const voice = page.getByRole('region', { name: 'Live 语音' });
  await expect(voice).toContainText('还没有语音通话');
  await expect(voice.getByTestId('usage-voice-time')).toHaveCount(0);
  const now = Date.now();
  const call = (id: string, daysAgo: number, seconds: number | undefined, final: boolean) => ({
    id,
    model: 'gpt-live-1',
    startedAt: now - daysAgo * 86_400_000,
    endedAt: now - daysAgo * 86_400_000 + 60_000,
    seconds,
    final,
    status: final ? 'completed' : 'interrupted',
  });
  await page.evaluate(
    (calls) => {
      const fixture = (window as any).__usageFixture;
      fixture.voice = calls;
      for (const listener of fixture.listeners) listener({ type: 'usage:updated' });
    },
    [
      call('a', 0, 95, true),
      call('b', 0, 40, false),
      call('c', 2, 600, true),
      call('d', 3, undefined, false),
      call('old', 60, 3000, true),
    ],
  );
  await expect(voice.getByTestId('usage-voice-time')).toHaveText('12 分 15 秒部分');
  await expect(voice.getByTestId('usage-voice-calls')).toHaveText('4');
  await expect(voice).toContainText('1 次通话没有报告时长，未计入。');
  await expect(voice).toContainText('1 次通话未正常收尾');
  await expect(voice).toContainText('这里不估算金额');
  assert.ok(!(await voice.innerText()).includes('$'), 'voice shows no amount of money');
  await expect(voice.locator('.usage-day')).toHaveCount(3);
  // The calls leave the token estimate as it was.
  await expect(estimate).toHaveText('$11.76');
  checks.push('Live voice reports billed time and calls for the chosen range, marks what is partial, and estimates no cost');
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  await voice.screenshot({ path: path.join(output, 'voice.png') });

  const models = page.locator('button[data-choice-label="按模型筛选"]');
  await models.click();
  await page.getByRole('option', { name: 'gpt-6.1-sol', exact: true }).click();
  await expect(estimate).toHaveText('$1.91');
  await expect(page.getByRole('listbox', { name: '按模型筛选' })).toHaveCount(0);
  await models.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox', { name: '按模型筛选' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'gpt-6.1-sol', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(models).toBeFocused();
  await models.click();
  await page.getByRole('option', { name: '全部模型', exact: true }).click();
  await expect(estimate).toHaveText('$11.76');
  await page.getByRole('button', { name: '查看每日数据', exact: true }).press('Enter');
  await expect(page.getByRole('table', { name: '按日期汇总用量' })).toContainText('$11.76');
  await expect(page.getByRole('heading', { name: '明细', exact: true })).toBeFocused();
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tab', { name: '日期', exact: true })).toBeFocused();
  checks.push(
    'Custom model filter and date grouping recalculate currency; keyboard dismissal restores focus',
  );

  // The padded edge of the visible heading must activate the same disclosure.
  await page.locator('.usage-pricing-details').click({ position: { x: 16, y: 4 } });
  await expect(page.getByRole('button', { name: '估算依据与单价', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.getByText('单价：USD / 百万 Token')).toBeVisible();
  await expect(
    page.locator('.usage-price-table').getByText('2026-11-01', { exact: true }),
  ).toHaveCount(2);
  await page.getByRole('button', { name: 'OpenAI 官方价格' }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).__usageFixture.external), [
    'https://developers.openai.com/api/docs/pricing',
  ]);
  checks.push(
    'Estimate basis, dated rate card, and official source are available without leaving the dashboard',
  );
  await page
    .locator('.usage-pricing-details')
    .screenshot({ path: path.join(output, 'pricing-basis.png') });

  const replace = async (records: UsageRecord[]) =>
    page.evaluate((records) => (window as any).__usageFixture.replace(records), records);
  await replace([{ ...record('zero', 'gpt-6.1-sol'), tokens: zeroTokens() }]);
  await expect(estimate).toHaveText('$0.00');
  const partial = record('partial', 'gpt-6.1-sol');
  partial.tokens.cacheWriteInputTokens = null;
  await replace([partial, record('unknown', 'not-priced')]);
  await expect(estimate).toHaveText('$1.06');
  await expect(page.getByRole('status')).toContainText('1 项任务暂无可用估算。1 项仅计已知部分。');
  await expect(page.locator('.usage-kpi').filter({ hasText: '普通输入' })).toContainText('—');
  await expect(page.locator('.usage-kpi').filter({ hasText: '缓存写入' })).toContainText('—');
  checks.push(
    'Unknown cache writes remain missing; known components form a partial dollar subtotal; actual zero remains $0.00',
  );
  await page.locator('.usage-panel').evaluate((node) => (node.scrollTop = 0));
  await page.screenshot({ path: path.join(output, 'partial.png') });
  await replace([{ ...record('mixed', 'gpt-6.1-sol'), models: ['gpt-6.1-sol', 'gpt-6-astra'] }]);
  await expect(estimate).toHaveText('暂无估算');
  await page.screenshot({ path: path.join(output, 'unknown.png') });
  await replace([]);
  await expect(estimate).toHaveText('暂无估算');
  await expect(page.getByText('暂无用量记录', { exact: true })).toBeVisible();
  checks.push('Mixed-model and empty histories show unknown rather than fabricated $0');

  await replace(complete);
  await expect(estimate).toHaveText('$11.76');
  await page.setViewportSize({ width: 480, height: 860 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.usage-panel').evaluate((node) => (node.scrollTop = 0));
  const overflow = await page
    .locator('.usage-panel')
    .evaluate((node) => node.scrollWidth - node.clientWidth);
  await page.screenshot({ path: path.join(output, 'narrow.png') });
  if (overflow > 1)
    await writeFile(
      path.join(output, 'overflow.json'),
      JSON.stringify(
        await page.evaluate(() => {
          const panel = document.querySelector('.usage-panel')!;
          const right = panel.getBoundingClientRect().right;
          return {
            overflow: panel.scrollWidth - panel.clientWidth,
            panel: panel.getBoundingClientRect().toJSON(),
            nodes: [...panel.querySelectorAll('*')]
              .filter((n) => n.getBoundingClientRect().right > right + 1)
              .map((n) => ({
                tag: n.tagName,
                classes: n.className,
                rect: n.getBoundingClientRect().toJSON(),
              }))
              .slice(0, 30),
          };
        }),
        null,
        2,
      ),
    );
  assert(overflow <= 1, 'Narrow panel must not overflow outside its table scroller');
  await expect(estimate).toBeVisible();
  await models.click();
  await expect(page.getByRole('listbox', { name: '按模型筛选' })).toBeVisible();
  await page.screenshot({ path: path.join(output, 'narrow-select.png') });
  await page.keyboard.press('Escape');
  checks.push('480px viewport preserves primary value, filters, and keyboard access');
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify({ passed: true, source: 'controlled-usage-fixture', checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify({ passed: false, checks, errors, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
  await server.close();
}
