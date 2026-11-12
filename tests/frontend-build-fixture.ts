import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export const fixtureKnowledgeRoot = 'https://fixture.feishu.cn/wiki/BuildGuide';
export function buildKnowledgeFixture(platformUrl: string) {
  return {
    BuildGuide: {
      title: '前端构建知识库（模拟）',
      content: `这是本地模拟知识服务，用于验证 Athena 的检索与构建链路，不能当作线上状态。\n[前端项目配置](https://fixture.feishu.cn/docx/FrontendConfig)\n[平台操作指南](https://fixture.feishu.cn/docx/PlatformGuide)\n根据用户指定的应用需求构建前端；规则和平台入口要在相关文档中核对。`,
    },
    FrontendConfig: {
      title: '前端项目配置（模拟）',
      content: `静态前端使用静态资源部署。命名约束：应用名称 = Git 仓库项目名 = package.json 的 name。\n以下是演示环境约定：源码放沙箱 /workspace，package.json 提供 build 和 preview 脚本；npm run build 输出 dist/index.html；npm run preview 监听 0.0.0.0:$PORT。构建前可用沙箱安装、检查、修复代码。\n生成 .gitlab-ci.yml 记录 build 命令和 dist 产物；演示仓库 URL 使用 https://git.example.test/demo/<应用名称>.git，分支 main，环境 QA。这是假仓库定位，实际源码来自本对话的沙箱，不需要连接真实 GitLab。\n构建完成必须检查退出码、真实产物与页面交互。`,
    },
    PlatformGuide: {
      title: '前端平台操作指南（模拟）',
      content: `本地平台入口：${platformUrl}\n用 Neo 打开入口并操作页面：One 平台 → 新增应用 → 静态资源部署。填写应用名称、应用等级、应用组、应用负责人、测试负责人、告警接收人、开发语言、Git 仓库、描述，环境选 QA。演示人员和组可以使用 demo。\n保存后进入 CloudOS 流水线 → 新建构建计划，选择刚创建的应用，分支 main，类型 前端，环境 QA。点击 开始构建，观察真实日志和状态；平台会在本对话沙箱实际运行 npm run build。不得通过终端或脚本直接请求平台 API 替代页面操作。\n成功后打开构建结果里的预览地址，用 Neo 验证应用实际功能，并调用 neo_checkpoint 引用观察原文。最后把源码和 dist 打包到 frontend.tar.gz，通过 athena_sandbox_artifact 导出。此演示不提供生产发布。`,
    },
  };
}

export const fixtureLarkCli = (node: string, fixtureFile: string) => `#!${node}
const fs=require('node:fs');const args=process.argv.slice(2),docs=JSON.parse(fs.readFileSync(${JSON.stringify(fixtureFile)},'utf8'));
const out=data=>console.log(JSON.stringify({ok:true,identity:'user',data}));
const value=key=>args[args.indexOf(key)+1];
if(args.includes('--version')){console.log('lark-cli mock knowledge');process.exit()}
if(args[0]==='drive'&&args[1]==='+inspect'){const token=new URL(value('--url')).pathname.split('/').pop();if(!docs[token])throw Error('Missing fixture document');out({type:'docx',token,title:docs[token].title});}
else if(args[0]==='docs'&&args[1]==='+fetch'){const key=value('--doc'),doc=docs[key];if(!doc)throw Error('Missing fixture document');out({document:{document_id:key,revision_id:1,content:doc.content}});}
else if(args[0]==='wiki'&&args[1]==='+node-get')out({space_id:'123456',node_token:'BuildGuide',has_child:true});
else if(args[0]==='wiki'&&args[1]==='+node-list')out({nodes:[],has_more:false});
else{console.error(JSON.stringify({ok:false,identity:'user',error:{type:'fixture',message:'Unsupported command'}}));process.exitCode=1}
`;

interface Application {
  id: string;
  name: string;
  level: string;
  group: string;
  owner: string;
  tester: string;
  alerts: string;
  language: string;
  repository: string;
  description: string;
  deployment: string;
  environment: string;
}
interface Plan {
  id: string;
  applicationId: string;
  branch: string;
  type: string;
  environment: string;
}
export interface BuildProof {
  exitCode: number;
  logs: string;
  artifact?: { bytes: number; sha256: string };
  previewUrl?: string;
  previewError?: string;
}
interface Build extends BuildProof {
  id: string;
  planId: string;
  status: 'running' | 'succeeded' | 'failed';
}

