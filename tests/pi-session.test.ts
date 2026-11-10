import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiSession } from '../src/main/pi-session';
import type { AgentEvent } from '../src/shared/types';

async function fixture(mode = 'normal') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'athena-pi-test-'));
  const script = path.join(directory, 'cli.cjs');
  const executablePath = path.join(directory, 'pi');
  await writeFile(
    script,
    `
const fs=require('node:fs'); const readline=require('node:readline');
const mode=${JSON.stringify(mode)}; const log=${JSON.stringify(path.join(directory, 'commands.jsonl'))};
const discoveryGate=${JSON.stringify(path.join(directory, 'discovery-gate'))};
process.env.WORKBENCH_FIXTURE_SKILL_PATH=${JSON.stringify(path.join(directory, '.pi', 'skills', 'review', 'SKILL.md'))};

const args=process.argv.slice(2);
if(args.includes('--help')){console.log('--mode rpc --no-skills --no-prompt-templates');console.log(mode==='builtin-extensions'?'--no-extensions Disable extension discovery and built-in extensions':'--no-extensions --no-mcp');process.exit(0);}
if(mode==='builtin-extensions'&&args.includes('--no-mcp')){process.stderr.write('Unknown option: --no-mcp');process.exit(2);}
fs.writeFileSync(${JSON.stringify(path.join(directory, 'arguments.json'))},JSON.stringify(args));
const si=args.indexOf('--session-id'); const sr=args.indexOf('--session');
const sid=(mode==='wrong-session'||mode==='wrong-new-session')?'other':args[si>=0?si+1:sr+1];
const out=r=>process.stdout.write(JSON.stringify(r)+'\\n');
const response=(r,data)=>out({type:'response',id:r.id,command:r.type,success:true,data});
const end=(word='done')=>{out({type:'message_end',message:{role:'assistant',model:'test-model',provider:'fixture',stopReason:'stop',content:[{type:'text',text:word}],usage:{input:10,output:3,cacheRead:2,cacheWrite:1,totalTokens:16}}});out({type:'agent_settled',aborted:false});};
const start=()=>{out({type:'agent_start'});out({type:'message_start',message:{role:'assistant',model:'test-model',provider:'fixture'}});};
readline.createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(r)+'\\n');
if(r.type==='get_state'){if(mode!=='no-gate')out({type:'extension_ui_request',id:'gate',method:'notify',message:'athena-permissions-v1'});return response(r,{sessionId:sid,isStreaming:false,pendingMessageCount:0,model:{id:'test-model',provider:'fixture'}});}
if(r.type==='get_available_models')return response(r,{models:[{id:'test-model',provider:'fixture',name:'Fixture'}]});
if(r.type==='get_commands'){
      const commands = mode === 'outside-skill-path'
        ? [{ name: 'skill:review', description: 'Review', source: 'skill', sourceInfo: { path: '/etc/passwd' } }]
        : mode === 'global-skill-path'
          ? [{ name: 'skill:review', description: 'Review changes', source: 'skill', sourceInfo: { path: '/Users/example/.pi/agent/skills/review/SKILL.md' } }]
          : [{ name: 'skill:review', description: 'Review changes', source: 'skill', sourceInfo: { path: process.env.WORKBENCH_FIXTURE_SKILL_PATH } }, { name: 'fix-tests', source: 'prompt', sourceInfo: { path: '/tmp/fix-tests.md' } }];
 const answer=()=>response(r,{commands});
 if(mode==='delayed-discovery'&&!fs.existsSync(discoveryGate)){fs.writeFileSync(discoveryGate,'requested');const wait=setInterval(()=>{if(fs.existsSync(discoveryGate+'.release')){clearInterval(wait);answer()}},5);return;}
 return answer();
}
if(r.type==='get_available_thinking_levels')return response(r,{levels:['off','high']});
if(r.type==='set_model'||r.type==='set_thinking_level'||r.type==='clear_queue')return response(r,{});
if(r.type==='abort'){out({type:'agent_settled',aborted:true});return response(r,{});}
if(r.type==='extension_ui_response'){end(r.confirmed?'approved':'denied');return;}
if(r.type!=='prompt')return;
if(r.message==='handled')return response(r,{disposition:'handled'});
response(r,{disposition:'started'});start();
if(r.message==='crash'){process.stderr.write('sk-secret-do-not-forward');process.exit(7);return;}
if(r.message==='orphan'){
  require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('ready-child','yes');setTimeout(()=>require('node:fs').writeFileSync('orphan-leak','bad'),2500)"],{cwd:process.cwd(),stdio:'ignore'});
  const wait=setInterval(()=>{if(fs.existsSync('ready-child')){clearInterval(wait);process.exit(7);}},5);return;
}
if(r.message==='bad'){process.stdout.write('not json\\n');return;}
if(r.message==='mismatch'){out({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'first'}});end('other');return;}
if(r.message==='empty'){out({type:'agent_settled',aborted:false});return;}
if(r.message==='approval'){out({type:'extension_ui_request',id:'confirm-1',method:'confirm',title:'Pi · write',message:'file.txt'});return;}
if(r.message==='slow'){out({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'first'}});return;}
if(r.message==='retry'){out({type:'message_end',message:{role:'assistant',stopReason:'error',content:[]}});out({type:'agent_end',willRetry:true});start();end('recovered');return;}
out({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'HIDDEN_THINKING'}});
out({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'a\\u2028b'}});
out({type:'agent_end',willRetry:true});setTimeout(()=>end('a\\u2028b!'),20);
});
`,
  );
  await writeFile(
    executablePath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    { mode: 0o755 },
  );
  const events: AgentEvent[] = [];
  const session = new PiSession({
    workspace: directory,
    executablePath,
    sessionId: mode === 'wrong-session' ? 'original' : undefined,
    permissionsExtensionPath: path.resolve('resources/cli/pi-permissions.mjs'),
    tools: [],
    callTool: async () => ({ isError: true, text: 'not available' }),
    onEvent: (event) => events.push(event),
  });
  const cleanup = async () => {
    session.close();
    await rm(directory, { recursive: true, force: true });
  };
  return { session, events, directory, cleanup };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 2000; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Fixture condition timed out');
}

