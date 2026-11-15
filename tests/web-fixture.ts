import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/main/browser';
import { WebRuntime } from '../src/main/web-runtime';
import type { ApprovalRequest, ToolResult } from '../src/shared/types';

/** Real pinned agent-browser daemon and an Athena-owned Chrome profile; no model requests. */
export const liveWeb = process.env.ATHENA_TEST_AGENT_BROWSER === '1';

const LAB = `<!doctype html><meta charset="utf-8"><title>Lab</title>
<style>body{font:16px system-ui;margin:20px}label{display:block;margin:6px 0}#pad{width:300px;height:120px;background:#eee}.box{width:90px;height:40px;display:inline-block;background:#cde;margin:6px}</style>
<h1>Lab</h1>
<label>Name<input id="name" aria-label="Name"></label>
<label>Secret<input id="secret" type="password" aria-label="Secret"></label>
<label><input id="agree" type="checkbox" aria-label="Agree">Agree</label>
<label>Plan<select id="plan" aria-label="Plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
<button id="hover">Hover target</button>
<button id="count">Count</button>
<p id="log" role="status">idle</p>
<div id="pad" role="img" aria-label="Pad"></div>
<div id="from" class="box" role="button" aria-label="Card" tabindex="0">Card</div>
<div id="to" class="box" role="button" aria-label="Bin" tabindex="0">Bin</div>
<button id="b-alert">Show alert</button>
<button id="b-confirm">Ask confirm</button>
<button id="b-prompt">Ask prompt</button>
<label>Attachment<input id="file" type="file" aria-label="Attachment" multiple></label>
<button id="choose">Choose file</button>
<a id="dl" href="/file.txt">Download report</a>
<a id="pop" href="/popup" target="_blank">Open receipt</a>
<button id="open">Open window</button>
<button id="later">Load later</button>
<a id="next" href="/popup">Go to receipt</a>
<iframe title="Inner" src="/frame" width="420" height="90"></iframe>
<p id="long">aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!</p>
<div style="height:2000px">filler</div>
<p id="bottom">Bottom marker</p>
<script>
const $ = (selector) => document.querySelector(selector);
window.__events = [];
const log = (text) => { $('#log').textContent = text; window.__events.push(text); };
let clicks = 0;
$('#name').onfocus = () => window.__events.push('focus name');
$('#hover').onmouseenter = () => log('hovered');
$('#count').onclick = (event) => log('count ' + ++clicks + ' detail ' + event.detail);
$('#count').ondblclick = () => log('double');
$('#count').oncontextmenu = (event) => { event.preventDefault(); log('context'); };
let moves = 0;
$('#pad').onmousedown = (event) => { moves = 0; log('down ' + Math.round(event.offsetX) + ',' + Math.round(event.offsetY)); };
$('#pad').onmousemove = (event) => { if (event.buttons) moves++; else window.__hover = [Math.round(event.offsetX), Math.round(event.offsetY)]; };
$('#pad').onmouseup = (event) => log('up ' + Math.round(event.offsetX) + ',' + Math.round(event.offsetY) + ' moves ' + (moves > 2));
let carrying = false;
$('#from').onmousedown = () => { carrying = true; };
$('#to').onmouseup = () => { if (carrying) log('dropped card'); carrying = false; };
$('#b-alert').onclick = () => { alert('Heads up'); log('alert closed'); };
$('#b-confirm').onclick = () => log('confirm ' + confirm('Proceed?'));
$('#b-prompt').onclick = () => log('prompt ' + prompt('Your name?', 'nobody'));
$('#file').onchange = () => log('files ' + [...$('#file').files].map((file) => file.name + ':' + file.size).join(','));
$('#choose').onclick = () => $('#file').click();
$('#open').onclick = () => window.open('/popup');
$('#later').onclick = () => setTimeout(() => { const p = document.createElement('p'); p.id = 'late'; p.textContent = 'Arrived later'; document.body.append(p); }, 400);
console.log('lab ready');
console.warn('lab warning');
</script>`;

const FRAME = `<!doctype html><meta charset="utf-8"><label>Email<input id="email" aria-label="Email"></label><button id="ok">Confirm contact</button><p id="state">unconfirmed</p><script>document.querySelector('#ok').onclick=()=>document.querySelector('#state').textContent='confirmed '+document.querySelector('#email').value;</script>`;

