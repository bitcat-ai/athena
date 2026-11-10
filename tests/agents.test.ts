import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nodeShebang } from './node-script';
import {
  CodexSession,
  browserToolsFingerprint,
  createCodexUpdateChecker,
  detectAgents,
} from '../src/main/agents.ts';
import type { AgentEvent, AgentInfo, ElementDetails, ToolResult } from '../src/shared/types.ts';

async function fixture(
  options: {
    initializeDelayMs?: number;
    holdInitialize?: boolean;
    threadStartDelayMs?: number;
    waitForLogin?: boolean;
    loginMessage?: string;
    toolAggregatedOutput?: string;
    modelProtocol?: boolean;
    skillsResponse?: unknown;
    skills?: unknown[];
    skillsError?: { code: number; message: string };
  } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-agent-test-'));
  const executable = path.join(directory, 'codex');
  const log = path.join(directory, 'requests.jsonl');
  const code = `${nodeShebang()}
const fs = require('node:fs');
const readline = require('node:readline');
const log = ${JSON.stringify(log)};
const options = ${JSON.stringify(options)};
if (process.argv.includes('--version')) {
  if(options.waitForLogin) { setInterval(()=>{if(fs.existsSync(log+'.login')) {console.log('codex-cli test');process.exit(0);}},10); }
  else { console.log('codex-cli test'); process.exit(0); }
}
if (process.argv.includes('status')) {
  fs.writeFileSync(log+'.login','checked');
  fs.writeFileSync(log, JSON.stringify({apiKeyPresent:!!process.env.OPENAI_API_KEY}));
  console.error(options.loginMessage || 'Logged in using ChatGPT'); process.exit(0);
}
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const event = (method, params) => send({method, params});
let turn = 0, current, mode, pendingTool = false;
const finish = (status='completed', error) => event('turn/completed', {threadId:'thread-1',turn:{id:current,status,items:[],error}});
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 30));
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line); fs.appendFileSync(log, line+'\\n');
  const p = request.params || {};
  if (request.method === 'initialize') { if(options.holdInitialize)return; return setTimeout(()=>send({id:request.id,result:{userAgent:'fake-codex'}}),options.initializeDelayMs||0); }
  if (request.method === 'skills/list') return send({id:request.id,...(options.skillsError ? {error:options.skillsError} : {result:options.skillsResponse ?? {data:[{cwd:p.cwds[0],skills:options.skills ?? []}]}})});
  if (request.method === 'model/list') return send({id:request.id,result:{data:[
    {id:'catalog-a',model:'model-a',displayName:'Model A',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low',description:'Quick'}],defaultReasoningEffort:'low'},
    {id:'hidden',model:'hidden',hidden:true},
    ...(p.cursor ? [{id:'catalog-b',model:'model-b',displayName:'Model B',supportedReasoningEfforts:[],defaultReasoningEffort:'low'}] : [])
  ],nextCursor:p.cursor ? null : 'page-2'}});
  if (request.method === 'thread/start' && options.modelProtocol) return send({id:request.id,result:{thread:{id:'thread-1'},model:p.model,reasoningEffort:p.config?.model_reasoning_effort}});
  if (request.method === 'thread/start') return setTimeout(()=>send({id:request.id,result:{thread:{id:'thread-1'}}}),options.threadStartDelayMs||0);
  if (p.threadId?.startsWith('no-rollout-')) {
    const missing='no rollout found for thread id '+p.threadId;
    if(request.method==='thread/read') return send({id:request.id,error:{code:-32600,message:p.threadId==='no-rollout-auth'?'Permission denied':'thread not loaded: '+p.threadId}});
    if(request.method==='thread/resume') return send({id:request.id,error:{code:p.threadId==='no-rollout-code'?-32000:-32600,message:p.threadId==='no-rollout-wrong-id'?'no rollout found for thread id different':missing}});
  }
  if (request.method === 'thread/read') return send({id:request.id,result:{thread:{id:p.threadId,turns:p.threadId==='unused-warmed-thread'?[]:[{id:'existing-turn'}]}}});
  if (request.method === 'thread/resume') return p.threadId==='thread-1' ? send({id:request.id,result:{thread:{id:'thread-1'}}}) : send({id:request.id,error:{code:-32602,message:'Thread not found'}});
  if (request.method === 'turn/start') {
    current='turn-'+(++turn); mode=p.input[0].text.split('\\n')[0];
    if(mode==='pre-ack') {
      event('turn/started',{threadId:'thread-1',turn:{id:current,status:'inProgress'}});
      send({id:110,method:'item/tool/requestUserInput',params:{threadId:'thread-1',turnId:current,itemId:'pre-ack-input',isBlocking:true,questions:[{id:'choice',header:'选择',question:'Choose one',options:[{label:'A',description:''},{label:'B',description:''}]}]}});
      return setTimeout(()=>send({id:request.id,result:{turn:{id:current,status:'inProgress'}}}),30);
    }
    send({id:request.id,result:{turn:{id:current,status:'inProgress'}}});
    event('turn/started',{threadId:'thread-1',turn:{id:current,status:'inProgress'}});
    if(mode==='tool-after-completion') {
      finish();
      return send({id:101,method:'item/tool/call',params:{threadId:'thread-1',turnId:current,callId:'too-late',tool:'browser_snapshot',arguments:{}}});
    }
    if(mode==='usage') {
      const count={inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0};
      event('thread/tokenUsage/updated',{threadId:'foreign',turnId:current,tokenUsage:{total:count,last:count}});
      event('thread/tokenUsage/updated',{threadId:'thread-1',turnId:'unknown',tokenUsage:{total:count,last:count}});
      event('thread/tokenUsage/updated',{threadId:'thread-1',turnId:current,tokenUsage:{total:count,last:count}});
      event('model/rerouted',{threadId:'thread-1',turnId:current,fromModel:p.model,toModel:'fallback',reason:'unknown'});
      return finish();
    }
    if(mode==='fail') return finish('failed',{message:'model unavailable'});
    if(mode==='plan') {
      event('turn/plan/updated',{threadId:'another-thread',turnId:current,plan:[{step:'foreign',status:'completed'}]});
      event('turn/plan/updated',{threadId:'thread-1',turnId:'old-turn',plan:[{step:'old',status:'completed'}]});
      event('turn/plan/updated',{threadId:'thread-1',turnId:current,plan:[{step:'invalid',status:'invented'}]});
      event('turn/plan/updated',{threadId:'thread-1',turnId:current,explanation:'not public reasoning',plan:[{step:'Read receipt',status:'inProgress',privateField:'do not forward'}]});
    }
    if(mode==='fatal-error') return event('error',{threadId:'thread-1',turnId:current,error:{message:'connection lost'},willRetry:false});
    if(mode==='exit') return process.exit(7);
    if(mode==='cancel'||mode==='cancel-ack-only') { event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'cancel-wait',delta:'Waiting for cancellation'}); return; }
    if(mode==='descendant') {
      const descendant=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      fs.writeFileSync(log+'.pid',String(descendant.pid));
      event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'child-wait',delta:'Child running'});return;
    }
    if(mode==='late-terminal') {
      event('turn/started',{threadId:'thread-1',turn:{id:'previous-turn',status:'inProgress'}});
      event('turn/completed',{threadId:'thread-1',turn:{id:'previous-turn',status:'completed',items:[]}});
    }
    if(mode==='exit-code') event('item/completed',{threadId:'thread-1',turnId:current,item:{id:'failed-command',type:'commandExecution',status:'completed',command:'npm test',exitCode:2,aggregatedOutput:'test failed'}});
    if(mode==='file-approval') {
      event('item/started',{threadId:'thread-1',turnId:current,item:{id:'file-1',type:'fileChange',status:'inProgress',changes:[{path:${JSON.stringify(path.join(directory, 'index.html'))},kind:{type:'update'},diff:'-Old label\\n+New label'}]}});
      return send({id:120,method:'item/fileChange/requestApproval',params:{threadId:'thread-1',turnId:current,itemId:'file-1',startedAtMs:Date.now(),grantRoot:null}});
    }
    if(mode==='approval'||mode==='approval-retracted'||mode==='approval-with-tool') {
      send({id:100,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:current,itemId:'command-1',command:'touch example.txt',cwd:${JSON.stringify(directory)}}});
      if(mode==='approval-retracted') { event('serverRequest/resolved',{threadId:'thread-1',requestId:100}); finish(); }
      if(mode==='approval-with-tool') event('item/started',{threadId:'thread-1',turnId:current,item:{id:'parallel-tool',type:'commandExecution',status:'inProgress',command:'test fixture'}});
      return;
    }
    if(mode.startsWith('question')) {
      const questions=[
        {id:'route',header:'路径',question:'请选择实现路径',options:[{label:'Small',description:'最小实现'},{label:'Full',description:'完整实现'}],isOther:mode==='question-other'},
        {id:'note',header:'备注',question:'请输入补充说明',isSecret:mode==='question-secret',options:null}
      ];
      if(mode==='question-malformed') questions[1].id='route';
      send({id:110,method:'item/tool/requestUserInput',params:{threadId:mode==='question-foreign'?'another-thread':'thread-1',turnId:current,itemId:'question-1',isBlocking:true,autoResolutionMs:1,questions}});
      if(mode==='question-retracted') { event('serverRequest/resolved',{threadId:'thread-1',requestId:110}); finish(); }
      if(mode==='question-foreign-resolved') event('serverRequest/resolved',{threadId:'another-thread',requestId:110});
      return;
    }
    if(mode==='tool-failure') {
      const args={ref:'fixture-button',styles:{'background-image':'linear-gradient(90deg, black, white)'}};
      event('item/started',{threadId:'thread-1',turnId:current,item:{id:'tool-1',type:'dynamicToolCall',tool:'workbench_browser_edit',arguments:args,status:'inProgress'}});
      return send({id:101,method:'item/tool/call',params:{threadId:'thread-1',turnId:current,callId:'tool-1',tool:'workbench_browser_edit',arguments:args}});
    }
    if(mode==='duplicate-tool') {
      for(const id of [101,102]) send({id,method:'item/tool/call',params:{threadId:'thread-1',turnId:current,callId:'same-action',tool:'browser_snapshot',arguments:{}}});
      return;
    }
    if(mode==='tool'||mode==='unknown'||mode==='pending-tool'||mode==='foreign-tool') {
      pendingTool=mode==='pending-tool';
      return send({id:101,method:'item/tool/call',params:{threadId:'thread-1',turnId:mode==='foreign-tool'?'previous-turn':current,callId:'tool-1',tool:mode==='unknown'?'read_secret':'browser_snapshot',arguments:{}}});
    }
    event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'message-'+turn,delta:'Hello'});
    event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'message-'+turn,delta:' world'});
    event('item/completed',{threadId:'thread-1',turnId:current,item:{id:'message-'+turn,type:'agentMessage',text:'Hello world'}});
    return finish();
  }
  if(request.method==='turn/interrupt') { send({id:request.id,result:{}}); if(mode==='cancel-ack-only') return; return finish('interrupted'); }
  if(request.id===100 && 'result' in request) { event('serverRequest/resolved',{threadId:'thread-1',requestId:100}); event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'approval-result',delta:request.result.decision}); return finish(); }
  if(request.id===110 && ('result' in request || 'error' in request)) { event('serverRequest/resolved',{threadId:'thread-1',requestId:110}); event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'input-result',delta:'Answers handled'}); return finish(); }
  if(request.id===120 && 'result' in request) return finish();
  if(request.id===101 && 'result' in request && mode==='tool-failure') {
    const item={id:'tool-1',type:'dynamicToolCall',tool:'workbench_browser_edit',status:'failed',success:request.result.success};
    if(typeof options.toolAggregatedOutput==='string') item.aggregatedOutput=options.toolAggregatedOutput;
    event('item/completed',{threadId:'thread-1',turnId:current,item});
    event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'failure-explanation',delta:'未修改页面：'+request.result.contentItems[0].text});
    return finish();
  }
  if(request.id===101 && 'result' in request && !pendingTool) { event('item/agentMessage/delta',{threadId:'thread-1',turnId:current,itemId:'tool-result',delta:request.result.success?'tool succeeded':'tool rejected'}); return finish(); }
});
`;
  await writeFile(executable, code);
  await chmod(executable, 0o700);
  return {
    directory,
    executable,
    log,
    async requests() {
      return (
        await readFile(log, 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        })
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for protocol event');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function session(
  f: Awaited<ReturnType<typeof fixture>>,
  events: AgentEvent[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult> = async () => ({
    text: 'snapshot',
  }),
  sessionId?: string,
  overrides: Partial<ConstructorParameters<typeof CodexSession>[0]> = {},
) {
  const tools = [
    {
      name: 'browser_snapshot',
      description: 'Read the current browser',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
  return new CodexSession({
    workspace: f.directory,
    executablePath: f.executable,
    sessionId,
    sessionToolsFingerprint: sessionId ? browserToolsFingerprint(tools) : undefined,
    tools,
    callTool,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
}

test('Codex discovers enabled skills for the effective cwd without starting a model turn', async (t) => {
  const f = await fixture({ skills: [
    { name: 'review', path: '/opt/codex/global/review/SKILL.md', enabled: true, description: 'Review code', interface: { shortDescription: 'Review' } },
    { name: 'disabled', path: '/opt/codex/disabled/SKILL.md', enabled: false },
  ] });
  const agent = session(f, []);
  t.after(() => { agent.close(); return f.cleanup(); });
  const discovery = await agent.discoverProviderSkills();
  assert.equal(discovery.status, 'ready');
  assert.deepEqual(discovery.skills, [{ name: 'review', description: 'Review code', shortDescription: 'Review', providerPath: '/opt/codex/global/review/SKILL.md', contentHash: undefined, userInvocable: true, source: 'provider', provider: { id: 'codex', name: 'Codex' } }]);
  const requests = await f.requests();
  assert.deepEqual(requests.find(r => r.method === 'skills/list').params, { cwds: [f.directory] });
  assert.ok(requests.findIndex(r => r.method === 'initialized') < requests.findIndex(r => r.method === 'skills/list'));
  assert.equal(requests.some(r => r.method === 'thread/start' || r.method === 'turn/start'), false);
});

test('Codex discovery preserves failure states and never borrows a different cwd', async (t) => {
  for (const [options, expected] of [
    [{ skillsResponse: { data: [{ cwd: '/other', skills: [{ name: 'wrong', enabled: true }] }] } }, 'malformed'],
    [{ skillsResponse: { data: [{ cwd: '/other', skills: [] }] } }, 'malformed'],
    [{ skillsError: { code: -32601, message: 'Method not found' } }, 'unsupported'],
    [{ skillsError: { code: -32000, message: 'Unauthorized: please run codex login' } }, 'unavailable'],
    [{ skillsError: { code: -32000, message: 'Unavailable' } }, 'unavailable'],
    [{ skills: [] }, 'empty'],
  ] as Array<[Parameters<typeof fixture>[0], string]>) {
    const f = await fixture(options);
    const agent = session(f, []);
    try {
      const result = await agent.discoverProviderSkills();
      assert.equal(result.status, expected);
      assert.deepEqual(result.skills, []);
      if (options?.skillsError?.message.includes('Unauthorized'))
        assert.match(result.diagnostics[0]?.message ?? '', /请先在终端登录 Codex，再刷新连接/);
    } finally { agent.close(); await f.cleanup(); }
  }
});

test('Codex sends selected skills as native mentions, not page context', async (t) => {
  const f = await fixture();
  const agent = session(f, []);
  t.after(() => { agent.close(); return f.cleanup(); });
  await agent.send('Check the changes', 'Current page', undefined, undefined, [{
    name: 'review', provider: { id: 'codex', name: 'Codex' }, source: 'provider',
    providerPath: '/opt/codex/review/SKILL.md', description: 'Review', userInvocable: true,
  }]);
  const turn = (await f.requests()).find(r => r.method === 'turn/start');
  assert.deepEqual(turn.params.input, [{ type: 'text', text: '$review\n\nCheck the changes\n\n<page_context>\nCurrent page\n</page_context>' }]);
  await agent.send('No skill');
  const turns = (await f.requests()).filter(r => r.method === 'turn/start');
  assert.deepEqual(turns[1].params.input, [{ type: 'text', text: 'No skill' }]);
});

test('preparing a session initializes once without a model turn and is reused by later sends', async (t) => {
  const f = await fixture({ initializeDelayMs: 30, threadStartDelayMs: 30 });
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await Promise.all([agent.prepare(), agent.prepare(), agent.listModels()]);
  const prepared = await f.requests();
  assert.equal(prepared.filter((r) => r.method === 'initialize').length, 1);
  assert.equal(prepared.filter((r) => r.method === 'thread/start').length, 1);
  assert.equal(prepared.filter((r) => r.method === 'turn/start').length, 0);
  assert.equal(agent.sessionId, undefined, 'a prewarm has no accepted turn to persist');
  await agent.send('hello');
  await agent.send('hello again');
  const sent = await f.requests();
  assert.equal(sent.filter((r) => r.method === 'initialize').length, 1);
  assert.equal(sent.filter((r) => r.method === 'thread/start').length, 1);
  assert.equal(sent.filter((r) => r.method === 'turn/start').length, 2);
  assert(!events.some((e) => e.type === 'status' && e.label === '连接本机 Codex'));
});

test('closing a prewarm rejects its handshake and cannot create a late thread', async (t) => {
  const f = await fixture({ holdInitialize: true });
  const agent = session(f, []);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const warming = assert.rejects(agent.prepare(), /关闭/);
  await waitFor(async () => (await f.requests()).some((r) => r.method === 'initialize'), 10000);
  agent.close();
  await warming;
  assert.equal(
    (await f.requests()).some((r) => r.method === 'thread/start'),
    false,
  );
});

test('a model change during prewarm uses the new turn selection without reconnecting', async (t) => {
  const f = await fixture({ threadStartDelayMs: 80, modelProtocol: true });
  const agent = session(f, []);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const ready = agent.prepare({ model: 'model-a', effort: 'low' });
  await waitFor(async () => (await f.requests()).some((r) => r.method === 'thread/start'));
  const turn = agent.send('hello', undefined, undefined, { model: 'model-b' });
  await Promise.all([ready, turn]);
  const requests = await f.requests();
  assert.equal(requests.filter((r) => r.method === 'initialize').length, 1);
  assert.equal(requests.find((r) => r.method === 'thread/start').params.model, 'model-a');
  assert.equal(requests.find((r) => r.method === 'turn/start').params.model, 'model-b');
});

test('structured streaming uses existing CLI and restrictive per-process configuration', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('hello', 'Selected page');
  assert.equal(agent.sessionId, 'thread-1');
  assert.equal(
    events
      .filter((event) => event.type === 'delta')
      .map((event) => event.text)
      .join(''),
    'Hello world',
  );
  assert.equal(events.filter((event) => event.type === 'complete').length, 1);
  const requests = await f.requests();
  const start = requests.find((request) => request.method === 'thread/start').params;
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'untrusted');
  assert.equal(start.approvalsReviewer, 'user');
  assert.equal(start.model, undefined);
  assert.deepEqual(start.config.mcp_servers, {});
  assert.equal(start.config.features.plugins, false);
  assert.equal(start.config.features.default_mode_request_user_input, true);
  assert.deepEqual(start.environments, [
    { environmentId: 'local', cwd: f.directory, runtimeWorkspaceRoots: [f.directory] },
  ]);
  assert.deepEqual(
    requests.find((request) => request.method === 'turn/start').params.environments,
    start.environments,
  );
  assert.equal(start.dynamicTools[0].type, 'function');
  assert.match(start.developerInstructions, /exact tabId, frameId, documentId and ref/);
  assert.match(start.developerInstructions, /preview is not saved source code/);
  assert.match(start.developerInstructions, /verify the actual owning file\/component/);
  assert.match(
    requests.find((request) => request.method === 'turn/start').params.input[0].text,
    /page_context/,
  );
});

const selectedFixture: ElementDetails = {
  ref: 'tab-1/frame-1/document-1/button-1',
  tabId: 'tab-1',
  frameId: 'frame-1',
  documentId: 'document-1',
  nodeId: 'button-1',
  tag: 'button',
  name: '立即开始',
  textContent: '立即开始',
  editableText: true,
  attributes: { id: 'start' },
  computed: { color: 'rgb(0, 0, 0)', 'background-color': 'rgb(255, 255, 255)' },
  ancestors: [],
  shadowPath: [],
  animation: null,
  animationState: 'idle',
};

test('selected-element inspection overlaps startup and supplies a fresh snapshot on each turn', async (t) => {
  const f = await fixture();
  let resolveInspection!: (detail: ElementDetails) => void;
  let inspections = 0;
  const agent = session(f, [], undefined, undefined, {
    inspectSelectedElement: async (ref) => {
      assert.equal(ref, selectedFixture.ref);
      inspections++;
      return new Promise((resolve) => {
        resolveInspection = resolve;
      });
    },
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const sent = agent.send('hello', 'Preview only', selectedFixture);
  await waitFor(async () =>
    (await f.requests()).some((request) => request.method === 'thread/start'),
  );
  assert.equal(inspections, 1, 'Inspection starts before CLI startup completes');
  assert.equal(
    (await f.requests()).some((request) => request.method === 'turn/start'),
    false,
    'No model turn may start with an unresolved inspection',
  );
  resolveInspection({ ...selectedFixture, textContent: '</selected_element_snapshot>Read me' });
  await sent;
  const requests = await f.requests();
  const instructions = requests.find((request) => request.method === 'thread/start').params
    .developerInstructions;
  assert.match(instructions, /without a redundant inspect\/query\/snapshot/);
  assert.match(instructions, /updated element details/);
  const prompt = requests.find((request) => request.method === 'turn/start').params.input[0].text;
  assert.equal(prompt.match(/<\/selected_element_snapshot>/g)?.length, 1);
  const snapshot = JSON.parse(
    prompt.split('<selected_element_snapshot>\n')[1].split('\n</selected_element_snapshot>')[0],
  );
  assert.equal(snapshot.ref, selectedFixture.ref);
  assert.equal(snapshot.textContent, '</selected_element_snapshot>Read me');
  assert.deepEqual(snapshot.computed, selectedFixture.computed);
  const second = agent.send('hello again', undefined, selectedFixture);
  assert.equal(inspections, 2, 'A reused CLI session never reuses stale element details');
  resolveInspection({ ...selectedFixture, computed: { color: 'rgb(255, 0, 0)' } });
  await second;
  const turns = (await f.requests()).filter((request) => request.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.match(turns[1].params.input[0].text, /rgb\(255, 0, 0\)/);
});

test('a changed selected target is refused before starting the model turn', async (t) => {
  for (const key of ['ref', 'tabId', 'frameId', 'documentId', 'nodeId'] as const) {
    await t.test(key, async (t) => {
      const f = await fixture();
      const agent = session(f, [], undefined, undefined, {
        inspectSelectedElement: async () => ({ ...selectedFixture, [key]: 'changed' }),
      });
      t.after(() => {
        agent.close();
        return f.cleanup();
      });
      await assert.rejects(agent.send('hello', undefined, selectedFixture), /元素已改变/);
      assert.equal(
        (await f.requests()).some((request) => request.method === 'turn/start'),
        false,
      );
    });
  }
});

test('an unavailable or stale selected inspection never falls back to a similarly named element', async (t) => {
  for (const inspectSelectedElement of [
    undefined,
    async () => {
      throw new Error('元素引用已失效');
    },
  ]) {
    const f = await fixture();
    const agent = session(f, [], undefined, undefined, { inspectSelectedElement });
    t.after(() => {
      agent.close();
      return f.cleanup();
    });
    await assert.rejects(agent.send('hello', undefined, selectedFixture), /所选元素|引用已失效/);
    assert.equal(
      (await f.requests()).some((request) => request.method === 'turn/start'),
      false,
    );
  }
});

test('canceling while the selected-element inspection is pending cannot start a late turn', async (t) => {
  const f = await fixture();
  let resolveInspection!: (detail: ElementDetails) => void;
  const agent = session(f, [], undefined, undefined, {
    inspectSelectedElement: async () =>
      new Promise((resolve) => {
        resolveInspection = resolve;
      }),
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const stopped = assert.rejects(agent.send('hello', undefined, selectedFixture), /任务已停止/);
  await waitFor(async () =>
    (await f.requests()).some((request) => request.method === 'thread/start'),
  );
  await agent.interrupt();
  resolveInspection(selectedFixture);
  await stopped;
  assert.equal(
    (await f.requests()).some((request) => request.method === 'turn/start'),
    false,
  );
});

test('browser tool bridge returns text and screenshot in the actual app-server schema', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  let calls = 0;
  const agent = session(f, events, async (name, args) => {
    calls++;
    assert.equal(name, 'browser_snapshot');
    assert.deepEqual(args, {});
    return { text: 'Current page', image: 'iVBORw0KGgo=' };
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('tool');
  const reply = (await f.requests()).find((request) => request.id === 101 && request.result);
  assert.equal(calls, 1);
  assert.equal(reply.result.success, true);
  assert.deepEqual(
    reply.result.contentItems.map((item: { type: string }) => item.type),
    ['inputText', 'inputImage'],
  );
  assert.equal(reply.result.contentItems[1].imageUrl, 'data:image/png;base64,iVBORw0KGgo=');
  assert.ok(events.some((event) => event.type === 'tool' && event.call.status === 'done'));
});

test('dynamic tool completion preserves detailed rejection output while the explanation can complete', async (t) => {
  const detail = 'Unsupported CSS property or value: background-image';
  for (const [name, aggregatedOutput] of [
    ['missing aggregate', undefined],
    ['empty aggregate', ''],
    ['nonempty aggregate takes precedence', 'Final tool diagnostic: background-image was rejected'],
  ] as const) {
    await t.test(name, async (t) => {
      const f = await fixture({ toolAggregatedOutput: aggregatedOutput });
      const events: AgentEvent[] = [];
      const agent = session(
        f,
        events,
        async (name, args) => {
          assert.equal(name, 'workbench_browser_edit');
          assert.deepEqual(args, {
            ref: 'fixture-button',
            styles: { 'background-image': 'linear-gradient(90deg, black, white)' },
          });
          return { isError: true, text: detail };
        },
        undefined,
        {
          tools: [
            {
              name: 'workbench_browser_edit',
              description: 'Edit the fixture element',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      );
      t.after(() => {
        agent.close();
        return f.cleanup();
      });
      await agent.send('tool-failure');
      const reply = (await f.requests()).find((request) => request.id === 101 && request.result);
      assert.equal(reply.result.success, false);
      assert.equal(
        reply.result.contentItems[0].text,
        detail,
        'The CLI receives the original rejection',
      );
      const updates = events
        .filter((event) => event.type === 'tool')
        .filter((event) => event.call.id === 'tool-1');
      assert.equal(
        updates.at(-2)?.call.output,
        detail,
        'The host callback initially emits the specific error',
      );
      const stored = updates.at(-1)!.call;
      assert.equal(stored.status, 'error');
      assert.equal(
        stored.output,
        aggregatedOutput || detail,
        'The final upsert must not replace the diagnostic with a generic failure',
      );
      const complete = events.find((event) => event.type === 'complete');
      assert.ok(complete?.type === 'complete');
      assert.equal(complete.text, `未修改页面：${detail}`);
      assert.equal(
        events.some((event) => event.type === 'error'),
        false,
        'A completed failure explanation is not a fatal turn error',
      );
    });
  }
});

test('unknown dynamic tools are refused without calling the host', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  let calls = 0;
  const agent = session(f, events, async () => {
    calls++;
    return { text: 'unexpected' };
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('unknown');
  const reply = (await f.requests()).find((request) => request.id === 101 && request.result);
  assert.equal(calls, 0);
  assert.equal(reply.result.success, false);
});

test('command approval waits for an explicit decision and declines correctly', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const sent = agent.send('approval');
  await waitFor(() => events.some((event) => event.type === 'approval'));
  assert.equal(
    (await f.requests()).some((request) => request.id === 100 && request.result),
    false,
  );
  const approval = events.find((event) => event.type === 'approval');
  assert.ok(approval && approval.type === 'approval');
  agent.resolveApproval(approval.request.id, false);
  await sent;
  assert.equal(
    (await f.requests()).find((request) => request.id === 100 && request.result).result.decision,
    'decline',
  );
  assert.throws(() => agent.resolveApproval(approval.request.id, true), /不存在/);
  assert.equal(
    events.filter((event) => event.type === 'request-resolved' && event.id === approval.request.id)
      .length,
    1,
    'The local answer and server acknowledgement must not resolve the UI request twice',
  );
});

test('questions wait for an explicit validated answer and use the app-server answer envelope', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const sent = agent.send('question');
  await waitFor(() => events.some((event) => event.type === 'user-input'));
  const input = events.find((event) => event.type === 'user-input');
  assert.ok(input && input.type === 'user-input');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    (await f.requests()).some((request) => request.id === 110 && request.result),
    false,
  );
  assert.throws(
    () => agent.resolveUserInput('wrong-request', { route: ['Small'], note: ['ok'] }),
    /不存在/,
  );
  assert.throws(() => agent.resolveUserInput(input.request.id, { route: ['Small'] }), /每一个/);
  assert.throws(
    () =>
      agent.resolveUserInput(input.request.id, { route: ['Small'], note: ['ok'], extra: ['x'] }),
    /未知/,
  );
  assert.throws(
    () => agent.resolveUserInput(input.request.id, { route: ['Unknown'], note: ['ok'] }),
    /选项/,
  );
  assert.throws(
    () =>
      agent.resolveUserInput(input.request.id, { route: ['Small'], note: ['x'.repeat(20_001)] }),
    /最多/,
  );
  assert.throws(
    () => agent.resolveUserInput(input.request.id, { route: ['Small', 'Small'], note: ['ok'] }),
    /不重复/,
  );
  input.request.questions[0].isOther = true;
  assert.throws(
    () => agent.resolveUserInput(input.request.id, { route: ['Mutated'], note: ['ok'] }),
    /选项/,
    'UI event mutation must not change the validation policy',
  );
  agent.resolveUserInput(input.request.id, { route: ['Small'], note: ['用户提供的补充说明'] });
  await sent;
  const reply = (await f.requests()).find((request) => request.id === 110 && request.result);
  assert.deepEqual(reply.result, {
    answers: { route: { answers: ['Small'] }, note: { answers: ['用户提供的补充说明'] } },
  });
  assert.equal(
    events.filter((event) => event.type === 'request-resolved' && event.id === input.request.id)
      .length,
    1,
  );
  assert.throws(
    () => agent.resolveUserInput(input.request.id, { route: ['Small'], note: ['late'] }),
    /不存在/,
  );
});

test('explicit Other questions accept free text and secret answers never enter events', async (t) => {
  for (const mode of ['question-other', 'question-secret']) {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const agent = session(f, events);
    t.after(() => {
      agent.close();
      return f.cleanup();
    });
    const sent = agent.send(mode);
    await waitFor(() => events.some((event) => event.type === 'user-input'));
    const input = events.find((event) => event.type === 'user-input');
    assert.ok(input && input.type === 'user-input');
    const answer = mode === 'question-secret' ? 'FAKE_SECRET_VALUE_NOT_FOR_LOGS' : '自由补充说明';
    assert.equal(input.request.questions[1].isSecret, mode === 'question-secret');
    assert.equal(input.request.questions[0].isOther, mode === 'question-other');
    agent.resolveUserInput(input.request.id, {
      route: [mode === 'question-other' ? 'Custom approach' : 'Full'],
      note: [answer],
    });
    await sent;
    assert.equal(JSON.stringify(events).includes(answer), false);
  }
});

test('server withdrawal resolves approvals and questions without an invented response', async (t) => {
  for (const mode of ['approval-retracted', 'question-retracted']) {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const agent = session(f, events);
    t.after(() => {
      agent.close();
      return f.cleanup();
    });
    await agent.send(mode);
    const request = events.find(
      (event) => event.type === 'approval' || event.type === 'user-input',
    );
    assert.ok(request && (request.type === 'approval' || request.type === 'user-input'));
    assert.equal(
      events.filter((event) => event.type === 'request-resolved' && event.id === request.request.id)
        .length,
      1,
    );
    if (request.type === 'approval')
      assert.throws(() => agent.resolveApproval(request.request.id, true), /不存在/);
    else
      assert.throws(
        () => agent.resolveUserInput(request.request.id, { route: ['Full'], note: ['late'] }),
        /不存在/,
      );
    const rpcId = mode === 'approval-retracted' ? 100 : 110;
    assert.equal(
      (await f.requests()).some((message) => message.id === rpcId && message.result),
      false,
    );
  }
});

test('foreign-thread resolution cannot remove the active question', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const sent = agent.send('question-foreign-resolved');
  await waitFor(() => events.some((event) => event.type === 'user-input'));
  const input = events.find((event) => event.type === 'user-input');
  assert.ok(input && input.type === 'user-input');
  assert.equal(
    events.some((event) => event.type === 'request-resolved'),
    false,
  );
  agent.resolveUserInput(input.request.id, { route: ['Small'], note: ['ok'] });
  await sent;
});

test('malformed and foreign-thread questions never reach the UI', async (t) => {
  for (const mode of ['question-malformed', 'question-foreign']) {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const agent = session(f, events);
    t.after(() => {
      agent.close();
      return f.cleanup();
    });
    await agent.send(mode);
    assert.equal(
      events.some((event) => event.type === 'user-input'),
      false,
    );
    const reply = (await f.requests()).find((request) => request.id === 110);
    if (mode === 'question-malformed') assert.equal(reply.error.code, -32602);
    else assert.deepEqual(reply.result, { answers: {} });
  }
});

test('interrupt and close clear pending questions with empty answers and no successful completion', async (t) => {
  for (const operation of ['interrupt', 'close'] as const) {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const agent = session(f, events);
    t.after(() => {
      agent.close();
      return f.cleanup();
    });
    const stopped = assert.rejects(
      agent.send('question'),
      operation === 'close' ? /已关闭/ : /已停止/,
    );
    await waitFor(() => events.some((event) => event.type === 'user-input'));
    const input = events.find((event) => event.type === 'user-input');
    assert.ok(input && input.type === 'user-input');
    await agent[operation]();
    await stopped;
    await waitFor(async () =>
      (await f.requests()).some((request) => request.id === 110 && request.result),
    );
    const reply = (await f.requests()).find((request) => request.id === 110 && request.result);
    assert.deepEqual(reply.result, { answers: {} });
    assert.equal(
      events.filter((event) => event.type === 'request-resolved' && event.id === input.request.id)
        .length,
      1,
    );
    assert.equal(
      events.some((event) => event.type === 'complete'),
      false,
    );
    assert.throws(
      () => agent.resolveUserInput(input.request.id, { route: ['Full'], note: ['late'] }),
      /不存在/,
    );
  }
});

test('failed and canceled turns reject and never emit a successful completion', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await assert.rejects(agent.send('fail'), /model unavailable/);
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
  const canceled = assert.rejects(agent.send('cancel'), /任务已停止/);
  await waitFor(() =>
    events.some((event) => event.type === 'delta' && event.text === 'Waiting for cancellation'),
  );
  await agent.interrupt();
  await canceled;
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
  await agent.send('hello');
  assert.equal(events.filter((event) => event.type === 'complete').length, 1);
});

test('canceling a pending tool prevents its late result from reporting success', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  let release!: (result: ToolResult) => void;
  const agent = session(
    f,
    events,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const canceled = assert.rejects(agent.send('pending-tool'), /任务已停止/);
  await waitFor(() => !!release);
  await agent.interrupt();
  await canceled;
  const eventCount = events.length;
  release({ text: 'late success' });
  await waitFor(async () =>
    (await f.requests()).some((request) => request.id === 101 && request.result),
  );
  assert.equal(
    events.slice(eventCount).some((event) => event.type === 'tool'),
    false,
    'A late tool must not attach itself to a later turn',
  );
  assert.equal(
    (await f.requests()).find((request) => request.id === 101 && request.result).result.success,
    false,
  );
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
});

test('unexpected CLI exit rejects active work', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await assert.rejects(agent.send('exit'), /进程已退出/);
  assert.equal(agent.isClosed, true);
  assert.equal(agent.sessionId, 'thread-1');
  const replacement = session(f, [], undefined, agent.sessionId, {
    sessionToolsFingerprint: agent.toolsFingerprint,
  });
  t.after(() => replacement.close());
  await replacement.send('hello');
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
});

test('a fatal stream error closes the connection instead of leaving an unknown live turn', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await assert.rejects(agent.send('fatal-error'), /connection lost/);
  assert.equal(agent.isClosed, true);
  assert.equal(agent.sessionId, 'thread-1');
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
});

test('tool fingerprints ignore object and tool ordering but include schema changes', () => {
  const a = {
    name: 'a',
    description: 'A',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  };
  const b = { name: 'b', description: 'B', inputSchema: { properties: {}, type: 'object' } };
  assert.equal(
    browserToolsFingerprint([a, b]),
    browserToolsFingerprint([{ ...b, inputSchema: { type: 'object', properties: {} } }, a]),
  );
  assert.notEqual(
    browserToolsFingerprint([a]),
    browserToolsFingerprint([
      { ...a, inputSchema: { type: 'object', properties: { count: { type: 'number' } } } },
    ]),
  );
});

test('old tools upgrade into a disclosed new execution session with preserved visible history', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events, undefined, 'legacy-thread', {
    sessionToolsFingerprint: browserToolsFingerprint([]),
    historyForToolUpgrade: JSON.stringify([
      { role: 'user', text: 'Only edit the checkout button.' },
      { role: 'assistant', text: 'The source is checkout.html.' },
    ]),
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('Continue using the new tools');
  const requests = await f.requests();
  assert.equal(
    requests.some((request) => request.method === 'thread/resume'),
    false,
  );
  assert.equal(requests.filter((request) => request.method === 'thread/start').length, 1);
  assert.match(
    requests.find((request) => request.method === 'turn/start').params.input[0].text,
    /conversation_history[\s\S]*checkout\.html/,
  );
  assert.equal(agent.sessionId, 'thread-1');
  assert.equal(agent.replacedSessionId, 'legacy-thread');
  assert.notEqual(agent.toolsFingerprint, browserToolsFingerprint([]));
  assert.ok(
    events.some((event) => event.type === 'status' && /保留原会话/.test(event.label ?? '')),
  );
  await agent.send('A later turn');
  const turns = (await f.requests()).filter((request) => request.method === 'turn/start');
  assert.equal(turns[1].params.input[0].text.includes('conversation_history'), false);
});

test('unknown tool versions require visible history and never silently replace the saved session', async (t) => {
  const f = await fixture();
  const agent = session(f, [], undefined, 'legacy-thread', { sessionToolsFingerprint: undefined });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await assert.rejects(agent.send('continue'), /需要已保存的可见对话历史/);
  assert.equal(agent.sessionId, 'legacy-thread');
  assert.equal(agent.toolsFingerprint, undefined);
  assert.equal(agent.replacedSessionId, undefined);
  assert.deepEqual(await f.requests(), []);
});

test('a saved empty prewarm can upgrade without injecting the first prompt as history', async (t) => {
  const f = await fixture();
  const agent = session(f, [], undefined, 'unused-warmed-thread', {
    sessionToolsFingerprint: browserToolsFingerprint([]),
    historyForToolUpgrade: '[]',
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await Promise.all([agent.prepare(), agent.prepare()]);
  assert.equal(agent.sessionId, 'unused-warmed-thread');
  await agent.send('First real task');
  const requests = await f.requests();
  assert.deepEqual(
    requests.filter((r) => r.method === 'thread/read').map((r) => r.params),
    [{ threadId: 'unused-warmed-thread', includeTurns: true }],
  );
  assert.equal(requests.filter((r) => r.method === 'thread/start').length, 1);
  assert.equal(
    requests.some((r) => r.method === 'thread/resume'),
    false,
  );
  assert.deepEqual(
    requests.filter((r) => r.method === 'turn/start').map((r) => r.params.input[0].text),
    ['First real task'],
  );
  assert.equal(agent.sessionId, 'thread-1');
  assert.equal(agent.replacedSessionId, 'unused-warmed-thread');
});

test('an identified empty prewarm with no rollout recovers across both matching and changed tools', async (t) => {
  for (const changed of [false, true]) {
    const f = await fixture();
    const agent = session(f, [], undefined, 'no-rollout-test', {
      ...(changed ? { sessionToolsFingerprint: browserToolsFingerprint([]) } : {}),
      historyForToolUpgrade: '[]',
    });
    t.after(() => {
      agent.close();
      return f.cleanup();
    });
    await agent.prepare();
    const before = await f.requests();
    assert.equal(agent.sessionId, 'no-rollout-test');
    assert.equal(before.filter((r) => r.method === 'thread/read').length, 1);
    assert.equal(before.filter((r) => r.method === 'thread/resume').length, 1);
    assert.equal(before.filter((r) => r.method === 'thread/start').length, 1);
    assert.equal(
      before.some((r) => r.method === 'turn/start'),
      false,
    );
    await agent.send('First real task');
    assert.equal(agent.replacedSessionId, 'no-rollout-test');
    assert.equal(agent.sessionId, 'thread-1');
  }
});

test('unrelated CLI errors, unknown fingerprints, and nonempty history cannot trigger missing-rollout recovery', async (t) => {
  for (const [id, overrides] of [
    ['no-rollout-auth', {}],
    ['no-rollout-code', {}],
    ['no-rollout-wrong-id', {}],
    ['no-rollout-test', { sessionToolsFingerprint: undefined }],
    [
      'no-rollout-test',
      { historyForToolUpgrade: JSON.stringify([{ role: 'user', text: 'Keep this turn' }]) },
    ],
  ] as const) {
    const f = await fixture();
    const agent = session(f, [], undefined, id, { historyForToolUpgrade: '[]', ...overrides });
    t.after(() => {
      agent.close();
      return f.cleanup();
    });
    await assert.rejects(agent.prepare());
    assert.equal(agent.sessionId, id);
    assert(
      !(await f.requests()).some((r) => r.method === 'thread/start' || r.method === 'turn/start'),
    );
  }
});

test('empty local history does not authorize replacing a CLI thread that contains turns', async (t) => {
  const f = await fixture();
  const agent = session(f, [], undefined, 'used-thread', {
    sessionToolsFingerprint: browserToolsFingerprint([]),
    historyForToolUpgrade: '[]',
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await assert.rejects(agent.prepare(), /原会话已保留/);
  assert.equal(agent.sessionId, 'used-thread');
  assert.equal(agent.replacedSessionId, undefined);
  assert.deepEqual(
    (await f.requests()).map((r) => r.method),
    ['initialize', 'initialized', 'thread/read'],
  );
});

test('canceling migration before its first turn retains the old session and fingerprint', async (t) => {
  const f = await fixture({ threadStartDelayMs: 500 });
  const oldFingerprint = browserToolsFingerprint([]);
  const agent = session(f, [], undefined, 'legacy-thread', {
    sessionToolsFingerprint: oldFingerprint,
    historyForToolUpgrade: JSON.stringify([{ role: 'user', text: 'Keep this history' }]),
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const stopped = assert.rejects(agent.send('continue'), /任务已停止/);
  await waitFor(async () =>
    (await f.requests()).some((request) => request.method === 'thread/start'),
  );
  await agent.interrupt();
  await stopped;
  assert.equal(agent.isClosed, true);
  assert.equal(agent.sessionId, 'legacy-thread');
  assert.equal(agent.toolsFingerprint, oldFingerprint);
  assert.equal(agent.replacedSessionId, undefined);
  assert.equal(
    (await f.requests()).some((request) => request.method === 'turn/start'),
    false,
  );
});

test('startup cancellation terminates a pending handshake without waiting for its request timeout', async (t) => {
  const f = await fixture({ initializeDelayMs: 1000 });
  const agent = session(f, []);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const stopped = assert.rejects(agent.send('hello'), /任务已停止/);
  await waitFor(async () =>
    (await f.requests()).some((request) => request.method === 'initialize'),
  );
  await agent.interrupt();
  await stopped;
  assert.equal(agent.isClosed, true);
  assert.equal(
    (await f.requests()).some((request) => request.method === 'thread/start'),
    false,
  );
});

test('an interrupt ACK without a completed event closes the stalled connection', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const stopped = assert.rejects(agent.send('cancel-ack-only'), /未确认结束/);
  await waitFor(() => events.some((event) => event.type === 'delta'));
  await agent.interrupt();
  await stopped;
  assert.equal(agent.isClosed, true);
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
});

test('questions arriving before turn-start acknowledgement are queued and remain answerable', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const done = agent.send('pre-ack');
  await waitFor(() => events.some((event) => event.type === 'user-input'));
  const request = events.find((event) => event.type === 'user-input');
  assert.ok(request?.type === 'user-input');
  agent.resolveUserInput(request.request.id, { choice: ['A'] });
  await done;
  assert.deepEqual(
    (await f.requests()).find((request) => request.id === 110 && request.result).result,
    { answers: { choice: { answers: ['A'] } } },
  );
});

test('late terminal notifications cannot finish or replace the current turn', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('late-terminal');
  const completions = events.filter((event) => event.type === 'complete');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].text, 'Hello world');
});

test('tools from another turn are refused and nonzero command exits are failures', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  let calls = 0;
  const agent = session(f, events, async () => {
    calls++;
    return { text: 'unexpected' };
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('foreign-tool');
  assert.equal(calls, 0);
  assert.equal(
    (await f.requests()).find((request) => request.id === 101 && request.result).result.success,
    false,
  );
  await agent.send('exit-code');
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool' &&
        event.call.id === 'failed-command' &&
        event.call.status === 'error',
    ),
  );
});

test('concurrent tool activity does not hide a pending approval', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const done = agent.send('approval-with-tool');
  await waitFor(() =>
    events.some((event) => event.type === 'tool' && event.call.id === 'parallel-tool'),
  );
  assert.equal(events.filter((event) => event.type === 'status').at(-1)?.status, 'waiting');
  const approval = events.find((event) => event.type === 'approval');
  assert.ok(approval?.type === 'approval');
  agent.resolveApproval(approval.request.id, false);
  await done;
});

test('file approvals include their exact path and patch before accepting the one operation', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const done = agent.send('file-approval');
  await waitFor(() => events.some((event) => event.type === 'approval'));
  const approval = events.find((event) => event.type === 'approval');
  assert.ok(approval?.type === 'approval');
  assert.equal(approval.request.kind, 'file');
  assert.ok(approval.request.detail.includes(path.join(f.directory, 'index.html')));
  assert.match(approval.request.detail, /-Old label\n\+New label/);
  agent.resolveApproval(approval.request.id, true);
  await done;
  assert.equal(
    (await f.requests()).find((request) => request.id === 120 && request.result).result.decision,
    'accept',
  );
});

test(
  'closing a POSIX CLI session terminates its owned command process group',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture();
    const events: AgentEvent[] = [];
    const agent = session(f, events);
    let pid: number | undefined;
    t.after(() => {
      agent.close();
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      return f.cleanup();
    });
    const stopped = assert.rejects(agent.send('descendant'), /已关闭/);
    await waitFor(() =>
      events.some((event) => event.type === 'delta' && event.text === 'Child running'),
    );
    pid = Number(await readFile(f.log + '.pid', 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    process.kill(pid, 0);
    agent.close();
    await stopped;
    await waitFor(() => {
      try {
        process.kill(pid!, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    });
  },
);

test('saved sessions use thread/resume and retain restrictive runtime settings', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events, undefined, 'thread-1');
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('hello');
  const requests = await f.requests();
  assert.equal(
    requests.some((request) => request.method === 'thread/start'),
    false,
  );
  const resume = requests.find((request) => request.method === 'thread/resume').params;
  assert.equal(resume.threadId, 'thread-1');
  assert.equal(resume.sandbox, 'read-only');
  assert.equal(resume.dynamicTools, undefined);
  assert.deepEqual(resume.config.mcp_servers, {});
  assert.equal(agent.sessionId, 'thread-1');
});

test('a missing saved session does not silently replace conversation history', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events, undefined, 'missing-thread');
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await assert.rejects(agent.send('hello'), /无法恢复 Codex 会话/);
  const requests = await f.requests();
  assert.equal(
    requests.some(
      (request) => request.method === 'thread/start' || request.method === 'turn/start',
    ),
    false,
  );
  assert.equal(
    events.some((event) => event.type === 'complete'),
    false,
  );
});

test('discovery uses executable PATH entries and does not pass an API key to login status', async (t) => {
  const f = await fixture();
  const oldPath = process.env.PATH;
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.PATH = `${f.directory}${path.delimiter}${oldPath ?? ''}`;
  process.env.OPENAI_API_KEY = 'fake-test-only';
  t.after(async () => {
    process.env.PATH = oldPath;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    await f.cleanup();
  });
  const agents = await detectAgents();
  const codex = agents.find((agent) => agent.id === 'codex');
  assert.ok(codex);
  assert.equal(codex.path, f.executable);
  assert.equal(codex.authentication, 'ready');
  assert.equal(codex.version, 'codex-cli test');
  assert.equal(JSON.parse(await readFile(f.log, 'utf8')).apiKeyPresent, false);
  assert.deepEqual(agents.map((agent) => agent.id).sort(), [
    'claude',
    'codex',
    'cursor',
    'gemini',
    'opencode',
    'pi',
  ]);
  assert.equal(agents.find((agent) => agent.id === 'opencode')?.supported, false);
});

test('Codex update checks compare the installed CLI against the official stable release', async () => {
  const codex: AgentInfo = {
    id: 'codex',
    name: 'Codex',
    available: true,
    supported: true,
    path: '/fixture/codex',
  };
  const latest = async (url: string) => {
    assert.equal(url, 'https://releases.openai.com/codex/channels/latest');
    return Response.json({ tag_name: 'rust-v0.100.0' });
  };
  const check = (version: string) =>
    createCodexUpdateChecker(latest, async () => 'codex-cli ' + version)(codex);
  assert.deepEqual(await check('0.98.2'), {
    status: 'available',
    installedVersion: '0.98.2',
    latestVersion: '0.100.0',
    releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.100.0',
  });
  for (const [version, status] of [
    ['0.100.0', 'current'],
    ['1.0.0-alpha.2', 'current'],
    ['0.100.0-beta.2', 'available'],
    ['custom', 'unknown'],
  ])
    assert.equal((await check(version)).status, status);
  for (const fetchRelease of [
    async () => {
      throw new Error('offline');
    },
    async () => new Response(null, { status: 503 }),
    async () => Response.json({ tag_name: 'rust-v1.0.0-beta.1' }),
    async () => new Response('not json'),
  ])
    assert.deepEqual(
      await createCodexUpdateChecker(fetchRelease, async () => 'codex-cli 0.99.0')(codex),
      { status: 'unknown' },
    );
});

test('Codex update checks share probes, cache release metadata, and observe external upgrades and removal', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const root = await mkdtemp(path.join(tmpdir(), 'athena-update-check-'));
  const executable = path.join(root, 'codex');
  const releaseTag = 'rust-v1.0.0';
  const codex: AgentInfo = {
    id: 'codex',
    name: 'Codex',
    supported: true,
    available: true,
    path: executable,
    version: 'codex-cli 0.99.0',
  };
  let fetches = 0,
    online = true;
  const check = createCodexUpdateChecker(async () => {
    fetches++;
    return online ? Response.json({ tag_name: releaseTag }) : new Response(null, { status: 503 });
  });
  try {
    await writeFile(
      executable,
      `${nodeShebang()}\nconst fs=require('fs');if(process.argv[2]!=='--version')process.exit(2);fs.appendFileSync(${JSON.stringify(path.join(root, 'probes'))},'v');console.log('codex-cli '+fs.readFileSync(${JSON.stringify(path.join(root, 'installed'))},'utf8'));`,
      { mode: 0o700 },
    );
    await writeFile(path.join(root, 'installed'), '0.99.0');
    const [first, second] = await Promise.all([check(codex), check(codex, true)]);
    assert.equal(first.status, 'available');
    assert.deepEqual(first, second);
    assert.equal(await readFile(path.join(root, 'probes'), 'utf8'), 'v');
    t.mock.timers.tick(1000);
    await writeFile(path.join(root, 'installed'), '1.0.0');
    assert.equal((await check(codex)).status, 'current');
    assert.equal(fetches, 1);
    t.mock.timers.tick(6 * 60 * 60_000);
    await check(codex);
    assert.equal(fetches, 2);
    online = false;
    t.mock.timers.tick(1000);
    assert.equal((await check(codex, true)).status, 'unknown');
    t.mock.timers.tick(1000);
    await check(codex);
    assert.equal(fetches, 3);
    online = true;
    t.mock.timers.tick(10 * 60_000);
    assert.equal((await check(codex)).status, 'current');
    assert.equal(fetches, 4);
    await rm(executable);
    t.mock.timers.tick(1000);
    assert.equal((await check(codex)).status, 'unknown');
    assert.equal(fetches, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('A late release response cannot restore an alert for a replaced executable', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  let finish!: (response: Response) => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const check = createCodexUpdateChecker(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        began();
      }),
    async (path) => (path.endsWith('old') ? 'codex-cli 0.9.0' : 'codex-cli 1.0.0'),
  );
  const codex: AgentInfo = {
    id: 'codex',
    name: 'Codex',
    available: true,
    supported: true,
    path: '/old',
  };
  const oldResult = check(codex);
  await started;
  t.mock.timers.tick(1000);
  const newResult = check({ ...codex, path: '/new' });
  finish(Response.json({ tag_name: 'rust-v1.0.0' }));
  assert.equal((await oldResult).status, 'unknown');
  assert.equal((await newResult).status, 'current');
});

test('Codex version and login probes run independently without serial startup waits', async () => {
  const f = await fixture({ waitForLogin: true });
  const oldPath = process.env.PATH;
  process.env.PATH = `${f.directory}${path.delimiter}${oldPath ?? ''}`;
  try {
    const codex = (await detectAgents()).find((agent) => agent.id === 'codex');
    assert.equal(
      codex?.available,
      true,
      'The version fixture only finishes after the login process has run',
    );
    assert.equal(codex.version, 'codex-cli test');
    assert.equal(codex.authentication, 'ready');
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await f.cleanup();
  }
});

test('a zero-exit not-logged-in response is not misreported as authenticated', async () => {
  const f = await fixture({ loginMessage: 'Not logged in' });
  const oldPath = process.env.PATH;
  process.env.PATH = `${f.directory}${path.delimiter}${oldPath ?? ''}`;
  try {
    const codex = (await detectAgents()).find((agent) => agent.id === 'codex');
    assert.equal(codex?.authentication, 'missing');
    assert.match(codex?.detail ?? '', /codex login/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await f.cleanup();
  }
});

test('public plans reject foreign turns and malformed statuses, without forwarding hidden fields', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(async () => {
    await agent.close();
    await f.cleanup();
  });
  await agent.send('plan');
  const plans = events.filter((e) => e.type === 'plan');
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].steps, [{ step: 'Read receipt', status: 'inProgress' }]);
  assert(plans[0].at > 0);
});

test('duplicate dynamic call ids are never dispatched twice while the first result is unknown', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  let dispatches = 0;
  const agent = session(f, events, async () => {
    dispatches++;
    await new Promise((r) => setTimeout(r, 40));
    return { text: 'one action committed' };
  });
  t.after(async () => {
    await agent.close();
    await f.cleanup();
  });
  await agent.send('duplicate-tool');
  assert.equal(dispatches, 1);
  const responses = await f.requests();
  assert.equal(responses.find((x) => x.id === 102)?.result?.success, false);
  const call = events.filter((e) => e.type === 'tool' && e.call.status === 'done').at(-1);
  assert(
    call?.type === 'tool' &&
      call.call.durationMs! >= 35 &&
      call.call.finishedAt! >= call.call.startedAt!,
  );
});

test('model discovery is paginated and does not create a thread; turn overrides persist across calls', async (t) => {
  const f = await fixture({ modelProtocol: true });
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  const models = await agent.listModels();
  assert.deepEqual(
    models.map((m) => m.model),
    ['model-a', 'model-b'],
  );
  assert.equal(models[1].defaultEffort, undefined);
  assert(!(await f.requests()).some((r) => r.method === 'thread/start'));
  await agent.send('hello', undefined, undefined, { model: 'model-a', effort: 'low' });
  await agent.send('hello', undefined, undefined, { model: 'model-b' });
  const requests = await f.requests();
  assert.deepEqual(
    requests.filter((r) => r.method === 'turn/start').map((r) => [r.params.model, r.params.effort]),
    [
      ['model-a', 'low'],
      ['model-b', null],
    ],
  );
  assert(
    !requests.some((r) => r.method === 'thread/resume'),
    'loaded resume cannot be used as a model change',
  );
  const starts = events.filter((e) => e.type === 'run-started');
  assert.equal(starts[0].model.model, 'model-a');
  assert.equal(starts[1].model.source, 'unconfirmed');
  assert.equal(starts[1].model.requested, 'model-b');
  assert.equal(starts[1].model.model, undefined, 'requested model is not evidence of execution');
});

test('usage and model reroutes are scoped to owned turns without reasoning payloads', async (t) => {
  const f = await fixture({ modelProtocol: true });
  const events: AgentEvent[] = [];
  const agent = session(f, events);
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('usage', undefined, undefined, { model: 'model-a', effort: 'low' });
  const usage = events.filter((e) => e.type === 'usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].total.inputTokens, 100);
  assert.equal(usage[0].total.cacheWriteInputTokens, 0);
  const reroute = events.find((e) => e.type === 'model');
  assert.equal(reroute?.model.source, 'rerouted');
  assert.equal(reroute?.model.model, 'fallback');
});

test('terminal turns refuse late tools while execution-model confirmation is pending', async (t) => {
  const f = await fixture();
  const events: AgentEvent[] = [];
  let hostCalls = 0;
  const agent = session(f, events, async () => {
    hostCalls++;
    return { text: 'must not run' };
  });
  t.after(() => {
    agent.close();
    return f.cleanup();
  });
  await agent.send('tool-after-completion');
  await waitFor(async () => (await f.requests()).some((r) => r.id === 101 && r.result));
  assert.equal(hostCalls, 0);
  assert.equal((await f.requests()).find((r) => r.id === 101 && r.result).result.success, false);
  assert.equal(events.filter((event) => event.type === 'complete').length, 1);
});
