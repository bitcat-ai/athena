import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { browserPageSource } from '../src/main/browser-page.ts';

interface ElementInfo {
  ref: string;
  documentId: string;
  tag: string;
  name: string;
  role?: string;
  selector: string;
  shadowPath: string[];
  value?: string;
  bounds: { x: number; y: number; width: number; height: number };
}
interface Details extends ElementInfo {
  textContent: string;
  editableText: boolean;
  editReason?: string;
  attributes: Record<string, string>;
  computed: Record<string, string>;
  ancestors: ElementInfo[];
  animation?: AnimationConfig | null;
  animationState?: 'running' | 'paused' | 'finished' | 'idle' | 'reduced-motion';
}
interface AnimationConfig {
  keyframes: Array<{ offset?: number; styles: Record<string, string> }>;
  duration: number;
  iterations?: number | 'infinite';
  easing?: string;
  direction?: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
}
interface QueryResult {
  documentId: string;
  elements: ElementInfo[];
  truncated: boolean;
}
interface EditResult {
  editId: string;
  element: Details;
}
interface PageEvent {
  kind: string;
  target?: ElementInfo;
  value?: string;
  source: string;
  editId?: string;
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

async function bridge<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ method, args }) => {
      const api = (
        globalThis as unknown as {
          __workbenchPage: Record<string, (...args: unknown[]) => unknown>;
        }
      ).__workbenchPage;
      return api[method](...args);
    },
    { method, args },
  ) as Promise<T>;
}

async function fixture(t: TestContext) {
  const context = await browser!.newContext({
    viewport: { width: 1200, height: 1000 },
    reducedMotion: 'no-preference',
  });
  t.after(() => context.close());
  const page = await context.newPage();
  const events: PageEvent[] = [];
  await page.route('**/*', (route) => route.abort());
  await page.exposeFunction('__workbenchEvent', (payload: string) => {
    events.push(JSON.parse(payload));
  });
  await page.addInitScript(browserPageSource);
  const html = `<!doctype html><meta charset="utf-8"><title>Element fixture</title>
    <style>body{font:16px sans-serif;padding:20px}p{margin:12px 0}button{padding:16px}#button-label{display:inline-block;padding:12px}#box{width:300px;height:60px;padding:20px;background:#eee}#leaf{display:inline-block;padding:8px}#shadow-host{display:block;margin-top:20px}#long{display:none}</style>
    <h1 id="heading">普通标题</h1>
    <p id="duplicate" data-testid="duplicate">同样文字</p><p id="duplicate" data-testid="duplicate">同样文字</p>
    <button id="complex"><svg width="20" height="20"><circle cx="10" cy="10" r="8" /></svg><span id="button-label">保存</span></button>
    <p><span id="leaf" style="color:rgb(10, 20, 30);margin-left:3px !important">  原始文字  </span></p>
    <img id="photo" alt="示例图片" width="80" height="60" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='60'%3E%3Crect width='80' height='60' fill='green'/%3E%3C/svg%3E">
    <div id="box">普通容器</div><div id="shadow-host"></div>
    <input id="password-input" type="password" value="unusual-sensitive-value">
    <textarea id="private-area" data-private>private-textarea-content</textarea>
    <p id="long"></p><iframe id="child-frame" srcdoc="<p id='child-text'>子页面</p>" width="200" height="80"></iframe>
    <script>
      globalThis.clicked=0;
      document.querySelector('#complex').addEventListener('click',()=>globalThis.clicked++);
      const outer=document.querySelector('#shadow-host').attachShadow({mode:'open'});
      outer.innerHTML='<style>:host{display:block}#inner-host{display:block;padding:10px}</style><div id="inner-host"></div>';
      const inner=outer.querySelector('#inner-host').attachShadow({mode:'open'});
      inner.innerHTML='<style>#deep-leaf{display:inline-block;padding:10px}input{display:block}</style><div><span id="deep-leaf">Shadow 文本</span><input id="deep-input" aria-label="Shadow input"></div>';
      document.querySelector('#long').textContent='x'.repeat(20001);
      globalThis.originalTextNode=document.querySelector('#leaf').firstChild;
    </script>`;
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const find = async (selector: string) =>
    (await bridge<QueryResult>(page, 'query', { selector })).elements[0];
  return { page, events, find };
}

async function eventually(condition: () => boolean) {
  const until = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > until) assert.fail('Expected page event did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const redGradient = 'linear-gradient(135deg,#d9363e 0%,#c41e3a 55%,#9f1239 100%)';
const breathing: AnimationConfig = {
  keyframes: [
    { offset: 0, styles: { transform: 'translateY(0px) scale(1)', opacity: '0.9' } },
    { offset: 0.5, styles: { transform: 'translateY(-8px) scale(1.04)', opacity: '1' } },
    { offset: 1, styles: { transform: 'translateY(0px) scale(1)', opacity: '0.9' } },
  ],
  duration: 1600,
  iterations: 'infinite',
  easing: 'ease-in-out',
};

async function visualFixture(t: TestContext) {
  const f = await fixture(t);
  await f.page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'visual-button';
    button.textContent = '开始';
    button.style.cssText =
      'background:linear-gradient(90deg,#123abc,#2563eb);box-shadow:0 2px 4px rgba(0,0,0,.2)';
    document.body.prepend(button);
  });
  return { ...f, button: await f.find('#visual-button') };
}

test(
  'safe gradient shorthand and box-shadow replace an existing gradient and undo exactly',
  { skip: !executable },
  async (t) => {
    const { page, button } = await visualFixture(t);
    const original = await page
      .locator('#visual-button')
      .evaluate((el) => (el as HTMLElement).style.cssText);
    const result = await bridge<EditResult>(page, 'edit', {
      ref: button.ref,
      styles: { background: redGradient, 'box-shadow': '0 8px 24px rgba(217,36,62,.35)' },
    });
    assert.match(
      result.element.computed['background-image'],
      /linear-gradient.*rgb\(217, 54, 62\)/,
    );
    assert.match(result.element.computed['box-shadow'], /24px/);
    await bridge(page, 'undo', result.editId);
    assert.equal(
      await page.locator('#visual-button').evaluate((el) => (el as HTMLElement).style.cssText),
      original,
    );
  },
);

test(
  'safe background-image gradient can replace the image hiding a plain background-color',
  { skip: !executable },
  async (t) => {
    const { page, button } = await visualFixture(t);
    await bridge(page, 'edit', { ref: button.ref, styles: { 'background-color': '#d9363e' } });
    assert.match(
      await page.locator('#visual-button').evaluate((el) => getComputedStyle(el).backgroundImage),
      /rgb\(18, 58, 188\)/,
    );
    const result = await bridge<EditResult>(page, 'edit', {
      ref: button.ref,
      styles: { 'background-image': redGradient },
    });
    assert.match(result.element.computed['background-image'], /rgb\(217, 54, 62\)/);
  },
);

test(
  'structured owned animation runs and undo leaves a pre-existing website animation untouched',
  { skip: !executable },
  async (t) => {
    const { page, button } = await visualFixture(t);
    await page.evaluate(() => {
      (globalThis as any).siteAnimation = document
        .querySelector('#visual-button')!
        .animate([{ color: 'black' }, { color: 'white' }], {
          duration: 4000,
          iterations: Infinity,
        });
    });
    const result = await bridge<EditResult>(page, 'edit', {
      ref: button.ref,
      animation: breathing,
    });
    assert.equal(result.element.animationState, 'running');
    assert.equal(result.element.animation?.duration, 1600);
    assert.equal(
      await page.locator('#visual-button').evaluate((el) => el.getAnimations().length),
      2,
    );
    await bridge(page, 'undo', result.editId);
    assert.equal((await bridge<Details>(page, 'inspect', button.ref)).animation, null);
    assert.equal(await page.evaluate(() => (globalThis as any).siteAnimation.playState), 'running');
    assert.equal(
      await page.locator('#visual-button').evaluate((el) => el.getAnimations().length),
      1,
    );
  },
);

test(
  'hyphenated animation styles become real WAAPI properties and inspect reports pause/finish',
  { skip: !executable },
  async (t) => {
    const { page, button } = await visualFixture(t);
    const animation: AnimationConfig = {
      duration: 1000,
      iterations: 'infinite',
      keyframes: [
        {
          offset: 0,
          styles: { 'box-shadow': '0px 0px 0px rgba(0,0,0,0)', 'background-color': 'rgb(255,0,0)' },
        },
        {
          offset: 1,
          styles: {
            'box-shadow': '0px 10px 20px rgba(0,0,0,0.8)',
            'background-color': 'rgb(0,0,255)',
          },
        },
      ],
    };
    const edited = await bridge<EditResult>(page, 'edit', { ref: button.ref, animation });
    const evidence = await page.locator('#visual-button').evaluate(async (el) => {
      const player = el.getAnimations().find((item) => item.id.startsWith('workbench-preview:'))!;
      player.pause();
      await player.ready;
      player.currentTime = 500;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return {
        keyframes: (player.effect as KeyframeEffect).getKeyframes(),
        color: getComputedStyle(el).backgroundColor,
        shadow: getComputedStyle(el).boxShadow,
      };
    });
    assert(
      evidence.keyframes.every(
        (frame) => typeof frame.boxShadow === 'string' && typeof frame.backgroundColor === 'string',
      ),
    );
    assert.equal(
      evidence.keyframes.some((frame) => 'box-shadow' in frame || 'background-color' in frame),
      false,
    );
    assert.notEqual(evidence.color, 'rgb(255, 0, 0)');
    assert.notEqual(evidence.color, 'rgb(0, 0, 255)');
    assert.match(evidence.shadow, /10px/);
    assert.equal((await bridge<Details>(page, 'inspect', button.ref)).animationState, 'paused');
    await bridge(page, 'undo', edited.editId);
    const finite = await bridge<EditResult>(page, 'edit', {
      ref: button.ref,
      animation: { ...breathing, duration: 100, iterations: 1 },
    });
    await page.locator('#visual-button').evaluate(async (el) => {
      await el.getAnimations().find((item) => item.id.startsWith('workbench-preview:'))?.finished;
    });
    assert.equal((await bridge<Details>(page, 'inspect', button.ref)).animationState, 'finished');
    await bridge(page, 'undo', finite.editId);
  },
);

test(
  'stop and nested animation undo restore only previous tool-owned playback and record the config',
  { skip: !executable },
  async (t) => {
    const { page, button, events } = await visualFixture(t);
    await page.evaluate(() => {
      (globalThis as any).siteAnimation = document
        .querySelector('#visual-button')!
        .animate([{ color: 'black' }, { color: 'white' }], {
          duration: 4000,
          iterations: Infinity,
        });
    });
    const first = await bridge<EditResult>(page, 'edit', { ref: button.ref, animation: breathing });
    const second = await bridge<EditResult>(page, 'edit', {
      ref: button.ref,
      animation: { ...breathing, duration: 800, direction: 'alternate' },
    });
    await assert.rejects(bridge(page, 'undo', first.editId), /newer animation/);
    assert.equal(
      (await bridge<EditResult>(page, 'undo', second.editId)).element.animation?.duration,
      1600,
    );
    const stopped = await bridge<EditResult>(page, 'edit', { ref: button.ref, animation: null });
    assert.equal(stopped.element.animation, null);
    assert.equal(stopped.element.animationState, 'idle');
    assert.equal(
      await page.locator('#visual-button').evaluate((el) => el.getAnimations().length),
      1,
    );
    const restored = await bridge<EditResult>(page, 'undo', stopped.editId);
    assert.equal(restored.element.animation?.duration, 1600);
    assert.equal(restored.element.animationState, 'running');
    await bridge(page, 'undo', first.editId);
    assert.equal(
      await page.locator('#visual-button').evaluate((el) => el.getAnimations().length),
      1,
    );
    assert.equal(await page.evaluate(() => (globalThis as any).siteAnimation.playState), 'running');
    await eventually(() => events.filter((event) => event.kind === 'edit').length === 3);
    const changes = events
      .filter((event) => event.kind === 'edit')
      .map((event) => JSON.parse(event.value!));
    assert.equal(changes[0].animation.keyframes.length, 3);
    assert.equal(changes[0].animation.duration, 1600);
    assert.equal(changes[2].animation, null);
  },
);

