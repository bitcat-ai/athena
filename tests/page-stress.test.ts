import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test, { after, before, type TestContext } from 'node:test';
import { chromium, type Browser, type Page } from '@playwright/test';
import { browserPageSource } from '../src/main/browser-page';
import { PAGE_STRESSES, readStressIssues, stressPrompt } from '../src/shared/page-stress';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executable = [chromium.executablePath(), CHROME].find((value): value is string =>
  Boolean(value && existsSync(value)),
);
let browser: Browser | undefined;
before(async () => {
  if (executable) browser = await chromium.launch({ executablePath: executable, headless: true });
});
after(async () => {
  await browser?.close();
});

interface Issue {
  problem: string;
  selector: string;
  tag: string;
  was: string;
  mark?: number;
}
interface Result {
  applied: boolean;
  reason?: string;
  editId: string;
  replaced: number;
  issues: Issue[];
}
const bridge = <T>(page: Page, method: string, ...args: unknown[]) =>
  page.evaluate(
    ({ method, args }) => (globalThis as any).__workbenchPage[method](...args),
    { method, args },
  ) as Promise<T>;

/** A small shop page with the usual fragile spots: a fixed-width button, a one-line badge, a tight nav. */
async function fixture(t: TestContext) {
  const context = await browser!.newContext({ viewport: { width: 900, height: 700 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('**/*', (route) => route.abort());
  await page.exposeFunction('__workbenchEvent', () => {});
  await page.addInitScript(browserPageSource);
  const html = `<!doctype html><meta charset="utf-8"><title>Shop</title>
    <style>
      body{margin:0;padding:24px;font:16px/1.4 sans-serif;width:852px}
      nav{display:flex;gap:16px;width:420px}
      nav a{display:block;width:90px}
      #buy{display:block;width:120px;height:40px;overflow:hidden;white-space:nowrap;padding:0}
      #card{width:200px;border:1px solid #ccc;padding:8px}
      #badge{display:inline-block;white-space:nowrap}
      #roomy{width:800px}
      #price{display:inline-block;width:110px;overflow:hidden;white-space:nowrap}
      #secret{display:none}
    </style>
    <nav><a id="home" href="#">Home</a><a id="plans" href="#">Plans</a><a id="help" href="#">Help</a></nav>
    <h1 id="title">Simple pricing</h1>
    <p id="roomy">One plan.</p>
    <button id="buy">Start now</button>
    <div id="card"><span id="badge">New</span></div>
    <p>Total <span id="price">$1,299.50</span></p>
    <p id="secret">hidden text</p>
    <input id="field" value="typed by the user">
    <p data-private id="private">private note</p>`;
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const text = (selector: string) => page.locator(selector).textContent();
  return { page, text };
}

test(
  'long content replaces every visible text and reports the elements it breaks',
  { skip: !executable },
  async (t) => {
    const { page, text } = await fixture(t);
    const original = await page.locator('body').innerText();
    const result = await bridge<Result>(page, 'stress', { kind: 'long' });
    assert.equal(result.applied, true);
    assert.equal(await text('#buy'), 'Start now Start now Start now');
    assert.equal(await text('#home'), 'HomeWolfeschlegelsteinhausenbergerdorff');
    // What the user typed, what is hidden and what is private stay as they are.
    assert.equal(await page.locator('#field').inputValue(), 'typed by the user');
    assert.equal(await text('#secret'), 'hidden text');
    assert.equal(await text('#private'), 'private note');

    const found = Object.fromEntries(result.issues.map((issue) => [issue.selector, issue]));
    const problem = (id: string) =>
      result.issues.find((issue) => issue.selector.includes(id))?.problem;
    assert.equal(problem('#buy'), 'clipped', JSON.stringify(found));
    assert.equal(problem('#badge'), 'overflow');
    assert.equal(problem('#home'), 'overflow', 'a word wider than its link runs over the next one');
    assert.equal(problem('#roomy'), undefined, 'text with room to grow is not a finding');
    assert.equal(result.issues.find((issue) => issue.selector.includes('#buy'))?.was, 'Start now');
    assert.equal(
      await page.locator('#buy').getAttribute('data-athena-stress'),
      'clipped',
      'the weak spot is marked on the page',
    );
    assert.equal(await page.locator('#roomy').getAttribute('data-athena-stress'), null);

    // It is one preview: the timeline names it, and an undo puts the whole page back.
    const timeline = await bridge<{ entries: Array<{ kind: string }> }>(page, 'timeline');
    assert.deepEqual(
      timeline.entries.map((entry) => entry.kind),
      ['stress'],
    );
    const mark = result.issues.find((issue) => issue.selector.includes('#buy'))!.mark!;
    assert.equal(await bridge(page, 'stressReveal', result.editId, mark), true);
    await bridge(page, 'scrub', 0);
    assert.equal(await page.locator('body').innerText(), original);
    assert.equal(await page.locator('[data-athena-stress]').count(), 0);
    await bridge(page, 'scrub', 1);
    assert.equal(await page.locator('#buy').getAttribute('data-athena-stress'), 'clipped');
    await bridge(page, 'undo', result.editId);
    assert.equal(await page.locator('body').innerText(), original);
    assert.equal(await page.locator('[data-athena-stress]').count(), 0);
    assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 0);
  },
);

test(
  'each kind of content does what its name says, and a page without numbers says so',
  { skip: !executable },
  async (t) => {
    const { page, text } = await fixture(t);
    const run = async (kind: string) => {
      const result = await bridge<Result>(page, 'stress', { kind });
      assert.equal(result.applied, true, kind);
      return result;
    };
    const back = (result: Result) => bridge(page, 'undo', result.editId);

    let result = await run('numbers');
    assert.equal(await text('#price'), '$9,876,543,210.99');
    assert.equal(await text('#title'), 'Simple pricing', 'text without numbers is left alone');
    assert.equal(result.replaced, 1);
    assert.equal(result.issues.find((issue) => issue.selector.includes('#price'))?.problem, 'clipped');
    await back(result);
    assert.equal(await text('#price'), '$1,299.50');

    result = await run('empty');
    assert.equal(await text('#title'), '');
    assert.ok(result.issues.some((issue) => issue.problem === 'collapsed'));
    await back(result);

    result = await run('pseudo');
    assert.match((await text('#title'))!, /^\[Símplé príçíñg ~+\]$/);
    await back(result);

    result = await run('rtl');
    assert.match((await text('#title'))!, /[؀-ۿ]/);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).direction), 'rtl');
    await back(result);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).direction), 'ltr');
    assert.equal(await text('#title'), 'Simple pricing');

    await page.evaluate(() => document.querySelector('#price')!.parentElement!.remove());
    const none = await bridge<Result>(page, 'stress', { kind: 'numbers' });
    assert.equal(none.applied, false);
    assert.match(none.reason!, /No numbers/);
    assert.equal((await bridge<Result>(page, 'stress', { kind: 'other' })).applied, false);
  },
);

test('findings from the page are kept only in the shape they should have', () => {
  const issues = readStressIssues([
    { problem: 'clipped', selector: '#buy', tag: 'button', was: 'Start now', mark: 0 },
    { problem: 'invented', selector: '#x', tag: 'p', was: '' },
    { problem: 'page', selector: 'html', tag: 'html', was: 7, mark: -1 },
    'text',
  ]);
  assert.deepEqual(issues, [
    { problem: 'clipped', selector: '#buy', tag: 'button', was: 'Start now', mark: 0 },
    { problem: 'page', selector: 'html', tag: 'html', was: '' },
  ]);
  const prompt = stressPrompt({ kind: 'long', editId: 'e', replaced: 9, issues });
  assert.match(prompt, /「超长内容」/);
  assert.match(prompt, /1\. 内容被截断：#buy（原文「Start now」）/);
  assert.match(prompt, /2\. 整页出现横向滚动：html/);
  assert.equal(new Set(PAGE_STRESSES.map((item) => item.id)).size, 5);
});
