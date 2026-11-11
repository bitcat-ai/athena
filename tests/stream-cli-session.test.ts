import assert from 'node:assert/strict';
import { testImage } from './image-fixture';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StreamCliSession, type StreamCliId } from '../src/main/stream-cli-session';
import type { AgentEvent, BrowserTool } from '../src/shared/types';

const cliIds: StreamCliId[] = ['claude', 'gemini', 'cursor'];
async function fixture(
  cli: StreamCliId,
  mode = 'normal',
  sessionId?: string,
  approveWorkspace = true,
  tools: BrowserTool[] = [],
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'athena-stream-cli-test-'));
  const script = path.join(directory, 'fixture.cjs');
  const executablePath = path.join(directory, cli === 'cursor' ? 'cursor-agent' : cli);
  await writeFile(
    script,
    `
const fs = require('node:fs'); const cp = require('node:child_process');
const cli=${JSON.stringify(cli)}, mode=${JSON.stringify(mode)}, dir=${JSON.stringify(directory)};
const args=process.argv.slice(2); let input='';
process.stdin.setEncoding('utf8'); process.stdin.on('data',s=>input+=s); process.stdin.on('end',()=>{
 fs.appendFileSync(dir+'/args.jsonl', JSON.stringify({args,input})+'\\n');
 const pi=args.indexOf('--admin-policy'); if(pi>=0) fs.writeFileSync(dir+'/policy.txt',fs.readFileSync(args[pi+1]));
 const ri=args.indexOf('--resume'); const id=mode==='wrong-session'?'different-session':ri>=0?args[ri+1]:'native-session';
 const out=r=>process.stdout.write(JSON.stringify(r)+(mode==='no-final-newline'&&r.type==='result'?'':'\\r\\n'));
 const message=s=>({role:'assistant',content:[{type:'thinking',thinking:'HIDDEN_THINKING'},{type:'text',text:s}]});
 const delta=s=>cli==='claude'?out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:s}}}):cli==='gemini'?out({type:'message',role:'assistant',content:s,delta:true}):out({type:'assistant',timestamp_ms:123,message:message(s)});
 const result=()=>cli==='gemini'?out({type:'result',status:'success',stats:mode==='unknown-usage'?{}:{input_tokens:20,output_tokens:4,cached:3,total_tokens:28,models:{'actual-gemini':{total_tokens:28}}}}):out({type:'result',subtype:'success',is_error:false,result:'你\\u2028好!',session_id:id,...(cli==='claude'&&mode!=='unknown-usage'?{usage:{input_tokens:10,cache_read_input_tokens:3,cache_creation_input_tokens:2,output_tokens:4}}:{})});
 process.stderr.write('sk-secret-do-not-forward HIDDEN_STDERR');
 if(mode==='quota'){process.stderr.write('Weekly usage limit reached. sk-secret-private');process.exitCode=1;return;}
 if(mode==='auth-required'){process.stderr.write('Authentication required. sk-secret-private');process.exitCode=1;return;}
 if(mode==='missing-session'){process.exitCode=1;return;}
 if(mode==='invalid-json'){process.stdout.write('not json\\n');return;}
 if(mode==='no-init'){result();return;}
 out(cli==='gemini'?{type:'init',session_id:id,model:'auto'}:{type:'system',subtype:'init',session_id:id,model:'configured-alias',...(mode==='browser-tools'?{mcp_servers:[{name:'athena',status:'connected'}],tools:['mcp__athena__neo_status']}:{} )});
 if(mode==='wrong-session') return;
 if(mode==='browser-tools') {
  void (async()=>{
   const configPath=args[args.indexOf('--mcp-config')+1];
   const definition=JSON.parse(fs.readFileSync(configPath,'utf8')).mcpServers.athena;
   fs.writeFileSync(dir+'/bridge.json',JSON.stringify({url:definition.env.ATHENA_MCP_URL,mode:fs.statSync(configPath).mode&511}));
   const child=cp.spawn(definition.command,definition.args,{env:{...process.env,...definition.env},stdio:'pipe'});
   child.stderr.resume();
   const pending=new Map(); require('node:readline').createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r);pending.delete(r.id);});
   const request=(id,method,params)=>new Promise(resolve=>{pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n');});
   await request('init','initialize',{}); await request('list','tools/list');
   out({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'call-1',name:'mcp__athena__neo_status',input:{}}]}});
   const response=await request('action','tools/call',{name:'neo_status',arguments:{}});
   child.stdin.end();
   if(response.error || response.result.isError) throw new Error('browser call rejected');
   out({type:'assistant',message:message('browser done')});
   out({type:'result',subtype:'success',is_error:false,result:'browser done',session_id:id});
  })().catch(()=>{process.exitCode=1;});
  return;
 }

 if(mode==='approval'){out({type:'control_request',request_id:'approve',request:{subtype:'can_use_tool'}});setInterval(()=>{},1000);return;}
 if(mode==='native-error'){out({type:'error',message:'sk-secret-native-error'});return;}
 if(mode==='aborted-result'){out(cli==='gemini'?{type:'result',status:'success',aborted:true}:{type:'result',subtype:'success',is_error:false,stop_reason:'aborted',aborted:true,result:'bad'});return;}
 if(mode==='result-error'){out(cli==='gemini'?{type:'result',status:'error',error:{message:'sk-secret-native-error'}}:{type:'result',subtype:'error_during_execution',is_error:true,result:'sk-secret-native-error'});return;}
 if(mode==='tool-disabled'){out(cli==='gemini'?{type:'tool_use',tool_id:'tool-1',tool_name:'write_file',parameters:{}}:{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'tool-1',name:'Write',input:{}}]}});return;}
 if(mode==='denied'){out({type:'result',subtype:'success',is_error:false,permission_denials:[{tool_name:'Write'}],result:'blocked'});return;}
 if(cli==='claude') {
  out({type:'stream_event',event:{type:'message_start',message:{model:'actual-claude'}}});
  out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'HIDDEN_THINKING'}}});
  out({type:'stream_event',parent_tool_use_id:'subagent',event:{type:'content_block_delta',delta:{type:'text_delta',text:'HIDDEN_SUBAGENT'}}});
 }
 if(cli==='gemini') {out({type:'message',role:'user',content:'HIDDEN_USER'});out({type:'error',severity:'warning',message:'HIDDEN_WARNING'});}
 if(cli==='cursor') {
  out({type:'assistant',timestamp_ms:100,model_call_id:'flush-id',message:message('HIDDEN_DUPLICATE')});
  out({type:'assistant',message:message('HIDDEN_FINAL_FLUSH')});
  if(mode==='bad-tool-record') out({type:'tool_call',subtype:'started',tool_call:{readToolCall:{args:{path:'file.txt'}}}});
  if(mode==='tool-orphan-end') out({type:'tool_call',subtype:'completed',call_id:'tool-1',tool_call:{readToolCall:{result:{success:{content:'data'}}}}});
  if(mode==='tool'||mode==='tool-error'||mode==='tool-false'||mode==='tool-pending'||mode==='mutating-tool'||mode==='mutating-tool-colon-id') {
   const name=mode.startsWith('mutating-tool')?'writeToolCall':'readToolCall';
   const call_id=mode==='mutating-tool-colon-id'?'tool:1':'tool-1';
   out({type:'tool_call',subtype:'started',call_id,tool_call:{[name]:{args:{path:'file.txt'}}}});
   if(mode!=='tool-pending') out({type:'tool_call',subtype:'completed',call_id,tool_call:{[name]:{result:mode==='tool-error'?{error:{message:'private'}}:mode==='tool-false'?{success:false}:{success:{content:'HIDDEN_TOOL_OUTPUT'}}}}});
  }
 }
 // Deliberately split inside a UTF-8 character, not just at JSON record boundaries.
 const original=process.stdout.write.bind(process.stdout); let split=true;
 process.stdout.write=(s,...rest)=>{if(typeof s==='string'&&s.includes('你')&&split){split=false;const b=Buffer.from(s); const at=b.indexOf(Buffer.from('你'))+1; original(b.subarray(0,at)); original(b.subarray(at)); return true;} return original(s,...rest);};
 if(mode!=='snapshot-only')delta('你\\u2028好');
 if(mode==='slow'||mode==='leader-exits') {
  const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
  fs.writeFileSync(dir+'/descendant',String(child.pid));
  process.on('SIGTERM',()=>{});
  if(mode==='leader-exits'){setTimeout(()=>process.exit(7),100);return;}
  setInterval(()=>{},1000);return;
 }
 if(mode==='no-result') return;
 if(cli==='claude')out({type:'assistant',message:{...message('你\\u2028好!'),model:'actual-claude',stop_reason:'end_turn'}});
 if(cli==='gemini') {if(mode==='snapshot-only')out({type:'message',role:'assistant',content:'你\\u2028好!'});else delta('!');}
 if(mode==='wrong-record-session'){out({type:'assistant',session_id:'other-session',message:message('bad')});return;}
 result();
 if(mode==='duplicate-result') result();
 if(mode==='nonzero') process.exitCode=7;
 if(mode==='after-result-garbage')process.stdout.write('private invalid line\\n');
 if(mode==='delayed-exit')setTimeout(()=>{},100);
});
`,
  );
  await writeFile(
    executablePath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    { mode: 0o755 },
  );
  const events: AgentEvent[] = [];
  let hostCalls = 0;
  const session = new StreamCliSession({
    cli,
    workspace: directory,
    executablePath,
    sessionId,
    tools,
    callTool: async () => {
      hostCalls++;
      if (tools.length) return { text: 'native page ready' };
      throw new Error('Host tools must not be invoked');
    },
    onEvent: (event) => {
      events.push(event);
      if (
        approveWorkspace &&
        event.type === 'approval' &&
        event.request.id.startsWith(`${cli}-workspace:`)
      )
        session.resolveApproval(event.request.id, true);
    },
  });
  const logs = async () =>
    (await readFile(path.join(directory, 'args.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  return {
    directory,
    executablePath,
    session,
    events,
    logs,
    hostCalls: () => hostCalls,
    cleanup: async () => {
      session.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Fixture timed out');
}
function text(events: AgentEvent[]) {
  return events
    .filter((e) => e.type === 'delta')
    .map((e) => e.text)
    .join('');
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const [mode, expected] of [
  ['quota', /额度/],
  ['auth-required', /登录/],
] as const) {
  test(`CLI ${mode} errors expose an actionable category without raw diagnostics`, async () => {
    const f = await fixture('cursor', mode);
    try {
      await assert.rejects(f.session.send('first'), expected);
      assert.equal(JSON.stringify(f.events).includes('sk-secret'), false);
    } finally {
      await f.cleanup();
    }
  });
}

test('Cursor asks the host before trusting a workspace and keeps Ask restrictions after approval', async () => {
  const f = await fixture('cursor', 'normal', undefined, false);
  try {
    const done = f.session.send('first');
    await until(() => f.events.some((event) => event.type === 'approval'));
    await assert.rejects(readFile(path.join(f.directory, 'args.jsonl')));
    const approval = f.events.find((event) => event.type === 'approval');
    assert.ok(approval?.type === 'approval');
    assert.ok(approval.request.detail.includes(f.directory));
    f.session.resolveApproval(approval.request.id, true);
    await done;
    const call = JSON.parse((await readFile(path.join(f.directory, 'args.jsonl'), 'utf8')).trim());
    assert.ok(call.args.includes('--trust'));
    assert.equal(call.args[call.args.indexOf('--mode') + 1], 'ask');
    assert.equal(
      call.args.some((arg: string) => ['--force', '--yolo', '--approve-mcps'].includes(arg)),
      false,
    );
    assert.ok(
      f.events.some(
        (event) => event.type === 'request-resolved' && event.id === approval.request.id,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

for (const decision of ['allow', 'deny', 'stop'] as const)
  test(`Gemini workspace ${decision} gates startup and retains the admin tool restriction`, async () => {
    const f = await fixture('gemini', 'normal', undefined, false);
    try {
      const pending = f.session.send('task');
      const done = decision === 'allow' ? pending : assert.rejects(pending, /拒绝|停止/);
      await until(() => f.events.some((event) => event.type === 'approval'));
      await assert.rejects(readFile(path.join(f.directory, 'args.jsonl')));
      const event = f.events.find((event) => event.type === 'approval');
      assert.ok(event?.type === 'approval');
      if (decision === 'stop') await f.session.interrupt();
      else f.session.resolveApproval(event.request.id, decision === 'allow');
      await done;
      if (decision === 'allow') {
        const [call] = await f.logs();
        assert.ok(call.args.includes('--skip-trust'));
        assert.ok(call.args.includes('--admin-policy'));
        assert.equal(call.args[call.args.indexOf('--approval-mode') + 1], 'plan');
      } else await assert.rejects(readFile(path.join(f.directory, 'args.jsonl')));
      assert.throws(() => f.session.resolveApproval(event.request.id, true), /失效/);
    } finally {
      await f.cleanup();
    }
  });

for (const decision of ['deny', 'stop'] as const) {
  test(`Cursor workspace ${decision} never starts a CLI process or accepts late approval`, async () => {
    const f = await fixture('cursor', 'normal', undefined, false);
    try {
      const done = assert.rejects(f.session.send('first'), decision === 'deny' ? /拒绝/ : /停止/);
      await until(() => f.events.some((event) => event.type === 'approval'));
      const approval = f.events.find((event) => event.type === 'approval');
      assert.ok(approval?.type === 'approval');
      if (decision === 'deny') f.session.resolveApproval(approval.request.id, false);
      else await f.session.interrupt();
      await done;
      await assert.rejects(readFile(path.join(f.directory, 'args.jsonl')));
      assert.throws(() => f.session.resolveApproval(approval.request.id, true), /失效/);
    } finally {
      await f.cleanup();
    }
  });
}

for (const cli of cliIds) {
  test(`${cli}: native stream, Unicode, hidden data filtering, evidence-only usage and native resume`, async () => {
    const f = await fixture(cli);
    try {
      await f.session.prepare();
      await assert.rejects(readFile(path.join(f.directory, 'args.jsonl'))); // preparation never calls a model
      await f.session.send('first', 'context', undefined, { model: 'chosen-model' });
      assert.equal(text(f.events), '你\u2028好!');
      assert.equal(f.session.sessionId, 'native-session');
      assert.equal(f.events.filter((e) => e.type === 'complete').length, 1);
      assert.equal(JSON.stringify(f.events).includes('HIDDEN'), false);
      assert.equal(JSON.stringify(f.events).includes('sk-secret'), false);
      assert.equal(f.hostCalls(), 0);
      const usage = f.events.find((e) => e.type === 'usage');
      if (cli === 'cursor') {
        assert.equal(usage, undefined);
        assert.equal(
          f.events.some((e) => e.type === 'model'),
          false,
        );
      } else {
        assert.equal(usage?.total.inputTokens, cli === 'claude' ? 15 : 20);
        assert.equal(usage?.total.reasoningOutputTokens, null);
        assert.equal(usage?.total.totalTokens, cli === 'claude' ? null : 28);
        assert.ok(
          f.events.some(
            (e) =>
              e.type === 'model' &&
              e.model.model === `actual-${cli}` &&
              e.model.source === 'cli-message',
          ),
        );
      }
      await f.session.send('second');
      const calls = await f.logs();
      assert.equal(calls[0].args.includes('--resume'), false);
      assert.equal(calls[1].args[calls[1].args.indexOf('--resume') + 1], 'native-session');
      assert.equal(calls[0].input, 'first\n\n<task_context>\ncontext\n</task_context>');
      assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'chosen-model');
      assert.equal(calls[0].args.includes('first'), false);
      assert.ok(
        !calls
          .flatMap((c) => c.args)
          .some((a) => /skip-permissions|^--yolo$|^--force$|^--approve-mcps$/.test(a)),
      );
      if (cli === 'claude') {
        assert.equal(calls[0].args[calls[0].args.indexOf('--tools') + 1], '');
        assert.ok(calls[0].args.includes('--safe-mode'));
        assert.equal(calls[0].args[calls[0].args.indexOf('--permission-prompts') + 1], 'none');
      } else if (cli === 'gemini') {
        assert.equal(calls[0].args[calls[0].args.indexOf('--approval-mode') + 1], 'plan');
        assert.match(
          await readFile(path.join(f.directory, 'policy.txt'), 'utf8'),
          /toolName = "\*"\ndecision = "deny"\npriority = 999/,
        );
        await until(async () => {
          try {
            await readFile(calls[0].args[calls[0].args.indexOf('--admin-policy') + 1]);
            return false;
          } catch {
            return true;
          }
        });
      } else assert.equal(calls[0].args[calls[0].args.indexOf('--mode') + 1], 'ask');
      f.session.close();
      // A newly constructed adapter resumes the same native identity, not reconstructed history.
      const resumed = new StreamCliSession({
        cli,
        workspace: f.directory,
        executablePath: f.executablePath,
        sessionId: 'native-session',
        tools: [],
        callTool: async () => {
          throw new Error('unavailable');
        },
        onEvent: (event) => {
          if (event.type === 'approval' && event.request.id.startsWith(`${cli}-workspace:`))
            resumed.resolveApproval(event.request.id, true);
        },
      });
      try {
        await resumed.send('after restart');
        assert.equal(resumed.sessionId, 'native-session');
      } finally {
        resumed.close();
      }
      const last = (await f.logs()).at(-1)!;
      assert.equal(last.args[last.args.indexOf('--resume') + 1], 'native-session');
    } finally {
      await f.cleanup();
    }
  });
  for (const mode of [
    'invalid-json',
    'no-init',
    'no-result',
    'nonzero',
    'native-error',
    'result-error',
    'aborted-result',
    'approval',
    'duplicate-result',
    'after-result-garbage',
    'wrong-record-session',
  ]) {
    test(`${cli}: ${mode} cannot become successful completion`, async () => {
      const f = await fixture(cli, mode);
      try {
        await assert.rejects(f.session.send('task'));
        assert.equal(
          f.events.some((e) => e.type === 'complete'),
          false,
        );
        assert.equal(f.session.isClosed, true);
        assert.equal(JSON.stringify(f.events).includes('sk-secret'), false);
        assert.throws(() => f.session.resolveApproval('approve', true), /尚未接通/);
        assert.throws(() => f.session.resolveUserInput('answer', {}), /尚未接通/);
      } finally {
        await f.cleanup();
      }
    });
  }
  for (const mode of ['wrong-session', 'missing-session']) {
    test(`${cli}: ${mode} fails without falling back to a new native session`, async () => {
      const f = await fixture(cli, mode, 'original-session');
      try {
        await assert.rejects(f.session.send('resume'));
        assert.equal(f.session.sessionId, 'original-session');
        assert.equal((await f.logs()).length, 1);
        assert.equal(
          f.events.some((e) => e.type === 'complete'),
          false,
        );
      } finally {
        await f.cleanup();
      }
    });
  }
  test(`${cli}: absent usage remains unknown and initialization alias is not runtime proof`, async () => {
    const f = await fixture(cli, 'unknown-usage');
    try {
      await f.session.send('task');
      assert.equal(
        f.events.some((e) => e.type === 'usage'),
        false,
      );
      assert.equal(
        f.events.some((e) => e.type === 'model' && e.model.model === 'configured-alias'),
        false,
      );
    } finally {
      await f.cleanup();
    }
  });
  test(`${cli}: terminal result is not completion before process exits`, async () => {
    const f = await fixture(cli, 'delayed-exit');
    try {
      const done = f.session.send('task');
      await until(() => text(f.events).endsWith('!'));
      assert.equal(
        f.events.some((e) => e.type === 'complete'),
        false,
      );
      await done;
      assert.equal(f.events.filter((e) => e.type === 'complete').length, 1);
    } finally {
      await f.cleanup();
    }
  });
  test(`${cli}: interrupt kills stubborn process group, rejects turn and overlapping send`, async () => {
    const f = await fixture(cli, 'slow');
    try {
      const done = f.session.send('slow');
      const rejected = assert.rejects(done, /停止/);
      await assert.rejects(f.session.send('overlap'), /等待/);
      await until(async () => {
        try {
          return Number(await readFile(path.join(f.directory, 'descendant'), 'utf8')) > 0;
        } catch {
          return false;
        }
      });
      const pid = Number(await readFile(path.join(f.directory, 'descendant'), 'utf8'));
      await new Promise((r) => setTimeout(r, 80)); // descendant has installed SIGTERM handler
      assert.equal(alive(pid), true);
      await f.session.interrupt();
      await rejected;
      await until(() => !alive(pid));
      assert.equal(
        f.events.some((e) => e.type === 'complete'),
        false,
      );
    } finally {
      await f.cleanup();
    }
  });
}
for (const cli of ['claude', 'gemini'] as const)
  test(`${cli}: tool-disabled mode never pretends native tools were authorized`, async () => {
    const f = await fixture(cli, 'tool-disabled');
    try {
      await assert.rejects(f.session.send('task'), /已禁用/);
      assert.equal(f.hostCalls(), 0);
    } finally {
      await f.cleanup();
    }
  });
test('claude: permission denial is not task success', async () => {
  const f = await fixture('claude', 'denied');
  try {
    await assert.rejects(f.session.send('task'), /权限被拒绝/);
    assert.equal(
      f.events.some((e) => e.type === 'complete'),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
for (const mode of [
  'tool',
  'tool-error',
  'tool-false',
  'tool-pending',
  'mutating-tool',
  'mutating-tool-colon-id',
  'bad-tool-record',
  'tool-orphan-end',
])
  test(`cursor: ${mode} preserves native read tool evidence without a fake approval bridge`, async () => {
    const f = await fixture('cursor', mode);
    try {
      if (mode === 'tool') {
        await f.session.send('task');
        const events = f.events.filter((e) => e.type === 'tool');
        assert.deepEqual(
          events.map((e) => e.call.status),
          ['running', 'done'],
        );
        assert.deepEqual(events[0].call.input, { path: 'file.txt' });
        assert.equal(JSON.stringify(events).includes('HIDDEN_TOOL_OUTPUT'), false);
      } else {
        await assert.rejects(f.session.send('task'));
        assert.equal(
          f.events.some((e) => e.type === 'complete'),
          false,
        );
      }
      assert.equal(f.hostCalls(), 0);
    } finally {
      await f.cleanup();
    }
  });
test('stream-cli-session: startup failure, input guards and model effort support fail explicitly', async () => {
  const f = await fixture('gemini');
  try {
    await assert.rejects(f.session.prepare({ model: 'model', effort: 'high' }), /不支持/);
    await assert.rejects(f.session.send(''), /格式/);
    await assert.rejects(f.session.send('task', undefined, {} as any), /网页元素/);
    const session = new StreamCliSession({
      cli: 'claude',
      workspace: f.directory,
      executablePath: path.join(f.directory, 'does-not-exist'),
      tools: [],
      onEvent: (e) => f.events.push(e),
      callTool: async () => {
        throw new Error('not available');
      },
    });
    try {
      await assert.rejects(session.send('task'), /启动/);
      assert.equal(session.isClosed, true);
    } finally {
      session.close();
    }
    assert.throws(
      () =>
        new StreamCliSession({
          cli: 'gemini',
          workspace: f.directory,
          executablePath: f.executablePath,
          sessionId: 'latest',
          tools: [],
          onEvent: () => {},
          callTool: async () => {
            throw new Error();
          },
        }),
      /明确的原生/,
    );
  } finally {
    await f.cleanup();
  }
});
test('stream-cli-session: rejects invalid browser tool definitions', async () => {
  const f = await fixture('claude');
  try {
    const session = new StreamCliSession({
      cli: 'claude',
      workspace: f.directory,
      executablePath: f.executablePath,
      tools: [{} as any],
      onEvent: () => {},
      callTool: async () => {
        throw new Error();
      },
    });
    try {
      await assert.rejects(session.prepare(), /工具定义无效/);
    } finally {
      session.close();
    }
  } finally {
    await f.cleanup();
  }
});
test('stream-cli-session: closing during Gemini asynchronous policy setup cannot launch a late process', async () => {
  const f = await fixture('gemini');
  try {
    const done = f.session.send('task');
    const rejected = assert.rejects(done, /关闭/);
    await Promise.resolve();
    f.session.close();
    await rejected;
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(readFile(path.join(f.directory, 'args.jsonl')));
  } finally {
    await f.cleanup();
  }
});
for (const cli of cliIds)
  test(`${cli}: a final JSONL record without LF is parsed at EOF`, async () => {
    const f = await fixture(cli, 'no-final-newline');
    try {
      await f.session.send('task');
      assert.equal(text(f.events), '你\u2028好!');
    } finally {
      await f.cleanup();
    }
  });
for (const cli of ['claude', 'gemini'] as const)
  test(`${cli}: native full message recovers a missing partial stream`, async () => {
    const f = await fixture(cli, 'snapshot-only');
    try {
      await f.session.send('task');
      assert.equal(text(f.events), '你\u2028好!');
    } finally {
      await f.cleanup();
    }
  });
test('stream-cli-session: descendant is killed even when its group leader has already exited', async () => {
  const f = await fixture('gemini', 'leader-exits');
  try {
    const done = f.session.send('task');
    const rejected = assert.rejects(done, /失败/);
    await until(async () => {
      try {
        return Number(await readFile(path.join(f.directory, 'descendant'), 'utf8')) > 0;
      } catch {
        return false;
      }
    });
    const pid = Number(await readFile(path.join(f.directory, 'descendant'), 'utf8'));
    await rejected;
    await until(() => !alive(pid));
    assert.equal(
      f.events.some((e) => e.type === 'complete'),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
test('stream-cli-session: explicit close rejects an active turn instead of completing it', async () => {
  const f = await fixture('cursor', 'delayed-exit');
  try {
    const done = f.session.send('task');
    const rejected = assert.rejects(done, /关闭/);
    await until(() => text(f.events).endsWith('!'));
    f.session.close();
    await rejected;
    assert.equal(
      f.events.some((e) => e.type === 'complete'),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
test('stream-cli-session: prepare remembers explicit model selection without running a discovery prompt', async () => {
  const f = await fixture('claude');
  try {
    await f.session.prepare({ model: 'prepared-model', effort: 'high' });
    await f.session.send('task');
    const call = (await f.logs())[0];
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'prepared-model');
    assert.equal(call.args[call.args.indexOf('--effort') + 1], 'high');
  } finally {
    await f.cleanup();
  }
});
test('stream-cli-session: interrupt during prepare prevents a late launch', async () => {
  const f = await fixture('claude');
  try {
    const done = f.session.send('task');
    const rejected = assert.rejects(done, /关闭/);
    await f.session.interrupt();
    await rejected;
    await assert.rejects(readFile(path.join(f.directory, 'args.jsonl')));
  } finally {
    await f.cleanup();
  }
});

test('Claude uses streaming image content while unsupported CLIs reject before launch', async (t) => {
  const f = await fixture('claude');
  t.after(f.cleanup);
  await f.session.send('', undefined, undefined, undefined, [testImage]);
  const [record] = await f.logs();
  assert.ok(record.args.includes('--input-format'));
  const input = JSON.parse(record.input);
  assert.equal(input.type, 'user');
  assert.deepEqual(input.message.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: testImage.data } },
  ]);
  for (const cli of ['cursor', 'gemini'] as const) {
    const unsupported = await fixture(cli);
    t.after(unsupported.cleanup);
    await assert.rejects(
      unsupported.session.send('look', undefined, undefined, undefined, [testImage]),
      /不支持图片/,
    );
    await assert.rejects(unsupported.logs(), { code: 'ENOENT' });
  }
});

test('Claude native MCP configuration routes browser calls and is revoked after each turn', async (t) => {
  const tool = {
    name: 'neo_status',
    description: 'Browser status',
    inputSchema: { type: 'object', properties: {} },
  };
  const f = await fixture('claude', 'browser-tools', undefined, true, [tool]);
  t.after(f.cleanup);
  await f.session.send('read the browser');
  assert.equal(f.hostCalls(), 1);
  const events = f.events.filter((event) => event.type === 'tool');
  assert.deepEqual(
    events.map((event) => event.call.status),
    ['running', 'done'],
  );
  assert.equal(events[0].call.name, 'neo_status');
  const [call] = await f.logs();
  assert.ok(call.args.includes('--restricted'));
  assert.ok(call.args.includes('mcp__athena__neo_status'));
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.ok(!call.args.includes('--safe-mode'));
  const bridge = JSON.parse(await readFile(path.join(f.directory, 'bridge.json'), 'utf8'));
  assert.equal(bridge.mode, 0o600);
  await assert.rejects(fetch(bridge.url));
  await until(async () =>
    readFile(call.args[call.args.indexOf('--mcp-config') + 1]).then(
      () => false,
      () => true,
    ),
  );
  assert.equal(f.session.matchesConfiguration(f.directory, f.executablePath, [tool]), true);
  assert.equal(f.session.matchesConfiguration(f.directory, f.executablePath, []), false);
});
