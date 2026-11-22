import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { existsSync } from 'node:fs';
import { chromium, type Browser } from '@playwright/test';
import { browserPageSource } from '../src/main/browser-page.ts';

interface GuideEvent {
  kind: string;
  token?: string;
  index?: number;
  event?: string;
  by?: string;
  filled?: boolean;
  located?: boolean;
}
interface Shown {
  shown: boolean;
  located?: boolean;
  reason?: string;
  target?: { tag: string; role?: string; name: string; selector?: string };
}
interface Seen {
  at?: string;
  action?: string;
  busy: boolean;
  bye: boolean;
  title: string;
  count: string;
  note: string;
  hint: string;
  ring: { x: number; y: number; width: number; height: number };
  card: { x: number; y: number; width: number; height: number };
  buttons: Record<string, { x: number; y: number; label: string }>;
  rowHeight: number;
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executable = [chromium.executablePath(), CHROME].find((value): value is string =>
  Boolean(value && existsSync(value)),
);
let browser: Browser | undefined;
before(async () => {
  if (!executable) return;
  browser = await chromium.launch({
    executablePath: executable,
    headless: true,
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--use-mock-keychain',
      '--disable-sync',
    ],
  });
});
after(async () => {
  await browser?.close();
});

const html = `<!doctype html><meta charset="utf-8"><title>Guide fixture</title>
  <style>body{font:16px sans-serif;margin:0;padding:24px}button,a{display:inline-block;padding:10px 14px}p{margin:12px 0}label{display:block;margin:12px 0}input,select{display:block;margin-top:4px;width:240px;height:28px}#far{margin-top:1600px}</style>
  <p id="intro">点击登录之前，请先看完这段说明文字，它也提到了登录。</p>
  <button id="login"><span>登录</span></button>
  <a id="pricing" href="#pricing">查看价格 / 套餐</a>
  <label for="city">所在城市</label><input id="city" name="city">
  <label>登录密码<input id="secret" type="password" value="already-there"></label>
  <select id="plan" aria-label="选择套餐"><option value="">请选择</option><option value="pro">Pro 专业版</option></select>
  <div id="vault" data-private>保险箱编号 7788</div>
  <div id="redraw" style="padding:12px;width:160px;background:#eee">会重绘的按钮</div>
  <button id="far">页面底部的按钮</button>
  <script>
    globalThis.seen={login:0,outside:0,document:[]};
    document.querySelector('#login').addEventListener('click',()=>globalThis.seen.login++);
    for (const type of ['pointerdown','mousedown','click']) document.addEventListener(type,event=>globalThis.seen.document.push(type+':'+event.target.id));
    document.querySelector('#redraw').addEventListener('pointerdown',event=>{
      const next=event.currentTarget.cloneNode(true);next.id='redrawn';event.currentTarget.replaceWith(next);
    });
  </script>`;

