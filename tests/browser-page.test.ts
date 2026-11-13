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

test('choreography stays out of manual edits and reduced motion, and a newer edit replaces the show on its element', async (t) => {
  if (!browser) return t.skip('Browser binary unavailable');
  const { page, find } = await fixture(t);
  await captureOverlayRoot(page);
  const box = await find('#box');
  const heading = await find('#heading');
  const players = () => page.locator('#box').evaluate((el) => el.getAnimations().length);
  await bridge(page, 'edit', { ref: box.ref, styles: { 'background-color': 'rgb(1, 2, 3)' } });
  let swarm = await readSwarm(page);
  assert.deepEqual([swarm.nodes, swarm.muted, await players()], [0, false, 0]);
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