test(
  'reduced motion preserves the requested config without falsely claiming it is playing',
  { skip: !executable },
  async (t) => {
    const { page, button } = await visualFixture(t);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const edit = await bridge<EditResult>(page, 'edit', {
      ref: button.ref,
      styles: { background: redGradient },
      animation: breathing,
    });
    assert.equal(edit.element.animationState, 'reduced-motion');
    assert.equal(edit.element.animation?.duration, 1600);
    assert.equal(
      await page.locator('#visual-button').evaluate((el) => el.getAnimations().length),
      0,
    );
    assert.match(edit.element.computed['background-image'], /rgb\(217, 54, 62\)/);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(
      (ref) => (globalThis as any).__workbenchPage.inspect(ref).animationState === 'running',
      button.ref,
    );
    assert.equal(
      await page.locator('#visual-button').evaluate((el) => el.getAnimations().length),
      1,
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(
      (ref) => (globalThis as any).__workbenchPage.inspect(ref).animationState === 'reduced-motion',
      button.ref,
    );
    assert.equal(
      await page.locator('#visual-button').evaluate((el) => el.getAnimations().length),
      0,
    );
    await bridge(page, 'undo', edit.editId);
    assert.equal((await bridge<Details>(page, 'inspect', button.ref)).animation, null);
  },
);

test(
  'visual CSS and animation reject unsafe payloads atomically',
  { skip: !executable },
  async (t) => {
    const { page, button } = await visualFixture(t);
    const original = await page
      .locator('#visual-button')
      .evaluate((el) => (el as HTMLElement).style.cssText);
    const invalidStyles = [
      { background: 'url(https://invalid.test/image)' },
      { 'background-image': 'image-set(url(https://invalid.test/image) 1x)' },
      { 'background-image': '-webkit-image-set("https://invalid.test/image" 1x)' },
      { 'background-image': 'paint(untrusted)' },
      { 'background-image': 'image("https://invalid.test/image")' },
      { background: 'var(--private)' },
      { background: 'attr(data-private)' },
      { filter: 'url(#private)' },
      { filter: 'expression(alert(1))' },
      { background: 'u\\72l(https://invalid.test/image)' },
      { background: 'linear-gradient(red,blue);color:red' },
      { background: 'linear-gradient(red,blue)/*comment*/' },
      { color: 'red !important' },
    ];
    for (const styles of invalidStyles)
      await assert.rejects(
        bridge(page, 'edit', { ref: button.ref, styles: { color: 'red', ...styles } }),
        /Unsupported/,
      );
    const invalidAnimations: unknown[] = [
      { ...breathing, keyframes: [breathing.keyframes[0]] },
      { ...breathing, keyframes: Array.from({ length: 13 }, () => breathing.keyframes[0]) },
      { ...breathing, duration: 99 },
      { ...breathing, duration: 60001 },
      { ...breathing, iterations: 0 },
      { ...breathing, iterations: 101 },
      { ...breathing, easing: 'cubic-bezier(2,0,1,1)' },
      { ...breathing, easing: 'steps(0)' },
      { ...breathing, easing: 'steps(1,jump-none)' },
      { ...breathing, easing: 'steps(1001)' },
      { ...breathing, direction: 'sideways' },
      {
        ...breathing,
        keyframes: [
          { offset: 0.8, styles: { opacity: '0.5' } },
          { offset: 0.2, styles: { opacity: '1' } },
        ],
      },
      {
        ...breathing,
        keyframes: [{ styles: { background: redGradient } }, { styles: { opacity: '1' } }],
      },
      {
        ...breathing,
        keyframes: [{ styles: { filter: 'url(#unsafe)' } }, { styles: { filter: 'none' } }],
      },
      { ...breathing, keyframes: [{ styles: {} }, { styles: { opacity: '1' } }] },
    ];
    for (const animation of invalidAnimations)
      await assert.rejects(
        bridge(page, 'edit', { ref: button.ref, styles: { color: 'red' }, animation }),
      );
    assert.equal(
      await page.locator('#visual-button').evaluate((el) => (el as HTMLElement).style.cssText),
      original,
    );
    assert.equal(
      await page.locator('#visual-button').evaluate((el) => el.getAnimations().length),
      0,
    );
  },
);

test(
  'animation preview preserves sensitive/stale-ref and undo conflict protections',
  { skip: !executable },
  async (t) => {
    const { page, button, find } = await visualFixture(t);
    const sensitive = await find('#password-input');
    await assert.rejects(
      bridge(page, 'edit', { ref: sensitive.ref, animation: breathing }),
      /Sensitive/,
    );
    const edit = await bridge<EditResult>(page, 'edit', { ref: button.ref, animation: breathing });
    await page.locator('#visual-button').evaluate((el) => {
      const player = el.getAnimations().find((item) => item.id.startsWith('workbench-preview:'))!;
      (player.effect as KeyframeEffect).updateTiming({ duration: 2000 });
    });
    await assert.rejects(bridge(page, 'undo', edit.editId), /animation changed/);
    await page.locator('#visual-button').evaluate((el) => {
      (globalThis as any).ownedBeforeRemoval = el
        .getAnimations()
        .find((item) => item.id.startsWith('workbench-preview:'));
      el.remove();
    });
    await assert.rejects(
      bridge(page, 'edit', { ref: button.ref, animation: null }),
      /stale|removed/,
    );
    assert.equal(
      await page.evaluate(() => (globalThis as any).ownedBeforeRemoval.playState),
      'idle',
    );
  },
);

test(
  'reveal scrolls an offscreen non-interactive node without requiring it to receive pointer events',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    await page.evaluate(() => {
      const label = document.createElement('p');
      label.id = 'offscreen-label';
      label.textContent = '不可点击的远处文字';
      label.style.cssText = 'margin-top:2000px;pointer-events:none';
      document.body.appendChild(label);
    });
    const element = await find('#offscreen-label');
    assert(element.bounds.y > 1000);
    const revealed = await bridge<ElementInfo>(page, 'reveal', element.ref);
    assert.equal(revealed.ref, element.ref);
    assert(revealed.bounds.y >= 0 && revealed.bounds.y + revealed.bounds.height <= 1000);
    await assert.rejects(bridge(page, 'bounds', element.ref), /covered/);
    await page.locator('#offscreen-label').evaluate((el) => el.remove());
    await assert.rejects(bridge(page, 'reveal', element.ref), /stale|removed/);
  },
);

test(
  'page bridge selects ordinary text, images and containers exactly, with unique selectors for duplicate labels',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const matches = await bridge<QueryResult>(page, 'query', { text: '同样文字', exact: true });
    assert.equal(matches.elements.length, 2);
    assert.notEqual(matches.elements[0].ref, matches.elements[1].ref);
    for (const element of matches.elements) {
      assert.notEqual(element.selector, '#duplicate');
      assert.equal(
        await page.evaluate(
          (selector) => document.querySelectorAll(selector).length,
          element.selector,
        ),
        1,
      );
    }
    assert.equal(
      (await bridge<QueryResult>(page, 'query', { text: '同样文字', exact: true, limit: 1 }))
        .truncated,
      true,
    );
    assert.equal(
      (await bridge<QueryResult>(page, 'query', { role: 'button' })).elements[0].selector,
      '#complex',
    );
    await assert.rejects(bridge(page, 'query', { selector: 'div[' }), /Invalid CSS selector/);
    const first = await find('#button-label');
    const again = await find('#button-label');
    assert.equal(first.ref, again.ref);
    for (const selector of ['#heading', '#button-label', '#photo', '#box']) {
      const element = await find(selector);
      const r = element.bounds;
      const picked = await bridge<ElementInfo>(
        page,
        'atPoint',
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      assert.equal(picked.ref, element.ref, `Exact point target for ${selector}`);
    }
    assert.equal(await page.evaluate(() => (globalThis as any).clicked), 0);
    const snapshot = await bridge<QueryResult>(page, 'snapshot');
    for (const selector of ['#heading', '#photo', '#box'])
      assert(snapshot.elements.some((item) => item.selector === selector));
  },
);

test(
  'open shadow roots keep exact point/event targets and a reconstructable selector path',
  { skip: !executable },
  async (t) => {
    const { page, find, events } = await fixture(t);
    const deep = await find('#deep-leaf');
    assert.deepEqual(deep.shadowPath, ['#shadow-host', '#inner-host']);
    const r = deep.bounds;
    assert.equal(
      (await bridge<ElementInfo>(page, 'atPoint', r.x + r.width / 2, r.y + r.height / 2)).ref,
      deep.ref,
    );
    const matches = await page.evaluate((element) => {
      let root: Document | ShadowRoot = document;
      for (const host of element.shadowPath) root = root.querySelector(host)!.shadowRoot!;
      return root.querySelectorAll(element.selector).length;
    }, deep);
    assert.equal(matches, 1);
    await page.locator('#deep-leaf').click();
    await page.locator('#deep-input').fill('Shadow 输入');
    await eventually(() => events.some((event) => event.kind === 'fill'));
    assert.equal(events.find((event) => event.kind === 'click')?.target?.ref, deep.ref);
    const fill = events.find((event) => event.kind === 'fill');
    assert.equal(fill?.target?.selector, '#deep-input');
    assert.equal(fill?.value, 'Shadow 输入');
    assert.deepEqual(fill?.target?.shadowPath, ['#shadow-host', '#inner-host']);
    const details = await bridge<Details>(page, 'inspect', deep.ref);
    assert.equal(details.editableText, true);
    assert(details.ancestors.some((item) => item.selector === '#inner-host'));
    assert(details.ancestors.some((item) => item.selector === '#shadow-host'));
  },
);

test(
  'text and CSS preview preserve Text nodes and restore exact prior inline styles',
  { skip: !executable },
  async (t) => {
    const { page, find, events } = await fixture(t);
    const leaf = await find('#leaf');
    const before = await bridge<Details>(page, 'inspect', leaf.ref);
    const beforeStyle = await page.locator('#leaf').getAttribute('style');
    assert.equal(before.textContent, '  原始文字  ');
    assert.equal(before.editableText, true);
    await bridge(page, 'setSource', 'agent');
    const literal = '<img src=x onerror="globalThis.injected=true">';
    const edited = await bridge<EditResult>(page, 'edit', {
      ref: leaf.ref,
      text: literal,
      styles: { color: '#123456', 'font-size': '24px', margin: '8px' },
    });
    assert.equal(edited.element.textContent, literal);
    assert.equal(edited.element.computed['font-size'], '24px');
    assert.equal(edited.element.computed.color, 'rgb(18, 52, 86)');
    assert.equal(await page.locator('#leaf img').count(), 0);
    assert.equal(
      await page.evaluate(
        () => (globalThis as any).originalTextNode === document.querySelector('#leaf')!.firstChild,
      ),
      true,
    );
    assert.equal(await page.evaluate(() => (globalThis as any).injected), undefined);
    await bridge(page, 'setSource', 'human');
    const undone = await bridge<EditResult>(page, 'undo', edited.editId);
    assert.equal(undone.element.textContent, '  原始文字  ');
    const restoredStyle = await page.locator('#leaf').getAttribute('style');
    assert.equal(
      await page.evaluate(() =>
        document.querySelector<HTMLElement>('#leaf')!.style.getPropertyPriority('margin-left'),
      ),
      'important',
    );
    assert.equal(
      await page.locator('#leaf').evaluate((el) => getComputedStyle(el).marginLeft),
      '3px',
    );
    assert(beforeStyle && restoredStyle);
    await eventually(
      () => events.filter((event) => event.kind === 'edit' || event.kind === 'undo').length === 2,
    );
    assert.deepEqual(
      events
        .filter((event) => event.kind === 'edit' || event.kind === 'undo')
        .map((event) => [event.kind, event.source, event.target?.ref]),
      [
        ['edit', 'agent', leaf.ref],
        ['undo', 'human', leaf.ref],
      ],
    );
    await assert.rejects(bridge(page, 'undo', edited.editId), /No active edit/);
  },
);

test(
  'complex elements retain their children and CSS validation rejects the entire invalid patch',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const complex = await find('#complex');
    const detail = await bridge<Details>(page, 'inspect', complex.ref);
    assert.equal(detail.editableText, false);
    assert.match(detail.editReason!, /child elements/);
    await assert.rejects(
      bridge(page, 'edit', { ref: complex.ref, text: 'replacement', styles: { color: 'red' } }),
      /child elements/,
    );
    assert.equal(await page.locator('#complex > svg').count(), 1);
    assert.equal(await page.locator('#complex > span').count(), 1);
    assert.equal(await page.locator('#complex').getAttribute('style'), null);
    const leaf = await find('#button-label');
    for (const patch of [
      { styles: { color: 'red', 'background-image': 'url(https://invalid.test/image)' } },
      { styles: { color: 'red;display:none' } },
      { styles: { color: 'var(--untrusted)' } },
      { attributes: { onclick: 'alert(1)' } },
      { innerHTML: '<script>alert(1)</script>' },
    ])
      await assert.rejects(
        bridge(page, 'edit', { ref: leaf.ref, ...patch }),
        /Unsupported|Only supported/,
      );
    assert.equal(await page.locator('#button-label').getAttribute('style'), null);
    const edit = await bridge<EditResult>(page, 'edit', { ref: leaf.ref, text: '保存预览' });
    await page.locator('#button-label').click();
    assert.equal(await page.evaluate(() => (globalThis as any).clicked), 1);
    assert.equal(await page.locator('#complex > svg').count(), 1);
    await bridge(page, 'undo', edit.editId);
    assert.equal(await page.locator('#button-label').textContent(), '保存');
  },
);

