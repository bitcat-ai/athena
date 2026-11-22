/** Built Electron renderer → real IPC/host → fake OpenAI + fake Codex. No real credentials or model calls. */
import assert from 'node:assert/strict';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import type { AppSnapshot, Conversation } from '../src/shared/types';

const root = process.cwd();
await access(path.join(root, 'dist/main/main.cjs'));
await mkdir(path.join(root, '.runtime'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.runtime/live-host-'));
const dataDir = path.join(directory, 'data');
const bin = path.join(directory, 'bin');
const log = path.join(directory, 'protocol.jsonl');
await seedLegacyWorkspace(dataDir);
await mkdir(bin, { recursive: true });
await writeFile(log, '');
const fakeCodex = path.join(bin, 'codex');
await writeFile(
  fakeCodex,
  `#!${process.execPath}\n` +
    String.raw`
import fs from 'node:fs';
import readline from 'node:readline';
if(process.argv.includes('--version')){console.log('codex-cli live-fixture');process.exit(0)}
if(process.argv[2]!=='app-server')process.exit(0);
const threadId='voice-thread';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const event=(method,params)=>send({method,params});
let current='';let number=0;
const tool = (id, name, args) => send({id,method:'item/tool/call',params:{threadId,turnId:current,callId:'voice-'+id,tool:name,arguments:args}});
const finish=(text,status='completed')=>{
 event('item/agentMessage/delta',{threadId,turnId:current,itemId:'answer-'+current,delta:text});
 event('item/completed',{threadId,turnId:current,item:{id:'answer-'+current,type:'agentMessage',text}});
 event('turn/completed',{threadId,turnId:current,turn:{id:current,status,items:[]}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);const params=request.params||{};
 fs.appendFileSync(process.env.ATHENA_VOICE_TEST_LOG,JSON.stringify(request)+'\n');
 if(request.method==='initialize')return send({id:request.id,result:{userAgent:'voice-fixture'}});
 if(request.method==='thread/start'||request.method==='thread/resume')return send({id:request.id,result:{thread:{id:threadId}}});
 if(request.method==='model/list')return send({id:request.id,result:{data:[]}});
 if(request.method==='skills/list')return send({id:request.id,result:{data:[]}});
 if(request.method==='turn/start'){
  current='voice-turn-'+(++number);
  send({id:request.id,result:{turn:{id:current,status:'inProgress'}}});
  event('turn/started',{threadId,turnId:current,turn:{id:current,status:'inProgress'}});
  const prompt=JSON.stringify(params.input);
  if(prompt.includes('hold-voice-task'))return;
  if(prompt.includes('approval-voice-task'))return send({id:42,method:'item/commandExecution/requestApproval',params:{threadId,turnId:current,itemId:'approval-item',command:'echo isolated-voice-test',reason:'仅验证语音任务沿用界面审批，不执行命令。'}});
  if(prompt.includes('read-voice-task')) return tool(61,'workbench_browser_query',{selector:'h1'});
  return finish('本轮无需操作。');
 }
 if([61,62,63].includes(request.id)) {
  if(!request.result?.success) return finish('工具执行失败：'+JSON.stringify(request.result));
  if(request.id===62)return tool(63,'workbench_browser_query',{selector:'h1'});
  const heading=JSON.parse(request.result.contentItems[0].text).elements[0];
  if(request.id===61)return tool(62,'workbench_browser_edit',{ref:heading.ref,text:'语音委托已生效'});
  return finish('重新读取标题：'+heading.text);
 }
 if(request.method==='turn/interrupt'){send({id:request.id,result:{}});return finish('语音任务已停止。','interrupted')}
 if(request.id===42&&request.result){event('serverRequest/resolved',{threadId,turnId:current,requestId:42});return finish(request.result.decision==='accept'?'已收到界面批准，隔离任务完成。':'已拒绝操作。')}
 if(request.method&&request.id!==undefined)return send({id:request.id,result:{}});
}).on('close',()=>process.exit(0));
`,
);
await chmod(fakeCodex, 0o700);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  WORKBENCH_USER_DATA_DIR: dataDir,
  ATHENA_VOICE_TEST_LOG: log,
};
for (const key of [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'WORKBENCH_DEV_SERVER_URL',
])
  delete env[key];
// Use the existing verified binary if available, with an isolated browser profile.
const cachedBrowser = path.resolve('.runtime/agent-browser/0.42.0/agent-browser-darwin-arm64');
await access(cachedBrowser)
  .then(() => {
    env.ATHENA_AGENT_BROWSER_PATH = cachedBrowser;
  })
  .catch(() => {});
let application: ElectronApplication | undefined;
const checks: string[] = [];
const errors: string[] = [];
try {
  const binary = process.env.ATHENA_APP_EXECUTABLE;
  application = await electron.launch({
    executablePath: binary,
    args: [
      ...(binary ? [] : ['tests/electron-background.cjs']),
      '--use-mock-keychain',
      '--use-fake-device-for-media-stream',
      '--mute-audio',
    ],
    cwd: root,
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.workbench));
  const invoke = <T = any>(action: string, payload?: unknown) =>
    page.evaluate(({ action, payload }) => window.workbench.invoke<T>(action, payload), {
      action,
      payload,
    });
  const snapshot = () => invoke<AppSnapshot>('app:snapshot');
  assert.equal((await snapshot()).agents.find((item) => item.id === 'codex')?.path, fakeCodex);
  assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), dataDir);
  await application.evaluate(({ net }) => {
    const requests: any[] = [];
    (globalThis as any).__voiceHttp = requests;
    net.fetch = async (url, options) => {
      const address = String(url);
      if (!address.startsWith('https://api.openai.com/v1/live/sessions'))
        throw new Error('unexpected fixture request');
      requests.push({
        url: address,
        method: options?.method,
        hasAuth: new Headers(options?.headers).has('Authorization'),
        body: options?.body,
      });
      return address.endsWith('/hangup')
        ? new Response(null, { status: 200 })
        : Response.json({
            session: { id: 'live_host_fixture' },
            transport: { type: 'webrtc', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' },
          });
    };
  });
  // All audio devices are Chromium fakes; no OS microphone is captured in this test.
  const permissions = await page.evaluate(async () => {
    const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
    const result = { audio: audio.getAudioTracks().length, videoDenied: false, frameDenied: false };
    audio.getTracks().forEach((track) => track.stop());
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      result.videoDenied = true;
    }
    const frame = document.createElement('iframe');
    frame.srcdoc = '<html><body>Permission fixture</body></html>';
    document.body.append(frame);
    await new Promise<void>((resolve) => {
      frame.onload = () => resolve();
    });
    try {
      const stream = await frame.contentWindow!.navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      result.frameDenied = true;
    }
    frame.remove();
    return result;
  });
  assert.deepEqual(permissions, { audio: 1, videoDenied: true, frameDenied: true });
  checks.push('Electron allows main-frame microphone only and rejects camera/iframe capture');
  await invoke('voice:configure', { key: 'sk-isolated-test-not-a-real-key' });
  const saved = await readFile(path.join(dataDir, 'live-voice/credentials.json'), 'utf8');
  assert.ok(!saved.includes('sk-isolated-test-not-a-real-key'));
  assert.deepEqual(await invoke('voice:config'), { configured: true, active: false });
  const initial = await snapshot();
  const conversation =
    initial.conversations.find((item) => item.id === initial.codexConnection?.conversationId) ??
    initial.conversations[0] ??
    (await invoke<Conversation>('conversation:new'));
  const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
  await invoke('voice:connect', {
    requestId: 'host_request',
    conversationId: conversation.id,
    sdp,
  });
  await assert.rejects(invoke('voice:configure', { key: 'sk-another-isolated-test-key' }), /结束/);
  assert.equal(await application.evaluate(() => (globalThis as any).__voiceHttp[0].hasAuth), true);
  checks.push(
    'built host stores encrypted credentials, creates authenticated Live request and blocks replacement during a call',
  );

  const delegate = (id: string, text: string, startMs: number) =>
    invoke<string>('voice:delegate', {
      requestId: 'host_request',
      delegationId: id,
      offsetMs: startMs + 100,
      transcripts: [{ role: 'user', text, startMs, endMs: startMs + 100 }],
    });
  await expect.poll(async () => (await snapshot()).browser.status, { timeout: 30000 }).toBe('ready');
  const original = await invoke('browser:query', { selector: 'h1' });
  assert.notEqual(original.elements[0]?.text, '语音委托已生效');
  const first = delegate('task_first', 'read-voice-task：修改并核对隔离页面标题', 0);
  const duplicate = delegate('task_first', 'read-voice-task：核对隔离项目', 0);
  assert.match(await first, /重新读取标题：语音委托已生效/);
  assert.equal(
    (await invoke('browser:query', { selector: 'h1' })).elements[0].text,
    '语音委托已生效',
  );
  assert.equal(await duplicate, await first);
  const recorded = (await snapshot()).conversations.find((item) => item.id === conversation.id)!;
  assert.equal(recorded.messages.length, 2);
  assert.match(recorded.messages[0].text, /核对隔离页面/);
  assert.match(recorded.messages[1].text, /重新读取标题：语音委托已生效/);
  const protocol = () =>
    readFile(log, 'utf8').then((text) =>
      text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  assert.equal((await protocol()).filter((request) => request.method === 'turn/start').length, 1);
  checks.push(
    'voice delegation drives the real browser edit through Codex tools, reads back the title, persists the result, and deduplicates the request',
  );

  const approval = delegate('task_approval', 'approval-voice-task：请求一次界面批准', 1000).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const panel = page.locator('.req[data-request-key]');
  await expect(panel.getByRole('button', { name: '允许这次', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  assert.match(await delegate('spoken_yes', '同意，执行', 1200), /尚未提交/);
  assert.equal((await snapshot()).pendingRequests?.length, 1);
  await panel.getByRole('button', { name: '允许这次', exact: true }).click();
  const approved = await approval;
  assert.ok('value' in approved, 'approval fixture must complete without a host error');
  assert.match(approved.value, /界面批准/);
  checks.push(
    'spoken yes cannot approve a task; normal Athena approval UI resolves the real host request',
  );

  const held = delegate('task_hold', 'hold-voice-task：等待停止', 2000).catch((error) =>
    String(error),
  );
  await expect
    .poll(
      async () => (await protocol()).filter((request) => request.method === 'turn/start').length,
      { timeout: 15_000 },
    )
    .toBe(3);
  await invoke('voice:disconnect', { requestId: 'host_request' });
  await held;
  assert.ok((await protocol()).some((request) => request.method === 'turn/interrupt'));
  await expect
    .poll(
      async () =>
        (await snapshot()).conversations
          .find((item) => item.id === conversation.id)!
          .messages.at(-1)!.status,
    )
    .not.toBe('streaming');
  assert.equal((await invoke('voice:config')).active, false);
  await assert.rejects(delegate('late_task', '不要重放', 3000), /已结束/);
  const interrupts = (await protocol()).filter(
    (request) => request.method === 'turn/interrupt',
  ).length;
  await invoke('voice:connect', { requestId: 'host_second', conversationId: conversation.id, sdp });
  await invoke('conversation:send', {
    id: conversation.id,
    text: 'hold-voice-task：这是键盘发起的任务',
  });
  await expect
    .poll(
      async () => (await protocol()).filter((request) => request.method === 'turn/start').length,
    )
    .toBe(4);
  await invoke('voice:disconnect', { requestId: 'host_second' });
  assert.equal(
    (await protocol()).filter((request) => request.method === 'turn/interrupt').length,
    interrupts,
  );
  assert.equal(
    (await snapshot()).conversations.find((item) => item.id === conversation.id)!.messages.at(-1)!
      .status,
    'streaming',
  );
  assert.equal(await invoke('conversation:stop', { conversationId: 'stale-conversation' }), false);
  assert.equal(
    (await protocol()).filter((request) => request.method === 'turn/interrupt').length,
    interrupts,
  );
  assert.equal(
    await invoke('conversation:stop', {
      conversationId: conversation.id,
      messageId: 'stale-message',
    }),
    false,
  );
  const message = (await snapshot()).conversations
    .find((item) => item.id === conversation.id)!
    .messages.at(-1)!;
  assert.equal(
    await invoke('conversation:stop', { conversationId: conversation.id, messageId: message.id }),
    true,
  );
  assert.equal(
    (await protocol()).filter((request) => request.method === 'turn/interrupt').length,
    interrupts + 1,
  );
  await invoke('conversation:stop');
  checks.push('only a stop from the running conversation can interrupt its task');
  checks.push(
    'hangup interrupts the voice-owned task, rejects late delegation and leaves a keyboard task running',
  );
  assert.deepEqual(errors, []);
  await mkdir(path.join(root, 'test-results/live-voice'), { recursive: true });
  await writeFile(
    path.join(root, 'test-results/live-voice/host-result.json'),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await application?.close();
  await rm(directory, { recursive: true, force: true });
}
