/** A guide from the agent's tool call to the card in the conversation: real Electron, page and
 * agent-browser, a simulated Codex protocol. No model, Feishu or user credentials are used.
 * Run after npm run build: npx tsx tests/guide-ui.e2e.ts
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { nodeShebang } from './node-script';
import type { AppSnapshot } from '../src/shared/types';

const root = process.cwd();
await access(path.join(root, 'dist/main/main.cjs'));
const directory = await mkdtemp(path.join(tmpdir(), 'athena-guide-ui-'));
const profile = path.join(directory, 'profile');
const workspace = path.join(directory, 'workspace');
const bin = path.join(directory, 'bin');
for (const folder of [profile, workspace, bin]) await mkdir(folder, { recursive: true });
// The button sits at a fixed place, so the test can click it the way a person would.
const site = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html;charset=utf-8');
  response.end(
    '<!doctype html><meta charset="utf-8"><title>Plans</title><style>body{margin:0;font:16px sans-serif}#upgrade{position:absolute;left:40px;top:40px;width:120px;height:40px}label{position:absolute;left:40px;top:120px}</style>' +
      '<button id="upgrade">升级</button><label>公司名称 <input id="company"></label>' +
      '<script>document.querySelector("#upgrade").onclick=()=>{location.hash="upgraded"}</script>',
  );
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: { agent: 'codex', workspace },
    conversations: [
      { id: 'guide', title: 'Guide', agent: 'codex', workspace, messages: [], updatedAt: 1 },
    ],
    recordings: [],
    onboarding: {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      workspaceConfirmed: workspace,
    },
  }),
);
// Every turn opens the page and guides: two steps, or one when the prompt starts with "one".
await writeFile(
  path.join(bin, 'codex'),
  `${nodeShebang()}
if (process.argv.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
const event = (method, params) => send({method, params});
let thread = 'guide-'+process.pid, current, tools=[], step=0, page, prompt='';
const finish = (text, status='completed') => {
  const turn=current; current=undefined;
  if(!turn)return;
  event('item/agentMessage/delta',{threadId:thread,turnId:turn,itemId:turn,delta:text});
  event('item/completed',{threadId:thread,turnId:turn,item:{id:turn,type:'agentMessage',text}});
  event('turn/completed',{threadId:thread,turn:{id:turn,status,items:[]}});
};
const call = (tool, args) => {
  if(!tools.includes(tool))return finish('FIXTURE_ERROR: missing '+tool);
  send({id:900+step,method:'item/tool/call',params:{threadId:thread,turnId:current,callId:'tool-'+current+'-'+step,tool,arguments:args}});
};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line),p=r.params||{};
  if(r.method==='initialize')return send({id:r.id,result:{userAgent:'guide-fixture'}});
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
    prompt=text.split('\\n')[0];
    const raw=text.match(/<web_browser_context>\\n([^\\n]+)/)?.[1];
    if(!raw)return finish('FIXTURE_ERROR: missing host browser state');
    page=JSON.parse(raw).currentPage.pageId;
    return call('web_navigate',{page,url:process.env.GUIDE_URL});
  }
  if(r.method==='turn/interrupt'){send({id:r.id,result:{}});return finish('任务已停止','interrupted');}
  if(r.id>=900&&r.result){
    if(!current)return;
    const text=(r.result.contentItems||[]).filter(x=>x.type==='inputText').map(x=>x.text).join('\\n');
    if(!r.result.success)return finish('FIXTURE_ERROR: '+text);
    if(step++===0)return call('workbench_browser_guide',prompt.startsWith('one')
      ? {steps:[{note:'点“升级”',text:'升级',action:'click'}]}
      : {title:'开通套餐',steps:[{note:'点“升级”',text:'升级',action:'click'},{note:'填写公司名称',selector:'#company',action:'input'}]});
    return finish('GUIDE '+JSON.parse(text).ended);
  }
  if(r.id!==undefined&&r.method)send({id:r.id,result:{}});
});
`,
  { mode: 0o700 },
);
for (const name of ['claude', 'opencode', 'gemini'])
  await writeFile(path.join(bin, name), `${nodeShebang()}\nconsole.log('${name} fixture');\n`, {
    mode: 0o700,
  });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  WORKBENCH_USER_DATA_DIR: profile,
  GUIDE_URL: url,
};
for (const key of [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'WORKBENCH_DEV_SERVER_URL',
])
  delete env[key];

// A hidden run must not take the keyboard from whoever is working on this Mac: the window is
// never activated, where hiding it after the fact would leave the application in front.
const hidden = process.env.WORKBENCH_HIDE_TEST_WINDOW === '1';
const quiet = path.join(directory, 'quiet-window.cjs');
await writeFile(
  quiet,
  String.raw`
const { BrowserWindow } = require('electron');
const { showInactive, hide } = BrowserWindow.prototype;
BrowserWindow.prototype.show = function () {
  this.webContents.setBackgroundThrottling(false);
  showInactive.call(this);
  hide.call(this);
};
BrowserWindow.prototype.focus = function () {};
`,
);

const app = await electron.launch({
  args: hidden ? ['-r', quiet, '.'] : ['.'],
  cwd: root,
  env: Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
});
const errors: string[] = [];
const checks: string[] = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
  const assistant = async () =>
    (await snapshot()).conversations
      .find((item) => item.id === 'guide')!
      .messages.filter((message) => message.role === 'assistant')
      .at(-1);
  const send = async (text: string) => {
    await page.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill(text);
    await page.locator('.composer [data-slot="prompt-input-send"]').click();
  };
  const done = async () => {
    await expect.poll(async () => (await assistant())?.status, { timeout: 45_000 }).toBe('done');
    return (await assistant())!;
  };
  /** The person at the screen clicks the page, through the same channel the browser pane uses. */
  const press = (x: number, y: number) =>
    page.evaluate(
      async ({ x, y }) => {
        for (const action of ['down', 'up'])
          await window.workbench.invoke('browser:input', {
            type: 'mouse',
            action,
            button: 'left',
            x,
            y,
          });
      },
      { x, y },
    );
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 45_000 })
    .toBe('ready');

  // The guide's steps appear in the conversation once the first one is on the page.
  await send('带我开通套餐');
  const card = page.getByRole('group', { name: '带你做：开通套餐' });
  await expect(card).toBeVisible({ timeout: 45_000 });
  const rows = card.locator('.guide-steps li');
  await expect(rows).toHaveText(['1点“升级”', '2填写公司名称']);
  await expect(rows.nth(0)).toHaveAttribute('aria-current', 'step');
  await expect(card.getByText('跟着页面上的提示操作，每一步都由你自己完成。')).toBeVisible();
  const end = card.getByRole('button', { name: '结束带做' });
  const go = card.getByRole('button', { name: '去页面操作 ↗' });
  const [endBox, goBox] = [(await end.boundingBox())!, (await go.boundingBox())!];
  assert.ok(Math.abs(endBox.y - goBox.y) < 2, 'the two actions share one row');
  await expect(card.getByRole('button')).toHaveCount(2);
  assert.equal((await assistant())?.status, 'streaming');
  await expect.poll(async () => (await snapshot()).browser.title).toBe('Plans');
  checks.push('The card lists the steps, marks the current one and offers no way to approve');

  // The user's own click on the page moves the card on; the task is not interrupted by it.
  await press(100, 60);
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'step');
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'done');
  await expect.poll(async () => (await snapshot()).browser.url).toBe(url + '/#upgraded');
  assert.equal((await assistant())?.status, 'streaming');
  // Neither shortcut answers it: ⌘↩ shows the page, Esc is left alone.
  await card.focus();
  await page.keyboard.press('Meta+Enter');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await expect(card).toBeVisible();
  assert.equal((await assistant())?.status, 'streaming');
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({
    path: path.join(root, 'test-results/guide-card.png'),
    animations: 'disabled',
  });
  checks.push('A click on the page advances the card and leaves the turn running');

  await end.click();
  await expect(card).toHaveCount(0);
  const ended = await done();
  assert.equal(ended.text, 'GUIDE ended_by_user');
  assert.deepEqual(
    ended.requests?.map(({ kind, resolution, summary }) => ({ kind, resolution, summary })),
    [{ kind: 'handoff', resolution: 'guided', summary: '完成 1/2 步后由你结束' }],
  );
  checks.push('结束带做 ends it as the user’s decision and the conversation keeps one line of it');

  // A guide the user completes closes its card by itself.
  await send('one 再带我点一次');
  const short = page.getByRole('group', { name: '带你在页面上操作' });
  await expect(short).toBeVisible({ timeout: 45_000 });
  assert.equal((await snapshot()).browser.url, url + '/');
  await press(100, 60);
  await expect(short).toHaveCount(0);
  assert.equal((await snapshot()).browser.url, url + '/#upgraded');
  const completed = await done();
  assert.equal(completed.text, 'GUIDE completed');
  assert.deepEqual(
    completed.requests?.map(({ resolution, summary }) => ({ resolution, summary })),
    [{ resolution: 'guided', summary: '完成 1/1 步' }],
  );
  checks.push('A completed guide closes its card and records how far the user got');

  // Stopping the turn takes the card away without recording a decision.
  await send('再带我一次');
  await expect(card).toBeVisible({ timeout: 45_000 });
  await page.locator('.composer [data-slot="prompt-input-send"]').click();
  await expect(card).toHaveCount(0);
  await expect
    .poll(async () => (await assistant())?.status, { timeout: 45_000 })
    .not.toBe('streaming');
  assert.deepEqual((await assistant())?.requests ?? [], []);
  checks.push('Stopping the turn removes the card and records nothing');

  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, checks, screenshot: 'test-results/guide-card.png' }, null, 2),
  );
} finally {
  await app.close();
  site.close();
  await rm(directory, { recursive: true, force: true });
}