async function fixture(t: TestContext) {
  const context = await browser!.newContext({
    viewport: { width: 1000, height: 700 },
    reducedMotion: 'reduce',
  });
  t.after(() => context.close());
  const page = await context.newPage();
  const events: GuideEvent[] = [];
  await page.route('**/*', (route) => route.abort());
  await page.exposeFunction('__workbenchEvent', (payload: string) => {
    events.push(JSON.parse(payload));
  });
  // tsx names the helper functions inside evaluate callbacks through this.
  await page.addInitScript('globalThis.__name = (fn) => fn');
  await page.addInitScript(browserPageSource);
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // The overlay lives in a closed shadow root; the fixture keeps a handle to look inside.
  await page.evaluate(() => {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = original.call(this, init);
      if (this.hasAttribute('data-workbench-overlay')) (globalThis as any).__overlayRoot = root;
      return root;
    };
  });
  const call = <T>(method: string, ...args: unknown[]) =>
    page.evaluate(({ method, args }) => (globalThis as any).__workbenchPage[method](...args), {
      method,
      args,
    }) as Promise<T>;
  const show = (step: Record<string, unknown>) =>
    call<Shown>('guideShow', { token: 't1', index: 0, total: 3, note: '说明', ...step });
  const seen = () =>
    page.evaluate(() => {
      const root = (globalThis as any).__overlayRoot as ShadowRoot | undefined;
      const layer = root?.querySelector<HTMLElement>('.gd');
      if (!layer) return null;
      const box = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const buttons: Record<string, { x: number; y: number; label: string }> = {};
      for (const button of layer.querySelectorAll<HTMLElement>('[data-do]')) {
        if (getComputedStyle(button).display === 'none') continue;
        const rect = button.getBoundingClientRect();
        buttons[button.dataset.do!] = {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          label: button.textContent || '',
        };
      }
      const text = (name: string) => layer.querySelector(name)?.textContent || '';
      return {
        at: layer.dataset.at,
        action: layer.dataset.action,
        busy: 'busy' in layer.dataset,
        bye: 'bye' in layer.dataset,
        title: text('.gd-title'),
        count: text('.gd-count'),
        note: text('.gd-note'),
        hint: text('.gd-hint'),
        ring: box(layer.querySelector('.gd-ring')!),
        card: box(layer.querySelector('.gd-card')!),
        buttons,
        rowHeight: layer.querySelector('.gd-row')!.getBoundingClientRect().height,
      };
    }) as Promise<Seen | null>;
  const settled = async () => {
    // Positions are written once per animation frame.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    return (await seen())!;
  };
  const rect = (selector: string) =>
    page.evaluate((selector) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, selector);
  const guideEvents = () => events.filter((event) => event.kind === 'guide');
  return { page, events, call, show, seen, settled, rect, guideEvents };
}

test(
  'recorded guidance follows the exact business row and refuses a duplicate or different page',
  { skip: !executable },
  async (t) => {
    const { page, show } = await fixture(t);
    await page.evaluate(() => {
      document.body.innerHTML =
        '<table><tr><th>C10080</th><td><button id="wrong">导出</button></td></tr><tr><th>客户 C1008 · 华东</th><td><button id="wanted">导出</button></td></tr></table>';
    });
    const practice = await page.evaluate(() => ({
      origin: location.origin,
      pathname: location.pathname,
      object: 'C1008',
      inRow: true,
      tag: 'button',
    }));
    const step = { text: '导出', action: 'click', practice };
    assert.equal((await show(step)).target?.selector, '#wanted');
    assert.equal(
      (await show({ ...step, practice: { ...practice, origin: 'https://unrelated.example' } }))
        .reason,
      'wrong_origin',
    );
    await page.evaluate(() => {
      document.querySelector('#wanted')!.after(document.querySelector('#wanted')!.cloneNode(true));
    });
    assert.equal((await show(step)).reason, 'ambiguous_target');
  },
);