test(
  'sensitive fields remain masked and truncated text is never editable',
  { skip: !executable },
  async (t) => {
    const { page, find, events } = await fixture(t);
    for (const selector of ['#password-input', '#private-area']) {
      const element = await find(selector);
      const details = await bridge<Details>(page, 'inspect', element.ref);
      assert.equal(details.editableText, false);
      assert.equal(details.textContent, '[hidden]');
      assert.equal(details.value, '[hidden]');
      await assert.rejects(
        bridge(page, 'edit', { ref: element.ref, styles: { color: 'red' } }),
        /Sensitive/,
      );
      await assert.rejects(
        bridge(page, 'edit', { ref: element.ref, text: 'replacement' }),
        /Sensitive/,
      );
    }
    await page.locator('#password-input').fill('new-private-value');
    await eventually(() => events.some((event) => event.kind === 'fill'));
    // The data: fixture URL contains its literal HTML; URL redaction belongs to the runtime.
    const snapshot = await bridge<{ text: string; elements: ElementInfo[] }>(page, 'snapshot');
    const serialized = JSON.stringify({ events, text: snapshot.text, elements: snapshot.elements });
    for (const secret of [
      'new-private-value',
      'unusual-sensitive-value',
      'private-textarea-content',
    ])
      assert.equal(serialized.includes(secret), false);
    const long = await find('#long');
    const longDetails = await bridge<Details>(page, 'inspect', long.ref);
    assert.equal(longDetails.textContent.length, 20000);
    assert.equal(longDetails.editableText, false);
    assert.match(longDetails.editReason!, /20000/);
    await assert.rejects(bridge(page, 'edit', { ref: long.ref, text: 'short' }), /20000/);
  },
);

test(
  'removed/reinserted nodes and old documents invalidate refs instead of matching a replacement',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const leaf = await find('#leaf');
    const edit = await bridge<EditResult>(page, 'edit', { ref: leaf.ref, text: 'preview' });
    await assert.rejects(
      page.evaluate((ref) => {
        const el = document.querySelector('#leaf')!;
        el.remove();
        document.body.appendChild(el);
        return (globalThis as any).__workbenchPage.inspect(ref);
      }, leaf.ref),
      /stale|removed/,
    );
    const reinserted = await find('#leaf');
    assert.notEqual(reinserted.ref, leaf.ref);
    await assert.rejects(bridge(page, 'undo', edit.editId), /stale|removed/);
    await page.goto('data:text/html,<p id="leaf">A different document</p>');
    const current = await find('#leaf');
    assert.notEqual(current.documentId, leaf.documentId);
    await assert.rejects(
      bridge(page, 'edit', { ref: reinserted.ref, text: 'must not apply' }),
      /old document/,
    );
    assert.equal(await page.locator('#leaf').textContent(), 'A different document');
  },
);

test(
  'undo refuses conflicting text/styles and allows reversing later edits first',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const leaf = await find('#leaf');
    const first = await bridge<EditResult>(page, 'edit', { ref: leaf.ref, text: 'first' });
    const second = await bridge<EditResult>(page, 'edit', { ref: leaf.ref, text: 'second' });
    await assert.rejects(bridge(page, 'undo', first.editId), /changed after/);
    assert.equal(
      (await bridge<EditResult>(page, 'undo', second.editId)).element.textContent,
      'first',
    );
    assert.equal((await bridge<EditResult>(page, 'undo')).element.textContent, '  原始文字  ');
    const style = await bridge<EditResult>(page, 'edit', {
      ref: leaf.ref,
      text: 'preview remains',
      styles: { width: '200px' },
    });
    await page.locator('#leaf').evaluate((el) => {
      (el as HTMLElement).style.color = 'pink';
    });
    await assert.rejects(bridge(page, 'undo', style.editId), /styles changed/);
    assert.equal(await page.locator('#leaf').textContent(), 'preview remains');
    assert.equal(
      await page.locator('#leaf').evaluate((el) => (el as HTMLElement).style.width),
      '200px',
    );
  },
);

test(
  'iframe ownership stays separate from the parent page and document references',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const iframe = await find('#child-frame');
    const r = iframe.bounds;
    assert.equal(
      (await bridge<ElementInfo>(page, 'atPoint', r.x + r.width / 2, r.y + r.height / 2)).tag,
      'iframe',
    );
    assert.equal(
      (await bridge<QueryResult>(page, 'query', { selector: '#child-text' })).elements.length,
      0,
    );
    const child = page.frames().find((frame) => frame.parentFrame());
    assert(child);
    const childElement = (await child.evaluate(
      () => (globalThis as any).__workbenchPage.query({ selector: '#child-text' }).elements[0],
    )) as ElementInfo;
    assert.notEqual(childElement.documentId, iframe.documentId);
    await assert.rejects(bridge(page, 'inspect', childElement.ref), /old document/);
  },
);

test('hover previews deep nodes and selection tracks layout without touching the target', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page, find } = await fixture(t);
  await captureOverlayRoot(page);
  const leaf = await find('#deep-leaf');
  await bridge(page, 'setInspect', true);
  await page.mouse.move(leaf.bounds.x + 10, leaf.bounds.y + 10);
  await page.waitForFunction(() => {
    const root = (globalThis as any).__overlayRoot as ShadowRoot | undefined;
    return root?.querySelector<HTMLElement>('[data-kind="hover"]')?.style.display === 'block';
  });
  let hover = await readOverlay(page, 'hover');
  assert.equal(
    hover.label,
    'span · ' + Math.round(leaf.bounds.width) + ' × ' + Math.round(leaf.bounds.height),
  );
  assert(Math.abs(hover.x - leaf.bounds.x) < 1);
  assert(Math.abs(hover.y - leaf.bounds.y) < 1);
  const before = await page.locator('#leaf').getAttribute('style');
  const selected = await find('#leaf');
  await bridge(page, 'setInspect', false);
  await bridge(page, 'outline', selected.ref);
  await page.locator('#leaf').evaluate((el) => {
    el.parentElement!.style.paddingTop = '31px';
  });
  await page.waitForFunction(() => {
    const box = (globalThis as any).__overlayRoot.querySelector('[data-kind="selected"]');
    return (
      Math.abs(
        (box?.getBoundingClientRect().y ?? -9999) -
          document.querySelector('#leaf')!.getBoundingClientRect().y,
      ) < 1
    );
  });
  assert.equal(await page.locator('#leaf').getAttribute('style'), before);
  assert.equal((await readOverlay(page, 'hover')).visible, false);
  await page.evaluate(() => {
    document.body.style.minHeight = '2000px';
    window.scrollTo(0, 80);
  });
  await page.waitForFunction(() => {
    const box = (globalThis as any).__overlayRoot.querySelector('[data-kind="selected"]');
    return (
      Math.abs(
        (box?.getBoundingClientRect().y ?? -9999) -
          document.querySelector('#leaf')!.getBoundingClientRect().y,
      ) < 1
    );
  });
  await bridge(page, 'setInspect', true);
  await page.mouse.move(100, 100);
  await bridge(page, 'leave');
  await page.waitForFunction(
    () =>
      (globalThis as any).__overlayRoot.querySelector('[data-kind="hover"]').style.display ===
      'none',
  );
  await page.locator('#leaf').evaluate((el) => el.remove());
  await page.waitForFunction(
    () =>
      (globalThis as any).__overlayRoot.querySelector('[data-kind="selected"]').style.display ===
      'none',
  );
  await bridge(page, 'clearOverlays');
  assert.equal(await page.locator('[data-workbench-overlay]').count(), 0);
});

test('element feedback is temporary, respects reduced motion, and preserves website animations', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page, find } = await fixture(t);
  await captureOverlayRoot(page);
  const leaf = await find('#leaf');
  const other = await find('#heading');
  const before = await page.locator('#leaf').getAttribute('style');
  await page.locator('#leaf').evaluate((el) => {
    (globalThis as any).__websiteAnimation = el.animate([{ opacity: 1 }, { opacity: 0.8 }], {
      duration: 1000,
      iterations: Infinity,
    });
  });
  await bridge(page, 'feedback', leaf.ref, 'working');
  const effect = await readOverlay(page, 'feedback');
  assert.equal(effect.visible, true);
  assert.equal(effect.sweep, 'sweep');
  assert.match(effect.label ?? '', /^span · \d+ × \d+$/);
  assert.equal((await readCursor(page)).label, 'Athena · 处理中');
  assert.equal(await page.locator('#leaf').getAttribute('style'), before);
  assert.equal(
    await page.evaluate(() => (globalThis as any).__websiteAnimation.playState),
    'running',
  );
  await bridge(page, 'feedback', other.ref, 'working');
  await bridge(page, 'feedback', leaf.ref, null);
  assert.equal(
    (await readOverlay(page, 'feedback')).visible,
    true,
    'old target cleanup cannot clear the current target',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal((await readOverlay(page, 'feedback')).sweep, 'none');
  await page.waitForFunction(
    () => !(globalThis as any).__overlayRoot.querySelector('.agent-cursor').getAnimations().length,
  );
  await bridge(page, 'setSource', 'agent');
  const edit = await bridge<EditResult>(page, 'edit', { ref: leaf.ref, text: '修改完成' });
  assert.equal((await readOverlay(page, 'feedback')).visible, true);
  await page.waitForFunction(
    () =>
      (globalThis as any).__overlayRoot.querySelector('.agent-cursor .label').textContent ===
      'Athena · 已执行',
  );
  await page.waitForFunction(
    () =>
      (globalThis as any).__overlayRoot.querySelector('[data-kind="feedback"]').style.display ===
      'none',
  );
  await bridge(page, 'undo', edit.editId);
  assert.equal(await page.locator('#leaf').getAttribute('style'), before);
  assert.equal(
    await page.evaluate(() => (globalThis as any).__websiteAnimation.playState),
    'running',
  );
  const snapshot = await bridge<{ text: string }>(page, 'snapshot');
  assert(!snapshot.text.includes('span ·'));
  assert(!snapshot.text.includes('Athena ·'));
});

test('agent cursor follows actual targets and layout, clears on removal, and stays out of manual edits', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page, find } = await fixture(t);
  await captureOverlayRoot(page);
  const leaf = await find('#leaf');
  const heading = await find('#heading');
  await bridge(page, 'feedback', leaf.ref, 'working');
  await page.waitForFunction(
    () =>
      !(globalThis as any).__overlayRoot
        .querySelector('.agent-cursor')
        .getAnimations()
        .some((a: Animation) => a.playState === 'running'),
  );
  let cursor = await readCursor(page);
  assert.equal(cursor.visible, true);
  assert(Math.abs(cursor.x - (leaf.bounds.x + leaf.bounds.width * 0.7)) < 1);
  assert(Math.abs(cursor.y - (leaf.bounds.y + Math.min(24, leaf.bounds.height * 0.5))) < 1);
  await bridge(page, 'setSource', 'agent');
  await bridge(page, 'edit', { ref: heading.ref, text: '今天的计划' });
  await page.waitForFunction(
    () =>
      (globalThis as any).__overlayRoot.querySelector('.agent-cursor .label').textContent ===
      'Athena · 已执行',
  );
  assert.equal(await page.locator('#heading').textContent(), '今天的计划');
  assert.match((await readOverlay(page, 'feedback')).label ?? '', /^h1 ·/);
  await bridge(page, 'feedback', heading.ref, 'working');
  await page.evaluate(() => {
    document.body.style.minHeight = '2000px';
    document.body.style.paddingTop = '180px';
    scrollTo(0, 80);
  });
  await page.waitForFunction(() => {
    const target = document.querySelector('#heading')!.getBoundingClientRect();
    const cursor = (globalThis as any).__overlayRoot
      .querySelector('.agent-cursor')
      .getBoundingClientRect();
    return Math.abs(cursor.y - (target.y + Math.min(24, target.height * 0.5))) < 1;
  });
  await page.locator('#heading').evaluate((el) => el.remove());
  await page.waitForFunction(
    () => (globalThis as any).__overlayRoot.querySelector('.agent-cursor').style.display === 'none',
  );
  await bridge(page, 'setSource', 'human');
  await bridge(page, 'edit', { ref: leaf.ref, text: '手动预览' });
  cursor = await readCursor(page);
  assert.equal(cursor.visible, false, 'manual edits must not impersonate the agent');
  await page.locator('#leaf').evaluate((el) => {
    el.style.cssText =
      'position:fixed;right:0;bottom:0;width:10px;height:10px;padding:0;overflow:hidden';
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bridge(page, 'feedback', leaf.ref, 'working');
  await page.waitForFunction(() => {
    const cursor = (globalThis as any).__overlayRoot.querySelector('.agent-cursor');
    const label = cursor.querySelector('.label').getBoundingClientRect();
    const pointer = cursor.querySelector('svg').getBoundingClientRect();
    return (
      cursor.style.display === 'block' &&
      label.left >= 0 &&
      label.right <= innerWidth &&
      label.bottom <= innerHeight &&
      pointer.right <= innerWidth &&
      pointer.bottom <= innerHeight
    );
  });
  await bridge(page, 'clearOverlays');
  assert.equal(await page.locator('[data-workbench-overlay]').count(), 0);
});

async function readCursor(page: Page) {
  return page.evaluate(() => {
    const cursor = (globalThis as any).__overlayRoot.querySelector('.agent-cursor') as HTMLElement;
    const rect = cursor.getBoundingClientRect();
    return {
      visible: getComputedStyle(cursor).display !== 'none',
      x: rect.x,
      y: rect.y,
      label: cursor.textContent,
    };
  });
}

