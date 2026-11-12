// Deterministic Agent protocol fixture. All tools, browser actions and builds run in the real host.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (process.argv.includes('--version')) {
  console.log('codex-cli frontend-workflow-fixture');
  process.exit(0);
}
const config = JSON.parse(
  fs.readFileSync(path.join(path.dirname(process.argv[1]), 'workflow.json'), 'utf8'),
);
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let thread = 'build-' + process.pid,
  turn,
  page,
  names = [],
  nextId = 800,
  lastSnapshot = '';
const pending = new Map();
function finish(text, error) {
  out({
    method: 'item/agentMessage/delta',
    params: { threadId: thread, turnId: turn, itemId: turn, delta: text },
  });
  out({
    method: 'item/completed',
    params: { threadId: thread, turnId: turn, item: { id: turn, type: 'agentMessage', text } },
  });
  out({
    method: 'turn/completed',
    params: {
      threadId: thread,
      turn: {
        id: turn,
        status: error ? 'failed' : 'completed',
        items: [],
        ...(error ? { error: { message: text } } : {}),
      },
    },
  });
}
function tool(name, args) {
  if (!names.includes(name)) throw Error('Host did not expose ' + name);
  const id = ++nextId;
  fs.appendFileSync(config.log, JSON.stringify({ name, args }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    out({
      id,
      method: 'item/tool/call',
      params: { threadId: thread, turnId: turn, callId: 'call-' + id, tool: name, arguments: args },
    });
  });
}
async function snapshot() {
  return (lastSnapshot = await tool('web_snapshot', { page }));
}
function ref(label) {
  const line = lastSnapshot.split('\n').find((line) => line.includes('"' + label + '"'));
  const value = line?.match(/\[ref=(ab[0-9a-f]+:e\d+)\]/)?.[1];
  if (!value) throw Error('No current ref for ' + label + '\n' + lastSnapshot);
  return value;
}
async function click(label) {
  await tool('web_act', { page, kind: 'click', ref: ref(label) });
  return snapshot();
}
async function checkpoint(evidence) {
  const observation = lastSnapshot.includes(evidence)
    ? lastSnapshot
    : await tool('web_read', { page });
  const observationId = observation.match(/Athena observationId: ([a-f0-9-]+)/)?.[1];
  if (!observationId || !observation.includes(evidence))
    throw Error('Missing evidence ' + evidence);
  await tool('web_checkpoint', { observationId, summary: evidence, evidence, outcome: 'verified' });
}
async function workflow(input) {
  const raw = input.match(/<web_browser_context>\n([^\n]+)/)?.[1];
  if (!raw) throw Error('No browser context');
  page = JSON.parse(raw).currentPage.pageId;
  const indexed = JSON.parse(await tool('workbench_feishu_index', {}));
  if (indexed.documents.length < 3) throw Error('Related documents were not indexed');
  const found = JSON.parse(await tool('workbench_feishu_search', { query: '前端 静态 构建' }));
  if (!found.hits.length) throw Error('No relevant knowledge');
  const requirements = JSON.parse(
    await tool('workbench_feishu_read', { url: 'https://fixture.feishu.cn/docx/FrontendConfig' }),
  );
  if (!requirements.content.includes('package.json')) throw Error('Missing naming constraint');
  const guide = JSON.parse(
    await tool('workbench_feishu_read', { url: 'https://fixture.feishu.cn/docx/PlatformGuide' }),
  );
  const platform = guide.content.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (!platform) throw Error('No platform link in source');
  await tool('athena_sandbox_write', { files: config.files });
  const preflight = JSON.parse(
    await tool('athena_sandbox_exec', { command: 'npm run build', wait_seconds: 20 }),
  );
  if (preflight.command.exitCode !== 0) throw Error('Preflight build failed');
  await tool('web_navigate', { page, url: platform });
  await snapshot();
  await click('新增应用');
  const fields = {
    应用名称: config.name,
    应用等级: 'P2',
    应用组: 'demo',
    应用负责人: 'demo',
    测试负责人: 'demo',
    告警接收人: 'demo',
    开发语言: 'JavaScript',
    'Git 仓库': 'https://git.example.test/demo/' + config.name + '.git',
    描述: '前端任务看板联调',
  };
  await tool('web_act', {
    page,
    kind: 'fill',
    fields: Object.entries(fields).map(([label, value]) => ({ ref: ref(label), value })),
  });
  await snapshot();
  await click('保存应用');
  await checkpoint('应用 ' + config.name + ' 已创建');
  await click('CloudOS 流水线');
  await click('新建构建计划');
  await click('保存构建计划');
  await checkpoint('构建计划已创建');
  await click('开始构建');
  await tool('web_wait', { page, for: 'text', value: '构建成功', timeout: 30000 });
  await snapshot();
  await checkpoint('构建成功');
  await click('打开应用预览');
  await tool('web_wait', { page, for: 'text', value: '任务看板', timeout: 10000 });
  await snapshot();
  await tool('web_act', { page, kind: 'fill', ref: ref('任务标题'), value: '联调验证任务' });
  await snapshot();
  await click('添加任务');
  await tool('web_navigate', { page, action: 'reload' });
  await snapshot();
  await checkpoint('联调验证任务');
  const packed = JSON.parse(
    await tool('athena_sandbox_exec', {
      command:
        'tar -czf frontend.tar.gz package.json build.mjs preview.mjs .gitlab-ci.yml src dist',
      wait_seconds: 20,
    }),
  );
  if (packed.command.exitCode !== 0) throw Error('Packaging failed');
  const artifact = JSON.parse(await tool('athena_sandbox_artifact', { path: 'frontend.tar.gz' }));
  if (!artifact.sha256) throw Error('Artifact was not verified');
  finish(
    'FRONTEND_WORKFLOW_VERIFIED\n知识与企业平台为本地 mock；agent-browser、Docker 构建、页面交互和产物均已实际验证。\n产物：' +
      artifact.path,
  );
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line),
    p = message.params || {};
  if (pending.has(message.id) && !message.method) {
    const wait = pending.get(message.id);
    pending.delete(message.id);
    const value = message.result;
    const text = (value?.contentItems || [])
      .filter((item) => item.type === 'inputText')
      .map((item) => item.text)
      .join('\n');
    return value?.success ? wait.resolve(text) : wait.reject(Error(text || 'Tool request failed'));
  }
  if (message.method === 'initialize')
    return out({ id: message.id, result: { userAgent: 'frontend-workflow-fixture' } });
  if (message.method === 'model/list') return out({ id: message.id, result: { data: [] } });
  if (message.method === 'thread/read')
    return out({ id: message.id, result: { thread: { id: p.threadId, turns: [] } } });
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    thread = p.threadId || thread;
    names = (p.dynamicTools || []).map((tool) => tool.name);
    return out({ id: message.id, result: { thread: { id: thread } } });
  }
  if (message.method === 'turn/start') {
    turn = 'turn-' + Date.now();
    out({ id: message.id, result: { turn: { id: turn, status: 'inProgress' } } });
    out({
      method: 'turn/started',
      params: { threadId: thread, turn: { id: turn, status: 'inProgress' } },
    });
    void workflow(
      p.input
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n'),
    ).catch((error) => finish('WORKFLOW_ERROR: ' + error.message, true));
    return;
  }
  if (message.method === 'turn/interrupt') {
    out({ id: message.id, result: {} });
    finish('Stopped', true);
    return;
  }
  if (message.id !== undefined && message.method) out({ id: message.id, result: {} });
});
