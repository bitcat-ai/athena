import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserRuntime } from '../src/main/browser';
import { selectedElementContext } from '../src/main/agent-session';

test(
  'selected context identifies the current layout and adjacent refs without repeating ancestor scope or exposing protected neighbours',
  {
    skip: !process.env.ATHENA_TEST_CHROME,
    timeout: 30_000,
  },
  async (t) => {
    const demo = await readFile('resources/demo.html', 'utf8');
    const site = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url === '/') res.end(demo);
      else if (req.url === '/private')
        res.end('<main><h1>Heading</h1><input data-private value="private-neighbour"></main>');
      else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + (site.address() as { port: number }).port;
    const storageDir = await mkdtemp(path.join(tmpdir(), 'athena-context-'));
    const browser = new BrowserRuntime({
      storageDir,
      binaryPath: process.env.ATHENA_TEST_CHROME,
      onFrame() {},
      onState() {},
      onStep() {},
      onSelected() {},
      onHumanTakeover() {},
    });
    t.after(async () => {
      await browser.dispose();
      site.close();
      await rm(storageDir, { recursive: true, force: true });
    });
    await browser.start(origin);
    const initial = (await browser.queryElements({ selector: '#headline' })).elements[0];
    const mention = await browser.getElementForMention(initial.ref);
    const full = await browser.getElementDetails(initial.ref);
    assert.equal(full.layout, undefined);
    const inspect = (ref: string) => browser.getElementDetails(ref, true);
    const text = (await selectedElementContext(mention, inspect))!;
    const snapshot = JSON.parse(text);
    assert.equal(snapshot.ref, full.ref);
    assert.deepEqual(snapshot.computed, full.computed);
    assert.deepEqual(snapshot.semantics, full.semantics);
    assert.equal(snapshot.textContent, full.textContent);
    assert.equal(snapshot.layout.parentDisplay, 'flex');
    assert.equal(snapshot.layout.parentDirection, 'column');
    assert.equal(snapshot.layout.childCount, 3);
    assert.equal(snapshot.layout.next.tag, 'p');
    assert(!Object.hasOwn(snapshot.ancestors[0], 'frameId'));
    assert.equal((await browser.getElementForMention(snapshot.layout.next.ref)).tag, 'p');
    assert(Buffer.byteLength(text) < Buffer.byteLength(JSON.stringify(full)) * 0.75);
    await browser.navigate(origin + '/private');
    await assert.rejects(selectedElementContext(mention, inspect));
    const replacement = (await browser.queryElements({ selector: 'h1' })).elements[0];
    const safe = (await selectedElementContext(replacement, inspect))!;
    assert(!safe.includes('private-neighbour'));
    assert.equal(JSON.parse(safe).layout.next, undefined);
  },
);
