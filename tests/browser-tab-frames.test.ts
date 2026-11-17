import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserRuntime } from '../src/main/browser';
import type { BrowserFrame } from '../src/shared/types';

const binary = process.env.ATHENA_TEST_CHROME;

/** Two tabs on a tall page and a short one; `scrolled` reports whether a scroll reaches the pane. */
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-tab-frames-'));
  const bands = Array.from(
    { length: 30 },
    (_, index) => `<div style="height:200px;background:hsl(${index * 37},70%,60%)">${index}</div>`,
  ).join('');
  const site = createServer((request, response) => {
    response.setHeader('content-type', 'text/html;charset=utf-8');
    response.end(
      `<!doctype html><title>${request.url}</title><body style="margin:0">${request.url === '/b' ? 'Other' : bands}</body>`,
    );
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
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
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  await runtime.start(`${origin}/a`);
  const tall = runtime.getState().activeTabId!;
  const other = (await runtime.newTab(`${origin}/b`)).id;
  return {
    runtime,
    tall,
    other,
    /** Scrolls the active page and waits for a picture of it that is newer than the scroll. */
    async scrolled(): Promise<boolean> {
      // Let the pictures that follow a tab change arrive first.
      await pause(600);
      const before = frames.length;
      const tabId = runtime.getState().activeTabId;
      await runtime.dispatchInput({ type: 'wheel', x: 200, y: 200, deltaX: 0, deltaY: 120 });
      for (let i = 0; i < 60; i++) {
        if (frames.slice(before).some((frame) => frame.data && frame.tabId === tabId)) return true;
        await pause(50);
      }
      return false;
    },
    async close() {
      await runtime.dispose();
      await new Promise<void>((resolve) => site.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test(
  'real Chrome: a page keeps updating after switching to another tab and back',
  { skip: !binary, timeout: 40_000 },
  async () => {
    const f = await fixture();
    try {
      await f.runtime.switchTab(f.tall);
      assert.equal(await f.scrolled(), true, 'A scroll after the switch must reach the pane');
    } finally {
      await f.close();
    }
  },
);

test(
  'real Chrome: a page keeps updating after a web task worked on another tab',
  { skip: !binary, timeout: 40_000 },
  async () => {
    const f = await fixture();
    try {
      await f.runtime.switchTab(f.tall);
      // A web task reads another page: its executor fronts that page inside the browser.
      const page = (f.runtime as any).tabs.get(f.other).page;
      await f.runtime.performNative(f.other, () => page.call('Page.bringToFront'), true);
      assert.equal(await f.scrolled(), true, 'A scroll after the web task must reach the pane');
    } finally {
      await f.close();
    }
  },
);
