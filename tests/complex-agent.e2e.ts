/** Explicit local integration check; uses the existing Codex login and real model quota. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserRuntime, discoverBrowserOS } from '../src/main/browser';
import { NeoBrowserRuntime } from '../src/main/neo-browser';
import { CodexSession, detectAgents } from '../src/main/agents';
import { complexWorkflowFixture } from './complex-workflow-fixture';
import type { AgentEvent, WebExecutionEvent, ApprovalRequest } from '../src/shared/types';

const scenario = process.argv.includes('--lost-reply') ? 'lost-reply' : 'normal';
const output = path.resolve('test-results/complex-agent', `live-${scenario}`);
await mkdir(output, { recursive: true });
const dir = await mkdtemp(path.resolve('.runtime/complex-live-'));
const fixture = await complexWorkflowFixture();
const events: AgentEvent[] = [],
  execution: WebExecutionEvent[] = [];
const calls: Array<{
  name: string;
  args: unknown;
  isError: boolean;
  durationMs: number;
  output: string;
}> = [];
const approvals: Array<Omit<ApprovalRequest, 'id' | 'kind'> & { approved: boolean }> = [];
const startedAt = Date.now();
let agent: CodexSession | undefined;
let neo: NeoBrowserRuntime;
let report: Record<string, unknown> = {};
const browser = new BrowserRuntime({
  storageDir: path.join(dir, 'browser'),
  binaryPath: await discoverBrowserOS(),
  onState() {},
  onFrame() {},
  onSelected() {},
  onStep() {},
  onHumanTakeover() {
    if (neo && !neo.isHandingOver()) {
      void neo.cancelTask();
      void agent?.interrupt();
    }
  },
});
const file = path.join(dir, 'approved-fixture.txt');
await writeFile(file, 'Athena controlled upload\n');
neo = new NeoBrowserRuntime(browser, {
  directory: path.join(dir, 'neo'),
  onState() {},
  onDisconnect() {},
  onExecution: (e) => execution.push(e),
  approve: async (request) => {
    // Only this exact local fixture file/target is authorized. Arbitrary scripts stay denied.
    let approved = false;
    if (request.action === 'browser-upload' && request.detail.includes(fixture.origin)) {
      const args = JSON.parse(request.detail.slice(request.detail.indexOf('{')));
      const files = args.files ?? (args.file ? [args.file] : []);
      approved = files.length === 1 && files[0] === file;
    }
    approvals.push({ ...request, approved });
    console.log(JSON.stringify({ approval: request.action, approved }));
    return approved;
  },
});
try {
  const codex = (await detectAgents()).find((x) => x.id === 'codex' && x.available && x.supported);
  assert(codex?.path, 'A working local Codex CLI is required');
  await browser.start(fixture.origin + (scenario === 'lost-reply' ? '/?loseReply=1' : '/'));
  await neo.start();
  browser.allowAgentControl();
  const task = await neo.beginTask('complex-' + scenario);
  agent = new CodexSession({
    workspace: dir,
    executablePath: codex.path,
    tools: neo.getTools().filter((t) => t.name.startsWith('neo_')),
    callTool: async (name, args) => {
      if (args.url)
        assert.equal(new URL(String(args.url)).origin, fixture.origin, 'Local fixture scope');
      const t = Date.now();
      const result = await neo.callTool(name, args);
      calls.push({
        name,
        args,
        isError: Boolean(result.isError),
        durationMs: Date.now() - t,
        output: result.text,
      });
      console.log(
        JSON.stringify({
          tool: name,
          page: args.page,
          kind: args.kind,
          isError: Boolean(result.isError),
          ms: Date.now() - t,
          output: result.text.slice(0, 160),
        }),
      );
      return result;
    },
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'approval') agent!.resolveApproval(e.request.id, false);
      if (e.type === 'user-input')
        console.log(JSON.stringify({ unexpectedInput: e.request.questions }));
      if (e.type === 'plan') console.log(JSON.stringify(e));
      if (e.type === 'error') console.log(JSON.stringify(e));
    },
  });
  const timer = setTimeout(() => {
    void neo.cancelTask();
    void agent?.close();
  }, 12 * 60_000);
  try {
    await agent.send(
      `请在当前本地订单工作台，为 Ada Studio 完成一笔国际订单。先筛选“待处理”，翻页找到该客户；打开并读取“国际配送规则”，按规则填写税号和配送方式；联系人邮箱是 ada@example.test，订单附件是 ${file}。选择国际区域后先点击一次“检查订单”，读取校验提示，再补齐所需字段并重新校验。只有页面确认校验通过才提交。提交后核对“订单回执”，确认只有一笔正确订单，然后下载回执 CSV。若提交没有收到回执，先查看已有订单，不能重复提交。任务开始先用 neo_plan 记录简短计划，并随执行更新；需要有页面证据的检查点，最后报告实际订单号与下载文件。可使用 update_plan 发布计划，其余仅使用 neo_* 工具操作 ${fixture.origin} 的页面；不运行脚本、命令、文件工具，不访问其他站点，不改浏览器安全范围。上传审批仅授权此文件。`,
      task.context,
    );
  } finally {
    clearTimeout(timer);
  }
  assert(
    events.some((e) => e.type === 'complete'),
    'Real model completed',
  );
  assert(!events.some((e) => e.type === 'error'), 'No fatal model error');
  assert(
    !events.some(
      (e) =>
        e.type === 'tool' &&
        ['commandExecution', 'fileChange', 'mcpToolCall'].includes(e.call.name),
    ),
    'No non-browser execution',
  );
  assert(
    execution.some((e) => e.kind === 'plan'),
    'Structured public plan delivered by real Agent tool call',
  );
  assert.equal(fixture.attempts, 1, 'No duplicate submission, including after lost reply');
  assert.deepEqual(fixture.saves, [
    {
      id: 'ORDER-1',
      customer: 'Ada Studio',
      region: 'international',
      tax: 'INT-2048',
      shipping: 'express',
      contact: 'ada@example.test',
      attachment: 'approved-fixture.txt',
    },
  ]);
  assert.deepEqual(fixture.uploads, ['Athena controlled upload\n']);
  assert(execution.some((e) => e.kind === 'checkpoint' && e.outcome === 'verified'));
  assert(
    calls.some((c) => c.name === 'neo_act' && (c.args as any).fields?.length >= 2),
    'Batch form fill used',
  );
  assert(
    browser.getState().tabs.length >= 2 && calls.some((c) => c.name === 'neo_tabs'),
    'Normal tab workflow used',
  );
  assert(approvals.some((a) => a.action === 'browser-upload' && a.approved));
  const artifact = execution.find((e) => e.kind === 'artifact')?.artifact;
  assert(artifact, 'Host verified file artifact');
  const csv = await readFile(artifact.path, 'utf8');
  assert.match(
    csv,
    /ORDER-1,Ada Studio,international,INT-2048,express,ada@example.test,approved-fixture.txt/,
  );
  await copyFile(artifact.path, path.join(output, 'receipt.csv'));
  const nativeRecord = await neo.server.detail(task.sessionId);
  await writeFile(path.join(output, 'native-record.json'), JSON.stringify(nativeRecord, null, 2));
  report = {
    passed: true,
    scenario,
    cliVersion: codex.version,
    neoVersion: neo.getState().version,
    elapsedMs: Date.now() - startedAt,
    toolRounds: calls.length,
    failedTools: calls.filter((c) => c.isError).length,
    attempts: fixture.attempts,
    saves: fixture.saves,
    artifact,
    planEvents: execution.filter((e) => e.kind === 'plan'),
    checkpoints: execution.filter((e) => e.kind === 'checkpoint'),
    reply: events.find((e) => e.type === 'complete'),
    validation:
      'Real CLI → model → host → native Neo → local page/server/file; no external website verification',
  };
} catch (error) {
  report = {
    passed: false,
    scenario,
    elapsedMs: Date.now() - startedAt,
    error: String(error),
    attempts: fixture.attempts,
    saves: fixture.saves,
  };
  process.exitCode = 1;
} finally {
  await agent?.close();
  await neo.stop();
  await browser.dispose();
  await fixture.close();
  await writeFile(
    path.join(output, 'evidence.json'),
    JSON.stringify({ ...report, approvals, calls, execution, events }, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  await rm(dir, { recursive: true, force: true });
}
