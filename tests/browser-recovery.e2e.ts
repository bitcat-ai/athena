/** Simulated installation visibility and Codex protocol; real Electron, agent-browser, page and tool results. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { discoverChrome } from '../src/main/browser';
import { nodeShebang } from './node-script';
import type { AppSnapshot } from '../src/shared/types';

const root = process.cwd();
const installed = await discoverChrome(process.env.ATHENA_TEST_CHROME);
assert.ok(installed, 'This native recovery check requires an installed Chrome browser');
const directory = await mkdtemp(path.join(tmpdir(), 'athena-browser-recovery-'));
const profile = path.join(directory, 'profile');
const workspace = path.join(directory, 'workspace');
const bin = path.join(directory, 'bin');
const application = path.join(profile, 'Custom browser location/Renamed Chrome.app');
const log = path.join(directory, 'protocol.jsonl');
for (const folder of [profile, workspace, bin]) await mkdir(folder, { recursive: true });
const site = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html;charset=utf-8');
  response.end(
    '<!doctype html><title>Browser recovery</title><h1 id="proof">AFTER_INSTALL_OK</h1>',
  );
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: { agent: 'codex', workspace, browserPath: path.join(directory, 'moved.app') },
    conversations: [
      {
        id: 'recovery',
        title: 'Browser recovery',
        agent: 'codex',
        workspace,
        messages: [],
        updatedAt: 1,
      },
    ],
    recordings: [],
    onboarding: {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      workspaceConfirmed: workspace,
      browserDeferred: true,
    },
  }),
);
await writeFile(log, '');
await writeFile(
  path.join(bin, 'codex'),
  `${nodeShebang()}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const event = (method, params) => send({method, params});
let thread = 'recovery-'+process.pid, current, tools=[], step=0, page;
const finish = text => {
  event('item/agentMessage/delta',{threadId:thread,turnId:current,itemId:current,delta:text});
  event('item/completed',{threadId:thread,turnId:current,item:{id:current,type:'agentMessage',text}});
  event('turn/completed',{threadId:thread,turn:{id:current,status:'completed',items:[]}});
};
const call = (tool, args) => {
  if(!tools.includes(tool))return finish('FIXTURE_ERROR: missing '+tool);
  send({id:900+step,method:'item/tool/call',params:{threadId:thread,turnId:current,callId:'tool-'+current+'-'+step,tool,arguments:args}});
};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  fs.appendFileSync(process.env.RECOVERY_LOG,line+'\\n');
  const r=JSON.parse(line),p=r.params||{};
  if(r.method==='initialize')return send({id:r.id,result:{userAgent:'recovery-fixture'}});
  if(r.method==='model/list')return send({id:r.id,result:{data:[]}});
  if(r.method==='thread/read')return send({id:r.id,result:{thread:{id:p.threadId,turns:[]}}});
  if(r.method==='thread/start'||r.method==='thread/resume'){
    thread=p.threadId||thread;tools=(p.dynamicTools||[]).map(tool=>tool.name);
    return send({id:r.id,result:{thread:{id:thread}}});
  }
  if(r.method==='turn/start'){
    current='turn-'+Date.now();step=0;
    send({id:r.id,result:{turn:{id:current,status:'inProgress'}}});
    event('turn/started',{threadId:thread,turn:{id:current,status:'inProgress'}});
    const text=p.input.filter(item=>item.type==='text').map(item=>item.text).join('\\n');
    const raw=text.match(/<web_browser_context>\\n([^\\n]+)/)?.[1];
    if(!raw)return finish('FIXTURE_ERROR: missing host browser state');
    const context=JSON.parse(raw);
    if(context.available===false)return finish('NOT_INSTALLED: '+context.reason);
    page=context.currentPage.pageId;return call('web_navigate',{page,url:process.env.RECOVERY_URL});
  }
  if(r.id>=900&&r.result){
    const text=(r.result.contentItems||[]).filter(x=>x.type==='inputText').map(x=>x.text).join('\\n');
    if(!r.result.success)return finish('FIXTURE_ERROR: '+text);
    if(step++===0)return call('web_snapshot',{page});
    if(step===2){
      const observationId=text.match(/Athena observationId: ([a-f0-9-]+)/)?.[1];
      if(!observationId||!text.includes('AFTER_INSTALL_OK'))return finish('FIXTURE_ERROR: observation '+text);
      return call('web_checkpoint',{observationId,summary:'Read the page after installation',evidence:'AFTER_INSTALL_OK',outcome:'verified'});
    }
    return finish('RECOVERY_VERIFIED');
  }
  if(r.id!==undefined&&r.method)send({id:r.id,result:{}});
});
`,
  { mode: 0o700 },
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  WORKBENCH_USER_DATA_DIR: profile,
  WORKBENCH_BROWSER_PATH: path.join(directory, 'moved.app'),
  ATHENA_CHROME_PATH: path.join(directory, 'not-installed.app'),

  RECOVERY_LOG: log,
  RECOVERY_URL: url,
};
delete env.WORKBENCH_DEV_SERVER_URL;
const app = await electron.launch({
  args: [path.join(root, 'tests/browser-discovery-host.cjs')],
  cwd: directory,
  env: Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
});
try {
  const page = await app.firstWindow();
  await page.evaluate('window.__name = fn => fn');
  const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
  const assistant = async () =>
    (await snapshot()).conversations
      .find((c) => c.id === 'recovery')!
      .messages.filter((m) => m.role === 'assistant')
      .at(-1);
  const send = async (text: string) => {
    await page.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill(text);
    await page.locator('.composer [data-slot="prompt-input-send"]').click();
    await expect.poll(async () => (await assistant())?.status, { timeout: 45_000 }).toBe('done');
    return (await assistant())!;
  };
  await expect.poll(async () => (await snapshot()).browser.status).toBe('missing');
  assert.match((await send('Check the browser before installation')).text, /NOT_INSTALLED/);
  await mkdir(path.dirname(application), { recursive: true });
  await symlink(path.resolve(installed, '../../..'), application);
  await writeFile(path.join(profile, 'indexed-browser.txt'), application);
  const result = await send('Read the browser after installation');
  assert.equal(result.text, 'RECOVERY_VERIFIED');
  assert.ok(result.tools?.some((tool) => tool.name === 'web_snapshot'));
  assert.equal((await snapshot()).browser.title, 'Browser recovery');
  assert.equal((await snapshot()).web?.status, 'ready');
  await expect(page.locator('.app-toast').filter({ hasText: '未找到 Google Chrome' })).toHaveCount(
    0,
  );
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const catalogs = calls
    .filter((call) => call.method === 'thread/start')
    .map((call) => (call.params.dynamicTools || []).map((tool: any) => tool.name));
  assert.ok(catalogs.some((names) => !names.includes('web_snapshot')));
  assert.ok(catalogs.some((names) => names.includes('web_snapshot')));

  await page.getByRole('button', { name: '本机用户菜单', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '浏览器', exact: true }).click();
  const browserSettings = page.getByRole('tabpanel', { name: '浏览器', exact: true });
  await expect(browserSettings.getByText('已连接', { exact: true })).toBeVisible();

  await app.evaluate(() => (globalThis as any).__discoveryWebWorker.kill('SIGTERM'));
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  const resumed = await send('Read the page after the executor restarts');
  assert.equal(resumed.text, 'RECOVERY_VERIFIED');
  assert.notEqual(resumed.webSessionId, result.webSessionId);
  assert.equal((await snapshot()).browser.title, 'Browser recovery');
  assert.equal((await snapshot()).web?.status, 'ready');
  const output = path.join(root, 'test-results/browser-recovery');
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'connected.png'), animations: 'disabled' });
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        checks: [
          'missing install reported',
          'renamed indexed install found after launch',
          'prior deferral does not block connection',
          'same conversation receives refreshed tools',
          'real agent-browser navigation and snapshot verified',
          'owned executor disconnect recovers on a fresh task while preserving the page',
        ],
        cli: 'simulated Codex protocol',
        browser: 'real installed agent-browser',
        remoteModelCalls: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: later installation → same conversation → real agent-browser page; fresh executor task preserves the visible page.',
  );
} finally {
  await app.close();
  site.close();
  await rm(directory, { recursive: true, force: true });
}
