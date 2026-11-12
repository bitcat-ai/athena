/** Real Codex + agent-browser + two Docker sandboxes + private GitHub repository. Knowledge is an explicit fixture. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { _electron as electron, expect } from '@playwright/test';
import type { AppSnapshot, ChatMessage } from '../src/shared/types';
import type { ModelOption } from '../src/shared/usage';
import { fixtureLarkCli } from './frontend-build-fixture';
import { startCustomerRuntime } from './customer-export-runtime';
import { startRepositoryRegistry, demoRepository } from './customer-export-registry';

const root = process.cwd(),
  exec = promisify(execFile);
const source = path.join(root, '.runtime/customer-export-demo/repo');
const resume = process.env.ATHENA_CUSTOMER_RESUME;
const elementFlow = process.env.ATHENA_CUSTOMER_FLOW === 'element';
const agent = elementFlow ? 'claude' : 'codex';
const directory = resume
  ? path.resolve(resume)
  : await mkdtemp(path.join(root, '.runtime/customer-export-demo/run-'));
if (!directory.startsWith(path.join(root, '.runtime/customer-export-demo/run-')))
  throw new Error('Resume only this owned demo directory');
const priorMessages: ChatMessage[] = resume
  ? (JSON.parse(
      await readFile(path.join(directory, 'profile/workspace.json'), 'utf8'),
    ).conversations.find((c: { id: string }) => c.id === 'customer-export')?.messages ?? [])
  : [];
const recordedPrdMessage = elementFlow
  ? priorMessages.findLast((message) =>
      message.tools?.some((tool) => tool.name === 'workbench_prd_save' && tool.status === 'done'),
    )
  : undefined;
const priorPrd = recordedPrdMessage?.execution?.find(
  (event) => event.kind === 'artifact' && event.artifact?.path.endsWith('.md'),
)?.artifact;
const previousOutput = recordedPrdMessage
  ? (JSON.parse(
      await readFile(path.join(root, '.runtime/customer-export-demo/current-run.json'), 'utf8'),
    ).output as string)
  : undefined;
const previousAudit: Array<Record<string, any>> = previousOutput
  ? JSON.parse(
      await readFile(path.join(previousOutput, 'registry-audit.json'), 'utf8').catch(() => '[]'),
    )
  : [];
const previousPublication = previousAudit.findLast(
  (event) => event.action === 'remote-verified',
) as
  | { commit: string; branch: string; repository: string; componentCommits: Record<string, string> }
  | undefined;
if (previousPublication) {
  assert.equal(previousPublication.repository, demoRepository);
  assert.match(previousPublication.commit, /^[a-f0-9]{40}$/);
  assert.match(previousPublication.branch, /^demo\/customer-export-[a-f0-9]+$/);
}
const output = path.join(
  root,
  'test-results/customer-export',
  path.basename(directory) + (resume ? '-resume-' + Date.now() : ''),
);
for (const p of [
  output,
  path.join(output, 'raw-video'),
  path.join(directory, 'profile'),
  path.join(directory, 'workspace'),
  path.join(directory, 'bin'),
])
  await mkdir(p, { recursive: true });
await writeFile(
  path.join(root, '.runtime/customer-export-demo/current-run.json'),
  JSON.stringify({ directory, output }, null, 2),
);
console.log('Run directory:', directory);
const baseline = await startCustomerRuntime(source, path.join(directory, 'baseline'), 'baseline');
await writeFile(path.join(output, 'baseline.json'), JSON.stringify(baseline, null, 2));
console.log('Baseline website:', baseline.frontendUrl);
await exec('git', ['-C', source, 'push', '-u', 'origin', 'main'], { timeout: 90_000 });
const registry = await startRepositoryRegistry(
  path.join(directory, resume ? 'registry-' + Date.now() : 'registry'),
  source,
  baseline.frontendUrl,
);
await writeFile(path.join(output, 'baseline-commit.txt'), registry.base + '\n');
const wikiRoot = 'https://fixture.feishu.cn/wiki/CustomerGuide';
const manual = await readFile(path.join(source, 'docs/customer-handbook.md'), 'utf8');
const fixture = path.join(directory, 'knowledge.json');
await writeFile(
  fixture,
  JSON.stringify({
    CustomerGuide: {
      title: 'Meridian 业务知识库（示例）',
      content:
        '此处是明确授权的本地示例知识库，模拟飞书文档读取。\n[客户工作台操作手册](https://fixture.feishu.cn/docx/CustomerHandbook)\n[开发与验证约定](https://fixture.feishu.cn/docx/DevelopmentGuide)\n[供应商中心操作手册](https://fixture.feishu.cn/docx/SupplierHandbook)',
    },
    CustomerHandbook: {
      title: 'Meridian 客户工作台操作手册',
      content: manual + '\n当前网站：' + baseline.frontendUrl,
    },
    DevelopmentGuide: {
      title: 'Meridian 开发与验证约定',
      content:
        '业务模块通过 repository MCP 服务定位仓库。不得直接修改宿主工作区，前后端分别使用 target=frontend/backend 的独立沙箱。前端 npm ci && npm run build；后端 mvn -B -Dmaven.repo.local=/workspace/.m2 test package。保持现有页面设计，新增按钮与现有操作风格一致。提交前跑真实构建和测试，再上传两个 Git bundle 并调用 repository publish。只允许新建测试分支，不合并 main，不发布生产。宿主随后从远端拉取提交到独立 checkout，复建后会提供新的预览 URL。',
    },
    SupplierHandbook: {
      title: '供应商中心操作手册',
      content:
        '供应商编号以 S 开头，业务模块为 suppliers，与客户材料导出无关。此文档用于验证业务检索准确性。',
    },
  }),
);
const bin = path.join(directory, 'bin'),
  profile = path.join(directory, 'profile'),
  workspace = path.join(directory, 'workspace');
await writeFile(path.join(bin, 'package.json'), ' {"type":"commonjs"}');
await writeFile(path.join(bin, 'lark-cli'), fixtureLarkCli(process.execPath, fixture), {
  mode: 0o700,
});
if (!resume)
  await writeFile(
    path.join(profile, 'workspace.json'),
    JSON.stringify({
      settings: { agent, workspace, knowledgeRoot: wikiRoot },
      conversations: [
        {
          id: 'customer-export',
          title: '客户材料导出 · 全栈沙箱验证',
          agent,
          workspace,
          messages: [],
          updatedAt: Date.now(),
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

  ATHENA_REPOSITORY_MCP_URL: registry.endpoint,
  ATHENA_REPOSITORY_MCP_TOKEN: registry.token,
};
delete env.WORKBENCH_DEV_SERVER_URL;
const app = await electron.launch({
  args: [path.join(root, 'tests/electron-background.cjs')],
  cwd: root,
  env: Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
  recordVideo: { dir: path.join(output, 'raw-video'), size: { width: 1600, height: 1000 } },
});
const evidence: Record<string, unknown> = {
  knowledge: 'local mock Feishu index; original manual in real repository',
  agent: 'real ' + agent,
  flow: elementFlow
    ? 'selected element → DOM preview → PRD → full-stack source'
    : 'business knowledge → full-stack source',
  resumedFrom: resume,
  priorSegment: previousOutput,
  browser: 'real Chrome + agent-browser',
  git: demoRepository,
  baseCommit: registry.base,
  startedAt: Date.now(),
  directory,
  output,
};
let retest: Awaited<ReturnType<typeof startCustomerRuntime>> | undefined;
let videoPath: string | undefined;
const marks: Array<{ name: string; at: number }> = [];
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
  await page.evaluate('window.__name = fn => fn');
  const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
  await expect.poll(async () => (await snapshot()).web?.status, { timeout: 40_000 }).toBe('ready');
  const sidebarToggle = page.getByRole('button', { name: '收起侧栏', exact: true });
  if (await sidebarToggle.isVisible()) await sidebarToggle.click();
  const browserToggle = page.getByRole('button', { name: '展开浏览器', exact: true });
  if (await browserToggle.isVisible()) await browserToggle.click();
  await expect(page.locator('.browser-drawer')).toHaveClass(/is-open/);
  await page.waitForTimeout(350);
  const handle = await page.locator('.browser-resizer').boundingBox();
  if (handle) {
    await page.mouse.move(handle.x + 2, 400);
    await page.mouse.down();
    await page.mouse.move(550, 400, { steps: 20 });
    await page.mouse.up();
  }
  const reminder = page.getByRole('button', { name: '收起提醒', exact: true });
  if (await reminder.isVisible()) await reminder.click();
  await page.evaluate(
    (url) => window.workbench.invoke('browser:navigate', { url }),
    baseline.frontendUrl,
  );
  await expect
    .poll(
      async () =>
        JSON.stringify(
          await page.evaluate(() => window.workbench.invoke('browser:query', { selector: 'h1' })),
        ),
      { timeout: 15_000 },
    )
    .toContain('客户工作台');
  const before = await page.evaluate(() =>
    window.workbench.invoke<any>('browser:query', { selector: 'button' }),
  );
  assert.equal(
    JSON.stringify(before).includes('导出材料'),
    false,
    'Baseline must not contain export feature',
  );
  await page.screenshot({ path: path.join(output, '01-before.png') });
  marks.push({ name: 'baseline-visible', at: Date.now() });
  const catalog = await page.evaluate(() =>
    window.workbench.invoke<ModelOption[]>('models:list', { conversationId: 'customer-export' }),
  );
  const model =
    catalog.find((item) =>
      elementFlow ? item.model.includes('sonnet') : item.model === 'gpt-6.1-sol',
    ) ??
    catalog.find((item) => item.isDefault) ??
    catalog[0];
  assert.ok(model);
  const effort = model.efforts.find((item) => item.id === 'medium')?.id ?? model.defaultEffort;
  await page.evaluate(
    ({ model, effort }) =>
      window.workbench.invoke('settings:model', {
        conversationId: 'customer-export',
        model,
        effort,
      }),
    { model: model.model, effort },
  );
  evidence.requestedModel = { model: model.model, effort };
  const approvals = path.join(directory, 'approve-request-ids.json');
  await writeFile(approvals, '[]');
  const seenRequests = new Set<string>();
  const approved: string[] = [];
  let previewCaptured = false;
  if (recordedPrdMessage && previousOutput && priorPrd) {
    const previousEvidence = JSON.parse(
      await readFile(path.join(previousOutput, 'verification.json'), 'utf8'),
    );
    const preview = await readFile(path.join(previousOutput, 'preview-elements.json'));
    const prd = await readFile(priorPrd.path);
    assert.equal(createHash('sha256').update(prd).digest('hex'), priorPrd.sha256);
    await writeFile(path.join(output, 'preview-elements.json'), preview);
    evidence.selectedElement = previousEvidence.selectedElement;
    previewCaptured = true;
  }
  const runTurn = async (label: string, prompt: string, preserveMention = false) => {
    marks.push({ name: label + '-start', at: Date.now() });
    const previousAnswer = (await snapshot()).conversations
      .find((c) => c.id === 'customer-export')
      ?.messages.filter((m) => m.role === 'assistant')
      .at(-1)?.id;
    const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
    if (preserveMention) {
      await composer.focus();
      await page.keyboard.insertText(prompt);
      await expect(composer).toContainText('推送后等我提供');
      assert.equal(
        (await snapshot()).conversations
          .find((c) => c.id === 'customer-export')
          ?.messages.filter((m) => m.role === 'assistant')
          .at(-1)?.id,
        previousAnswer,
        'Multiline task entry must not submit on a newline',
      );
    } else await composer.fill(prompt);
    await page.locator('.composer [data-slot="prompt-input-send"]').click();
    const deadline = Date.now() + 25 * 60_000;
    let lastProgress = 0;
    while (Date.now() < deadline) {
      const state = await snapshot();
      for (const request of state.pendingRequests ?? []) {
        if (!seenRequests.has(request.request.id)) {
          console.log('PENDING REQUEST', JSON.stringify(request));
          seenRequests.add(request.request.id);
          await writeFile(
            path.join(directory, 'pending-request.json'),
            JSON.stringify(request, null, 2),
          );
        }
        const detail = (request.request as any).detail ?? '';
        const allowedReads = [
          path.join(root, 'resources/skills/business-context/SKILL.md'),
          `${homedir()}/.codex/skills/frontend-design/SKILL.md`,
        ];
        const literalReads = allowedReads.flatMap((p) => [`/bin/zsh -lc 'cat ${p}'\n${workspace}`]);
        literalReads.push(`/bin/zsh -lc 'cat ${allowedReads.join(' ')}'\n${workspace}`);
        literalReads.push(
          `/bin/zsh -lc 'cat ${homedir()}/.codex/skills/product-design/SKILL.md'\n${workspace}`,
        );
        literalReads.push(
          `/bin/zsh -lc 'cat ${['interface-quality', 'resilience', 'surfaces'].map((name) => `${homedir()}/.codex/skills/product-design/references/${name}.md`).join(' ')}'\n${workspace}`,
        );
        literalReads.push(
          `/bin/zsh -lc "rg -n 'customer-export|Meridian' ${homedir()}/.codex/memories/MEMORY.md"\n${workspace}`,
        );
        const manualApprovals = JSON.parse(await readFile(approvals, 'utf8'));
        if (
          request.kind === 'approval' &&
          (literalReads.includes(detail) || manualApprovals.includes(request.request.id))
        ) {
          approved.push(request.request.id);
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
      }
      const answer = state.conversations
        .find((c) => c.id === 'customer-export')
        ?.messages.filter((m) => m.role === 'assistant')
        .at(-1);
      if (answer?.id === previousAnswer) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      if (
        elementFlow &&
        !previewCaptured &&
        answer?.tools?.some((t) => t.name === 'workbench_browser_edit' && t.status === 'done')
      ) {
        const preview = await page.evaluate(() =>
          window.workbench.invoke<any>('browser:query', {
            selector: 'tbody tr:first-child button',
          }),
        );
        if (JSON.stringify(preview).includes('导出材料')) {
          previewCaptured = true;
          marks.push({ name: 'DOM-preview-visible', at: Date.now() });
          await writeFile(
            path.join(output, 'preview-elements.json'),
            JSON.stringify(preview, null, 2),
          );
          await page.screenshot({ path: path.join(output, '02-dom-preview.png') });
        }
      }
      if (answer && Date.now() - lastProgress > 15_000) {
        console.log(
          label,
          answer.status,
          answer.tools
            ?.slice(-3)
            .map((t) => t.name + ':' + t.status)
            .join(', '),
        );
        lastProgress = Date.now();
        await writeFile(
          path.join(directory, 'current-answer.json'),
          JSON.stringify(answer, null, 2),
        );
      }
      if (answer && ['done', 'error', 'cancelled'].includes(answer.status ?? '')) {
        await writeFile(path.join(output, label + '-answer.json'), JSON.stringify(answer, null, 2));
        await page.screenshot({ path: path.join(output, label + '-completed.png') });
        marks.push({ name: label + '-done', at: Date.now() });
        assert.equal(answer.status, 'done', answer.text + ' ' + answer.failure);
        return answer;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(label + ' timed out; inspect recorded tool state before retry');
  };
  if (elementFlow && !recordedPrdMessage) {
    const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
    await composer.focus();
    await composer.press('Meta+a');
    await composer.press('Backspace');
    await expect(page.locator('.frame-loading')).toHaveCount(0);
    await page.getByRole('button', { name: '选取元素', exact: true }).click();
    const query = await page.evaluate(() =>
      window.workbench.invoke<any>('browser:query', { selector: 'tbody tr:first-child button' }),
    );
    const target = query.elements.find((element: any) => element.name === '查看资料');
    assert.ok(target?.bounds);
    const frame = (await snapshot()).browserFrame!;
    const surface = await page.locator('.browser-surface').boundingBox();
    assert.ok(surface);
    await page.mouse.click(
      surface.x + ((target.bounds.x + target.bounds.width / 2) * surface.width) / frame.width,
      surface.y + ((target.bounds.y + target.bounds.height / 2) * surface.height) / frame.height,
    );
    await expect(page.locator('.composer .element-token')).toContainText('查看资料');
    evidence.selectedElement = (await snapshot()).browser.selectedElement;
    marks.push({ name: 'user-selected-element', at: Date.now() });
    await page.screenshot({ path: path.join(output, '01-selected-element.png') });
  }
  const taskPrompt = recordedPrdMessage
    ? `继续完成已保存 PRD 的实现，请用中文汇报进展。上一轮已真实完成“点击查看资料元素 → 旁边插入导出材料 DOM 预览 → workbench_prd_save 保存 PRD”，PRD SHA-256=${priorPrd?.sha256}，文件 ${priorPrd?.path}。该 PRD 是已核验的需求记录，暂停只发生在实现准备阶段。两个独立沙箱已克隆基线并读取代码，尚未新增功能或提交；先查看各自 git status 确认实际状态。不要重复克隆、删除目录或重做预览。\n先重新检索并读取客户操作手册，复核原需求（customer.json 和 3 份公开材料，排除内部跟进及其他客户）。再用当前基线网站 ${baseline.frontendUrl} 和 customers 调用 repository_resolve 获取本轮传输地址，继续在 target=frontend/backend 沙箱分别修改 React/Java，安装依赖、测试、构建，timeout_seconds=1200。基线分支名称可以沿用，bundle 上传后的远端分支由本轮 MCP 管理。实现所有客户行的导出按钮、下载中禁用和失败重试；后端 ZIP 内容及未知客户有测试。\n已有授权继续有效：可启动服务，健康路径 /api/health；用 agent-browser 在实际联通预览下载核验后，在两个沙箱各提交本组件代码、创建 Git bundle、上传到本轮地址并 publish 测试分支，不合并 main、不发布生产、不修改宿主源码。飞书服务和业务数据为示例；Git、沙箱、Java、agent-browser 和下载为真实执行。推送后等我提供从远端重新拉取的复测地址。`
    : resume && !elementFlow
      ? `继续上一轮已经完成的客户材料导出实现。宿主已修复 agent-browser 的空闲传输会话问题并重新打开当前基线网站，已有前后端沙箱代码、依赖、测试结果和 Git commit 都保留，不能重写或重复创建提交。先查询 target=frontend/backend 沙箱状态及 git log，重新启动前后端服务（后端 /api/health），然后用 agent-browser 验证实际导出按钮和 C1001/C1008 下载。上一轮未上传 bundle、未 publish。请重新调用 repository_resolve，以当前基线网站 ${baseline.frontendUrl} 和 customers 获取本轮传输地址；按返回的新地址上传现有 commit bundle，再调用 publish。此前允许推送新测试分支的授权继续有效；不合并 main，不发布生产。所有源码和服务操作都用沙箱工具，不使用宿主命令。完成后报告远端 commit，等我给宿主复测新地址。`
      : elementFlow
        ? `旁边添加一个“导出材料”按钮。功能是下载当前客户的公开材料 ZIP，包含 customer.json、营业资质、服务协议和结算说明，排除内部跟进和其他客户数据。
先直接在当前网页所选“查看资料”旁用 workbench_browser_edit 插入真实可撤销按钮预览（after），保持现有样式；立即重新观察，不能等源码改完再展示。预览只表达外观，不得声称下载已实现。然后索引、检索设置中的示例飞书知识库，找到客户操作手册，用 workbench_prd_save 将我的要求、选中元素、预览、资料来源与验收条件记录为 PRD。PRD 保存成功后才进入后续代码流程。
后续通过 repository MCP 按当前网站和 customers 模块定位真实 Git 仓库；使用 target=frontend/backend 两个独立沙箱克隆、安装依赖、分别修改 React 前端和 Java 后端、运行测试及构建。安装/构建使用 timeout_seconds=1200，并查询长命令的最终退出码。前端逐行按钮有下载中禁用与失败重试；后端生成 ZIP 并测试字段白名单、未知客户和客户隔离。可自由创建沙箱与启动服务，后端健康路径 /api/health。
本轮已明确授权按 MCP 流程提交、上传 Git bundle 并推送私有测试仓库的新测试分支，不合并 main、不发布生产、不修改宿主源码。先启动联通预览，agent-browser 核对功能后再推送。所有客户数据虚构，飞书知识服务是明确授权的本地示例；不要把它当作真实飞书线上状态。推送后等我提供从远端重新拉取的复测地址。`
        : `这是一次真实全栈沙箱演示。请先用 agent-browser 观察当前 Meridian 客户网站，理解客户列表、筛选、分页和资料详情；再从设置中的示例飞书知识库索引、检索并读取对应的客户操作手册，引用来源。不要把供应商手册当作客户业务。\n我的需求：在客户列表每行加入“导出材料”按钮，下载该客户的公开材料 ZIP；Java 后端生成 ZIP，包含 customer.json 和 3 份材料，排除内部跟进备注与其他客户数据。保持现有风格和列表功能，处理下载中、失败重试，补后端边界测试。\n必须通过 workbench_repository_resolve MCP 工具按当前网站 URL 和 customers 模块获取真实 Git 仓库；不要猜地址。必须在 target=frontend 与 target=backend 两个独立沙箱内分别克隆代码、安装依赖、改代码、运行测试和构建，使用沙箱工具写文件，不在宿主编辑源码。每次沙箱调用都带正确 target；后端服务健康路径 /api/health。可自由启动这两个沙箱和服务，无需重复确认。\n本次明确授权在这个新建私有测试仓库中提交代码，按 MCP 返回的流程上传两个沙箱生成的 commit bundle，调用 publish 推送测试分支；不合并 main，不发布生产。启动前后端联通预览后用 agent-browser 检查新增功能，再完成提交推送。不要把示例知识库写成真实飞书线上验收。提交完成后报告真实 commit 和沙箱测试证据；暂时不要做宿主复测，等我给新地址。所有数据虚构。`;
  const priorPublishedAnswer = previousPublication
    ? priorMessages.findLast(
        (message) =>
          message.role === 'assistant' &&
          message.status === 'done' &&
          message.tools?.some(
            (tool) => tool.name === 'workbench_repository_publish' && tool.status === 'done',
          ),
      )
    : undefined;
  if (previousPublication)
    assert.ok(priorPublishedAnswer, 'Published commit must have real model tool evidence');
  const implementation =
    priorPublishedAnswer ??
    (await runTurn('02-implementation', taskPrompt, elementFlow && !recordedPrdMessage));
  const priorTools = recordedPrdMessage
    ? priorMessages.flatMap((message) => message.tools ?? [])
    : resume && !elementFlow
      ? (JSON.parse(
          await readFile(
            path.join(
              root,
              'test-results/customer-export',
              path.basename(directory),
              '02-implementation-answer.json',
            ),
            'utf8',
          ),
        ).tools ?? [])
      : [];
  const toolNames = [...priorTools, ...(implementation.tools ?? [])]
    .filter((t) => t.status === 'done')
    .map((t) => t.name);
  if (elementFlow) {
    assert.ok(previewCaptured, 'Need visible DOM preview before implementation');
    const tools = [...(recordedPrdMessage?.tools ?? []), ...(implementation.tools ?? [])];
    const previewIndex = tools.findIndex(
      (t) => t.name === 'workbench_browser_edit' && t.status === 'done',
    );
    const prdIndex = tools.findIndex((t) => t.name === 'workbench_prd_save' && t.status === 'done');
    const repositoryIndex = tools.findIndex(
      (t) => t.name === 'workbench_repository_resolve' && t.status === 'done',
    );
    const sandboxIndex = tools.findIndex(
      (t) => t.name === 'athena_sandbox_exec' && t.status === 'done',
    );
    assert.ok(
      previewIndex >= 0 &&
        prdIndex > previewIndex &&
        repositoryIndex > prdIndex &&
        sandboxIndex > prdIndex,
      'Preview → PRD → repository/sandbox order must be actual',
    );
    const prd =
      priorPrd ??
      implementation.execution?.find(
        (e) => e.kind === 'artifact' && e.artifact?.path.endsWith('.md'),
      )?.artifact;
    assert.ok(prd, 'PRD must be an actual saved artifact');
    const bytes = await readFile(prd.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), prd.sha256);
    await writeFile(path.join(output, 'customer-export-PRD.md'), bytes);
    evidence.prd = { ...prd, exported: path.join(output, 'customer-export-PRD.md') };
  }
  for (const name of [
    'workbench_feishu_index',
    'workbench_feishu_read',
    'workbench_repository_resolve',
    'athena_sandbox_exec',
    'workbench_repository_publish',
  ])
    assert.ok(toolNames.includes(name), 'Missing actual tool ' + name);
  assert.ok(
    toolNames.some((name) => ['web_snapshot', 'web_read', 'web_grep'].includes(name)),
    'Need an actual agent-browser observation',
  );
  assert.ok(
    toolNames.some((name) => ['web_act', 'web_download'].includes(name)),
    'Need actual agent-browser interaction',
  );
  const publication = previousPublication ?? registry.published;
  assert.ok(publication, 'No verified remote Git commit');
  const remote = (
    await exec('git', ['ls-remote', demoRepository, 'refs/heads/' + publication.branch], {
      timeout: 90_000,
    })
  ).stdout
    .trim()
    .split(/\s/)[0];
  assert.equal(remote, publication.commit, 'Remote ref must still match the recorded publication');
  evidence.publication = publication;
  evidence.implementationModel = implementation.model;
  await writeFile(
    path.join(output, 'registry-audit.json'),
    JSON.stringify([...previousAudit, ...registry.audit], null, 2),
  );
  const checkout = path.join(directory, 'local-retest-' + Date.now());
  await exec('git', ['clone', '--branch', publication.branch, demoRepository, checkout], {
    timeout: 90_000,
  });
  const pulled = (await exec('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim();
  assert.equal(pulled, publication.commit);
  marks.push({ name: 'remote-pulled-locally', at: Date.now() });
  console.log('Fresh local checkout verified:', pulled);
  retest = await startCustomerRuntime(checkout, path.join(directory, 'retest'), 'fresh-checkout');
  await writeFile(
    path.join(output, 'fresh-checkout.json'),
    JSON.stringify({ commit: pulled, ...retest }, null, 2),
  );
  await page.evaluate(
    (url) => window.workbench.invoke('browser:navigate', { url }),
    retest.frontendUrl,
  );
  const verification = await runTurn(
    '03-retest',
    `我已从真实 GitHub 测试分支重新 clone，核对 HEAD=${pulled}，并从该 checkout 在新的前后端容器独立安装、构建、运行。新的复测地址：${retest.frontendUrl}。复测前先用 workbench_feishu_search 查询“客户材料导出”，再用 workbench_feishu_read 核对对应客户操作手册，作为本轮验收依据。请用 agent-browser 打开这个新地址，验证导出按钮与下载：先为 C1001 云栖设计工作室下载客户材料 ZIP，然后搜索 C1008 山岚文旅并下载它的 ZIP；再检查合作状态筛选与分页仍可用。必须通过 web_download 从实际按钮触发并记录下载产物，不能用 fetch 或终端代替浏览器下载。页面操作后重新观察核对，用中文引用已验证页面与文件说明结果。不要修改任何代码或再次提交。`,
  );
  assert.ok(
    [...priorTools, ...(implementation.tools ?? []), ...(verification.tools ?? [])].some(
      (tool) => tool.name === 'workbench_feishu_search' && tool.status === 'done',
    ),
    'Need a successful knowledge search in the recorded workflow',
  );
  const artifacts = (verification.execution ?? [])
    .filter((e) => e.kind === 'artifact' && e.artifact?.path.toLowerCase().endsWith('.zip'))
    .map((e) => e.artifact!);
  assert.ok(
    artifacts.length >= 2,
    'Need actual agent-browser browser ZIP downloads for both customers',
  );
  const archiveProof = [];
  for (const [index, artifact] of artifacts.entries()) {
    const bytes = await readFile(artifact.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    const destination = path.join(output, `customer-materials-${index + 1}.zip`);
    await writeFile(destination, bytes);
    const proof = await exec('python3', [
      '-c',
      `import zipfile,json,sys\nz=zipfile.ZipFile(sys.argv[1]);names=z.namelist();assert len(names)==4,names;assert all(not n.startswith('/') and '..' not in n.split('/') for n in names);assert sum(i.file_size for i in z.infolist())<1000000\ndata={n:z.read(n).decode('utf-8') for n in names};text='\\n'.join(data.values());assert 'INTERNAL_ONLY' not in text;ids=[i for i in ['C1001','C1008'] if i in text];assert len(ids)==1,ids;assert any(n.endswith('customer.json') for n in names);assert all(ids[0] in v for v in data.values());print(json.dumps({'customer':ids[0],'entries':names},ensure_ascii=False))`,
      destination,
    ]);
    archiveProof.push({
      ...JSON.parse(proof.stdout),
      file: destination,
      bytes: bytes.length,
      sha256: artifact.sha256,
    });
  }
  assert.deepEqual([...new Set(archiveProof.map((p) => p.customer))].sort(), ['C1001', 'C1008']);
  evidence.archiveProof = archiveProof;
  evidence.retestModel = verification.model;
  evidence.approvedRequestIds = approved;
  evidence.toolNames = toolNames;
  evidence.completedAt = Date.now();
  evidence.status = 'passed';
  await page.screenshot({ path: path.join(output, '04-verified.png') });
  console.log(
    'PASS: real model → docs → repository MCP → two sandboxes → Git push → fresh checkout → agent-browser ZIP downloads.',
  );
} catch (error) {
  evidence.status = 'failed';
  evidence.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  const page = await app.firstWindow().catch(() => undefined);
  const video = page?.video();
  await app.close();
  if (video) {
    videoPath = await video.path();
    evidence.rawVideo = videoPath;
  }
  await baseline.close();
  await retest?.close();
  registry.close();
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(output, 'chapters.json'), JSON.stringify(marks, null, 2));
  await writeFile(
    path.join(output, 'registry-audit.json'),
    JSON.stringify([...previousAudit, ...registry.audit], null, 2),
  );
  console.log('Evidence:', output, 'Video:', videoPath);
}