async function captureOverlayRoot(page: Page) {
  await page.evaluate(() => {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = original.call(this, init);
      if (this.hasAttribute('data-workbench-overlay')) (globalThis as any).__overlayRoot = root;
      return root;
    };
  });
}
async function readOverlay(page: Page, kind: string) {
  return page.evaluate((kind) => {
    const box = (globalThis as any).__overlayRoot.querySelector(
      `[data-kind="${kind}"]`,
    ) as HTMLElement;
    const rect = box.getBoundingClientRect();
    return {
      visible: getComputedStyle(box).display !== 'none',
      x: rect.x,
      y: rect.y,
      label: box.querySelector('span')?.textContent,
      sweep: getComputedStyle(box.querySelector('.scan') || box, '::after').animationName,
    };
  }, kind);
}

async function readSwarm(page: Page) {
  return page.evaluate(() => {
    const root = (globalThis as any).__overlayRoot as ShadowRoot | undefined;
    const stage = root?.isConnected ? root.querySelector('.swarm') : null;
    return {
      nodes: stage?.childElementCount ?? 0,
      cursors: stage?.querySelectorAll('.sw-cur').length ?? 0,
      frames: stage?.querySelectorAll('.sw-sel').length ?? 0,
      muted: (root?.querySelectorAll('style').length ?? 0) > 1,
      veiled: (CSS as any).highlights.has('athena-swarm-pending'),
      sheets: document.adoptedStyleSheets.length,
    };
  });
}
const swarmDone = (page: Page) =>
  page.waitForFunction(() => {
    const root = (globalThis as any).__overlayRoot as ShadowRoot;
    return (
      !root.querySelector('.swarm')?.childElementCount && root.querySelectorAll('style').length < 2
    );
  });

test('agent style edits play as cursors while the document and observations already hold the result', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page, find } = await fixture(t);
  await captureOverlayRoot(page);
  const box = await find('#box');
  await bridge(page, 'setSource', 'agent');
  const styles = { 'background-color': 'rgb(200, 30, 30)', width: '400px' };
  // One task: no frame is rendered between the edit and these reads.
  const played = await page.evaluate(
    ({ ref, styles }) => {
      const api = (globalThis as any).__workbenchPage;
      const el = document.querySelector('#box') as HTMLElement;
      const result = api.edit({ ref, styles });
      return {
        result,
        inline: el.getAttribute('style'),
        painted: getComputedStyle(el).backgroundColor,
        paintedWidth: el.getBoundingClientRect().width,
        inspected: api.inspect(ref),
        queried: api.query({ selector: '#box' }).elements[0].bounds.width,
        players: el.getAnimations().length,
      };
    },
    { ref: box.ref, styles },
  );
  assert.equal(played.inline, 'background-color: rgb(200, 30, 30); width: 400px;');
  assert.equal(played.result.element.computed['background-color'], 'rgb(200, 30, 30)');
  assert.equal(played.result.element.bounds.width, 440);
  assert.equal(played.inspected.computed['background-color'], 'rgb(200, 30, 30)');
  assert.equal(played.queried, 440);
  assert.equal(played.painted, 'rgb(238, 238, 238)', 'the old look is held until a cursor arrives');
  assert.equal(played.paintedWidth, 340);
  assert.equal(played.players, 1);
  let swarm = await readSwarm(page);
  assert(swarm.cursors >= 1);
  assert.equal(swarm.frames, 1);
  assert.equal(swarm.muted, true, 'the regular feedback boxes stay unseen during the show');
  await page.waitForFunction(
    () => (globalThis as any).__overlayRoot.querySelectorAll('.swarm .sw-cur').length > 1,
    undefined,
    { timeout: 3000 },
  );
  await swarmDone(page);
  assert.deepEqual(
    await page.locator('#box').evaluate((el) => ({
      players: el.getAnimations().length,
      painted: getComputedStyle(el).backgroundColor,
      inline: el.getAttribute('style'),
    })),
    { players: 0, painted: 'rgb(200, 30, 30)', inline: played.inline },
  );
  const undone = await page.evaluate((editId) => {
    const api = (globalThis as any).__workbenchPage;
    const el = document.querySelector('#box') as HTMLElement;
    const result = api.undo(editId);
    const held = getComputedStyle(el).backgroundColor;
    api.mask(true);
    const settled = {
      painted: getComputedStyle(el).backgroundColor,
      players: el.getAnimations().length,
    };
    api.mask(false);
    return { result, inline: el.getAttribute('style'), held, settled };
  }, played.result.editId);
  assert.equal(undone.inline, '', 'the inline style is restored as written, with no extras');
  assert.equal(undone.result.element.computed['background-color'], 'rgb(238, 238, 238)');
  assert.equal(undone.held, 'rgb(200, 30, 30)', 'undo is played from the edited look');
  assert.deepEqual(undone.settled, { painted: 'rgb(238, 238, 238)', players: 0 });
  swarm = await readSwarm(page);
  assert.equal(swarm.nodes, 0, 'a capture ends the show at once');
});

test('agent text edits type only the changed part behind a highlight and leave nothing behind', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page, find } = await fixture(t);
  await captureOverlayRoot(page);
  const heading = await find('#heading');
  await bridge(page, 'setSource', 'agent');
  const played = await page.evaluate((ref) => {
    const api = (globalThis as any).__workbenchPage;
    const result = api.edit({ ref, text: '普通标题已经更新' });
    const [range] = [...(CSS as any).highlights.get('athena-swarm-pending')] as Range[];
    return {
      editId: result.editId,
      text: document.querySelector('#heading')!.textContent,
      reported: result.element.textContent,
      snapshot: api.snapshot().text,
      pending: range.toString(),
    };
  }, heading.ref);
  assert.equal(played.text, '普通标题已经更新');
  assert.equal(played.reported, '普通标题已经更新');
  assert(played.snapshot.includes('普通标题已经更新'));
  assert.equal(played.pending, '已经更新', 'text both versions share is not retyped');
  let swarm = await readSwarm(page);
  assert.deepEqual([swarm.veiled, swarm.sheets, swarm.frames], [true, 1, 1]);
  await page.waitForFunction(() => {
    const [range] = [...(CSS as any).highlights.get('athena-swarm-pending')] as Range[];
    const caret = (globalThis as any).__overlayRoot.querySelector('.swarm .sw-caret');
    return caret && range.toString().length < 4 && range.toString().length > 0;
  });
  await swarmDone(page);
  swarm = await readSwarm(page);
  assert.deepEqual([swarm.veiled, swarm.sheets, swarm.nodes], [false, 0, 0]);
  await bridge(page, 'undo', played.editId);
  assert.equal(await page.locator('#heading').textContent(), '普通标题');
  assert.equal(await page.locator('#heading').getAttribute('style'), null);
  assert((await readSwarm(page)).cursors >= 1, 'undo is played as well');
  await bridge(page, 'clearOverlays');
  assert.equal(await page.locator('[data-workbench-overlay]').count(), 0);
  assert.equal(await page.evaluate(() => (CSS as any).highlights.size), 0);
  assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 0);
});

test('agent insertions are drawn layer by layer and an undone insertion collapses', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page, find } = await fixture(t);
  await captureOverlayRoot(page);
  const anchor = await find('#box');
  await bridge(page, 'setSource', 'agent');
  const insert = {
    position: 'after',
    node: {
      tag: 'section',
      attributes: { id: 'drawn' },
      styles: { padding: '16px' },
      children: [
        { tag: 'h2', text: 'New section' },
        { tag: 'p', text: 'Drawn by cursors' },
        { tag: 'button', text: 'Continue' },
      ],
    },
  };
  const played = await page.evaluate(
    ({ ref, insert }) => {
      const api = (globalThis as any).__workbenchPage;
      const result = api.edit({ ref, insert });
      const el = document.querySelector('#drawn')!;
      return {
        editId: result.editId,
        html: el.outerHTML,
        painted: [el, ...el.children].map((node) => getComputedStyle(node).opacity),
        reported: api.inspect(result.element.ref).computed.opacity,
        snapshot: api.snapshot().text,
      };
    },
    { ref: anchor.ref, insert },
  );
  assert.equal(
    played.html,
    '<section id="drawn" style="padding: 16px;"><h2>New section</h2><p>Drawn by cursors</p><button type="button">Continue</button></section>',
  );
  assert.deepEqual(played.painted, ['0', '0', '0', '0'], 'nothing is painted before it is drawn');
  assert.equal(played.reported, '1');
  assert(played.snapshot.includes('Drawn by cursors'));
  let swarm = await readSwarm(page);
  assert.equal(swarm.cursors, 4);
  assert.equal(swarm.veiled, true);
  await swarmDone(page);
  assert.deepEqual(
    await page.locator('#drawn').evaluate((el) => ({
      html: el.outerHTML,
      players: [el, ...el.children].flatMap((node) => node.getAnimations()).length,
      painted: [el, ...el.children].map((node) => getComputedStyle(node).opacity),
    })),
    { html: played.html, players: 0, painted: ['1', '1', '1', '1'] },
  );
  swarm = await readSwarm(page);
  assert.deepEqual([swarm.veiled, swarm.sheets], [false, 0]);
  await bridge(page, 'undo', played.editId);
  assert.equal(await page.locator('#drawn').count(), 0);
  assert.equal(
    await page.evaluate(
      () => (globalThis as any).__overlayRoot.querySelectorAll('.swarm .sw-sel.ghost').length,
    ),
    1,
  );
  await swarmDone(page);
});

test('manual edits show a pointer without animating page elements, reduced motion stays still, and newer edits replace earlier shows', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page, find } = await fixture(t);
  await captureOverlayRoot(page);
  const box = await find('#box');
  const heading = await find('#heading');
  const players = () => page.locator('#box').evaluate((el) => el.getAnimations().length);
  await bridge(page, 'edit', { ref: box.ref, styles: { 'background-color': 'rgb(1, 2, 3)' } });
  let swarm = await readSwarm(page);
  assert.ok(swarm.cursors > 0);
  assert.equal(await players(), 0);
  await swarmDone(page);
  await bridge(page, 'setSource', 'agent');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bridge(page, 'edit', { ref: box.ref, styles: { 'background-color': 'rgb(4, 5, 6)' } });
  swarm = await readSwarm(page);
  assert.deepEqual([swarm.nodes, swarm.muted, await players()], [0, false, 0]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const frames = await page.evaluate(
    ({ box, heading }) => {
      const api = (globalThis as any).__workbenchPage;
      // Arrow helpers are not used here: the test transform would wrap them in a missing helper.
      const stage = (globalThis as any).__overlayRoot;
      const seen: number[] = [];
      api.edit({ ref: box, styles: { 'background-color': 'rgb(7, 8, 9)' } });
      seen.push(stage.querySelectorAll('.swarm .sw-sel').length);
      api.edit({ ref: box, styles: { 'background-color': 'rgb(10, 11, 12)' } });
      seen.push(stage.querySelectorAll('.swarm .sw-sel').length);
      api.edit({ ref: heading, text: '另一个元素' });
      seen.push(stage.querySelectorAll('.swarm .sw-sel').length);
      return seen;
    },
    { box: box.ref, heading: heading.ref },
  );
  assert.deepEqual(frames, [1, 1, 2]);
  assert.equal(await players(), 1);
  await bridge(page, 'setSource', 'human');
  await bridge(page, 'previewStyles', { ref: box.ref, styles: { color: 'rgb(9, 9, 9)' } });
  assert.equal(await players(), 0, 'direct manipulation shows the real styles');
  assert.equal((await readSwarm(page)).frames, 1, 'the show on another element continues');
  await page.locator('#heading').evaluate((el) => el.remove());
  await swarmDone(page);
});

