/** Real host + agent-browser + Docker. Feishu/One/CloudOS are explicit fixtures; optional real CLI inference. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { _electron as electron, expect } from '@playwright/test';
import { LocalSandbox } from '../src/main/local-sandbox';
import {
  buildKnowledgeFixture,
  fixtureKnowledgeRoot,
  fixtureLarkCli,
  startBuildPlatform,
} from './frontend-build-fixture';
import { nodeShebang } from './node-script';
import type { AppSnapshot } from '../src/shared/types';
import type { ModelOption } from '../src/shared/usage';

const live = process.env.ATHENA_LIVE_WORKFLOW === '1';
const root = process.cwd();
await mkdir(path.join(root, '.runtime'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.runtime/frontend-workflow-'));
const profile = path.join(directory, 'profile'),
  workspace = path.join(directory, 'workspace'),
  bin = path.join(directory, 'bin');
for (const folder of [profile, workspace, bin]) await mkdir(folder, { recursive: true });
await writeFile(path.join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
const output = path.join(
  root,
  'test-results',
  live ? 'frontend-workflow-live' : 'frontend-workflow',
);
await mkdir(output, { recursive: true });
const controller = new AbortController(),
  context = { conversationId: 'frontend-flow', turnId: 'mock-pipeline', signal: controller.signal };
const backend = new LocalSandbox(
  path.join(profile, 'sandboxes'),
  path.join(root, 'packages/athena-sandbox/athena-sandbox.mjs'),
  () => {},
);
const platform = await startBuildPlatform(async (application) => {
  const validation = await backend.run(
    context,
    `node -e 'const p=require("./package.json");if(p.name!==${JSON.stringify(application.name)})throw Error("package.json name mismatch")'`,
  );
  if (validation.command.exitCode !== 0)
    return { exitCode: validation.command.exitCode ?? 1, logs: validation.output };
  const result = await backend.run(context, 'npm run build', 30, 300);
  let final = result;
  while (final.command.status === 'running')
    final = await backend.result(context, result.command.id, 30);
  if (final.command.exitCode !== 0)
    return { exitCode: final.command.exitCode ?? 1, logs: final.output };
  const artifact = await backend.artifact(context, 'dist/index.html');
  try {
    const preview = await backend.service(context, 'npm run preview');
    return {
      exitCode: 0,
      logs: final.output,
      artifact: { bytes: artifact.bytes, sha256: artifact.sha256 },
      previewUrl: preview.url,
    };
  } catch (error) {
    return {
      exitCode: 0,
      logs: final.output,
      artifact: { bytes: artifact.bytes, sha256: artifact.sha256 },
      previewError: String(error),
    };
  }
});
const applicationName = 'athena-flow-demo';
const appHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>任务看板</title><meta name="viewport" content="width=device-width"><style>body{max-width:760px;margin:50px auto;padding:24px;font:16px system-ui;background:#f6f7f9;color:#202124}main{background:white;padding:30px;border-radius:18px}input,button,select{font:inherit;padding:10px;border:1px solid #bbb;border-radius:7px}button{background:#24272b;color:#fff;cursor:pointer}li{padding:14px 0;border-bottom:1px solid #eee;display:flex;gap:10px;align-items:center}form{display:flex;gap:8px;margin:25px 0}input[type=text]{flex:1}</style><main><h1>任务看板</h1><p>把今天的事情安排清楚。</p><form><input aria-label="任务标题" type="text" required><button>添加任务</button></form><label>筛选 <select aria-label="任务筛选"><option value="all">全部</option><option value="open">未完成</option><option value="done">已完成</option></select></label><ul></ul><p id="empty">暂时没有任务</p></main><script>let tasks=JSON.parse(localStorage.getItem('tasks')||'[]');const list=document.querySelector('ul'),filter=document.querySelector('select');function render(){list.replaceChildren();for(const t of tasks.filter(t=>filter.value==='all'||(filter.value==='done')===t.done)){const li=document.createElement('li'),box=document.createElement('input'),label=document.createElement('span');box.type='checkbox';box.checked=t.done;box.setAttribute('aria-label','完成 '+t.title);box.onchange=()=>{t.done=box.checked;save()};label.textContent=t.title;li.append(box,label);list.append(li)}document.getElementById('empty').hidden=list.children.length>0}function save(){localStorage.setItem('tasks',JSON.stringify(tasks));render()}document.querySelector('form').onsubmit=e=>{e.preventDefault();const input=e.target.querySelector('input');tasks.push({title:input.value,done:false});input.value='';save()};filter.onchange=render;render();</script></html>`;
const files = [
  {
    path: 'package.json',
    content: JSON.stringify({
      name: applicationName,
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: { build: 'node build.mjs', preview: 'node preview.mjs' },
    }),
  },
  { path: 'src/index.html', content: appHtml },
  {
    path: 'build.mjs',
    content:
      "import{mkdir,copyFile,writeFile}from'node:fs/promises';await mkdir('dist',{recursive:true});await copyFile('src/index.html','dist/index.html');await writeFile('dist/build.json',JSON.stringify({node:process.version,builtAt:new Date().toISOString()}));console.log('Built dist/index.html');",
  },
  {
    path: 'preview.mjs',
    content:
      "import{createServer}from'node:http';import{readFile}from'node:fs/promises';createServer(async(q,s)=>{try{s.setHeader('Content-Type','text/html; charset=utf-8');s.end(await readFile('dist/index.html'))}catch{s.statusCode=500;s.end('Build is missing')}}).listen(Number(process.env.PORT||4173),'0.0.0.0');",
  },
  {
    path: '.gitlab-ci.yml',
    content:
      'stages: [build]\nfrontend-build:\n  stage: build\n  script: ["npm run build"]\n  artifacts:\n    paths: [dist/]\n',
  },
];
const fixture = path.join(directory, 'knowledge.json');
await writeFile(fixture, JSON.stringify(buildKnowledgeFixture(platform.url)));
await writeFile(path.join(bin, 'lark-cli'), fixtureLarkCli(process.execPath, fixture), {
  mode: 0o700,
});
const log = path.join(directory, 'tools.jsonl');
await writeFile(log, '');
if (!live) {
  await writeFile(
    path.join(bin, 'codex'),
    nodeShebang() +
      '\n' +
      (await readFile(path.join(root, 'tests/frontend-build-cli.cjs'), 'utf8')),
    { mode: 0o700 },
  );
  await writeFile(
    path.join(bin, 'workflow.json'),
    JSON.stringify({ name: applicationName, root: fixtureKnowledgeRoot, files, log }),
  );
}
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: { agent: 'codex', workspace },
    conversations: [
      {
        id: 'frontend-flow',
        title: '前端构建链路',
        agent: 'codex',
        workspace,
        messages: [],
        updatedAt: 1,
      },
    ],
    recordings: [],
    onboarding: {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      workspaceConfirmed: workspace,
      browserDeferred: true,
    },
  }),
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${bin}${path.delimiter}${process.env.PATH}`,
  WORKBENCH_USER_DATA_DIR: profile,
};
delete env.WORKBENCH_DEV_SERVER_URL;
const app = await electron.launch({
  args: [path.join(root, 'tests/electron-background.cjs')],
  cwd: root,
  env: Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
});
let container: string | undefined;
try {
  const page = await app.firstWindow();
  await page.evaluate('window.__name = fn => fn');
  const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
  await expect.poll(async () => (await snapshot()).web?.status, { timeout: 30_000 }).toBe('ready');
  if (!live)
    assert.equal(
      (await snapshot()).agents.find((agent) => agent.id === 'codex')?.path,
      path.join(bin, 'codex'),
      'Refuse to run a real CLI when the fixture is unavailable',
    );
  if (live) {
    const catalog = await page.evaluate(() =>
      window.workbench.invoke<ModelOption[]>('models:list', { conversationId: 'frontend-flow' }),
    );
    const model =
      catalog.find((item) => item.model === 'gpt-6.1-sol') ??
      catalog.find((item) => item.isDefault) ??
      catalog[0];
    assert.ok(model, 'Real CLI did not return a model catalog');
    const effort = model.efforts.find((item) => item.id === 'low')?.id ?? model.defaultEffort;
    await page.evaluate(
      ({ model, effort }) =>
        window.workbench.invoke('settings:model', {
          conversationId: 'frontend-flow',
          model,
          ...(effort ? { effort } : {}),
        }),
      { model: model.model, effort },
    );
    console.log(`Live CLI model requested: ${model.model}${effort ? ' / ' + effort : ''}`);
  }
  await page.locator('.sidebar-settings').click();
  await page.getByRole('tab', { name: '飞书', exact: true }).click();
  await page.getByRole('textbox', { name: '飞书知识库入口' }).fill(fixtureKnowledgeRoot);
  await page.getByRole('button', { name: '保存知识库入口', exact: true }).click();
  await expect
    .poll(async () => (await snapshot()).settings.knowledgeRoot)
    .toBe(fixtureKnowledgeRoot);
  await page.getByRole('button', { name: '返回对话', exact: true }).click();
  const prompt = `请依据设置中的飞书知识库索引并检索前端构建资料，构建一个名为 ${applicationName} 的前端任务看板，支持新增任务、完成状态筛选、刷新后保留数据。知识服务和企业平台在本次验证中是明确授权的本地 mock；必须真实使用沙箱写入代码和构建，并用 agent-browser 操作资料给出的 One / CloudOS 页面创建应用与构建计划、触发构建，不能通过脚本直接请求平台 API。可自由创建和使用本对话沙箱，不需要再问我确认，保持本机项目不变。构建成功后用 agent-browser 验证预览：新增“联调验证任务”，刷新确认仍存在。最后在沙箱生成包含源码和 dist 的 frontend.tar.gz 并通过 artifact 工具导出。不要发布生产。先读取相关资料再执行，并依据真实工具结果交付。`;
  await page.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill(prompt);
  await page.locator('.composer [data-slot="prompt-input-send"]').click();
  const approvedSkillReads = new Set<string>();
  const skillReadDetail = `/bin/zsh -lc 'cat ${path.join(root, 'resources/skills/business-context/SKILL.md')} ${path.join(homedir(), '.codex/skills/frontend-design/SKILL.md')}'\n${workspace}`;
  await expect
    .poll(
      async () => {
        const current = await snapshot();
        for (const request of live ? (current.pendingRequests ?? []) : []) {
          if (approvedSkillReads.has(request.request.id)) continue;
          assert.ok(
            request.kind === 'approval' && request.request.detail === skillReadDetail,
            'Unexpected approval in live verification; no automatic grant',
          );
          approvedSkillReads.add(request.request.id);
          await page.evaluate(
            (r) =>
              window.workbench.invoke('agent:approval', {
                id: r.request.id,
                conversationId: r.conversationId,
                messageId: r.messageId,
                approved: true,
              }),
            request,
          );
        }
        const messages =
          current.conversations.find((c) => c.id === 'frontend-flow')?.messages || [];
        return ['done', 'error'].includes(
          messages.filter((m) => m.role === 'assistant').at(-1)?.status ?? '',
        );
      },
      { timeout: live ? 600_000 : 180_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  const state = await snapshot(),
    answer = state.conversations
      .find((c) => c.id === 'frontend-flow')!
      .messages.filter((m) => m.role === 'assistant')
      .at(-1)!;
  await writeFile(path.join(output, 'answer.json'), JSON.stringify(answer, null, 2));
  assert.equal(answer.status, 'done', answer.text + ' ' + answer.failure);
  assert.equal(platform.applications.length, 1);
  assert.ok(platform.plans.length >= 1);
  if (!live) assert.equal(platform.buildInvocations, 1);
  const successfulBuild = platform.builds.at(-1)!;
  assert.equal(successfulBuild?.status, 'succeeded', JSON.stringify(platform.builds));
  assert.equal(successfulBuild?.exitCode, 0);
  assert.ok(successfulBuild?.previewUrl);
  const toolNames = (answer.tools || []).map((tool) => tool.name);
  for (const tool of [
    'workbench_feishu_index',
    'workbench_feishu_search',
    'workbench_feishu_read',
    'athena_sandbox_write',
    'athena_sandbox_exec',
    'web_act',
    'web_snapshot',
    'athena_sandbox_artifact',
  ])
    assert.ok(toolNames.includes(tool), 'Missing actual tool ' + tool);
  const query = await page.evaluate(() =>
    window.workbench.invoke<any>('browser:query', { selector: 'li' }),
  );
  assert.ok(
    query.elements.some((item: any) => item.text?.includes('联调验证任务')),
    JSON.stringify(query),
  );
  const artifact = answer.execution?.find(
    (event) => event.kind === 'artifact' && event.artifact?.path.endsWith('frontend.tar.gz'),
  )?.artifact;
  assert.ok(artifact, 'No verified source artifact');
  const bytes = await readFile(artifact.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  await writeFile(path.join(output, 'frontend.tar.gz'), bytes);
  await page.screenshot({ path: path.join(output, 'completed.png'), animations: 'disabled' });
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        mode: live ? 'real Codex model' : 'simulated Codex protocol',
        knowledge: 'mock, derived from observed manual constraints',
        platform: 'stateful mock One/CloudOS',
        sandbox: 'real Docker',
        browser: 'real agent-browser',
        application: platform.applications[0].name,
        build: successfulBuild,
        executionModel: answer.model,
        approvedReadOnlySkillRequests: approvedSkillReads.size,
        toolNames,
        artifact: { bytes: bytes.length, sha256: artifact.sha256 },
        audit: platform.audit,
      },
      null,
      2,
    ),
  );
  container = (await backend.status(context.conversationId)).name;
  console.log(
    'PASS: knowledge index/search/read → agent-browser platform actions → real Docker build → interactive preview → verified archive.',
  );
} finally {
  controller.abort();
  await app.close();
  await backend.dispose();
  await platform.close();
  container ??= (await backend.status(context.conversationId).catch(() => undefined))?.name;
  if (container) await promisify(execFile)('docker', ['rm', '-f', container]).catch(() => {});
}