test('Pi provider skill discovery passes optional identity metadata without host file reads', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.directory, '.pi', 'skills', 'review'), { recursive: true });
    const discovery = await f.session.discoverProviderSkills();
    assert.equal(discovery.status, 'ready');
    const skill = discovery.skills[0];
    assert(skill);
    assert.equal(skill.contentHash, undefined);
    assert.equal(skill.providerPath, path.join(f.directory, '.pi', 'skills', 'review', 'SKILL.md'));
    await assert.rejects(readFile(skill.providerPath));
    await f.session.send('task', undefined, undefined, undefined, [skill]);
    const commands = (await readFile(path.join(f.directory, 'commands.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(commands.filter((command) => command.type === 'prompt').map((command) => command.message), ['/skill:review\n\ntask']);
  } finally {
    await f.cleanup();
  }
});

test('Pi provider Skill discovery preserves provider-owned paths without reading them', async () => {
  const f = await fixture('outside-skill-path');
  try {
    await f.session.prepare();
    const discovery = await f.session.discoverProviderSkills();
    assert.equal(discovery.status, 'ready');
    assert.equal(discovery.skills[0]?.providerPath, '/etc/passwd');
    assert.equal(discovery.skills[0]?.contentHash, undefined);
  } finally {
    await f.cleanup();
  }
});

test('Pi provider Skill discovery accepts native global paths without reading them', async () => {
  const f = await fixture('global-skill-path');
  try {
    await f.session.prepare();
    const discovery = await f.session.discoverProviderSkills();
    assert.equal(discovery.status, 'ready');
    assert.equal(discovery.skills[0]?.providerPath, '/Users/example/.pi/agent/skills/review/SKILL.md');
    assert.equal(discovery.skills[0]?.contentHash, undefined);
    await assert.rejects(readFile(discovery.skills[0]!.providerPath!));
  } finally {
    await f.cleanup();
  }
});