test(
  'layout changes and their exact undo show pointers for both real siblings, while unchanged layouts and edits stay still',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    await captureOverlayRoot(page);
    await page.locator('#box').evaluate((box) => {
      box.innerHTML =
        '<h3 id="pair-head" style="margin:0">标题</h3><p class="intro" style="margin:0">副标题</p>';
      box.style.height = 'auto';
    });
    const heading = await find('#pair-head');
    await bridge(page, 'setSource', 'agent');
    const rects = () =>
      page.locator('#box > *').evaluateAll((els) =>
        els.map((el) => {
          const { x, y, width, height } = el.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
    const original = await rects();
    const request = { ref: heading.ref, direction: 'row' };
    const change = await bridge<EditResult & { applied: boolean; reason?: string }>(
      page,
      'layoutPair',
      request,
    );
    assert.ok(change.applied, change.reason ?? 'layout was not applied');
    const row = await rects();
    assert.ok(row[1].x >= row[0].x + row[0].width - 1);
    assert.ok((await readSwarm(page)).cursors >= 2, 'each sibling has a cursor');
    await swarmDone(page);
    assert.equal((await bridge<{ already?: boolean }>(page, 'layoutPair', request)).already, true);
    assert.equal((await readSwarm(page)).nodes, 0);
    await bridge(page, 'undo', change.editId);
    assert.deepEqual(await rects(), original);
    assert.ok((await readSwarm(page)).cursors >= 2);
    await swarmDone(page);
    const noop = await bridge<EditResult>(page, 'edit', { ref: heading.ref, text: '标题' });
    assert.equal((await readSwarm(page)).nodes, 0);
    await bridge(page, 'undo', noop.editId);
    assert.equal((await readSwarm(page)).nodes, 0);
  },
);

test(
  'direct manipulation shows a pointer only on a changed commit',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    await captureOverlayRoot(page);
    const { ref } = await find('#box');
    const preview = await bridge<EditResult>(page, 'previewStyles', {
      ref,
      styles: { width: '250px' },
    });
    await bridge(page, 'previewStyles', {
      ref,
      editId: preview.editId,
      styles: { width: '200px' },
    });
    assert.equal((await readSwarm(page)).nodes, 0);
    await bridge(page, 'commitStyles', preview.editId);
    assert.ok((await readSwarm(page)).cursors > 0);
    assert.equal(
      await page.locator('#box').evaluate((el) => (el as HTMLElement).style.width),
      '200px',
    );
    await swarmDone(page);
    const noop = await bridge<EditResult>(page, 'previewStyles', {
      ref,
      styles: { width: '200px' },
    });
    await bridge(page, 'commitStyles', noop.editId);
    assert.equal((await readSwarm(page)).nodes, 0);
  },
);

test(
  'native form commands show one cursor after typing, while identical values, failed actions and manual typing stay still',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    await captureOverlayRoot(page);
    await page.locator('#box').evaluate((el) => {
      el.innerHTML =
        '<input id="city" value="old"><select id="pick"><option>one</option><option>two</option></select>';
    });
    const city = page.locator('#city'),
      pick = await find('#pick'),
      cityRef = await find('#city');
    await city.fill('manual');
    assert.equal((await readSwarm(page)).cursors, 0);
    await bridge(page, 'setSource', 'agent');
    await bridge(page, 'watchScript', 'fields');
    await city.pressSequentially('abc');
    assert.equal(
      (await readSwarm(page)).cursors,
      0,
      'typing is batched, with no drawing between keys',
    );
    assert.equal(await bridge(page, 'replayScript', true, true), 'targets');
    assert.equal((await readSwarm(page)).cursors, 1);
    assert.equal(await city.inputValue(), 'manualabc');
    await swarmDone(page);
    await bridge(page, 'watchScript', 'fields');
    await city.fill('manualabc');
    assert.equal(await bridge(page, 'replayScript', true, true), false);
    await bridge(page, 'watchScript', 'fields');
    await city.fill('interrupted');
    assert.equal(await bridge(page, 'replayScript', false, true), false);
    assert.equal((await readSwarm(page)).nodes, 0);
    await bridge(page, 'select', pick.ref, 'two');
    assert.equal((await readSwarm(page)).cursors, 1);
    await swarmDone(page);
    await bridge(page, 'select', pick.ref, 'two');
    assert.equal((await readSwarm(page)).nodes, 0);
    await bridge(page, 'focus', cityRef.ref);
    await page.keyboard.insertText('completed');
    await bridge(page, 'replayScript');
    assert.equal((await readSwarm(page)).cursors, 1);
    await swarmDone(page);
    await bridge(page, 'watchScript', 'fields');
    await bridge(page, 'setSource', 'human');
    await city.fill('takeover');
    assert.equal(await bridge(page, 'replayScript', true, true), false);
    assert.equal((await readSwarm(page)).nodes, 0);
  },
);

test(
  'stylesheet changes use a local pointer when there is no snapshot and skipped declarations have no motion',
  { skip: !executable },
  async (t) => {
    const { page } = await fixture(t);
    await captureOverlayRoot(page);
    const first = await bridge<EditResult>(page, 'restyle', { css: '#box{width:280px}' });
    assert.ok((await readSwarm(page)).cursors > 0, 'manual stylesheet change');
    assert.equal(await page.locator('#box').evaluate((el) => getComputedStyle(el).width), '280px');
    await swarmDone(page);
    const duplicate = await bridge<EditResult>(page, 'restyle', { css: '#box{width:280px}' });
    assert.equal((await readSwarm(page)).cursors, 0);
    await bridge(page, 'undo', first.editId);
    assert.equal(
      (await readSwarm(page)).cursors,
      0,
      'the newer sheet still provides the same width',
    );
    await bridge(page, 'undo', duplicate.editId);
    assert.equal(await page.locator('#box').evaluate((el) => getComputedStyle(el).width), '300px');
    assert.ok(
      (await readSwarm(page)).cursors > 0,
      'removing the last matching rule changed the layout',
    );
  },
);

