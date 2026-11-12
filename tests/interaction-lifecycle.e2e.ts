/** Actual Electron/Neo with a deterministic local CLI fixture; no model inference. */
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AppSnapshot } from '../src/shared/types';

const root = process.cwd();
const dir = await mkdtemp(path.resolve('.runtime/interaction-lifecycle-'));
const output =
  process.env.ATHENA_LIFECYCLE_OUTPUT || 'test-results/interaction-refinement/lifecycle.json';
const binary = process.env.ATHENA_APP_EXECUTABLE;
const log = path.join(dir, 'protocol.ndjson');
const bin = path.join(dir, 'bin');
const workspace = path.join(dir, 'workspace');
await mkdir(bin);
await writeFile(path.join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
await mkdir(workspace);
await writeFile(log, '');
const program = `#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline');
const log=${JSON.stringify(log)},control=${JSON.stringify(dir)};
if(process.argv.includes('--version')){console.log('codex-cli lifecycle-fixture');process.exit(0)}
if(process.argv.includes('status')){console.error('Logged in using fixture');process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const event=(method,params)=>send({method,params});
const threadId='fixture-'+process.pid;let count=0,current,timer;
const finish=status=>{clearInterval(timer);event('turn/completed',{threadId,turn:{id:current,status,items:[]}})};
readline.createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line),p=r.params||{};fs.appendFileSync(log,JSON.stringify({pid:process.pid,at:Date.now(),...r})+'\\n');
if(r.method==='initialize')return send({id:r.id,result:{userAgent:'fixture'}});
if(r.method==='model/list')return send({id:r.id,result:{data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low',description:'Quick'},{reasoningEffort:'high',description:'Deep'}],defaultReasoningEffort:'low'}],nextCursor:null}});
if(['thread/start','thread/resume','thread/read'].includes(r.method))return send({id:r.id,result:{thread:{id:threadId,turns:[]},model:p.model||'gpt-6.1-sol',reasoningEffort:'low'}});
if(r.method==='turn/start'){
 current=threadId+'-turn-'+(++count);send({id:r.id,result:{turn:{id:current,status:'inProgress'}}});
 event('turn/started',{threadId,turn:{id:current,status:'inProgress'}});
 event('item/agentMessage/delta',{threadId,turnId:current,itemId:'message-'+current,delta:'正在整理结果。'});
 const active=current;timer=setInterval(()=>{if(current!==active||!fs.existsSync(control+'/release-'+active))return;
 event('item/agentMessage/delta',{threadId,turnId:current,itemId:'message-'+current,delta:'任务继续完成。'});
 const tokens={inputTokens:100*count,outputTokens:10*count,cachedInputTokens:20*count,cacheWriteInputTokens:0,reasoningOutputTokens:0,totalTokens:110*count};
 event('thread/tokenUsage/updated',{threadId,turnId:current,tokenUsage:{total:tokens,last:{inputTokens:100,outputTokens:10,cachedInputTokens:20,cacheWriteInputTokens:0,reasoningOutputTokens:0,totalTokens:110}}});finish('completed');},20);return;
}
if(r.method==='turn/interrupt'){send({id:r.id,result:{}});finish('interrupted');return;}
if(r.id!==undefined)send({id:r.id,result:{}});
});
`;
for (const name of ['codex', 'claude', 'opencode', 'gemini']) {
  const filename = path.join(bin, name);
  await writeFile(filename, program);
  await chmod(filename, 0o700);
}
await writeFile(
  path.join(dir, 'workspace.json'),
  JSON.stringify({
    settings: {
      workspace,
      agent: 'codex',
      modelSelection: { model: 'gpt-6.1-sol', effort: 'low' },
    },
    conversations: [
      {
        id: 'prepared-chat',
        title: '测试工作',
        agent: 'codex',
        workspace,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      },
    ],
    recordings: [],
  }),
);
const site = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html;charset=utf-8');
  response.end(
    '<!doctype html><title>测试清单</title><style>body{margin:0;min-height:7000px}button{position:fixed;top:30px;left:30px}</style><button id="counter" onclick="this.textContent=String(++window.clicks)">0</button><script>window.clicks=0</script>',
  );
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
const evidence: {
  checks: string[];
  error?: string;
  protocol?: unknown;
  passed?: boolean;
  connection?: unknown;
} = {
  checks: [],
};
const requests = async (): Promise<any[]> =>
  (await readFile(log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
try {
  app = await electron.launch({
    ...(binary ? { executablePath: binary } : {}),
    args: binary ? [] : ['.'],
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      WORKBENCH_USER_DATA_DIR: dir,
    },
  });
  const page = await app.firstWindow();
  const invoke = <T = any>(action: string, payload?: unknown) =>
    page.evaluate(({ action, payload }) => window.workbench.invoke<T>(action, payload), {
      action,
      payload,
    });
  const snapshot = () => invoke<AppSnapshot>('app:snapshot');
  await expect
    .poll(async () => (await snapshot()).codexConnection?.status, { timeout: 15000 })
    .toBe('ready');
  let protocol = await requests();
  assert.equal(protocol.filter((r) => r.method === 'initialize').length, 1);
  assert.equal(protocol.filter((r) => r.method === 'thread/start').length, 1);
  assert.equal(protocol.filter((r) => r.method === 'turn/start').length, 0);
  await expect(page.locator('.local-agent-status')).toContainText('已就绪');
  await invoke('models:list');
  await invoke('models:list', { refresh: true });
  assert.equal((await requests()).filter((r) => r.method === 'initialize').length, 1);
  evidence.checks.push(
    'Startup prepares the actual CLI thread before sending; directory refresh reuses it',
  );
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 30000 })
    .toBe('ready');
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await invoke('browser:navigate', { url });
  await expect(page.locator('.frame-loading')).toHaveCount(0, { timeout: 10000 });
  const latestAssistant = async () =>
    (await snapshot()).conversations
      .flatMap((c) => c.messages)
      .filter((m) => m.role === 'assistant')
      .sort((a, b) => a.createdAt - b.createdAt)
      .at(-1)!;
  const send = async () => {
    const before = (await requests()).filter((r) => r.method === 'turn/start').length;
    const previous = (await latestAssistant())?.id;
    await page
      .getByRole('textbox', { name: '发送给 Agent 的任务' })
      .fill('持续整理，等待验收完成。');
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
    await expect
      .poll(async () => (await requests()).filter((r) => r.method === 'turn/start').length)
      .toBe(before + 1);
    await expect.poll(async () => (await latestAssistant())?.id).not.toBe(previous);
    await expect.poll(async () => (await latestAssistant())?.text).toContain('正在整理结果。');
    const record = (await requests()).filter((r) => r.method === 'turn/start').at(-1);
    const n = (await requests()).filter(
      (r) => r.method === 'turn/start' && r.pid === record.pid,
    ).length;
    return { id: (await latestAssistant()).id, turn: `fixture-${record.pid}-turn-${n}` };
  };
  for (const gesture of ['wheel', 'click']) {
    const turn = await send();
    const box = await page.locator('.browser-surface').boundingBox();
    assert(box);
    if (gesture === 'wheel') {
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.mouse.wheel(0, 120);
    } else {
      await page.mouse.click(box.x + 40, box.y + 40);
    }
    await page.waitForTimeout(150);
    assert.equal((await latestAssistant()).id, turn.id);
    assert.equal(
      (await latestAssistant()).status,
      'streaming',
      `${gesture} must not cancel AI work`,
    );
    assert.equal((await requests()).filter((r) => r.method === 'turn/interrupt').length, 0);
    await writeFile(path.join(dir, 'release-' + turn.turn), 'release');
    await expect.poll(async () => (await latestAssistant()).status).toBe('done');
    assert.match((await latestAssistant()).text, /任务继续完成/);
  }
  assert.equal((await requests()).filter((r) => r.method === 'initialize').length, 1);
  assert.equal((await requests()).filter((r) => r.method === 'thread/start').length, 1);
  evidence.checks.push(
    'Wheel and click preserve a running AI turn; consecutive sends do not reconnect',
  );
  const held = await send();
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect.poll(async () => (await latestAssistant()).status).toBe('error');
  assert(
    (await requests()).some((r) => r.method === 'turn/interrupt' && r.params.turnId === held.turn),
  );
  evidence.checks.push('Explicit stop still interrupts the running turn');
  await page.locator('button.new-conversation').click();
  await expect.poll(async () => (await snapshot()).codexConnection?.status).toBe('ready');
  await expect
    .poll(async () => (await requests()).filter((r) => r.method === 'thread/start').length)
    .toBe(2);
  const starts = (await requests()).filter((r) => r.method === 'initialize').length;
  const created = await send();
  assert.equal((await requests()).filter((r) => r.method === 'initialize').length, starts);
  await writeFile(path.join(dir, 'release-' + created.turn), 'release');
  await expect.poll(async () => (await latestAssistant()).status).toBe('done');
  evidence.checks.push('New conversation initializes before first send');
  evidence.passed = true;
} catch (error) {
  evidence.error = String(error);
  if (app)
    evidence.connection = await (
      await app.firstWindow()
    )
      .evaluate(async () => {
        const snapshot = await window.workbench.invoke<AppSnapshot>('app:snapshot');
        return {
          connection: snapshot.codexConnection,
          agents: snapshot.agents,
          messages: snapshot.conversations
            .flatMap((c) => c.messages)
            .filter((m) => m.role === 'assistant'),
        };
      })
      .catch(() => undefined);
  throw error;
} finally {
  evidence.protocol = await requests();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ ...evidence, protocol: undefined }));
  await app?.close();
  await new Promise<void>((resolve) => site.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}
