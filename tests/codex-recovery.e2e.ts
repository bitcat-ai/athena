/** Host IPC and a local scripted CLI. Run after building Athena; no model inference. */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import type { AppSnapshot } from '../src/shared/types';

const profile = await mkdtemp(path.join(tmpdir(), 'athena-codex-recovery-'));
const workspace = path.join(profile, 'workspace');
const bin = path.join(profile, 'bin');
const log = path.join(profile, 'calls');
const version = path.join(profile, 'version');
const catalogTag = path.join(profile, 'catalog-tag');
await Promise.all([
  mkdir(workspace),
  mkdir(bin),
  writeFile(log, ''),
  writeFile(version, '1'),
  writeFile(catalogTag, 'a'),
]);
const cli = path.join(bin, 'codex');
await writeFile(
  cli,
  `#!${process.execPath}\n` +
    String.raw`
const fs = require('node:fs'), path = require('node:path');
const profile = process.env.WORKBENCH_USER_DATA_DIR;
const current = fs.readFileSync(path.join(profile, 'version'), 'utf8');
const catalog = 'fixture-' + current + fs.readFileSync(path.join(profile, 'catalog-tag'), 'utf8');
if (process.argv.includes('--version')) {console.log('codex-fixture ' + current); process.exit(0)}
if (process.argv.includes('status')) {console.error('Logged in using fixture'); process.exit(0)}
const send = (msg) => console.log(JSON.stringify(msg));
let thread = 'new-' + process.pid;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line); const p=r.params || {};
 fs.appendFileSync(path.join(profile,'calls'),JSON.stringify({pid:process.pid,method:r.method,params:p})+'\n');
 const reply = result => send({id:r.id,result});
 if(r.method==='initialize')return reply({userAgent:'fixture'});
 if(r.method==='thread/read')return reply({thread:{id:p.threadId,turns:p.threadId==='old-unused'?[]:[{id:'old-turn'}]}});
 if(r.method==='thread/resume')thread=p.threadId;
 if(['thread/resume','thread/start'].includes(r.method))return reply({thread:{id:thread}});
 if(r.method==='model/list')return reply({data:[{id:'fixture',model:catalog}],nextCursor:null});
 if(r.method==='skills/list')return reply({data:[{cwd:p.cwds[0],skills:[{name:'review',path:'/opt/codex/review/SKILL.md',enabled:true,description:'Review code'}]}]});
 if(r.method==='turn/start') {
   const turn='turn-'+r.id;
   reply({turn:{id:turn,status:'inProgress'}});
   if(p.input[0].text!=='hold')setTimeout(()=>send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed',items:[]}}}),5);
 }
});
`,
);
await chmod(cli, 0o700);
const conversation = (id: string, agentSessionId: string, cwd = workspace) => ({
  id,
  title: id,
  updatedAt: 1,
  workspace: cwd,
  agentSessionId,
  agentToolsFingerprint: 'a'.repeat(64),
  messages: [],
});
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: { agent: 'codex', workspace },
    onboarding: {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      browserDeferred: true,
      workspaceConfirmed: workspace,
    },
    recordings: [],
    conversations: [
      conversation('first', 'old-unused'),
      conversation('broken', 'old-used'),
      conversation('other', 'elsewhere', '/different-workspace'),
    ],
  }),
);
const requests = async () =>
  (await readFile(log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
let application: ElectronApplication | undefined;
try {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    WORKBENCH_USER_DATA_DIR: profile,
  };
  delete env.WORKBENCH_DEV_SERVER_URL;
  application = await electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  const page = await application.firstWindow({ timeout: 15000 });
  await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.setBackgroundThrottling(false);
    w.hide();
  });
  const invoke = <T = any>(name: string, payload?: unknown) =>
    page.evaluate(({ name, payload }) => window.workbench.invoke<T>(name, payload), {
      name,
      payload,
    });
  const snapshot = () => invoke<AppSnapshot>('app:snapshot');
  await expect.poll(async () => (await snapshot()).codexConnection?.status).toBe('ready');
  assert.equal((await snapshot()).agents.find((a) => a.id === 'codex')?.path, cli);
  assert.equal((await snapshot()).conversations[0].agentSessionId, 'old-unused');
  const warm = (await requests()).find((r) => r.method === 'thread/start');
  assert(warm);
  await invoke('models:list', { refresh: true });
  assert.equal((await requests()).filter((r) => r.method === 'model/list').at(-1).pid, warm.pid);
  // Exercise production renderer -> preload -> IPC -> runTurn -> fake app-server.
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  await composer.fill('/');
  await expect(page.getByRole('option', { name: /review/ })).toBeVisible();
  await composer.press('Enter');
  await expect(composer).toHaveValue('/review ');
  await composer.fill('/review First task');
  await composer.press('Enter');
  await expect
    .poll(async () => (await snapshot()).conversations[0].messages.at(-1)?.status)
    .toBe('done');
  const first = (await snapshot()).conversations[0];
  assert.deepEqual(first.previousAgentSessionIds, ['old-unused']);
  assert.equal(first.agentSessionId, 'new-' + warm.pid);
  const firstTurn = (await requests()).find((r) => r.method === 'turn/start')!;
  const discoveryRequest = (await requests()).find((r) => r.method === 'skills/list');
  assert.deepEqual(discoveryRequest.params, { cwds: [workspace] });
  assert.equal(firstTurn.params.input[0].text, '$review\n\nFirst task');
  assert.equal(firstTurn.params.input[0].text.includes('Skill 不存在：review'), false);
  const firstThreadOperations = (await requests()).filter((r) => r.method === 'thread/start' || r.method === 'thread/resume').length;
  await writeFile(catalogTag, 'b');
  await invoke('agents:refresh');
  await invoke('conversation:prepare', { conversationId: 'first' });
  assert.equal(
    (await requests()).filter((r) => r.method === 'thread/start' || r.method === 'thread/resume')
      .length,
    firstThreadOperations + 1,
    'explicit agents refresh reconnects the persisted thread once',
  );
  assert.equal((await invoke('models:list'))[0].model, 'fixture-1b');
  await assert.rejects(invoke('conversation:prepare', { conversationId: 'other' }), /其他工作目录/);
  assert.equal((await snapshot()).codexConnection?.conversationId, 'first');
  await assert.rejects(
    invoke('conversation:prepare', { conversationId: 'broken' }),
    /原会话已保留/,
  );
  const brokenState = (await snapshot()).codexConnection;
  assert.equal(brokenState?.status, 'error');
  const listsBefore = (await requests()).filter((r) => r.method === 'model/list').length;
  const models = await invoke('models:list', { refresh: true });
  assert.equal(models[0].model, 'fixture-1b');
  const after = await requests();
  const lists = after.filter((r) => r.method === 'model/list');
  assert.equal(lists.length, listsBefore + 1);
  const probe = lists.at(-1).pid;
  assert(
    !after.some(
      (r) => r.pid === probe && (r.method.startsWith('thread/') || r.method === 'turn/start'),
    ),
  );
  assert.deepEqual((await snapshot()).codexConnection, brokenState);
  await invoke('conversation:prepare', { conversationId: 'first' });
  await invoke('conversation:send', { id: 'first', text: 'hold' });
  await expect
    .poll(async () => (await requests()).filter((r) => r.method === 'turn/start').length)
    .toBe(2);
  assert.equal((await requests()).filter((r) => r.method === 'turn/start').at(-1).params.input[0].text, 'hold');
  const runningPid = (await requests()).filter((r) => r.method === 'turn/start').at(-1).pid;
  process.kill(runningPid, 'SIGKILL');
  await expect
    .poll(async () => (await snapshot()).conversations[0].messages.at(-1)?.status)
    .toBe('error');
  await invoke('models:list', { refresh: true });
  await invoke('conversation:prepare', { conversationId: 'first' });
  assert.equal((await requests()).filter((r) => r.method === 'turn/start').length, 2);
  assert.equal(
    (await requests()).filter((r) => r.method === 'thread/resume').at(-1).params.threadId,
    first.agentSessionId,
  );
  // Local selection still contributes progressive context, including when the
  // same name appears in both the raw draft and explicit selection.
  const localRoot = path.join(workspace, '.agents', 'skills', 'local-check');
  await mkdir(localRoot, { recursive: true });
  await writeFile(path.join(localRoot, 'SKILL.md'), '---\nname: local-check\ndescription: Local check\n---\nPrivate skill body');
  await invoke('conversation:send', { id: 'first', text: '/local-check Local task', selectedSkills: ['local-check'], context: 'page-marker' });
  await expect.poll(async () => (await requests()).filter((r) => r.method === 'turn/start').length).toBe(3);
  await expect.poll(async () => (await snapshot()).conversations.find(c => c.id === 'first')?.messages.at(-1)?.status).toBe('done');
  const localPrompt = (await requests()).filter((r) => r.method === 'turn/start').at(-1).params.input[0].text;
  assert.match(localPrompt, /Local task/);
  assert.ok(localPrompt.includes(path.join(localRoot, 'SKILL.md')));
  assert.ok(localPrompt.includes('page-marker'));
  assert.ok(!localPrompt.includes('Private skill body'));
  assert.ok(!localPrompt.includes('$review'));
  await writeFile(version, '2');
  await invoke('agents:refresh');
  await invoke('conversation:prepare', { conversationId: 'first' });
  const fresh = await invoke('models:list');
  assert.equal(fresh[0].model, 'fixture-2b');
  assert.equal((await requests()).filter((r) => r.method === 'turn/start').length, 3);
  console.log(
    'Verified empty-thread upgrade, independent catalog, refresh reuse, stale workspace, explicit reconnect without replay, and version change.',
  );
} finally {
  await application?.close();
  await rm(profile, { recursive: true, force: true });
}