test('Pi discovery and send both complete without creating host-side skill contents', async () => {
  const f = await fixture();
  try {
    await f.session.prepare();
    const models = await f.session.listModels();
    assert.equal(models[0].model, 'fixture/test-model');
    assert.deepEqual(models[0].efforts, []);
    const skillDirectory = path.join(f.directory, '.pi/skills/review');
    await mkdir(skillDirectory, { recursive: true });
    const discovery = await f.session.discoverProviderSkills();
    assert.equal(discovery.status, 'ready');
    assert.deepEqual(discovery.skills.map((skill) => skill.name), ['review']);
    assert.equal(discovery.skills[0].providerPath, path.join(f.directory, '.pi', 'skills', 'review', 'SKILL.md'));
    assert.equal(discovery.skills[0].contentHash, undefined);
    await f.session.send('normal', undefined, undefined, {
      model: 'fixture/test-model',
      effort: 'high',
    }, discovery.skills);
    assert.equal(
      f.events
        .filter((event) => event.type === 'delta')
        .map((event) => event.text)
        .join(''),
      'a b!',
    );
    assert.equal(JSON.stringify(f.events).includes('HIDDEN_THINKING'), false);
    assert.equal(f.events.filter((event) => event.type === 'complete').length, 1);
    const usage = f.events.find((event) => event.type === 'usage');
    assert.equal(usage?.total.inputTokens, 13);
    assert.equal(usage?.total.reasoningOutputTokens, null);
    assert.ok(
      f.events.some(
        (event) =>
          event.type === 'model' &&
          event.model.source === 'cli-message' &&
          event.model.requested === 'fixture/test-model',
      ),
    );
    const commands = (await readFile(path.join(f.directory, 'commands.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      commands.filter((command) => command.type === 'prompt').map((command) => command.message),
      ['/skill:review\n\nnormal'],
    );
    await f.session.send('normal');
    assert.equal(f.events.filter((event) => event.type === 'complete').length, 2);
  } finally {
    await f.cleanup();
  }
});

test('Pi built-in extension isolation avoids removed flags and retains the host permission extension', async () => {
  const f = await fixture('builtin-extensions');
  try {
    await f.session.prepare();
    const args = JSON.parse(await readFile(path.join(f.directory, 'arguments.json'), 'utf8'));
    assert.equal(args.includes('--no-mcp'), false);
    assert.ok(args.includes('--no-extensions'));
    assert.ok(args.includes('--no-approve'));
    assert.equal(
      args[args.indexOf('--extension') + 1],
      path.resolve('resources/cli/pi-permissions.mjs'),
    );
    await f.session.send('normal');
    assert.equal(f.events.filter((event) => event.type === 'complete').length, 1);
  } finally {
    await f.cleanup();
  }
});

test('Pi host approval is correlated, denied explicitly and cannot be reused', async () => {
  const f = await fixture();
  try {
    const done = f.session.send('approval');
    await until(() => f.events.some((event) => event.type === 'approval'));
    assert.throws(() => f.session.resolveApproval('foreign', true), /失效/);
    f.session.resolveApproval('confirm-1', false);
    await done;
    assert.equal(
      f.events
        .filter((event) => event.type === 'delta')
        .map((event) => event.text)
        .join(''),
      'denied',
    );
    assert.throws(() => f.session.resolveApproval('confirm-1', true), /失效/);
  } finally {
    await f.cleanup();
  }
});

test('Pi cancellation clears queues before abort and rejects overlapping sends', async () => {
  const f = await fixture();
  try {
    const done = f.session.send('slow');
    const rejected = assert.rejects(done, /停止/);
    await assert.rejects(f.session.send('normal'), /等待/);
    await until(() => f.events.some((event) => event.type === 'delta'));
    await f.session.interrupt();
    await rejected;
    const commands = (await readFile(path.join(f.directory, 'commands.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(
      commands.findIndex((command) => command.type === 'clear_queue') <
        commands.findIndex((command) => command.type === 'abort'),
    );
    assert.equal(f.events.filter((event) => event.type === 'complete').length, 0);
    await f.session.send('normal');
  } finally {
    await f.cleanup();
  }
});

test(
  'Pi terminates descendants even when the RPC process exits first',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.session.send('orphan'), /退出/);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await assert.rejects(readFile(path.join(f.directory, 'orphan-leak')), { code: 'ENOENT' });
    } finally {
      await f.cleanup();
    }
  },
);

test('Pi permits a successful automatic recovery but not an empty settled result', async () => {
  const f = await fixture();
  try {
    await f.session.send('retry');
    await assert.rejects(f.session.send('empty'), /未返回/);
  } finally {
    await f.cleanup();
  }
});

for (const [mode, prompt, pattern] of [
  ['no-gate', '', /授权扩展/],
  ['wrong-session', '', /其他会话/],
  ['wrong-new-session', '', /其他会话/],
  ['normal', 'handled', /独立任务/],
  ['normal', 'bad', /JSONL/],
  ['normal', 'mismatch', /不一致/],
  ['normal', 'crash', /退出/],
] as const)
  test(`Pi fails closed: ${mode}/${prompt}`, async () => {
    const f = await fixture(mode);
    try {
      await assert.rejects(prompt ? f.session.send(prompt) : f.session.prepare(), pattern);
      assert.equal(
        f.events.some((event) => event.type === 'complete'),
        false,
      );
      assert.equal(JSON.stringify(f.events).includes('sk-secret'), false);
    } finally {
      await f.cleanup();
    }
  });