async function eventually(condition: () => boolean | Promise<boolean>, what: string) {
  const until = Date.now() + 3000;
  while (!(await condition())) {
    if (Date.now() > until) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test(
  'a step points at its element with a ring, the pointer and a card that says what to do',
  { skip: !executable },
  async (t) => {
    const { show, settled, rect } = await fixture(t);
    const shown = await show({
      selector: '#login',
      note: '点这里登录',
      action: 'click',
      title: '登录流程',
      index: 1,
      back: true,
      handover: true,
    });
    assert.deepEqual(shown, {
      shown: true,
      located: true,
      target: { tag: 'button', role: 'button', name: '登录', selector: '#login' },
    });
    const view = await settled();
    const target = await rect('#login');
    assert.equal(view.at, 'target');
    assert.equal(view.action, 'click');
    assert.equal(view.title, '登录流程');
    assert.equal(view.count, '2 / 3');
    assert.equal(view.note, '点这里登录');
    assert.match(view.hint, /点一下高亮的位置/);
    // The ring surrounds the element with a small margin.
    assert.ok(
      Math.abs(view.ring.x - (target.x - 4)) < 1 && Math.abs(view.ring.y - (target.y - 4)) < 1,
    );
    assert.ok(Math.abs(view.ring.width - (target.width + 8)) < 1);
    // The card sits next to the element, inside the viewport, and never covers it.
    assert.ok(
      view.card.y >= target.y + target.height || view.card.y + view.card.height <= target.y,
    );
    assert.ok(view.card.x >= 12 && view.card.x + view.card.width <= 1000 - 12);
    // One row of controls: the click itself is the main action, so the card only offers to skip.
    assert.deepEqual(
      Object.fromEntries(Object.entries(view.buttons).map(([name, item]) => [name, item.label])),
      { end: '结束', back: '上一步', handover: '交给 Athena', next: '跳过' },
    );
    assert.ok(view.rowHeight <= 32, `controls wrapped: ${view.rowHeight}`);
    const heights = new Set(Object.values(view.buttons).map((item) => Math.round(item.y)));
    assert.equal(heights.size, 1);
  },
);

test(
  'visible text finds the control a person would mean, and protected content is never matched by what it says',
  { skip: !executable },
  async (t) => {
    const { show, call } = await fixture(t);
    // The paragraph and the button both say 登录; the button is what one clicks.
    assert.equal((await show({ text: '登录', action: 'click' })).target?.selector, '#login');
    // A control is found by its accessible name as well as by its text.
    assert.equal((await show({ text: '选择套餐', action: 'click' })).target?.selector, '#plan');
    assert.equal((await show({ text: '查看价格', action: 'click' })).target?.selector, '#pricing');
    // A label leads to its field when the step asks for input.
    assert.equal((await show({ text: '所在城市', action: 'input' })).target?.selector, '#city');
    // A protected field is found by its label, named without its content, and its value is no match.
    const secret = await show({ text: '登录密码', action: 'input' });
    assert.equal(secret.target?.selector, '#secret');
    assert.equal(secret.target?.name, '[hidden]');
    await call('guideClear');
    assert.deepEqual(await show({ text: 'already-there' }), {
      shown: false,
      reason: 'text_not_found',
    });
    assert.deepEqual(await show({ text: '保险箱编号' }), {
      shown: false,
      reason: 'text_not_found',
    });
    assert.deepEqual(await show({ text: '7788' }), { shown: false, reason: 'text_not_found' });
    // A selector may be narrowed by text.
    assert.equal((await show({ selector: 'button', text: '页面底部' })).target?.selector, '#far');
  },
);

test(
  'a step that cannot be placed says why and shows nothing',
  { skip: !executable },
  async (t) => {
    const { show, seen, call } = await fixture(t);
    assert.deepEqual(await show({ selector: '#missing' }), { shown: false, reason: 'not_found' });
    assert.deepEqual(await show({ selector: 'p[' }), { shown: false, reason: 'invalid_selector' });
    assert.deepEqual(await show({ ref: 'old-document:1' }), { shown: false, reason: 'stale_ref' });
    assert.deepEqual(await show({ text: '不存在的文字' }), {
      shown: false,
      reason: 'text_not_found',
    });
    assert.equal(await seen(), null);
    assert.equal(await call('guideState'), null);
  },
);

test(
  'clicking the highlighted element is the user’s own click and moves the guide on',
  { skip: !executable },
  async (t) => {
    const { page, show, settled, rect, guideEvents } = await fixture(t);
    await show({ selector: '#login', action: 'click', token: 'tok-click', index: 2 });
    await settled();
    // A click elsewhere on the page is just a click.
    const intro = await rect('#intro');
    await page.mouse.click(intro.x + 5, intro.y + 5);
    assert.deepEqual(guideEvents(), []);
    const target = await rect('#login');
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
    await eventually(() => guideEvents().length > 0, 'the advance');
    assert.equal(await page.evaluate(() => (globalThis as any).seen.login), 1);
    const [event] = guideEvents();
    assert.deepEqual(
      {
        token: event.token,
        index: event.index,
        event: event.event,
        by: event.by,
        located: event.located,
      },
      { token: 'tok-click', index: 2, event: 'advance', by: 'click', located: true },
    );
    // Until the host answers with the next step the card waits and reports nothing twice.
    const view = await settled();
    assert.equal(view.busy, true);
    assert.equal(view.at, 'page');
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(guideEvents().length, 1);
  },
);

test(
  'an element the page redraws while it is pressed still counts as clicked',
  { skip: !executable },
  async (t) => {
    const { page, show, settled, rect, guideEvents } = await fixture(t);
    await show({ selector: '#redraw', action: 'click', token: 'tok-redraw' });
    await settled();
    const target = await rect('#redraw');
    await page.mouse.click(target.x + 20, target.y + 10);
    await eventually(() => guideEvents().length > 0, 'the advance');
    assert.equal(guideEvents()[0].by, 'click');
    assert.equal(guideEvents().length, 1);
  },
);

test(
  'the card’s buttons work with real clicks that the page neither sees nor loses focus to',
  { skip: !executable },
  async (t) => {
    const { page, show, settled, seen, call, guideEvents } = await fixture(t);
    await page.focus('#city');
    await show({
      selector: '#city',
      action: 'input',
      token: 'a',
      index: 1,
      back: true,
      handover: true,
    });
    let view = await settled();
    assert.equal(view.buttons.next.label, '下一步');
    await page.evaluate(() => ((globalThis as any).seen.document.length = 0));

    await page.mouse.click(view.buttons.back.x, view.buttons.back.y);
    await eventually(() => guideEvents().length === 1, 'back');
    assert.equal(guideEvents()[0].event, 'back');
    assert.deepEqual(await page.evaluate(() => (globalThis as any).seen.document), []);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'city');

    await show({ selector: '#city', action: 'input', token: 'b', index: 1, handover: true });
    view = await settled();
    assert.equal(view.busy, false);
    await page.mouse.click(view.buttons.handover.x, view.buttons.handover.y);
    await eventually(() => guideEvents().length === 2, 'handover');
    assert.deepEqual(
      { token: guideEvents()[1].token, event: guideEvents()[1].event },
      { token: 'b', event: 'handover' },
    );

    // The last step of a guide finishes instead of going on.
    await show({ selector: '#login', action: 'look', token: 'c', index: 2 });
    view = await settled();
    assert.equal(view.buttons.next.label, '完成');
    assert.equal(view.buttons.handover, undefined);
    await page.mouse.click(view.buttons.next.x, view.buttons.next.y);
    await eventually(() => guideEvents().length === 3, 'finish');
    assert.deepEqual(
      { event: guideEvents()[2].event, by: guideEvents()[2].by },
      { event: 'advance', by: 'button' },
    );

    await show({ selector: '#login', action: 'click', token: 'd' });
    view = await settled();
    await page.mouse.click(view.buttons.next.x, view.buttons.next.y);
    await eventually(() => guideEvents().length === 4, 'skip');
    assert.equal(guideEvents()[3].by, 'skip');
    assert.equal(await page.evaluate(() => (globalThis as any).seen.login), 0);

    await show({ selector: '#login', action: 'click', token: 'e' });
    view = await settled();
    await page.mouse.click(view.buttons.end.x, view.buttons.end.y);
    await eventually(() => guideEvents().length === 5, 'end');
    assert.equal(guideEvents()[4].event, 'end');
    assert.equal(await seen(), null);
    assert.equal(await call('guideState'), null);
    assert.deepEqual(await page.evaluate(() => (globalThis as any).seen.document), []);
  },
);

test(
  'filling the field moves on and reports only that something was entered',
  { skip: !executable },
  async (t) => {
    const { page, events, show, settled, guideEvents } = await fixture(t);
    await show({ text: '所在城市', action: 'input', token: 'tok-input' });
    const view = await settled();
    assert.match(view.hint, /填好后点“下一步”/);
    await page.click('#city');
    await page.keyboard.type('unusual-city-name');
    assert.deepEqual(guideEvents(), []);
    await page.keyboard.press('Tab');
    await eventually(() => guideEvents().length > 0, 'the advance');
    const [event] = guideEvents();
    assert.deepEqual(
      { event: event.event, by: event.by, filled: event.filled },
      { event: 'advance', by: 'input', filled: true },
    );
    assert.ok(!JSON.stringify(guideEvents()).includes('unusual-city-name'));

    // A choice from a list counts the same way; an empty field is reported as empty.
    events.length = 0;
    await show({ text: '选择套餐', action: 'input', token: 'tok-select' });
    await settled();
    // A script that sets the value is not the user choosing.
    await page.selectOption('#plan', 'pro');
    await page.selectOption('#plan', '');
    assert.deepEqual(guideEvents(), []);
    await page.focus('#plan');
    await page.keyboard.type('P');
    await eventually(() => guideEvents().length > 0, 'the choice');
    assert.equal(await page.inputValue('#plan'), 'pro');
    assert.equal(guideEvents()[0].filled, true);

    events.length = 0;
    await page.fill('#city', '');
    await show({ selector: '#city', action: 'input', token: 'tok-empty' });
    const empty = await settled();
    await page.mouse.click(empty.buttons.next.x, empty.buttons.next.y);
    await eventually(() => guideEvents().length > 0, 'the advance');
    assert.deepEqual(
      { by: guideEvents()[0].by, filled: guideEvents()[0].filled },
      { by: 'button', filled: false },
    );
  },
);

test(
  'the guide outlives a cleared overlay, follows the element and finds one that appears later',
  { skip: !executable },
  async (t) => {
    const { page, show, settled, seen, call, rect } = await fixture(t);
    await show({ selector: '#login', action: 'click', token: 'keep' });
    await settled();
    // The guide puts itself back with the next frame, so the look has to come before it.
    const left = await page.evaluate(() => {
      (globalThis as any).__workbenchPage.clearOverlays();
      return document.querySelectorAll('[data-workbench-overlay]').length;
    });
    assert.equal(left, 0);
    let view = await settled();
    assert.equal(view.at, 'target');
    assert.deepEqual(await call('guideState'), {
      token: 'keep',
      index: 0,
      located: true,
      busy: false,
    });

    // The ring stays on the element when the page moves under it.
    await page.evaluate(
      () => (document.querySelector<HTMLElement>('#intro')!.style.marginTop = '90px'),
    );
    view = await settled();
    const moved = await rect('#login');
    assert.ok(Math.abs(view.ring.y - (moved.y - 4)) < 1);

    // An element outside the view is brought into it.
    await show({ selector: '#far', action: 'click', token: 'far' });
    await eventually(async () => {
      const box = await rect('#far');
      return box.y >= 0 && box.y + box.height <= 700;
    }, 'the scroll');
    view = await settled();
    assert.ok(view.card.y >= 12 && view.card.y + view.card.height <= 700 - 12);

    // A step shown before its element exists waits on the page and anchors once it is there.
    const waiting = await show({
      selector: '#later',
      action: 'click',
      token: 'later',
      require: false,
    });
    assert.deepEqual(waiting, { shown: true, located: false, target: undefined });
    view = await settled();
    assert.equal(view.at, 'page');
    assert.match(view.hint, /还没找到这一步的位置/);
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'later';
      button.textContent = '后来出现';
      document.body.prepend(button);
      scrollTo(0, 0);
    });
    await eventually(async () => (await seen())?.at === 'target', 'the anchor');
    assert.match((await seen())!.hint, /点一下高亮的位置/);

    // The host's goodbye stays for a moment, then everything is gone.
    await call('guideClear', '完成了');
    view = (await seen())!;
    assert.equal(view.bye, true);
    assert.equal(view.note, '完成了');
    assert.equal(await call('guideState'), null);
    await eventually(async () => (await seen()) === null, 'the removal');
  },
);
