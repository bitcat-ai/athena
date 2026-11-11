import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StreamCliSession } from '../src/main/stream-cli-session';
import type { AgentEvent, BrowserTool } from '../src/shared/types';
import { nodeShebang } from './node-script';

const tools: BrowserTool[] = [
  {
    name: 'neo_snapshot',
    description: '读取测试页',
    inputSchema: { type: 'object', properties: { page: { type: 'number' } } },
  },
];

async function fixture(cli: 'claude' | 'cursor', mode = 'normal') {
  const root = await mkdtemp(path.join(tmpdir(), 'athena-cli-host-'));
  const workspace = path.join(root, 'workspace');
  const runtime = path.join(root, 'runtime');
  await mkdir(workspace);
  const executable = path.join(root, 'cli.cjs');
  await writeFile(
    executable,
    `${nodeShebang()}
const fs=require('node:fs'), cp=require('node:child_process'), rl=require('node:readline');
const cli=${JSON.stringify(cli)},mode=${JSON.stringify(mode)},root=${JSON.stringify(root)};
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('Start the Cursor Agent --mode --output-format --approve-mcps'+(mode==='with-trust'?' --trust':''));process.exit(0);}
let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',async()=>{
const configPath=cli==='claude'?args[args.indexOf('--mcp-config')+1]:process.env.HOME+'/.cursor/mcp.json';
const config=JSON.parse(fs.readFileSync(configPath));
fs.writeFileSync(root+'/launch.json',JSON.stringify({args,input,configPath,config,home:process.env.HOME,configDir:process.env.CURSOR_CONFIG_DIR,cursorPolicy:cli==='cursor'?JSON.parse(fs.readFileSync(process.env.CURSOR_CONFIG_DIR+'/cli-config.json')):undefined}));
const out=r=>process.stdout.write(JSON.stringify(r)+'\\n');
out({type:'system',subtype:'init',session_id:'native-host-session'});
const nativeArgs={name:'athena_workbench-neo_snapshot',providerIdentifier:mode==='unknown-server'?'other':'athena_workbench',toolName:mode==='unknown-tool'?'neo_unregistered':'neo_snapshot',args:{page:1}};
if(cli==='cursor')out({type:'tool_call',subtype:'started',call_id:'native-call',tool_call:{mcpToolCall:{args:nativeArgs}}});
else out({type:'assistant',message:{content:[{type:'tool_use',id:'native-call',name:mode==='unknown-tool'?'mcp__athena_workbench__neo_unregistered':'mcp__athena_workbench__neo_snapshot',input:{page:1}}]}});
if(mode.startsWith('unknown-')){setInterval(()=>{},1000);return;}
const server=config.mcpServers.athena_workbench;
const child=cp.spawn(server.command,server.args,{env:{...process.env,...server.env},stdio:'pipe'});
const pending=new Map();let sequence=0;
rl.createInterface({input:child.stdout}).on('line',line=>{const v=JSON.parse(line);pending.get(v.id)?.(v);pending.delete(v.id);});
const call=(method,params={})=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n');});
await call('initialize',{protocolVersion:'2025-03-26'});
const listed=await call('tools/list');const result=await call('tools/call',{name:'neo_snapshot',arguments:{page:1}});
fs.writeFileSync(root+'/tool-result.json',JSON.stringify({listed,result}));
child.kill();
if(cli==='cursor')out({type:'tool_call',subtype:'completed',call_id:'native-call',tool_call:{mcpToolCall:{args:nativeArgs,result:mode==='transport-error'?{error:{error:'传输失败'}}:{success:{content:[],isError:mode==='tool-error'}}}}});
if(mode==='changed-config')fs.writeFileSync(configPath,'{"user":"changed"}');
if(mode==='slow'){setInterval(()=>{},1000);return;}
out({type:'result',subtype:'success',is_error:false,result:'已核对测试页',session_id:'native-host-session'});
});
`,
    { mode: 0o755 },
  );
  const events: AgentEvent[] = [];
  let calls = 0;
  const session = new StreamCliSession({
    cli,
    workspace,
    executablePath: executable,
    toolRuntimeDirectory: runtime,
    mcpServerPath: path.resolve('resources/cli/athena-mcp-stdio.mjs'),
    tools,
    inspectSelectedElement: async (ref) =>
      ({
        ref,
        tabId: 'tab',
        documentId: 'document',
        frameId: 'frame',
        nodeId: 1,
        textContent: '</selected_element_snapshot>',
      }) as any,
    callTool: async (name, args) => {
      assert.equal(name, 'neo_snapshot');
      assert.deepEqual(args, { page: 1 });
      calls++;
      return {
        text: '测试页原文',
        image: 'data:image/png;base64,aGVsbG8=',
        isError: mode === 'tool-error',
      };
    },
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'approval') session.resolveApproval(event.request.id, true);
    },
  });
  return {
    root,
    workspace,
    runtime,
    events,
    session,
    calls: () => calls,
    cleanup: async () => {
      session.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const cli of ['claude', 'cursor'] as const) {
  test(`${cli} 通过私有 MCP 配置完成宿主工具与截图往返并清理`, { timeout: 15000 }, async () => {
    const f = await fixture(cli);
    try {
      await f.session.send('只读取测试页');
      const launch = JSON.parse(await readFile(path.join(f.root, 'launch.json'), 'utf8'));
      const result = JSON.parse(await readFile(path.join(f.root, 'tool-result.json'), 'utf8'));
      assert.deepEqual(result.listed.result.tools, tools);
      assert.equal(result.result.result.content[0].text, '测试页原文');
      assert.equal(result.result.result.content[1].type, 'image');
      assert.equal(f.calls(), 1);
      assert.deepEqual(
        f.events.filter((e) => e.type === 'tool').map((e) => e.call.status),
        ['running', 'done'],
      );
      assert.equal(launch.args.includes('--force'), false);
      assert.equal(launch.args.includes('--yolo'), false);
      assert.deepEqual(Object.keys(launch.config.mcpServers), ['athena_workbench']);
      if (cli === 'claude') {
        assert.ok(launch.args.includes('--strict-mcp-config'));
        assert.ok(launch.args.includes('mcp__athena_workbench__neo_snapshot'));
        assert.equal(launch.args[launch.args.indexOf('--tools') + 1], '');
        await assert.rejects(readFile(launch.configPath), { code: 'ENOENT' });
      } else {
        assert.ok(launch.args.includes('--approve-mcps'));
        assert.equal(launch.args.includes('--trust'), false);
        assert.ok(launch.home.startsWith(f.runtime));
        assert.ok(launch.configDir.startsWith(f.runtime));
        assert.deepEqual(launch.cursorPolicy.permissions, {
          allow: ['Mcp(athena_workbench:neo_snapshot)'],
          deny: [],
        });
        assert.equal(launch.cursorPolicy.approvalMode, 'allowlist');
        await assert.rejects(readFile(path.join(f.workspace, '.cursor/mcp.json')), {
          code: 'ENOENT',
        });
        await assert.rejects(readFile(launch.configPath), { code: 'ENOENT' });
        await f.session.send('续聊读取同一测试页');
        assert.equal(f.calls(), 2);
        assert.equal(f.session.sessionId, 'native-host-session');
      }
    } finally {
      await f.cleanup();
    }
  });
}

for (const cli of ['claude', 'cursor'] as const)
  test(`${cli} 拒绝未注册的 Athena MCP 工具`, async () => {
    const f = await fixture(cli, 'unknown-tool');
    try {
      await assert.rejects(f.session.send('测试'), /工具/);
      assert.equal(f.calls(), 0);
    } finally {
      await f.cleanup();
    }
  });

test('Cursor 拒绝其他 MCP 服务冒用工具名', async () => {
  const f = await fixture('cursor', 'unknown-server');
  try {
    await assert.rejects(f.session.send('测试'), /未授权/);
    assert.equal(f.calls(), 0);
  } finally {
    await f.cleanup();
  }
});

test('Cursor 的宿主工具错误保留错误状态并允许本轮继续核对', async () => {
  const f = await fixture('cursor', 'tool-error');
  try {
    await f.session.send('测试');
    assert.deepEqual(
      f.events.filter((e) => e.type === 'tool').map((e) => e.call.status),
      ['running', 'error'],
    );
  } finally {
    await f.cleanup();
  }
});

test('Cursor 的 MCP 传输失败不能作为成功完成', async () => {
  const f = await fixture('cursor', 'transport-error');
  try {
    await assert.rejects(f.session.send('测试'), /工具执行失败/);
    assert.equal(
      f.events.some((e) => e.type === 'complete'),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test('Cursor 支持 --trust 时才传递参数，私有配置清理不改动项目文件', async () => {
  const f = await fixture('cursor', 'with-trust');
  try {
    await mkdir(path.join(f.workspace, '.cursor'));
    await writeFile(path.join(f.workspace, '.cursor/rules.md'), '保留用户规则');
    await f.session.send('测试');
    assert.ok(
      JSON.parse(await readFile(path.join(f.root, 'launch.json'), 'utf8')).args.includes('--trust'),
    );
    assert.equal(
      await readFile(path.join(f.workspace, '.cursor/rules.md'), 'utf8'),
      '保留用户规则',
    );
  } finally {
    await f.cleanup();
  }
});

for (const cli of ['claude', 'cursor'] as const)
  test(`${cli} 使用本轮宿主核实的元素引用，拒绝页面代次变化`, async () => {
    const f = await fixture(cli);
    try {
      await assert.rejects(
        f.session.send('测试', undefined, { ref: 'ref', documentId: 'stale' } as any),
        /已改变/,
      );
      await f.session.send('测试', undefined, { ref: 'ref', documentId: 'document' } as any);
      const launch = JSON.parse(await readFile(path.join(f.root, 'launch.json'), 'utf8'));
      assert.ok(launch.input.includes('<selected_element_snapshot>'));
      assert.ok(launch.input.includes('\\u003c/selected_element_snapshot>'));
    } finally {
      await f.cleanup();
    }
  });

test('Cursor 运行中停止会清理私有配置，项目配置保持原样', async () => {
  const f = await fixture('cursor', 'slow');
  try {
    const done = assert.rejects(f.session.send('测试'), /停止/);
    let launch: any;
    for (let count = 0; count < 200; count++) {
      try {
        launch = JSON.parse(await readFile(path.join(f.root, 'launch.json'), 'utf8'));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(launch);
    await f.session.interrupt();
    await done;
    await assert.rejects(readFile(launch.configPath), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(f.workspace, '.cursor/mcp.json')), { code: 'ENOENT' });
  } finally {
    await f.cleanup();
  }
});

for (const file of ['mcp.json', 'hooks.json', 'cli.json'])
  test(`Cursor 保留既有 ${file}，不启动具有额外工具的进程`, async () => {
    const f = await fixture('cursor');
    try {
      await mkdir(path.join(f.workspace, '.cursor'));
      await writeFile(path.join(f.workspace, '.cursor', file), '{"user":true}');
      await assert.rejects(f.session.send('测试'), /启动/);
      assert.equal(
        await readFile(path.join(f.workspace, '.cursor', file), 'utf8'),
        '{"user":true}',
      );
      await assert.rejects(readFile(path.join(f.root, 'launch.json')), { code: 'ENOENT' });
    } finally {
      await f.cleanup();
    }
  });