test('agent edits out of view are scrolled to and played, and changes without a box play on their container', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page, find } = await fixture(t);
  await captureOverlayRoot(page);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<p id="far" style="margin-top:3000px">远处的文字</p><div id="far-box" style="height:40px;background:#ddd"></div>
       <section id="tall" style="height:2600px;background:#f4f4f4"></section>`,
    );
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<div id="scroller" style="height:90px;overflow:auto"><p style="margin-top:200px" id="nested">容器里的文字</p></div>',
    );
    document
      .querySelector('#box')!
      .insertAdjacentHTML('beforeend', '<span id="unseen">隐藏</span>');
  });
  const far = await find('#far');
  const farBox = await find('#far-box');
  const nested = await find('#nested');
  const tall = await find('#tall');
  const unseen = await find('#unseen');
  const view = () =>
    page.evaluate(() => {
      const rect = document.querySelector('#far')!.getBoundingClientRect();
      return { y: scrollY, seen: rect.top >= 0 && rect.bottom <= innerHeight };
    });
  const home = () => page.evaluate(() => scrollTo(0, 0));

  await bridge(page, 'edit', { ref: far.ref, styles: { color: 'rgb(1, 2, 3)' } });
  assert.deepEqual(await view(), { y: 0, seen: false }, 'manual edits never move the page');
  await bridge(page, 'setSource', 'agent');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bridge(page, 'edit', { ref: far.ref, styles: { color: 'rgb(4, 5, 6)' } });
  assert.deepEqual(await view(), { y: 0, seen: false }, 'nor does an edit that will not be played');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const text = await bridge<EditResult>(page, 'edit', { ref: far.ref, text: '远处的文字改好了' });
  assert.equal((await view()).seen, true, 'the target is brought into view before the show');
  let swarm = await readSwarm(page);
  assert.deepEqual([swarm.frames, swarm.veiled, swarm.cursors >= 1], [1, true, true]);
  assert(
    text.element.bounds.y >= 0 && text.element.bounds.y < 1000,
    'the result reports where it is',
  );
  await swarmDone(page);

  await home();
  const style = await bridge<EditResult>(page, 'edit', {
    ref: farBox.ref,
    styles: { 'background-color': 'rgb(20, 120, 220)', height: '80px' },
  });
  assert.equal((await view()).seen, true);
  assert.equal(
    await page.locator('#far-box').evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(221, 221, 221)',
    'the old look is held where it can now be seen',
  );
  assert.equal((await readSwarm(page)).frames, 1);
  await swarmDone(page);

  await home();
  await bridge(page, 'undo', style.editId);
  assert.equal((await view()).seen, true, 'undo is brought into view as well');
  assert.equal((await readSwarm(page)).frames, 1);
  await swarmDone(page);

  const inserted = await bridge<EditResult>(page, 'edit', {
    ref: farBox.ref,
    insert: { position: 'after', node: { tag: 'p', text: '新段落' } },
  });
  await swarmDone(page);
  await home();
  await bridge(page, 'undo', inserted.editId);
  assert.equal((await view()).seen, true, 'a removed insertion collapses where it was');
  assert.equal(
    await page.evaluate(
      () => (globalThis as any).__overlayRoot.querySelectorAll('.swarm .sw-sel.ghost').length,
    ),
    1,
  );
  await swarmDone(page);

  await home();
  await bridge(page, 'edit', { ref: nested.ref, text: '容器里的文字改好了' });
  const scrolled = await page.evaluate(() => {
    const host = document.querySelector('#scroller')!.getBoundingClientRect();
    const rect = document.querySelector('#nested')!.getBoundingClientRect();
    return { page: scrollY, inside: rect.top >= host.top - 1 && rect.bottom <= host.bottom + 1 };
  });
  assert.deepEqual(scrolled, { page: 0, inside: true }, 'a container is scrolled, the page is not');
  assert.equal((await readSwarm(page)).frames, 1);
  await swarmDone(page);

  // Removing the last content lets the page spring back; the outline goes with what surrounds it.
  const last = await bridge<EditResult>(page, 'edit', {
    ref: tall.ref,
    insert: { position: 'after', node: { tag: 'p', text: '页面末尾的段落' } },
  });
  await swarmDone(page);
  const sprung = await page.evaluate((editId) => {
    scrollTo(0, document.documentElement.scrollHeight);
    const section = document.querySelector('#tall')!;
    const was = section.getBoundingClientRect().bottom;
    (globalThis as any).__workbenchPage.undo(editId);
    const ghost = (globalThis as any).__overlayRoot.querySelector('.swarm .sw-sel.ghost');
    return {
      moved: section.getBoundingClientRect().bottom - was,
      gap: ghost.getBoundingClientRect().top - section.getBoundingClientRect().bottom,
    };
  }, last.editId);
  assert(sprung.moved > 20, 'the page moved when its last content went');
  assert(Math.abs(sprung.gap - 12) <= 1, 'the outline stays under the content it followed');
  await swarmDone(page);

  // An element taller than the view: the cursor and the size badge stay inside it.
  await bridge(page, 'edit', {
    ref: tall.ref,
    styles: { 'background-color': 'rgb(230, 240, 255)' },
  });
  await page.waitForTimeout(450);
  const kept = await page.evaluate(() => {
    const stage = (globalThis as any).__overlayRoot.querySelector('.swarm');
    const lead = stage.querySelector('.sw-cur').getBoundingClientRect();
    const badge = stage.querySelector('.sw-sel b').getBoundingClientRect();
    return {
      lead: lead.x >= 0 && lead.x <= innerWidth && lead.y >= 0 && lead.y <= innerHeight,
      badge: badge.top >= 0 && badge.bottom <= innerHeight && badge.left >= 0,
      size: stage.querySelector('.sw-sel b').textContent,
    };
  });
  assert.deepEqual([kept.lead, kept.badge], [true, true]);
  assert.match(kept.size, / × 2600$/);
  await swarmDone(page);

  // No box of its own: the closest element that has one stands in.
  await home();
  await page.locator('#unseen').evaluate((el) => ((el as HTMLElement).hidden = true));
  await bridge(page, 'edit', { ref: unseen.ref, styles: { color: 'rgb(7, 8, 9)' } });
  const stood = await page.evaluate(() => {
    const frame = (globalThis as any).__overlayRoot.querySelector('.swarm .sw-sel');
    const box = document.querySelector('#box')!.getBoundingClientRect();
    return {
      frame: frame ? Math.round(frame.getBoundingClientRect().width) : 0,
      box: Math.round(box.width),
      players: document.querySelector('#unseen')!.getAnimations().length,
    };
  });
  assert.deepEqual([stood.frame, stood.players], [stood.box, 0]);
  await swarmDone(page);
});

// The snapshot that keeps the view as it looked while a page script of the agent has run.
async function readCover(page: Page) {
  return page.evaluate(() => ({
    kept: document
      .getAnimations()
      .filter(
        (item) =>
          (item.effect as KeyframeEffect | null)?.pseudoElement ===
          '::view-transition-old(athena-swarm-page)',
      ).length,
    sheets: document.adoptedStyleSheets.length,
    named: getComputedStyle(
      document.querySelector('[data-workbench-overlay]') ?? document.body,
    ).getPropertyValue('view-transition-name'),
  }));
}

test('agent page scripts are uncovered part by part: the view keeps its look while the page already holds the result', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page, find } = await fixture(t);
  await captureOverlayRoot(page);
  const box = await find('#box');
  const area = (await page.locator('#box').boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  // A patch of the box away from its text and corners.
  const shot = async () =>
    (
      await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: area.x + 200, y: area.y + 30, width: 40, height: 20, scale: 1 },
      })
    ).data;
  const before = await shot();
  assert.equal(await bridge(page, 'watchScript'), false, 'only scripts of the agent are watched');
  await bridge(page, 'setSource', 'agent');
  assert.equal(await bridge(page, 'watchScript'), true);
  // The script runs as its own task, the way an evaluation of the agent arrives. Its rules win
  // over anything an animation could hold back, and it changes the layout.
  const held = await page.evaluate(
    async ([ref, x, y]) => {
      const style = document.createElement('style');
      style.textContent =
        '* { transition: background-color .25s ease, color .25s ease; }' +
        'body { background: rgb(0, 0, 0) !important; color: rgb(245, 245, 247) !important; }' +
        '#heading { letter-spacing: -1px !important; color: rgb(41, 151, 255) !important; }' +
        '#box { background: rgb(29, 29, 31) !important; border-radius: 18px !important; width: 420px !important; }' +
        '#complex { background: rgb(0, 113, 227) !important; border-radius: 980px !important; color: rgb(255, 255, 255) !important; }';
      document.head.appendChild(style);
      // Longer than the page's own transitions, which run underneath.
      await new Promise((resolve) => setTimeout(resolve, 350));
      const el = document.querySelector('#box')!;
      return {
        box: getComputedStyle(el).backgroundColor,
        width: el.getBoundingClientRect().width,
        label: getComputedStyle(document.querySelector('#button-label')!).color,
        hit: document.elementFromPoint(x as number, y as number)?.id,
        inspected: (globalThis as any).__workbenchPage.inspect(ref).computed['background-color'],
        cursors: (globalThis as any).__overlayRoot.querySelectorAll('.swarm .sw-cur').length,
      };
    },
    [box.ref, area.x + 220, area.y + 40],
  );
  assert.deepEqual(
    held,
    {
      box: 'rgb(29, 29, 31)',
      width: 460,
      label: 'rgb(255, 255, 255)',
      hit: 'box',
      inspected: 'rgb(29, 29, 31)',
      cursors: 0,
    },
    'the page is as the script left it for anything that reads it or points at it',
  );
  assert.deepEqual(await readCover(page), {
    kept: 1,
    sheets: 1,
    named: 'athena-swarm-page-cursors',
  });
  assert.equal(await shot(), before, 'the view keeps its look until the script has returned');

  const started = await page.evaluate(() => {
    (globalThis as any).__replayed = (globalThis as any).__workbenchPage.replayScript();
    const stage = (globalThis as any).__overlayRoot;
    return {
      cursors: stage.querySelectorAll('.swarm .sw-cur').length,
      tags: stage.querySelectorAll('.swarm .tag').length,
    };
  });
  assert.deepEqual(started, { cursors: 4, tags: 1 });
  assert.equal((await readSwarm(page)).muted, true);
  await page.waitForFunction(
    () =>
      (globalThis as any).__overlayRoot.querySelectorAll('.swarm .sw-sel').length > 2 &&
      getComputedStyle(
        document.documentElement,
        '::view-transition-old(athena-swarm-page)',
      ).clipPath.split('M').length > 3,
    undefined,
    { timeout: 3000 },
  );
  assert.equal(
    await page.evaluate(() => (globalThis as any).__replayed),
    true,
    'the replay reports that it started',
  );
  await swarmDone(page);
  assert.equal((await readSwarm(page)).nodes, 0);
  assert.deepEqual(await readCover(page), { kept: 0, sheets: 0, named: 'none' });
  assert.notEqual(await shot(), before, 'the view ends on what the script made');
  assert.deepEqual(
    await page.evaluate(() => {
      const el = document.querySelector('#box')!;
      return {
        box: getComputedStyle(el).backgroundColor,
        radius: getComputedStyle(el).borderTopLeftRadius,
        body: getComputedStyle(document.body).backgroundColor,
        heading: getComputedStyle(document.querySelector('#heading')!).color,
        inline: el.getAttribute('style'),
        players: document.getAnimations().length,
      };
    }),
    {
      box: 'rgb(29, 29, 31)',
      radius: '18px',
      body: 'rgb(0, 0, 0)',
      heading: 'rgb(41, 151, 255)',
      inline: null,
      players: 0,
    },
  );
  await swarmDone(page);
});

test('text, new content and removals made by an agent script are uncovered where they are; a script that scrolls is not played', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page } = await fixture(t);
  await captureOverlayRoot(page);
  await bridge(page, 'setSource', 'agent');
  assert.equal(await bridge(page, 'watchScript'), true);
  await page.evaluate(() => {
    document.querySelector('#heading')!.textContent = '普通标题，改好了';
    document
      .querySelector('#box')!
      .insertAdjacentHTML(
        'afterend',
        '<section id="added" style="padding:12px"><h2>新增区块</h2><p>新增内容</p></section>',
      );
    document.querySelector('#duplicate')!.remove();
  });
  const started = await page.evaluate(() => {
    (globalThis as any).__replayed = (globalThis as any).__workbenchPage.replayScript();
    const stage = (globalThis as any).__overlayRoot;
    return {
      cursors: stage.querySelectorAll('.swarm .sw-cur').length,
      tags: stage.querySelectorAll('.swarm .tag').length,
      text: document.querySelector('#heading')!.textContent,
    };
  });
  assert.deepEqual(
    started,
    { cursors: 3, tags: 1, text: '普通标题，改好了' },
    'one cursor each for the rewritten heading, the new section and the place of the removed line',
  );
  assert.equal(await page.evaluate(() => (globalThis as any).__replayed), true);
  await swarmDone(page);
  assert.deepEqual(await readCover(page), { kept: 0, sheets: 0, named: 'none' });
  assert.equal(
    await page.locator('#added').evaluate((el) => el.getAttribute('style')),
    'padding:12px',
  );

  // What was in view when the script started is not what it changed after scrolling.
  assert.equal(await bridge(page, 'watchScript'), true);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="tall" style="height:3000px"></div>');
    scrollTo(0, 400);
  });
  assert.equal(await bridge(page, 'replayScript'), false);
  assert.equal((await readSwarm(page)).nodes, 0);
  assert.equal((await readCover(page)).kept, 0);
});

test('what an agent script changes down the page is held back and drawn from the top down by as many cursors as it takes, and the view returns', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page } = await fixture(t);
  await captureOverlayRoot(page);
  // Eight rows of tiles below the first screen.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<style>.tiles{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin:0 0 60px}.tile{height:120px;background:#ddd}</style>' +
        '<div style="height:1000px"></div>' +
        Array.from(
          { length: 8 },
          (_, row) =>
            `<h2>Row ${row}</h2><div class="tiles">${Array.from({ length: 6 }, (_, tile) => `<div class="tile">${row}.${tile}</div>`).join('')}</div>`,
        ).join(''),
    );
    (globalThis as any).__seen = [];
    addEventListener('scroll', () => (globalThis as any).__seen.push(Math.round(scrollY)));
  });
  await bridge(page, 'setSource', 'agent');
  const restyle = (rules: string) =>
    page.evaluate((rules) => {
      const style = document.createElement('style');
      style.textContent = rules;
      document.head.appendChild(style);
    }, rules);
  const begin = () =>
    page.evaluate(() => {
      (globalThis as any).__seen.length = 0;
      (globalThis as any).__replayed = (globalThis as any).__workbenchPage.replayScript();
      const tiles = [...document.querySelectorAll('.tile')];
      return {
        cursors: (globalThis as any).__overlayRoot.querySelectorAll('.swarm .sw-cur').length,
        held: tiles.filter((tile) => tile.getAnimations().length).length,
        clipped: getComputedStyle(tiles[0]).clipPath.startsWith('inset('),
        colour: getComputedStyle(tiles[0]).backgroundColor,
        scroll: scrollY,
      };
    });
  const touring = () => page.waitForFunction(() => scrollY > 600, undefined, { timeout: 8000 });

  assert.equal(await bridge(page, 'watchScript'), true);
  await restyle(
    '#box{background:rgb(29, 29, 31) !important}.tile{background:rgb(0, 113, 227) !important;border-radius:18px}',
  );
  const started = await begin();
  assert.deepEqual(
    started,
    { cursors: 1, held: 48, clipped: true, colour: 'rgb(0, 113, 227)', scroll: 0 },
    'one cursor for the one change in view; the tiles are restyled and withheld until the view gets to them',
  );
  await touring();
  const most = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let most = 0;
        const timer = setInterval(() => {
          const root = (globalThis as any).__overlayRoot as ShadowRoot;
          most = Math.max(most, root.querySelectorAll('.swarm .sw-cur').length);
          if (!root.querySelector('.swarm')?.childElementCount) {
            clearInterval(timer);
            resolve(most);
          }
        }, 50);
      }),
  );
  assert(most >= 5, `rows of tiles are drawn by more cursors than the first change, got ${most}`);
  assert.equal(await page.evaluate(() => (globalThis as any).__replayed), true);
  const ended = await page.evaluate(() => {
    const seen = (globalThis as any).__seen as number[];
    const peak = seen.indexOf(Math.max(...seen));
    return {
      down: seen.slice(0, peak + 1).every((y, index) => !index || y >= seen[index - 1]),
      reached: seen[peak] > 1800,
      scroll: scrollY,
      players: document.getAnimations().length,
      clip: getComputedStyle(document.querySelector('.tile')!).clipPath,
    };
  });
  assert.deepEqual(ended, { down: true, reached: true, scroll: 0, players: 0, clip: 'none' });
  await swarmDone(page);

  // A capture on the way shows the page as edited, where it was.
  assert.equal(await bridge(page, 'watchScript'), true);
  await restyle('.tile{background:rgb(52, 199, 89) !important}');
  assert.equal((await begin()).held, 48);
  await touring();
  await bridge(page, 'mask', true);
  assert.deepEqual(
    await page.evaluate(() => [
      scrollY,
      document.getAnimations().length,
      (globalThis as any).__overlayRoot.querySelector('.swarm')?.childElementCount ?? 0,
    ]),
    [0, 0, 0],
  );
  await bridge(page, 'mask', false);
  assert.equal(await page.evaluate(() => (globalThis as any).__replayed), true);
  await swarmDone(page);

  // Someone who scrolls on the way keeps the page where they took it.
  assert.equal(await bridge(page, 'watchScript'), true);
  await restyle('.tile{background:rgb(255, 149, 0) !important}');
  assert.equal((await begin()).held, 48);
  await touring();
  await page.mouse.move(600, 500);
  await page.mouse.wheel(0, 80);
  await page.waitForFunction(
    () => !(globalThis as any).__overlayRoot.querySelector('.swarm')?.childElementCount,
  );
  assert.deepEqual(await page.evaluate(() => [scrollY > 600, document.getAnimations().length]), [
    true,
    0,
  ]);
  assert.equal(await page.evaluate(() => (globalThis as any).__replayed), true);
  await swarmDone(page);

  // From the middle of the page: content that grows above the view moves the scroll position
  // with it, not the view. The view is drawn first, then the page from its top, and it ends
  // where it was.
  const from = await page.evaluate(() => {
    scrollTo(0, document.querySelectorAll('.tiles')[2].getBoundingClientRect().top + scrollY);
    return scrollY;
  });
  await page.waitForTimeout(100);
  assert.equal(await bridge(page, 'watchScript'), true);
  await restyle('#box{height:300px !important}.tile{background:rgb(175, 82, 222) !important}');
  // The page reports its new scroll position before the replay is asked for.
  await page.waitForTimeout(100);
  const middle = await begin();
  assert.deepEqual([middle.scroll, middle.cursors > 4], [from + 240, true]);
  assert.equal(await page.evaluate(() => (globalThis as any).__replayed), true);
  await swarmDone(page);
  assert.deepEqual(
    await page.evaluate(() => {
      const seen = (globalThis as any).__seen as number[];
      const first = document.querySelector('.tile')!.getBoundingClientRect().top + scrollY;
      return [
        Math.min(...seen) < first,
        Math.max(...seen) > scrollY,
        document.getAnimations().length,
      ];
    }),
    [true, true, 0],
    'the rows above the view are drawn before the rows below it',
  );
  assert.equal(await page.evaluate(() => scrollY), middle.scroll);
  await swarmDone(page);
});

test('lightweight script feedback follows CSSOM changes and ignores reads and writes with no visual effect', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page } = await fixture(t);
  await captureOverlayRoot(page);
  await bridge(page, 'setSource', 'agent');
  assert.equal(await bridge(page, 'watchScript', true), true);
  await page.evaluate(() => {
    document.styleSheets[0].insertRule('#heading{background-color:rgb(119, 140, 167)}');
  });
  assert.equal(await bridge(page, 'replayScript', true, true), 'targets');
  assert.equal(await page.locator('h1').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(119, 140, 167)');
  assert.ok((await readSwarm(page)).cursors > 0);
  await bridge(page, 'stopPresentation');
  assert.equal((await readSwarm(page)).nodes, 0);

  await bridge(page, 'watchScript', true);
  await page.evaluate(() => {
    document.body.dataset.audit = 'read';
    document.querySelector('h1')!.firstChild!.nodeValue = '普通标题';
  });
  assert.equal(await bridge(page, 'replayScript'), false);
  assert.equal((await readSwarm(page)).nodes, 0);

  await bridge(page, 'watchScript', true);
  await page.evaluate(() => { document.querySelector('h1')!.textContent = 'Committed'; });
  assert.equal(await bridge(page, 'replayScript'), true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await swarmDone(page);
  assert.equal(await page.locator('h1').textContent(), 'Committed');
});

test('scripts that change nothing in view, reduced motion, captures and someone using the page leave it as the script made it', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page } = await fixture(t);
  await captureOverlayRoot(page);
  await bridge(page, 'setSource', 'agent');
  const paint = (color: string) =>
    page.locator('#box').evaluate((el, color) => {
      (el as HTMLElement).style.background = color;
    }, color);
  const kept = async () => (await readCover(page)).kept;

  assert.equal(await bridge(page, 'watchScript'), true);
  await page.evaluate(() => {
    document.body.dataset.touched = '1';
    return document.title;
  });
  assert.equal(await bridge(page, 'replayScript'), false, 'nothing to see, nothing to wait for');
  assert.equal((await readSwarm(page)).nodes, 0);
  assert.deepEqual(await readCover(page), { kept: 0, sheets: 0, named: 'none' });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await bridge(page, 'watchScript'), false);
  await paint('#123');
  assert.equal(await bridge(page, 'replayScript'), false);
  assert.equal(await kept(), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // A capture between the script and its replay shows the page as edited and ends the show.
  assert.equal(await bridge(page, 'watchScript'), true);
  await paint('#456');
  assert.equal(await kept(), 1);
  await bridge(page, 'mask', true);
  assert.equal(await kept(), 0);
  await bridge(page, 'mask', false);
  assert.equal(await bridge(page, 'replayScript'), false);

  // A replay that is not to be shown only uncovers the page.
  assert.equal(await bridge(page, 'watchScript'), true);
  await paint('#234');
  assert.equal(await bridge(page, 'replayScript', false), false);
  assert.equal((await readSwarm(page)).nodes, 0);
  assert.equal(await kept(), 0);

  // A script that never reports back is not waited for by the next one, and what it leaves
  // behind is not played for someone who has taken over.
  assert.equal(await bridge(page, 'watchScript'), true);
  await paint('#789');
  assert.equal(await bridge(page, 'watchScript'), true);
  assert.deepEqual(await readCover(page), {
    kept: 1,
    sheets: 1,
    named: 'athena-swarm-page-cursors',
  });
  await bridge(page, 'setSource', 'human');
  assert.equal(await bridge(page, 'replayScript'), false);
  assert.equal((await readSwarm(page)).nodes, 0);
  assert.equal(await kept(), 0);
  await bridge(page, 'setSource', 'agent');

  // Someone using the page sees and reaches it as it is, before the show and during it.
  assert.equal(await bridge(page, 'watchScript'), true);
  await paint('#345');
  await page.locator('#complex').click();
  assert.equal(await page.evaluate(() => (globalThis as any).clicked), 1);
  assert.equal(await kept(), 0);
  assert.equal(await bridge(page, 'replayScript'), false);

  assert.equal(await bridge(page, 'watchScript'), true);
  await paint('#567');
  const cursors = await page.evaluate(() => {
    (globalThis as any).__replayed = (globalThis as any).__workbenchPage.replayScript();
    return (globalThis as any).__overlayRoot.querySelectorAll('.swarm .sw-cur').length;
  });
  assert.equal(cursors, 1);
  await page.keyboard.press('Shift');
  assert.equal((await readSwarm(page)).nodes, 0);
  assert.equal(await kept(), 0);
  assert.equal(await page.evaluate(() => (globalThis as any).__replayed), true);
  await swarmDone(page);

  // A script that does not return must not leave the view covered.
  assert.equal(await bridge(page, 'watchScript'), true);
  assert.equal(await kept(), 1);
  await page.waitForFunction(() => !document.adoptedStyleSheets.length, undefined, {
    timeout: 5000,
  });
  assert.equal(await kept(), 0);
  assert.equal(await bridge(page, 'replayScript'), false);
});

test(
  'scroll debounce flushes the old participant at a control handoff',
  { skip: !executable },
  async (t) => {
    const f = await fixture(t);
    await f.page.evaluate(() => {
      document.body.style.height = '5000px';
    });
    await bridge(f.page, 'setActor', 'alice');
    await f.page.evaluate(() => scrollTo(0, 100));
    await f.page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    await bridge(f.page, 'setActor', 'bob');
    await f.page.evaluate(() => scrollTo(0, 250));
    await eventually(() => f.events.filter((e) => e.kind === 'scroll').length === 2);
    const scrolls = f.events.filter((e) => e.kind === 'scroll') as Array<
      PageEvent & { actorId: string }
    >;
    assert.deepEqual(
      scrolls.map((e) => e.actorId),
      ['alice', 'bob'],
    );
    assert.deepEqual(
      scrolls.map((e) => JSON.parse(e.value!).y),
      [100, 250],
    );
  },
);

test(
  'structural previews create nested elements with fresh refs, support subsequent edits and undo in dependency order',
  { skip: !executable },
  async (t) => {
    const { page, find, events } = await fixture(t);
    const anchor = await find('#box');
    const insertion = {
      position: 'after',
      node: {
        tag: 'section',
        attributes: { id: 'preview-section', 'aria-label': 'Test section' },
        styles: { padding: '16px', 'background-color': '#eeeeee' },
        children: [
          { tag: 'h2', text: 'New section' },
          { tag: 'a', text: 'View details', attributes: { href: 'https://example.com/details' } },
          { tag: 'button', text: 'Preview button' },
        ],
      },
    };
    const added = await bridge<EditResult>(page, 'edit', { ref: anchor.ref, insert: insertion });
    assert.equal(added.element.tag, 'section');
    assert.notEqual(added.element.ref, anchor.ref);
    assert.equal((await find('#preview-section')).ref, added.element.ref);
    assert.equal(await page.locator('#preview-section button').getAttribute('type'), 'button');
    assert.equal(
      await page.locator('#preview-section a').getAttribute('href'),
      'https://example.com/details',
    );
    const changed = await bridge<EditResult>(page, 'edit', {
      ref: added.element.ref,
      styles: { 'background-color': '#ff0000' },
    });
    await assert.rejects(bridge(page, 'undo', added.editId), /changed|newer/i);
    await bridge(page, 'undo', changed.editId);
    await bridge(page, 'undo', added.editId);
    assert.equal(await page.locator('#preview-section').count(), 0);
    assert.equal(await page.locator('#box').textContent(), '普通容器');
    await eventually(() =>
      events.some((event) => event.kind === 'edit' && JSON.parse(event.value || '{}').insert),
    );
  },
);

test(
  'structural previews reject executable, sensitive, duplicate and oversized nodes before changing the page',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const anchor = await find('#box');
    const before = await page.locator('#box').innerHTML();
    for (const node of [
      { tag: 'script', text: 'alert(1)' },
      { tag: 'img', attributes: { onerror: 'alert(1)' } },
      { tag: 'a', attributes: { href: 'javascript:alert(1)' } },
      { tag: 'a', attributes: { href: 'https://user:password@example.com' } },
      { tag: 'input', attributes: { type: 'password' } },
      { tag: 'input', attributes: { id: 'account-email' } },
      { tag: 'div', attributes: { id: 'heading' } },
      { tag: 'div', styles: { background: 'url(https://example.com/track)' } },
      { tag: 'input', children: [{ tag: 'span', text: 'hidden child' }] },
      {
        tag: 'div',
        children: Array.from({ length: 80 }, () => ({ tag: 'span', text: 'too many' })),
      },
    ]) {
      await assert.rejects(bridge(page, 'edit', { ref: anchor.ref, insert: { node } }));
      assert.equal(await page.locator('#box').innerHTML(), before);
    }
    const sensitive = await find('#password-input');
    await assert.rejects(
      bridge(page, 'edit', { ref: sensitive.ref, insert: { node: { tag: 'span', text: 'no' } } }),
    );
  },
);

test(
  'undoing created content preserves newer input and nodes replaced by the page',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const anchor = await find('#box');
    const input = await bridge<EditResult>(page, 'edit', {
      ref: anchor.ref,
      insert: {
        node: {
          tag: 'input',
          attributes: { id: 'preview-search', type: 'search', placeholder: 'Search items' },
        },
      },
    });
    assert.equal(
      await page.locator('#preview-search').evaluate((el: HTMLInputElement) => el.form),
      null,
    );
    await page.locator('#preview-search').fill('unsaved input');
    await assert.rejects(bridge(page, 'undo', input.editId), /newer changes/);
    assert.equal(await page.locator('#preview-search').inputValue(), 'unsaved input');
    await page.locator('#preview-search').fill('');
    await bridge(page, 'undo', input.editId);
    const section = await bridge<EditResult>(page, 'edit', {
      ref: anchor.ref,
      insert: {
        node: {
          tag: 'section',
          attributes: { id: 'preview-owned' },
          children: [{ tag: 'span', text: 'same content' }],
        },
      },
    });
    await page
      .locator('#preview-owned span')
      .evaluate((node) => node.replaceWith(node.cloneNode(true)));
    await assert.rejects(bridge(page, 'undo', section.editId), /newer changes/);
    assert.equal(await page.locator('#preview-owned').count(), 1);
  },
);

test(
  'created elements inside an open Shadow DOM retain their frame-local identity and undo',
  { skip: !executable },
  async (t) => {
    const { page, find } = await fixture(t);
    const anchor = await find('#deep-leaf');
    const result = await bridge<EditResult>(page, 'edit', {
      ref: anchor.ref,
      insert: {
        position: 'after',
        node: { tag: 'span', text: 'Shadow addition', attributes: { id: 'preview-shadow' } },
      },
    });
    assert.equal((await find('#preview-shadow')).ref, result.element.ref);
    assert.ok(result.element.shadowPath.length);
    await bridge(page, 'undo', result.editId);
    assert.equal(await page.locator('#preview-shadow').count(), 0);
  },
);

interface RestyleResult {
  applied: boolean;
  reason?: string;
  editId?: string;
  element?: ElementInfo;
  rules?: number;
  matched?: number;
  unmatched?: string[];
  unchanged?: string[];
  dropped?: string[];
  texts?: Array<{
    selector: string;
    matched: number;
    changed: number;
    skipped?: number;
    hint?: string;
  }>;
}
const readLook = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('#box')!;
    return {
      body: getComputedStyle(document.body).backgroundColor,
      box: getComputedStyle(box).backgroundColor,
      radius: getComputedStyle(box).borderTopLeftRadius,
      heading: document.querySelector('#heading')!.textContent,
      label: document.querySelector('#button-label')!.textContent,
      inline: box.getAttribute('style'),
      styles: document.querySelectorAll('style').length,
      sheets: document.adoptedStyleSheets.length,
    };
  });

test(
  'a page restyle applies one sheet and its text replacements, reports what it reached, and one undo takes all of it back',
  { skip: !executable },
  async (t) => {
    const { page, events } = await fixture(t);
    const original = await readLook(page);
    await page.evaluate(() => {
      (globalThis as any).headingNode = document.querySelector('#heading')!.firstChild;
    });
    const result = await bridge<RestyleResult>(page, 'restyle', {
      css:
        'body{background:rgb(0,0,0);color:rgb(245,245,247)}' +
        '#box{background:rgb(29,29,31);border-radius:18px}' +
        '#heading:hover{color:rgb(41,151,255)}' +
        '.missing{color:red}' +
        '#box{}' +
        '#leaf{color:rgb(10,20,30)}',
      texts: [
        { selector: '#heading', text: '新标题' },
        { selector: '#button-label', text: '提交' },
        { selector: '#complex', text: '不会写入' },
      ],
    });
    assert.equal(result.applied, true);
    assert.equal(result.rules, 6);
    assert.equal(result.matched, 4, 'body, the box, the heading behind :hover and the leaf');
    assert.deepEqual(result.unmatched, ['.missing']);
    assert.deepEqual(result.dropped, ['#box']);
    assert.deepEqual(result.unchanged, ['#leaf'], 'an inline style keeps winning over the sheet');
    assert.deepEqual(result.texts, [
      { selector: '#heading', matched: 1, changed: 1 },
      { selector: '#button-label', matched: 1, changed: 1 },
      {
        selector: '#complex',
        matched: 1,
        changed: 0,
        skipped: 1,
        hint: 'Target the element that directly holds the text',
      },
    ]);
    assert.equal(result.element?.tag, 'html');
    assert.deepEqual(await readLook(page), {
      ...original,
      body: 'rgb(0, 0, 0)',
      box: 'rgb(29, 29, 31)',
      radius: '18px',
      heading: '新标题',
      label: '提交',
      sheets: 1,
    });
    assert.equal(
      await page.evaluate(
        () => document.querySelector('#heading')!.firstChild === (globalThis as any).headingNode,
      ),
      true,
      'the text node of the page is written to, not replaced',
    );
    assert.equal((await readCover(page)).kept, 0, 'nothing is played for a manual restyle');
    await eventually(() => events.some((event) => event.editId === result.editId));
    const recorded = events.find((event) => event.editId === result.editId)!;
    assert.equal(recorded.kind, 'edit');
    assert.equal(JSON.parse(recorded.value!).texts.length, 3);
    assert.match(JSON.parse(recorded.value!).sheet, /border-radius:18px/);

    const undone = await bridge<{ editId: string; page: boolean; keptTexts?: number }>(
      page,
      'undo',
      result.editId,
    );
    assert.equal(undone.page, true);
    assert.equal(undone.keptTexts, undefined);
    assert.deepEqual(await readLook(page), original);
    await assert.rejects(bridge(page, 'undo', result.editId), /No active edit/);

    // Text the page rewrote after the preview is newer than the preview and survives its undo.
    const second = await bridge<RestyleResult>(page, 'restyle', {
      texts: [
        { selector: '#heading', text: '预览标题' },
        { selector: '#button-label', text: '预览按钮' },
      ],
    });
    await page.evaluate(() => {
      document.querySelector('#heading')!.firstChild!.nodeValue = '页面自己的更新';
    });
    const kept = await bridge<{ keptTexts?: number }>(page, 'undo', second.editId);
    assert.equal(kept.keptTexts, 1);
    assert.deepEqual(await readLook(page), { ...original, heading: '页面自己的更新' });
  },
);

test(
  'a page restyle that could load a resource, reaches nothing or is malformed is refused whole and leaves the page alone',
  { skip: !executable },
  async (t) => {
    const { page, events } = await fixture(t);
    const original = await readLook(page);
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ css: '#box{background:url(https://example.com/a.png)}' }, /External resources/],
      [{ css: '#box{background:u\\72l("https://example.com/a.png")}' }, /External resources/],
      [
        { css: '#box{background-image:image-set("https://example.com/a.png" 1x)}' },
        /External resources/,
      ],
      [
        {
          css: '@font-face{font-family:x;src:url(https://example.com/f.woff2)}body{font-family:x}',
        },
        /Unsupported at-rule/,
      ],
      [
        { css: ':root{--bg:u\\72l(https://example.com/a.png)}#box{background:var(--bg)}' },
        /Custom properties/,
      ],
      [{ css: '.nope{color:red}' }, /Nothing on the page matches/],
      [{ css: '@import url("https://example.com/a.css");' }, /No style rule/],
      [{ texts: [{ selector: '#private-area', text: '公开' }] }, /Nothing on the page matches/],
      [{ texts: [{ selector: '#heading[', text: '标题' }] }, /Invalid selector/],
      [{ css: 'body{color:red}', script: 'alert(1)' }, /Only css and texts/],
      [{ css: 'body{color:red}', texts: [{ selector: '#heading' }] }, /selector and a text/],
    ];
    for (const [request, reason] of refused) {
      const result = await bridge<RestyleResult>(page, 'restyle', request);
      assert.equal(result.applied, false, JSON.stringify(request));
      assert.match(result.reason!, reason, JSON.stringify(request));
      assert.equal(result.editId, undefined);
    }
    const missed = await bridge<RestyleResult>(page, 'restyle', {
      css: '.nope{color:red}#box{}',
      texts: [{ selector: '#password-input', text: '公开' }],
    });
    assert.deepEqual(missed.unmatched, ['.nope']);
    assert.deepEqual(missed.dropped, ['#box']);
    assert.equal(missed.texts![0].skipped, 1);
    assert.deepEqual(await readLook(page), original);
    assert.equal(
      await page.locator('#private-area').inputValue(),
      'private-textarea-content',
      'sensitive fields are never written to',
    );
    assert.equal(events.filter((event) => event.kind === 'edit').length, 0);

    // Inline images and the at-rules that only group style rules are fine.
    const allowed = await bridge<RestyleResult>(page, 'restyle', {
      css:
        '@media (min-width:1px){#box{background-image:url("data:image/png;base64,iVBORw0KGgo=");border-radius:9px}}' +
        '@keyframes pulse{from{opacity:.9}to{opacity:1}}',
    });
    assert.equal(allowed.applied, true);
    assert.equal(allowed.matched, 1);
    assert.equal((await readLook(page)).radius, '9px');
    await bridge(page, 'undo', allowed.editId);
    assert.deepEqual(await readLook(page), original);
  },
);

test('a page restyle by the agent answers at once with the page already restyled while cursors uncover it, and so does its undo', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page } = await fixture(t);
  await captureOverlayRoot(page);
  const original = await readLook(page);
  await bridge(page, 'setSource', 'agent');
  const answered = await page.evaluate(async () => {
    const result = await (globalThis as any).__workbenchPage.restyle({
      css:
        'body{background:rgb(0,0,0);color:rgb(245,245,247)}' +
        '#box{background:rgb(29,29,31);border-radius:18px;width:420px}' +
        '#complex{background:rgb(0,113,227);border-radius:980px;color:rgb(255,255,255)}',
      texts: [{ selector: '#heading', text: '新标题' }],
    });
    return {
      applied: result.applied,
      matched: result.matched,
      unchanged: result.unchanged,
      box: getComputedStyle(document.querySelector('#box')!).backgroundColor,
      heading: document.querySelector('#heading')!.textContent,
      cursors: (globalThis as any).__overlayRoot.querySelectorAll('.swarm .sw-cur').length,
    };
  });
  assert.equal(answered.applied, true);
  assert.equal(answered.matched, 3);
  assert.deepEqual(answered.unchanged, []);
  assert.equal(answered.box, 'rgb(29, 29, 31)', 'the page holds the result when the tool answers');
  assert.equal(answered.heading, '新标题');
  assert.ok(answered.cursors > 0, 'the cursors are still at work when the tool answers');
  assert.equal((await readCover(page)).kept, 1, 'the old look is still held on screen');
  await swarmDone(page);
  await page.waitForFunction(
    () =>
      !document
        .getAnimations()
        .some(
          (item) =>
            (item.effect as KeyframeEffect | null)?.pseudoElement ===
            '::view-transition-old(athena-swarm-page)',
        ),
  );
  assert.deepEqual(await readCover(page), { kept: 0, sheets: 1, named: 'none' });

  const undone = await page.evaluate(async () => {
    const result = await (globalThis as any).__workbenchPage.undo();
    return {
      page: result.page,
      box: getComputedStyle(document.querySelector('#box')!).backgroundColor,
      cursors: (globalThis as any).__overlayRoot.querySelectorAll('.swarm .sw-cur').length,
    };
  });
  assert.equal(undone.page, true);
  assert.equal(undone.box, original.box);
  assert.ok(undone.cursors > 0, 'taking the restyle back is played the same way');
  await swarmDone(page);
  assert.deepEqual(await readLook(page), original);
});

test(
  'the page outline names what is on the page compactly, within its budget and without private or foreign content',
  { skip: !executable },
  async (t) => {
    const { page } = await fixture(t);
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent =
        ':root{--brand:#123456;--gap:8px}.card{display:flex;padding:8px;border-radius:12px;background:rgb(255,255,255);box-shadow:0 1px 2px rgba(0,0,0,.2)}';
      document.head.appendChild(style);
      const list = document.createElement('ul');
      list.id = 'cards';
      for (let index = 0; index < 10; index++) {
        const item = document.createElement('li');
        item.className = 'card';
        item.textContent = '卡片 ' + index;
        list.appendChild(item);
      }
      document.body.appendChild(list);
    });
    const outline = await bridge<string>(page, 'digest');
    const lines = outline.split('\n');
    assert.match(lines[0], /^viewport 1200x1000, document height \d+, scrolled to 0$/);
    assert.match(lines[1], /^html \{bg:none; color:#000000; font:16px\/400; family:/);
    assert.equal(lines[2], ':root variables: --brand: #123456; --gap: 8px');
    assert.match(lines[3], /^body \[\d+x\d+\] \{.*pad:20px/);
    assert.ok(lines.includes('  h1#heading "普通标题" {font:32px/700}'), outline);
    assert.ok(
      lines.some((line) => /^ {2}div#box "普通容器" \{bg:#eeeeee; pad:20px\}$/.test(line)),
      outline,
    );
    assert.ok(
      lines.includes('    li.card "卡片 0" {bg:#ffffff; radius:12px; shadow; pad:8px; flex}'),
      outline,
    );
    assert.ok(lines.includes('    × 9 more like li.card'), outline);
    for (const hidden of [
      'unusual-sensitive-value',
      'private-textarea-content',
      '子页面',
      'Shadow 文本',
      'data-workbench-overlay',
    ])
      assert.ok(!outline.includes(hidden), hidden);
    assert.ok(outline.length <= 6000);

    await page.evaluate(() => {
      // Five levels of four children each, every one with its own class.
      let level: Element[] = [document.body];
      for (let depth = 0; depth < 5; depth++) {
        const next: Element[] = [];
        for (const parent of level)
          for (let index = 0; index < 4; index++) {
            const el = document.createElement('div');
            el.className = 'level-' + depth + '-' + index;
            if (depth === 4) el.textContent = '叶子 ' + index;
            parent.appendChild(el);
            next.push(el);
          }
        level = next;
      }
    });
    const tight = await bridge<string>(page, 'digest', 1500);
    assert.ok(tight.length <= 1502, String(tight.length));
    assert.match(tight, /… \d+ children|… \+\d+ more/);
    assert.match(tight, /^viewport 1200x1000/);
  },
);

test(
  'two named siblings move together on the real start page; the form retains its row, the exact sheet can be undone, and replaced nodes lose it',
  { skip: !executable },
  async (t) => {
    const { page } = await fixture(t);
    const { readFile } = await import('node:fs/promises');
    const html = await readFile('resources/demo.html', 'utf8');
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const heading = (await bridge<QueryResult>(page, 'query', { selector: '#headline' }))
      .elements[0];
    const subtitle = (await bridge<QueryResult>(page, 'query', { selector: '.intro' })).elements[0];
    const positions = () =>
      page.evaluate(() =>
        ['#headline', '.intro', '.try'].map((s) => {
          const r = document.querySelector(s)!.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
        }),
      );
    const before = await positions();
    const start = performance.now();
    const result = await bridge<{ applied: boolean; editId: string; reason?: string }>(
      page,
      'layoutPair',
      { ref: heading.ref, direction: 'row' },
    );
    console.log('verified local layout round trip ms:', Math.round(performance.now() - start));
    assert.equal(result.applied, true, result.reason ?? 'layout was not applied');
    assert.equal(await bridge(page, 'layoutPairActive', result.editId), true);
    assert.deepEqual(await bridge(page, 'layoutPair', { ref: heading.ref, direction: 'row' }), {
      applied: false,
      already: true,
      direction: 'row',
    });
    const [h, p, form] = await positions();
    assert(h.right <= p.left + 1 && Math.min(h.bottom, p.bottom) > Math.max(h.top, p.top));
    assert(
      form.top >= Math.max(h.bottom, p.bottom) - 1 && Math.abs(form.width - before[2].width) <= 1,
    );
    const vertical = await bridge<EditResult>(page, 'layoutPair', {
      ref: subtitle.ref,
      otherRef: heading.ref,
      direction: 'column',
    });
    assert(vertical.editId, JSON.stringify(vertical));
    assert((await positions())[0].bottom <= (await positions())[1].top + 1);
    await bridge(page, 'undo', vertical.editId);
    assert.equal((await positions())[0].right, h.right);
    await bridge(page, 'undo', result.editId);
    assert.deepEqual(await positions(), before);
    const again = await bridge<EditResult>(page, 'layoutPair', {
      ref: heading.ref,
      direction: 'row',
    });
    assert(again.editId);
    await page.evaluate(() => {
      const s = document.querySelector('.intro')!;
      s.replaceWith(s.cloneNode(true));
    });
    assert.equal(await bridge(page, 'layoutPairActive', again.editId), false);
    assert.deepEqual(await positions(), before);
    await assert.rejects(bridge(page, 'undo', again.editId), /No active edit/);
    for (const width of [360, 620]) {
      await page.setViewportSize({ width, height: 780 });
      const original = await positions();
      const fitted = await bridge<EditResult>(page, 'layoutPair', {
        ref: heading.ref,
        direction: 'row',
      });
      assert.ok(fitted.editId, `width ${width}: ${JSON.stringify(fitted)}`);
      const [title, sub, form] = await positions();
      assert(
        title.right <= sub.left + 1 &&
          Math.min(title.bottom, sub.bottom) > Math.max(title.top, sub.top),
      );
      assert(
        form.top >= Math.max(title.bottom, sub.bottom) - 1 &&
          Math.abs(form.width - original[2].width) <= 1,
      );
      await bridge(page, 'undo', fitted.editId);
    }
  },
);

test(
  'ambiguous, private, nonadjacent and overflowing layout pairs are refused without changing the DOM or keeping a sheet',
  { skip: !executable },
  async (t) => {
    const { page } = await fixture(t);
    const show = async (body: string) => {
      await page.goto(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent('<main style="width:320px"><h2>标题</h2>' + body + '</main>'),
      );
      return (await bridge<QueryResult>(page, 'query', { selector: 'h2' })).elements[0];
    };
    for (const body of [
      '<p>甲</p><p>乙</p>',
      '<p class="intro" data-private>私有</p>',
      '<button>其它</button><p class="intro">副标题</p>',
      '<p class="intro" style="width:500px;white-space:nowrap">超出父容器宽度的固定尺寸副标题</p>',
    ]) {
      const heading = await show(body);
      const before = await page.locator('main').innerHTML();
      assert.equal(
        (
          await bridge<{ applied: boolean }>(page, 'layoutPair', {
            ref: heading.ref,
            direction: 'row',
          })
        ).applied,
        false,
      );
      assert.equal(await page.locator('main').innerHTML(), before);
      assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 0);
    }
  },
);

test(
  'a local row preview refuses newly clipped text in either the parent or a target',
  { skip: !executable },
  async (t) => {
    const { page } = await fixture(t);
    for (const [owner, overflow] of [
      ['main', 'hidden'],
      ['h2', 'clip'],
    ]) {
      const css =
        'main{width:400px} h2,p{font:16px/20px Arial;margin:0} ' +
        owner +
        '{height:' +
        (owner === 'main' ? 60 : 40) +
        'px;overflow-y:' +
        overflow +
        '}';
      await page.goto(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            '<style>' +
              css +
              '</style><main><h2>' +
              'word '.repeat(20) +
              '</h2><p class="intro">Subtitle</p></main>',
          ),
      );
      const heading = (await bridge<QueryResult>(page, 'query', { selector: 'h2' })).elements[0];
      const clipped = () => page.locator(owner).evaluate((el) => el.scrollHeight - el.clientHeight);
      assert.equal(await clipped(), 0);
      const result = await bridge<{ applied: boolean; reason?: string }>(page, 'layoutPair', {
        ref: heading.ref,
        direction: 'row',
      });
      assert.equal(result.applied, false, owner + ' unexpectedly applied');
      assert.equal(result.reason, 'geometry_not_verified');
      assert.equal(await clipped(), 0);
      assert.equal(await page.evaluate(() => document.adoptedStyleSheets.length), 0);
    }
  },
);