export async function startBuildPlatform(
  build: (application: Application, plan: Plan) => Promise<BuildProof>,
) {
  const applications: Application[] = [],
    plans: Plan[] = [],
    builds: Build[] = [];
  const audit: Array<{ method: string; path: string; at: number }> = [];
  let origin = '',
    buildInvocations = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (request.headers.origin && request.headers.origin !== origin) {
      response.writeHead(403);
      response.end();
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
      response.setHeader('Content-Type', 'text/html;charset=utf-8');
      response.end(platformHtml);
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    try {
      if (request.method === 'GET' && url.pathname === '/api/state') {
        response.end(JSON.stringify({ applications, plans, builds }));
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(404);
        response.end('{}');
        return;
      }
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 16_000) throw new Error('请求过大');
      }
      const data = JSON.parse(raw);
      audit.push({ method: request.method, path: url.pathname, at: Date.now() });
      if (url.pathname === '/api/applications') {
        for (const key of [
          'name',
          'level',
          'group',
          'owner',
          'tester',
          'alerts',
          'language',
          'repository',
          'description',
        ])
          if (typeof data[key] !== 'string' || !data[key].trim() || data[key].length > 500)
            throw new Error('缺少必填字段 ' + key);
        if (!/^[a-z][a-z0-9-]{1,48}$/.test(data.name))
          throw new Error('应用名仅支持小写字母、数字和连字符');
        if (data.deployment !== 'static' || data.environment !== 'QA')
          throw new Error('演示仅支持 QA 静态资源部署');
        if (
          data.repository
            .split('/')
            .at(-1)
            ?.replace(/\.git$/, '') !== data.name
        )
          throw new Error('应用名称必须与 Git 项目名一致');
        const existing = applications.find((app) => app.name === data.name);
        if (existing) {
          response.end(JSON.stringify(existing));
          return;
        }
        const item = { ...data, id: randomUUID() } as Application;
        applications.push(item);
        response.end(JSON.stringify(item));
        return;
      }
      if (url.pathname === '/api/plans') {
        if (
          !applications.some((app) => app.id === data.applicationId) ||
          data.branch !== 'main' ||
          data.type !== 'frontend' ||
          data.environment !== 'QA'
        )
          throw new Error('请确认应用、main 分支、前端类型和 QA 环境');
        const item = { ...data, id: randomUUID() } as Plan;
        plans.push(item);
        response.end(JSON.stringify(item));
        return;
      }
      if (url.pathname === '/api/builds') {
        const plan = plans.find((item) => item.id === data.planId);
        if (!plan) throw new Error('构建计划不存在');
        const existing = builds.find((item) => item.planId === plan.id);
        if (existing) {
          response.end(JSON.stringify(existing));
          return;
        }
        const item: Build = {
          id: randomUUID(),
          planId: plan.id,
          status: 'running',
          exitCode: -1,
          logs: '',
        };
        builds.push(item);
        buildInvocations++;
        void build(
          applications.find((app) => app.id === plan.applicationId)!,
          plan,
        )
          .then((result) =>
            Object.assign(item, result, { status: result.exitCode === 0 ? 'succeeded' : 'failed' }),
          )
          .catch((error) =>
            Object.assign(item, {
              status: 'failed',
              exitCode: 1,
              logs: error instanceof Error ? error.message : String(error),
            }),
          );
        response.end(JSON.stringify(item));
        return;
      }
      response.writeHead(404);
      response.end('{}');
    } catch (error) {
      response.writeHead(400);
      response.end(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url: origin,
    server,
    applications,
    plans,
    builds,
    audit,
    get buildInvocations() {
      return buildInvocations;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const platformHtml = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>前端构建演示</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7f7f8;color:#202124;font:15px system-ui}header{padding:18px 28px;background:#fff;border-bottom:1px solid #e5e5e7}nav{display:flex;gap:12px;margin:18px 0}main{max-width:960px;margin:24px auto;padding:0 24px}section{background:white;padding:24px;border-radius:14px;margin:18px 0}button{border:0;border-radius:8px;background:#202124;color:white;padding:10px 16px;cursor:pointer}button:disabled{opacity:.5}label{display:block;margin:12px 0}input,select,textarea{display:block;width:100%;padding:10px;margin-top:5px;border:1px solid #bbb;border-radius:6px;font:inherit}.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 20px}pre{white-space:pre-wrap;background:#f4f4f4;padding:16px;border-radius:8px}a{color:#2458a8}small{color:#666}.error{color:#a1271f}[hidden]{display:none!important}</style>
<header><strong>One · CloudOS</strong><small>　 本地模拟环境，不连接企业系统</small></header><main>
<nav><button id="one">One 应用中心</button><button id="pipeline">CloudOS 流水线</button></nav><p role="status" id="status"></p><p role="alert" class="error" id="error"></p>
<section id="applications"><h1>应用管理</h1><div id="app-list"></div><button id="new-app">新增应用</button>
<form id="app-form" hidden><h2>创建应用</h2><label>部署方式<select name="deployment" aria-label="部署方式"><option value="static">静态资源部署</option></select></label><div class="grid">
<label>应用名称<input name="name" aria-label="应用名称" required></label><label>应用等级<input name="level" aria-label="应用等级" required></label><label>应用组<input name="group" aria-label="应用组" required></label><label>应用负责人<input name="owner" aria-label="应用负责人" required></label><label>测试负责人<input name="tester" aria-label="测试负责人" required></label><label>告警接收人<input name="alerts" aria-label="告警接收人" required></label><label>开发语言<input name="language" aria-label="开发语言" required></label><label>Git 仓库<input name="repository" aria-label="Git 仓库" required></label></div>
<label>描述<textarea name="description" aria-label="描述" required></textarea></label><label>环境<select name="environment" aria-label="应用环境"><option>QA</option></select></label><button type="submit">保存应用</button></form></section>
<section id="pipelines" hidden><h1>构建计划</h1><button id="new-plan">新建构建计划</button><form id="plan-form" hidden><label>应用<select name="applicationId" id="app-choice" aria-label="构建应用"></select></label><label>分支<input name="branch" aria-label="分支" value="main" required></label><label>类型<select name="type" aria-label="构建类型"><option value="frontend">前端</option></select></label><label>环境<select name="environment" aria-label="构建环境"><option>QA</option></select></label><button type="submit">保存构建计划</button></form><div id="plan-list"></div><div id="build-list"></div></section>
<script>
const el=id=>document.getElementById(id);let state={applications:[],plans:[],builds:[]};const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function post(route,data){el('error').textContent='';const r=await fetch('/api/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}),v=await r.json();if(!r.ok)throw Error(v.error);return v;}
function render(){el('app-list').innerHTML=state.applications.map(a=>'<p>应用：'+esc(a.name)+' · 静态资源部署 · QA</p>').join('');const select=el('app-choice'),old=select.value;select.innerHTML=state.applications.map(a=>'<option value="'+a.id+'">'+esc(a.name)+'</option>').join('');if(old)select.value=old;el('plan-list').innerHTML=state.plans.map(p=>'<p>计划：'+esc(state.applications.find(a=>a.id===p.applicationId)?.name)+' · main · QA <button data-plan="'+p.id+'" '+(state.builds.some(b=>b.planId===p.id)?'disabled':'')+'>开始构建</button></p>').join('');el('build-list').innerHTML=state.builds.map(b=>'<article><h2>'+({running:'构建进行中',succeeded:'构建成功',failed:'构建失败'}[b.status])+'</h2><p>退出码：'+b.exitCode+'</p><pre>'+esc(b.logs)+'</pre>'+(b.artifact?'<p>产物 SHA-256：'+b.artifact.sha256+' · '+b.artifact.bytes+' bytes</p>':'')+(b.previewUrl?'<a href="'+esc(b.previewUrl)+'">打开应用预览</a>':'')+(b.previewError?'<p class="error">预览未就绪：'+esc(b.previewError)+'</p>':'')+'</article>').join('');}
let signature='';async function refresh(){const next=await(await fetch('/api/state')).json(),key=JSON.stringify(next);if(key!==signature){signature=key;state=next;render()}}
el('one').onclick=()=>{el('applications').hidden=false;el('pipelines').hidden=true};el('pipeline').onclick=()=>{el('applications').hidden=true;el('pipelines').hidden=false;refresh()};el('new-app').onclick=()=>el('app-form').hidden=false;el('new-plan').onclick=()=>{el('plan-form').hidden=false;refresh()};
el('app-form').onsubmit=async e=>{e.preventDefault();try{const app=await post('applications',Object.fromEntries(new FormData(e.target)));el('status').textContent='应用 '+app.name+' 已创建';el('app-form').hidden=true;await refresh()}catch(e){el('error').textContent=e.message}};
el('plan-form').onsubmit=async e=>{e.preventDefault();try{await post('plans',Object.fromEntries(new FormData(e.target)));el('status').textContent='构建计划已创建';el('plan-form').hidden=true;await refresh()}catch(e){el('error').textContent=e.message}};
el('plan-list').onclick=async e=>{const id=e.target.dataset.plan;if(!id)return;try{await post('builds',{planId:id});await refresh()}catch(e){el('error').textContent=e.message}};
setInterval(()=>refresh().catch(()=>{}),800);refresh();
</script></main></html>`;
