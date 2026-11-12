import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runWebScript, webScriptProfile } from '../src/main/web-script';

// The script process is confined with Seatbelt, which only macOS has.
const options = { skip: process.platform !== 'darwin', timeout: 30000 };
const run = (
  code: string,
  call: (method: string, params: any) => Promise<unknown> = async () => 1,
) => runWebScript(code, { call, timeout: 10000 });

test('a script returns JSON, logs in order and can pause', options, async () => {
  const result = await run(`
    console.log('first', { a: 1 }, [1, 2]);
    console.warn('second');
    const started = Date.now();
    await sleep(30);
    const fired = await new Promise((resolve) => setTimeout(resolve, 10, 'fired'));
    const cleared = setTimeout(() => console.log('never'), 10);
    clearTimeout(cleared);
    await sleep(30);
    return { waited: Date.now() - started >= 30, fired, text: '中文', nested: [null, true] };
  `);
  assert.equal(result.ok, true, String(result.error));
  assert.deepEqual(JSON.parse(result.value!), {
    waited: true,
    fired: 'fired',
    text: '中文',
    nested: [null, true],
  });
  assert.deepEqual(result.logs, ['[log] first {"a":1} [1,2]', '[warn] second']);
  const empty = await run('const unused = 1;');
  assert.equal(empty.ok, true);
  assert.equal(empty.value, undefined);
});

test('every browser method reaches the host as one ordered call', options, async () => {
  const calls: Array<[string, any]> = [];
  const result = await run(
    `
    const page = await browser.open('https://example.com/a');
    const same = browser.page(page.id);
    await same.info();
    await page.goto('https://example.com/b');
    await page.back();
    await page.forward();
    await page.reload();
    await page.snapshot({ mode: 'interactive' });
    await page.diff();
    await page.read('main');
    await page.grep('total', { limit: 3 });
    await page.click('r1', { button: 'right' });
    await page.fill('r1', 'v');
    await page.hover('r1');
    await page.selectOption('r1', 'pro');
    await page.check('r1');
    await page.uncheck('r1');
    await page.focus('r1');
    await page.drag('r1', 'r2');
    await page.type('abc');
    await page.press('Enter');
    await page.insertText('xyz');
    await page.scroll('down', 300, 'r1');
    await page.clickAt(1, 2, { clickCount: 2 });
    await page.typeAt(1, 2, 't');
    await page.hoverAt(3, 4);
    await page.dragAt(1, 2, 3, 4);
    await page.dialogAccept('yes');
    await page.dialogDismiss();
    await page.waitForSelector('#a', { timeout: 500 });
    await page.waitForText('done');
    await page.waitForTime(20);
    await page.evaluateInPage((n) => n + 1, 2, { timeout: 900 });
    await page.screenshot({ fullPage: true });
    await page.pdf({ landscape: true });
    await page.download('r1');
    await page.upload('r1', '/tmp/a.txt');
    await page.upload(['/tmp/b.txt']);
    await browser.pages.list();
    await browser.tabGroups({ action: 'list' });
    await browser.tabGroups();
    await page.close();
    return page.id;
  `,
    async (method, params) => {
      calls.push([method, params]);
      return method === 'open' ? { pageId: 7 } : {};
    },
  );
  assert.equal(result.ok, true, String(result.error));
  assert.equal(result.value, '7');
  const act = (kind: string, extra: object = {}) => ['act', { page: 7, kind, ...extra }];
  assert.deepEqual(calls, [
    ['open', { url: 'https://example.com/a' }],
    ['info', { page: 7 }],
    ['navigate', { page: 7, action: 'url', url: 'https://example.com/b' }],
    ['navigate', { page: 7, action: 'back' }],
    ['navigate', { page: 7, action: 'forward' }],
    ['navigate', { page: 7, action: 'reload' }],
    ['snapshot', { page: 7, mode: 'interactive' }],
    ['diff', { page: 7 }],
    ['read', { page: 7, selector: 'main' }],
    ['grep', { page: 7, pattern: 'total', limit: 3 }],
    act('click', { ref: 'r1', button: 'right' }),
    act('fill', { ref: 'r1', value: 'v' }),
    act('hover', { ref: 'r1' }),
    act('select', { ref: 'r1', value: 'pro' }),
    act('check', { ref: 'r1' }),
    act('uncheck', { ref: 'r1' }),
    act('focus', { ref: 'r1' }),
    act('drag', { ref: 'r1', targetRef: 'r2' }),
    act('type', { text: 'abc' }),
    act('press', { key: 'Enter' }),
    act('insert_text', { text: 'xyz' }),
    act('scroll', { direction: 'down', amount: 300, ref: 'r1' }),
    act('click_at', { x: 1, y: 2, clickCount: 2 }),
    act('type_at', { x: 1, y: 2, text: 't' }),
    act('hover_at', { x: 3, y: 4 }),
    act('drag_at', { startX: 1, startY: 2, endX: 3, endY: 4 }),
    act('dialog_accept', { text: 'yes' }),
    act('dialog_dismiss'),
    ['wait', { page: 7, for: 'selector', value: '#a', timeout: 500 }],
    ['wait', { page: 7, for: 'text', value: 'done' }],
    ['wait', { page: 7, for: 'time', value: 20 }],
    ['evaluate', { page: 7, func: '(n) => n + 1', arg: 2, timeout: 900 }],
    ['screenshot', { page: 7, fullPage: true }],
    ['pdf', { page: 7, landscape: true }],
    ['download', { page: 7, ref: 'r1' }],
    ['upload', { page: 7, ref: 'r1', files: ['/tmp/a.txt'] }],
    ['upload', { page: 7, files: ['/tmp/b.txt'] }],
    ['pages', null],
    ['tab_groups', { action: 'list' }],
    ['tab_groups', {}],
    ['close', { page: 7 }],
  ]);
});