export interface WebFixture {
  browser: BrowserRuntime;
  runtime: WebRuntime;
  origin: string;
  /** The same server under another origin. */
  foreign: string;
  directory: string;
  approvals: Array<Omit<ApprovalRequest, 'id' | 'kind'>>;
  /** Fails the test when the tool reports an error. */
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  begin(
    id: string,
    readonly?: boolean,
  ): Promise<{ sessionId: string; page: number; client: any; worker: any; elapsed: number }>;
  /** Evaluates in the visible page, outside the task. */
  state(expression: string): Promise<any>;
  /** Re-observes the page and records that the failed step did not take effect. */
  recover(page: number, evidence: string): Promise<void>;
  cleanup(): Promise<void>;
}

export const refOf = (text: string, label: string) => {
  const ref = text
    .split('\n')
    .find((line) => line.includes('"' + label + '"') && /\bref=/.test(line))
    ?.match(/\bref=(ab[a-f0-9]{8}:e\d+)/)?.[1];
  assert(ref, `no ref for ${label} in:\n${text}`);
  return ref;
};

export async function until(read: () => unknown, label = 'condition', timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await read())) {
    assert(Date.now() < deadline, `${label} did not happen`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function webFixture(start = '/lab'): Promise<WebFixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-web-'));
  const site = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    if (url.pathname === '/file.txt') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="report.txt"',
      });
      res.end('report body');
      return;
    }
    if (url.pathname === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<title>Missing</title><h1>Not here</h1>');
      return;
    }
    res.setHeader('content-type', 'text/html;charset=utf-8');
    if (url.pathname === '/frame') res.end(FRAME);
    else if (url.pathname === '/popup')
      res.end(
        '<!doctype html><title>Receipt</title><h1>Receipt</h1><p>Order 42 confirmed</p><a href="/lab">Back to lab</a>',
      );
    else if (url.pathname === '/foreign')
      res.end(
        `<!doctype html><title>Foreign</title><h1>Foreign host</h1><iframe title="Remote" src="http://localhost:${(site.address() as any).port}/frame" width="420" height="90"></iframe>`,
      );
    else if (url.pathname === '/lab') res.end(LAB);
    else
      res.end(
        '<!doctype html><title>Tasks</title><label>Title<input id="title" aria-label="Title"></label><p>Nothing saved</p>',
      );
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const port = (site.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const approvals: WebFixture['approvals'] = [];
  let runtime!: WebRuntime;
  const browser = new BrowserRuntime({
    storageDir: path.join(directory, 'browser'),
    onState() {},
    onFrame() {},
    onStep() {},
    onSelected() {},
    onHumanTakeover(reason) {
      runtime?.onHumanInteraction(reason);
    },
  });
  runtime = new WebRuntime(browser, {
    directory: path.join(directory, 'records'),
    onState() {},
    onDisconnect() {},
    approve: async (request) => {
      approvals.push(request);
      return true;
    },
  });
  const cleanup = async () => {
    await runtime.stop().catch(() => {});
    await browser.dispose();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await browser.start(origin + start);
    await runtime.start();
  } catch (error) {
    await cleanup();
    throw error;
  }
  const call: WebFixture['call'] = async (name, args) => {
    const result = await runtime.callTool(name, args);
    assert.ok(!result.isError, result.text);
    return result;
  };
  return {
    browser,
    runtime,
    origin,
    foreign: `http://localhost:${port}`,
    directory,
    approvals,
    call,
    async begin(id, readonly = false) {
      browser.allowAgentControl();
      const started = performance.now();
      const task = await runtime.beginTask(id, readonly);
      const client = (runtime.server as any).sessions.get(task.sessionId);
      return {
        sessionId: task.sessionId,
        page: JSON.parse(task.context.match(/<web_browser_context>\n([^\n]+)/)![1]).currentPage
          .pageId,
        client,
        worker: client.worker,
        elapsed: Math.round(performance.now() - started),
      };
    },
    async state(expression) {
      const result = await browser.nativeEvaluate(
        browser.getState().activeTabId!,
        expression,
        5000,
      );
      assert.equal(result.error, undefined);
      return result.value;
    },
    async recover(page, evidence) {
      const seen = await call('web_read', { page, format: 'text' });
      await call('web_checkpoint', {
        observationId: seen.text.match(/Athena observationId: ([a-f0-9-]+)/)![1],
        summary: 'Checked the page after a failed step',
        evidence,
        outcome: 'not_applied',
      });
    },
    cleanup,
  };
}
