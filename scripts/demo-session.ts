/** An isolated, manually operated demo. Starts no model task and records no video. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startCustomerRuntime } from '../tests/customer-export-runtime';
import { fixtureLarkCli } from '../tests/frontend-build-fixture';

const exec = promisify(execFile);
export const demoBase = '045db660db5203826be6563a46a0dee5292d75a2';
export const demoKnowledgeRoot = 'https://fixture.feishu.cn/wiki/DemoGuide';

export function demoKnowledge(origin: string, repository: string) {
  assert.equal(new URL(origin).hostname, '127.0.0.1');
  const remote = new URL(repository);
  assert.equal(remote.protocol, 'https:');
  assert.ok(!remote.username && !remote.password && !remote.search && !remote.hash);
  return {
    DemoGuide: {
      title: 'Meridian 演示知识库（离线示例）',
      content:
        '以下为虚构业务资料，通过本地知识服务替身提供，不是线上飞书 API 验收。\n' +
        '[客户对外材料规则](https://fixture.feishu.cn/docx/CustomerPolicy)\n' +
        '[网站与仓库对应表](https://fixture.feishu.cn/docx/RepositoryMap)\n' +
        '[开发与验收约定](https://fixture.feishu.cn/docx/DevelopmentGuide)\n' +
        '[供应商说明](https://fixture.feishu.cn/docx/SupplierPolicy)',
    },
    CustomerPolicy: {
      title: 'Meridian 客户对外材料规则（示例）',
      content:
        `适用网站 ${origin}，模块 customers。客户编号以 C 开头。\n` +
        '每个客户有营业资质、服务协议、结算说明三份公开材料。对外清单只列客户编号、公司名、合作状态、负责人和公开材料名称。内部跟进备注及 INTERNAL_ONLY 内容不得进入对外清单或导出文件。\n' +
        '列表支持搜索、合作状态筛选和每页六条分页。待审核客户为 C1004、C1009、C1014；验收必须读取实际页面，不能仅凭本文宣称完成。\n' +
        '新增导出需求：每行导出当前客户 ZIP，由 Java 后端生成 customer.json 和三份公开材料。未知客户 404，下载中防重复点击，失败可重试；不得包含其他客户或内部跟进。验收 C1001 与 C1008，解包核对，不只看下载成功。',
    },
    RepositoryMap: {
      title: 'Meridian 网站与代码仓库对应表（示例）',
      content:
        `网站 origin：${origin}\n应用：meridian-crm\n模块：customers\n` +
        `前端仓库：${repository}\n目录：frontend\n分支：main\n` +
        `后端仓库：${repository}\n目录：backend\n分支：main\n` +
        `本次演示基线：${demoBase}\n` +
        '通过 workbench_repository_resolve 核对并请求用户登记对应关系，不猜地址。resolve 返回的基线必须核对；与演示基线不同则暂停实施并重新准备。默认不提交、不推送、不发布。',
    },
    DevelopmentGuide: {
      title: 'Meridian 开发与验收约定（示例）',
      content:
        '前端 React/Vite，后端 Java 21/Maven。target=frontend/backend 使用各自独立沙箱；不修改宿主项目。先记录已确认的页面预览为 PRD，再定位仓库。\n' +
        '前端 npm ci && npm run build；后端 mvn -B -Dmaven.repo.local=/workspace/.m2 test package。长命令查询同一 command_id 至最终退出码。\n' +
        '服务监听 0.0.0.0:$PORT，后端健康路径 /api/health。前端 BACKEND_URL 指向后端可达地址。预览 URL 以宿主实际返回为准。\n' +
        '浏览器验证搜索、筛选、翻页及 C1001/C1008 下载；文件内容需解包核对，不得包含 INTERNAL_ONLY、其他客户、绝对路径或目录跳转。界面预览不等于源码实现。',
    },
    SupplierPolicy: {
      title: '供应商材料规则（无关示例）',
      content:
        '本文件仅适用于 suppliers 模块，编号 S 开头；供应商规则不能套用到客户 customers 模块。',
    },
  };
}

async function main() {
  assert.ok(
    process.argv.slice(2).every((arg) => arg === '--check'),
    '只接受 --check',
  );
  const root = process.cwd();
  const source = path.resolve(
    process.env.ATHENA_DEMO_SOURCE ?? '.runtime/customer-export-demo/repo',
  );
  const git = async (...args: string[]) =>
    (await exec('git', ['-C', source, ...args])).stdout.trim();
  const base = await git('rev-parse', 'HEAD');
  assert.equal(base, demoBase, '请使用锁定的独立演示基线；不要重置已有工作目录');
  assert.equal(await git('status', '--porcelain'), '', '演示源码有改动；请另建干净副本');
  const repository = await git('remote', 'get-url', 'origin');
  demoKnowledge('http://127.0.0.1:1', repository);
  const electron = path.join(
    root,
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  );
  const bundle = await readFile(path.join(root, 'dist/main/main.cjs'), 'utf8');
  for (const tool of [
    'workbench_browser_guide',
    'athena_learn',
    'workbench_feishu_index',
    'workbench_repository_resolve',
  ])
    assert.ok(bundle.includes(tool), `构建缺少 ${tool}，请先 npm run build`);
  await access(electron);
  await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  const dockerVersion = (
    await exec('docker', ['info', '--format', '{{.ServerVersion}}'])
  ).stdout.trim();
  await exec('docker', ['image', 'inspect', 'athena-sandbox-node:1', 'athena-sandbox-java:1']);
  const cliVersion = (await exec('codex', ['--version'])).stdout.trim();
  console.log(
    JSON.stringify({
      appHead: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
      demoBase: base,
      dockerVersion,
      cliVersion,
      knowledge: 'offline fixture',
      modelLoginVerified: false,
    }),
  );
  if (process.argv.includes('--check')) return;

  const parent = path.join(root, '.runtime/demo-scenarios');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(parent, 'run-'));
  const profile = path.join(directory, 'profile');
  const workspace = path.join(directory, 'workspace');
  const bin = path.join(directory, 'bin');
  for (const folder of [profile, workspace, bin]) await mkdir(folder, { mode: 0o700 });
  const setup = new AbortController();
  const cancelSetup = () => setup.abort();
  process.once('SIGINT', cancelSetup);
  process.once('SIGTERM', cancelSetup);
  let baseline;
  try {
    baseline = await startCustomerRuntime(
      source,
      path.join(directory, 'baseline'),
      'baseline',
      setup.signal,
    );
  } finally {
    process.removeListener('SIGINT', cancelSetup);
    process.removeListener('SIGTERM', cancelSetup);
  }
  try {
    setup.signal.throwIfAborted();
    const knowledgeFile = path.join(directory, 'knowledge.json');
    await writeFile(
      knowledgeFile,
      JSON.stringify(demoKnowledge(baseline.frontendUrl, repository), null, 2),
      { mode: 0o600 },
    );
    await writeFile(path.join(bin, 'package.json'), '{"type":"commonjs"}');
    await writeFile(path.join(bin, 'lark-cli'), fixtureLarkCli(process.execPath, knowledgeFile), {
      mode: 0o700,
    });
    await writeFile(
      path.join(profile, 'workspace.json'),
      JSON.stringify({
        settings: { agent: 'codex', workspace, knowledgeRoot: demoKnowledgeRoot },
        conversations: [],
        recordings: [],
      }),
      { mode: 0o600 },
    );
    const session = {
      directory,
      profile,
      workspace,
      source,
      demoBase: base,
      url: baseline.frontendUrl,
      backendUrl: baseline.backendUrl,
      knowledgeRoot: demoKnowledgeRoot,
      knowledgeMode: 'offline fixture',
      recording: false,
      automaticModelTasks: false,
    };
    await writeFile(path.join(directory, 'session.json'), JSON.stringify(session, null, 2), {
      mode: 0o600,
    });
    console.log('演示页面与专用档案已准备：\n' + JSON.stringify(session, null, 2));
    console.log(
      '按 docs/demos/README.md 在 Athena 手动演示。首次配置及 CLI 登录须实际核对；关闭窗口或 Ctrl+C 结束本次会话。',
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WORKBENCH_USER_DATA_DIR: profile,
      PATH: bin + path.delimiter + process.env.PATH,
    };
    for (const key of [
      'WORKBENCH_DEV_SERVER_URL',
      'ATHENA_REPOSITORY_MCP_URL',
      'ATHENA_REPOSITORY_MCP_TOKEN',
      'ELECTRON_RUN_AS_NODE',
    ])
      delete env[key];
    const child = spawn(electron, ['.'], { cwd: root, env, stdio: 'inherit' });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 || code === null ? resolve() : reject(new Error(`Athena 退出码 ${code}`)),
        );
      });
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  } finally {
    await baseline.close();
    console.log('本次基线服务已停止；档案与文件保留：' + directory);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