test(
  'calls issued together run one at a time and a host failure can be caught',
  options,
  async () => {
    let active = 0;
    let overlapped = false;
    const order: number[] = [];
    const result = await run(
      `
    const pages = [1, 2, 3].map((id) => browser.page(id));
    const values = await Promise.all(pages.map((page) => page.read()));
    let caught;
    try { await browser.page(9).read(); } catch (error) { caught = error.message; }
    return { values, caught };
  `,
      async (_method, params) => {
        if (params.page === 9) throw new Error('页面引用已变化');
        if (active++) overlapped = true;
        order.push(params.page);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return 'text ' + params.page;
      },
    );
    assert.equal(result.ok, true, String(result.error));
    assert.deepEqual(JSON.parse(result.value!), {
      values: ['text 1', 'text 2', 'text 3'],
      caught: '页面引用已变化',
    });
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(overlapped, false);
  },
);

test(
  'a script cannot reach the runner, the network, files or child processes',
  options,
  async () => {
    const directory = await mkdtemp(path.join(homedir(), '.athena-script-test-'));
    const secret = path.join(directory, 'secret.txt');
    await writeFile(secret, 'private file body');
    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = (listener.address() as { port: number }).port;
    try {
      const probe = await run(
        `
      const attempt = (label, run) => {
        try { return [label, 'value', String(run())]; } catch (error) { return [label, 'error', error.constructor.name]; }
      };
      return {
        globals: ['process', 'require', 'fetch', 'module', 'Buffer', 'XMLHttpRequest', 'WebSocket', 'setInterval', 'eval']
          .filter((name) => typeof globalThis[name] !== 'undefined'),
        attempts: [
          attempt('function', () => this.constructor.constructor('return process')()),
          attempt('async function', () => (async () => {}).constructor('return process')()),
          attempt('sdk function', () => browser.open.constructor('return process')()),
          attempt('console', () => console.log.constructor('return process')()),
          attempt('timer', () => setTimeout.constructor('return process')()),
          attempt('eval', () => (0, eval)('process')),
          attempt('frozen sdk', () => { 'use strict'; browser.open = 1; }),
          attempt('frozen page', () => { 'use strict'; browser.page(1).id = 2; }),
        ],
        thrown: await browser.page(1).read().then(() => 'no', (error) => Object.getPrototypeOf(error) === Error.prototype),
        stack: (() => { try { (function grow() { grow(); })(); } catch (error) { return error instanceof RangeError; } })(),
      };
    `,
        async () => {
          throw new Error('host failure');
        },
      );
      assert.equal(probe.ok, true, String(probe.error));
      const seen = JSON.parse(probe.value!);
      assert.deepEqual(seen.globals, ['eval']);
      for (const [label, kind, detail] of seen.attempts)
        assert.equal(kind, 'error', `${label} returned ${detail}`);
      assert.equal(seen.thrown, true, 'a host failure arrives as an error of the script realm');
      assert.equal(seen.stack, true);

      // Even code that did reach the runner's globals would find a confined process.
      const code = `
      const out = {};
      const attempt = (label, run) => { try { out[label] = 'ok ' + String(run()).slice(0, 40); } catch (error) { out[label] = 'denied'; } };
      attempt('read', () => require('node:fs').readFileSync(${JSON.stringify(secret)}, 'utf8'));
      attempt('write', () => require('node:fs').writeFileSync('escape.txt', 'x'));
      attempt('spawn', () => require('node:child_process').execFileSync('/bin/echo', ['hi']));
      attempt('env', () => Object.keys(process.env).filter((key) => key !== 'ELECTRON_RUN_AS_NODE' && !key.startsWith('__')).join(','));
      const done = (network) => { out.network = network; console.log(JSON.stringify(out)); process.exit(0); };
      require('node:net').connect(${port}, '127.0.0.1').on('error', () => done('denied')).on('connect', () => done('ok'));
    `;
      const confined = await promisify(execFile)(
        '/usr/bin/sandbox-exec',
        ['-p', await webScriptProfile(), process.execPath, '--permission', '-e', code],
        { cwd: directory, env: { ELECTRON_RUN_AS_NODE: '1' } },
      );
      assert.deepEqual(JSON.parse(confined.stdout), {
        read: 'denied',
        write: 'denied',
        spawn: 'denied',
        env: 'ok ',
        network: 'denied',
      });
    } finally {
      listener.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'a script that fails, never ends or floods its output is reported and stopped',
  options,
  async () => {
    const thrown = await run(`console.log('before');\nthrow new TypeError('bad input');`);
    assert.equal(thrown.ok, false);
    assert.match(thrown.error!, /^TypeError: bad input/);
    assert.match(thrown.error!, /script\.js:2/);
    assert(!/sdk\.js|node:internal/.test(thrown.error!), thrown.error!);
    assert.deepEqual(thrown.logs, ['[log] before']);

    const syntax = await run('const = 1;');
    assert.equal(syntax.ok, false);
    assert.match(syntax.error!, /SyntaxError/);

    const circular = await run('const a = {}; a.self = a; return a;');
    assert.equal(circular.ok, false);
    assert.match(circular.error!, /cannot be serialized/);

    let started = Date.now();
    const spinning = await runWebScript('while (true) {}', { call: async () => 1, timeout: 300 });
    assert.equal(spinning.ok, false);
    assert.match(spinning.error!, /300 ms/);
    assert(Date.now() - started < 3000);

    const pending = await runWebScript('await new Promise(() => {});', {
      call: async () => 1,
      timeout: 200,
    });
    assert.match(pending.error!, /200 ms/);

    const abort = new AbortController();
    started = Date.now();
    setTimeout(() => abort.abort(), 100);
    const stopped = await runWebScript('await sleep(20000);', {
      call: async () => 1,
      signal: abort.signal,
    });
    assert.equal(stopped.error, '脚本已停止');
    assert(Date.now() - started < 3000);
    abort.abort();
    await assert.rejects(runWebScript('return 1', { call: async () => 1, signal: abort.signal }));

    const flood = await run(`for (;;) console.log('x'.repeat(10000));`);
    assert.equal(flood.ok, false);
    assert(flood.logs.join('').length < 400_000);

    // A step the script started still finishes before the result is returned.
    let finished = false;
    const late = await runWebScript('await browser.page(1).read();', {
      timeout: 100,
      call: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        finished = true;
      },
    });
    assert.equal(late.ok, false);
    assert.equal(finished, true);
  },
);
