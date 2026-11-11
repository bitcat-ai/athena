import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OpenCodeSession } from '../src/main/opencode-session';
import type { AgentEvent } from '../src/shared/types';
import { nodeShebang } from './node-script';
import { testImage } from './image-fixture';

async function fixture(mode = 'normal', sessionId?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'athena-opencode-test-'));
  const executablePath = path.join(directory, 'opencode.cjs');
  await writeFile(
    executablePath,
    `${nodeShebang()}
const fs=require('node:fs'),rl=require('node:readline');
const mode=${JSON.stringify(mode)};
const args=process.argv.slice(2);
if(args[0]==='models'){console.log('fixture/one\\nfixture/two');process.exit(0);}
if(args.includes('--version')){console.log(mode==='wrong-version'?'2.0.0':'1.18.15');process.exit(0);}
if(args[0]==='debug'){
  console.log(JSON.stringify(args[1]==='config'?{default_agent:'build'}:{permission:[{permission:'*',pattern:'*',action:'allow'},{permission:'r?ad',pattern:'*.env',action:'deny'},{permission:'read',pattern:'safe.env',action:'allow'},{permission:'bash',pattern:'rm *',action:'deny'}]}));
  process.exit(0);
}
const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const [name,agent]=Object.entries(config.agent).find(([name])=>name.startsWith('athena-'));
fs.writeFileSync(__dirname+'/policy.json',JSON.stringify({name,agent,args:process.argv.slice(2)}));
const models=[{value:'fixture/one',name:'One'},{value:'fixture/two',name:'Two'}];
const state={configOptions:[{id:'model',category:'model',type:'select',currentValue:'fixture/one',options:models}]};
let id='ses_fixture',promptId;
const write=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const reply=(request,result)=>write({jsonrpc:'2.0',id:request.id,result});
const update=(update,sessionId=id)=>write({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});
const done=()=>{update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'verified reply'}});reply({id:promptId},{stopReason:'end_turn',usage:{inputTokens:3,outputTokens:4,totalTokens:10,cachedReadTokens:2,cachedWriteTokens:1,thoughtTokens:0}})};
rl.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 fs.appendFileSync(__dirname+'/requests.jsonl',JSON.stringify(request)+'\\n');
 if(!request.method){
   if(request.id===900){if(request.result?.outcome?.optionId==='allow')done();else reply({id:promptId},{stopReason:'refusal'});}
   return;
 }
 if(request.method==='initialize')return reply(request,{protocolVersion:1,agentInfo:{name:'OpenCode',version:mode==='wrong-version'?'2.0.0':'1.18.15'},agentCapabilities:{loadSession:true,promptCapabilities:{image:true}}});
 if(request.method==='session/new')return reply(request,{sessionId:id,...state});
 if(request.method==='session/load'){
   if(mode==='bad-resume')return write({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'sk-secret-server-details'}});
   id=request.params.sessionId;
   if(mode==='image-replay')update({sessionUpdate:'user_message_chunk',content:{type:'image',mimeType:'image/png',data:'A'.repeat(5*1024*1024)}});
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD_HISTORY'}});
   return reply(request,state);
 }
 if(request.method==='session/set_mode'){
   if(request.params.modeId!==name||mode==='bad-mode')return write({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'sk-secret-mode-error'}});
   return reply(request,{});
 }
 if(request.method==='session/set_config_option')return reply(request,state);
 if(request.method==='session/prompt'){
   promptId=request.id;
   if(mode==='invalid-json'){process.stdout.write('broken\\n');return;}
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'WRONG_SESSION'}},'ses_other');
   update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'HIDDEN_REASONING'}});
   if(mode==='hang'){setInterval(()=>{},1000);return;}
   if(mode==='permission-empty'){
     update({sessionUpdate:'tool_call',toolCallId:'read-1',title:'Read file',rawInput:{filePath:'evidence.txt'},status:'pending'});
     return write({jsonrpc:'2.0',id:900,method:'session/request_permission',params:{sessionId:id,toolCall:{toolCallId:'read-1',title:'Read file',kind:'read',rawInput:{}},options:[{optionId:'allow',kind:'allow_once'},{optionId:'reject',kind:'reject_once'}]}});
   }
   if(mode==='permission'||mode==='oversized')return write({jsonrpc:'2.0',id:900,method:'session/request_permission',params:{sessionId:id,toolCall:{title:'Read file',kind:'read',rawInput:{path:mode==='oversized'?'x'.repeat(13000):'evidence.txt'}},options:[{optionId:'always',kind:'allow_always'},{optionId:'allow',kind:'allow_once'},{optionId:'reject',kind:'reject_once'}]}});
   done();
 }
});`,
    { mode: 0o700 },
  );
  const events: AgentEvent[] = [];
  let resolveApproval: (event: Extract<AgentEvent, { type: 'approval' }>) => void = () => {};
  const approval = new Promise<Extract<AgentEvent, { type: 'approval' }>>((resolve) => {
    resolveApproval = resolve;
  });
  const session = new OpenCodeSession({
    workspace: directory,
    executablePath,
    sessionId,
    tools: [],
    callTool: async () => {
      throw Error('No host tool expected');
    },
    onEvent(event) {
      events.push(event);
      if (event.type === 'approval') resolveApproval(event);
    },
  });
  return {
    directory,
    session,
    events,
    approval,
    requests: async () =>
      (await readFile(path.join(directory, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    async cleanup() {
      session.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('OpenCode native configuration, explicit model selection, image transport and evidence-only usage', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(
      (await f.session.listModels()).map((m) => m.model),
      ['fixture/one', 'fixture/two'],
    );
    assert.equal(f.session.sessionId, undefined);
    await assert.rejects(readFile(path.join(f.directory, 'requests.jsonl')));
    await f.session.prepare();
    const policy = JSON.parse(await readFile(path.join(f.directory, 'policy.json'), 'utf8'));
    assert.equal(policy.agent.permission['*'], 'deny');
    for (const key of ['bash', 'read', 'edit', 'glob', 'grep', 'list', 'external_directory'])
      assert.equal(policy.agent.permission[key]['*'], 'ask');
    assert.equal(policy.agent.permission.read['*.env'], 'deny');
    assert.equal(policy.agent.permission.read['safe.env'], 'ask');
    assert.equal(policy.agent.permission.bash['rm *'], 'deny');
    assert.deepEqual(Object.keys(policy.agent.permission.read), ['*', '*.env', 'safe.env']);
    assert.ok(policy.args.includes('--pure'));
    assert.ok((await f.requests()).every((r) => r.method !== 'session/prompt'));
    await f.session.send('task', undefined, undefined, { model: 'fixture/two' }, [testImage]);
    assert.equal(f.session.sessionId, 'ses_fixture');
    assert.equal(
      f.events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text)
        .join(''),
      'verified reply',
    );
    assert.equal(JSON.stringify(f.events).includes('HIDDEN_REASONING'), false);
    assert.equal(JSON.stringify(f.events).includes('WRONG_SESSION'), false);
    const requests = await f.requests();
    assert.equal(
      requests.find((r) => r.method === 'session/set_config_option').params.value,
      'fixture/two',
    );
    assert.equal(
      requests.find((r) => r.method === 'session/prompt').params.prompt[1].type,
      'image',
    );
    const usage = f.events.find((e) => e.type === 'usage');
    assert.ok(usage?.type === 'usage');
    assert.equal(usage.total.inputTokens, 6);
    assert.equal(usage.total.totalTokens, 10);
    const started = f.events.find((e) => e.type === 'run-started');
    assert.ok(started?.type === 'run-started');
    assert.equal(started.model.source, 'unconfirmed');
    assert.equal(started.model.requested, 'fixture/two');
    assert.equal(
      f.events.some((e) => e.type === 'model'),
      false,
    );
    assert.equal(f.events.filter((e) => e.type === 'complete').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('OpenCode loads only the original native session and ignores replayed text', async () => {
  const f = await fixture('normal', 'ses_previous');
  try {
    await f.session.send('continue');
    const requests = await f.requests();
    assert.equal(
      requests.some((r) => r.method === 'session/new'),
      false,
    );
    assert.equal(
      requests.find((r) => r.method === 'session/load').params.sessionId,
      'ses_previous',
    );
    assert.equal(f.session.sessionId, 'ses_previous');
    assert.equal(JSON.stringify(f.events).includes('OLD_HISTORY'), false);
  } finally {
    await f.cleanup();
  }
});

test('OpenCode can resume a session whose native replay contains a large image block', async () => {
  const f = await fixture('image-replay', 'ses_image');
  try {
    await f.session.send('continue');
    assert.equal(f.session.sessionId, 'ses_image');
    assert.equal(
      f.events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text)
        .join(''),
      'verified reply',
    );
  } finally {
    await f.cleanup();
  }
});

for (const mode of ['wrong-version', 'bad-mode', 'bad-resume', 'invalid-json', 'oversized'])
  test(`OpenCode ${mode} fails closed and does not invent completion`, async () => {
    const f = await fixture(mode, mode === 'bad-resume' ? 'ses_missing' : undefined);
    try {
      await assert.rejects(f.session.send('task'));
      assert.equal(
        f.events.some((e) => e.type === 'complete'),
        false,
      );
      assert.equal(JSON.stringify(f.events).includes('sk-secret'), false);
      assert.equal(f.session.isClosed, true);
      if (mode === 'bad-resume')
        assert.equal(
          (await f.requests()).some((r) => r.method === 'session/new'),
          false,
        );
    } finally {
      await f.cleanup();
    }
  });

for (const decision of ['allow', 'reject', 'stop'])
  test(`OpenCode native permission ${decision} is scoped to the active request`, async () => {
    const f = await fixture('permission');
    try {
      const pending = f.session.send('read evidence');
      const done = decision === 'allow' ? pending : assert.rejects(pending);
      const event = await f.approval;
      assert.equal(event.request.detail, JSON.stringify({ path: 'evidence.txt' }, null, 2));
      await assert.rejects(f.session.send('overlap'), /等待/);
      if (decision === 'stop') await f.session.interrupt();
      else f.session.resolveApproval(event.request.id, decision === 'allow');
      await done;
      assert.throws(() => f.session.resolveApproval(event.request.id, true), /失效/);
      if (decision === 'allow') {
        const response = (await f.requests()).find((r) => r.id === 900 && !r.method);
        assert.equal(response.result.outcome.optionId, 'allow');
      }
      assert.equal(
        f.events.some((e) => e.type === 'complete'),
        decision === 'allow',
      );
    } finally {
      await f.cleanup();
    }
  });

test('OpenCode rejects invalid native IDs and unsupported model choices', async () => {
  const f = await fixture();
  try {
    await f.session.listModels();
    await assert.rejects(f.session.prepare({ model: 'fixture/one', effort: 'high' }), /可用目录/);
    await assert.rejects(f.session.prepare({ model: 'unknown' }), /可用目录/);
    assert.ok((await f.requests()).every((r) => r.method !== 'session/prompt'));
  } finally {
    await f.cleanup();
  }
});

test('OpenCode empty permission metadata is joined to the matching native tool input', async () => {
  const f = await fixture('permission-empty');
  try {
    const pending = f.session.send('/untrusted-command');
    const event = await f.approval;
    assert.deepEqual(JSON.parse(event.request.detail), { filePath: 'evidence.txt' });
    f.session.resolveApproval(event.request.id, true);
    await pending;
    const prompt = (await f.requests()).find((r) => r.method === 'session/prompt');
    assert.ok(prompt.params.prompt[0].text.startsWith('<user_task>'));
  } finally {
    await f.cleanup();
  }
});
