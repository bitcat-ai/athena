import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserRuntime } from '../src/main/browser';
import type { BrowserFrame } from '../src/shared/types';

const binary = process.env.ATHENA_TEST_CHROME;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A page that never stops painting, with one heading and two look-alike buttons. */
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-direct-edit-'));
  const site = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html;charset=utf-8');
    response.end(
      `<!doctype html><title>Shop</title><style>@keyframes slide{to{transform:translateX(300px)}}.dot{width:40px;height:40px;background:#c33;animation:slide 1s linear infinite alternate}</style><body><h1 class="hero">Old title</h1><button class="cta">Buy</button><button class="cta">Sell</button><div class="dot"></div></body>`,
    );
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const frames: BrowserFrame[] = [];
  const runtime = new BrowserRuntime({
    storageDir: directory,
    binaryPath: binary,
    onState() {},
    onFrame: (frame) => frames.push(frame),
    onStep() {},
    onSelected() {},
    onHumanTakeover() {},
  });
  await runtime.start(`http://127.0.0.1:${(site.address() as { port: number }).port}/`);
  return {
    runtime,
    frames,
    async close() {
      await runtime.dispose();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test(
  'real Chrome: a page is read when it loads, and an element is edited by selector in one call',
  { skip: !binary, timeout: 40_000 },
  async () => {
    const f = await fixture();
    try {
      const id = f.runtime.getState().activeTabId!;
      // Nothing asks for the outline; the page settling is enough.
      await pause(1500);
      const ahead = (f.runtime as any).tabs.get(id).outline;
      assert(ahead?.text.includes('h1.hero'), 'the outline was read ahead of any request');
      const started = performance.now();
      const outline = await f.runtime.nativeOutline(id);
      const took = performance.now() - started;
      assert(outline?.includes('h1.hero'));
      assert(took < 400, `a turn does not wait for the page (${Math.round(took)} ms)`);

      f.runtime.allowAgentControl();
      const edited = await f.runtime.callTool('workbench_browser_edit', {
        selector: 'h1.hero',
        text: 'New title',
        styles: { color: 'rgb(200, 0, 0)' },
      });
      assert(!edited.isError, edited.text);
      const result = JSON.parse(edited.text);
      assert.equal(result.element.textContent, 'New title');
      assert(result.element.ref, 'the result carries a ref for the next change');

      const ambiguous = await f.runtime.callTool('workbench_browser_edit', {
        selector: '.cta',
        text: 'Changed',
      });
      assert(ambiguous.isError, 'two matches are never guessed between');
      assert.match(ambiguous.text, /2 个元素匹配/);
      assert.match(ambiguous.text, /ref=/);
      const texts = async () =>
        (await f.runtime.queryElements({ selector: '.cta' })).elements.map((item) => item.text);
      assert.deepEqual(await texts(), ['Buy', 'Sell'], 'a refused edit leaves the page alone');

      const byText = await f.runtime.callTool('workbench_browser_edit', {
        selector: '.cta',
        containing: 'Sell',
        text: 'Trade',
      });
      assert(!byText.isError, byText.text);
      const byOrder = await f.runtime.callTool('workbench_browser_edit', {
        selector: '.cta',
        nth: 1,
        text: 'Order',
      });
      assert(!byOrder.isError, byOrder.text);
      assert.deepEqual(await texts(), ['Order', 'Trade']);

      const missing = await f.runtime.callTool('workbench_browser_edit', {
        selector: '.absent',
        text: 'x',
      });
      assert(missing.isError);
      assert.match(missing.text, /没有元素匹配/);
      const inspected = await f.runtime.callTool('workbench_browser_inspect', {
        selector: 'h1.hero',
      });
      assert(!inspected.isError, inspected.text);
    } finally {
      await f.close();
    }
  },
);

test(
  'real Chrome: frames are not held to the idle rate while an agent action runs',
  { skip: !binary, timeout: 40_000 },
  async () => {
    const f = await fixture();
    try {
      await pause(1500);
      const count = async (during: () => Promise<unknown>) => {
        const before = f.frames.length;
        await during();
        return f.frames.length - before;
      };
      const idle = await count(() => pause(2000));
      f.runtime.allowAgentControl();
      const acting = await count(() => f.runtime.performNative(undefined, () => pause(2000)));
      console.log(`frames in 2 s: idle ${idle}, during an agent action ${acting}`);
      assert(idle <= 54, `idle frames stay paced (${idle})`);
      assert(acting >= idle * 1.4, `agent actions lift the pace (${idle} → ${acting})`);
    } finally {
      await f.close();
    }
  },
);

test(
  'real Chrome: a page offers what it holds, takes a look and gives it back, and knows what is pointed at',
  { skip: !binary, timeout: 40_000 },
  async () => {
    const f = await fixture();
    try {
      const id = f.runtime.getState().activeTabId!;
      await pause(1500);
      const offers = f.runtime.getState().tabs.find((tab) => tab.id === id)?.hints ?? [];
      assert.deepEqual(
        offers.map((hint) => hint.id),
        ['headline'],
        'a page with a heading and no form, table or article offers the heading',
      );

      const colour = async () =>
        (
          await (f.runtime as any).tabs
            .get(id)
            .page.call('Runtime.evaluate', {
              expression: `getComputedStyle(document.querySelector('h1')).fontFamily`,
              returnByValue: true,
            })
        ).result.value as string;
      const plain = await colour();
      const look = await f.runtime.remix('blueprint');
      assert.equal(look.preset, 'blueprint');
      assert.match(await colour(), /monospace|Menlo|Mono/i);
      assert.equal(f.runtime.getState().previewEdits?.length, 1, 'a look is one page preview');
      await f.runtime.remix('editorial');
      assert.equal(f.runtime.getState().previewEdits?.length, 1, 'looks replace one another');
      await f.runtime.remix(null);
      assert.equal(await colour(), plain);
      assert.equal(f.runtime.getState().previewEdits?.length ?? 0, 0);
      await assert.rejects(f.runtime.remix('nonsense'));

      const box = (
        await (f.runtime as any).tabs.get(id).page.call('Runtime.evaluate', {
          expression: `(()=>{const b=document.querySelectorAll('.cta')[1].getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()`,
          returnByValue: true,
        })
      ).result.value as { x: number; y: number };
      const pointed = await f.runtime.pointedElement(box.x, box.y, id);
      assert.equal(pointed?.tag, 'button');
      assert.equal(pointed?.text, 'Sell');
      f.runtime.allowAgentControl();
      const changed = await f.runtime.callTool('workbench_browser_edit', {
        ref: pointed!.ref,
        text: 'Pointed',
      });
      assert(!changed.isError, changed.text);
      assert.equal(await f.runtime.pointedElement(box.x, box.y, 'another-tab'), undefined);
    } finally {
      await f.close();
    }
  },
);
