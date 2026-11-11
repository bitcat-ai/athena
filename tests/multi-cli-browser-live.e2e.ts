// 显式启用后使用本机真实模型，仅操作临时 loopback 页面；不发送消息或访问 QA 平台。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import type { AgentId, AppSnapshot } from '../src/shared/types';

const supported: AgentId[] = ['codex', 'claude', 'cursor', 'pi'];
const requested = process.env.WORKBENCH_LIVE_CLI;
if (
  process.env.WORKBENCH_LIVE_BROWSER !== '1' ||
  !requested ||
  (requested !== 'all' && !supported.includes(requested as AgentId))
)
  throw new Error(
    '真实模型验收须明确设置 WORKBENCH_LIVE_BROWSER=1 和 WORKBENCH_LIVE_CLI=codex|claude|cursor|pi|all',
  );
const selected = requested === 'all' ? supported : [requested as AgentId];
const output = path.resolve('test-results/multi-cli-browser');
await mkdir(output, { recursive: true });
const submissions: Array<{ title: string; owner: string }> = [];
const site = createServer(async (request, response) => {
  response.setHeader('content-type', 'text/html;charset=utf-8');
  if (request.url === '/save' && request.method === 'POST') {
    let body = '';
    for await (const part of request) body += part;
    const value = JSON.parse(body);
    submissions.push(value);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: submissions.length }));
    return;
  }
  response.end(`<!doctype html><meta charset="utf-8"><title>Athena 本地浏览器验收</title>
    <style>body{font:18px system-ui;margin:40px}label{display:block;margin:20px 0}input,button{font:inherit;padding:8px}</style>
    <h1>本地表单验收</h1><label>标题<input id="title" aria-label="标题"></label>
    <label>负责人<input id="owner" aria-label="负责人"></label><button id="save">保存</button>
    <p id="result" role="status">尚未保存</p><script>
    document.querySelector('#save').onclick=async()=>{
      const value={title:document.querySelector('#title').value,owner:document.querySelector('#owner').value};
      const result=await fetch('/save',{method:'POST',body:JSON.stringify(value)}).then(r=>r.json());
      document.querySelector('#result').textContent='已保存 #'+result.id+'：'+value.title+' / '+value.owner;
    };</script>`);
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
const reports: Record<string, unknown>[] = [];
try {
  for (const cli of selected) {
    const directory = await mkdtemp(path.join(tmpdir(), `athena-${cli}-browser-`));
    const userData = path.join(directory, 'data');
    await seedLegacyWorkspace(userData);
    const stateFile = path.join(userData, 'workspace.json');
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    saved.settings.agent = cli;
    saved.onboarding = {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      workspaceConfirmed: saved.settings.workspace,
      browserDeferred: false,
    };
    await writeFile(stateFile, JSON.stringify(saved), { mode: 0o600 });
    const marker = `Athena-${randomUUID()}`;
    const before = submissions.length;
    const started = Date.now();
    const errors: string[] = [];
    const report: Record<string, unknown> = { cli, passed: false };
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    const deadline = setTimeout(() => void app?.close().catch(() => {}), 5 * 60_000);
    try {
      app = await electron.launch({
        args: ['.'],
        cwd: process.cwd(),
        env: { ...process.env, WORKBENCH_USER_DATA_DIR: userData },
      });
      const page = await app.firstWindow();
      page.on('pageerror', (error) => errors.push(error.message));
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.webContents.setBackgroundThrottling(false);
        window.hide();
      });
      const snapshot = () =>
        page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
      await expect
        .poll(async () => (await snapshot()).neo?.status, { timeout: 45_000 })
        .toBe('ready');
      const info = (await snapshot()).agents.find((agent) => agent.id === cli);
      report.detected = info && {
        available: info.available,
        supported: info.supported,
        version: info.version,
      };
      assert.ok(info?.available && info.supported, `${cli} 尚未就绪`);
      await expect(page.locator('#composer-agent-name')).toHaveText(info.name);
      await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
      await page.evaluate((url) => window.workbench.invoke('browser:navigate', { url }), origin);
      const prompt = `这是已批准的本地隔离页面验收，仅操作当前 ${origin} 页面。先用 neo_plan 发布简短计划，再用 neo_snapshot 读取引用，neo_act 的 fields 一次填写标题为 ${marker}、负责人为 ${cli}，然后点击一次保存。重新 neo_read/neo_snapshot 核实完整回执，用最新 observationId 和原文执行 neo_checkpoint（verified），最后更新计划并一句话报告。仅用 neo_* 工具；不使用文件、命令、脚本、外部地址、飞书或 QA 平台。结果未知先观察，不重复提交。`;
      await page.getByRole('textbox', { name: '发送给 Agent 的任务', exact: true }).fill(prompt);
      await page.getByRole('button', { name: '发送任务', exact: true }).click();
      await expect
        .poll(
          async () => {
            const state = await snapshot();
            for (const pending of state.pendingRequests ?? []) {
              assert.equal(pending.kind, 'approval', '出现未经批准的提问');
              if (pending.kind !== 'approval') continue;
              assert.ok(
                cli === 'cursor' &&
                  pending.request.id.startsWith('cursor-workspace:') &&
                  pending.request.detail.startsWith(`${saved.settings.workspace}\n`),
                '出现范围外审批',
              );
              await page
                .getByRole('region', { name: 'Agent 待处理事项', exact: true })
                .getByRole('button', { name: '允许这次操作', exact: true })
                .click();
            }
            const conversation = state.conversations.find(
              (c) => c.agent === cli && c.messages.some((m) => m.text === prompt),
            );
            const answer = conversation?.messages.findLast((m) => m.role === 'assistant');
            return answer?.status === 'done' || answer?.status === 'error';
          },
          { timeout: 240_000, intervals: [250, 500, 1000] },
        )
        .toBe(true);
      const final = await snapshot();
      const conversation = final.conversations.find(
        (c) => c.agent === cli && c.messages.some((m) => m.text === prompt),
      );
      const answer = conversation?.messages.findLast((m) => m.role === 'assistant');
      assert.equal(answer?.status, 'done', answer?.failure || answer?.text || '任务未完成');
      assert.deepEqual(
        submissions.slice(before),
        [{ title: marker, owner: cli }],
        '服务端应仅收到一次正确提交',
      );
      assert.ok(answer?.plan?.length, '缺少公开计划');
      assert.ok(
        answer.execution?.some(
          (event) => event.kind === 'checkpoint' && event.outcome === 'verified',
        ),
        '缺少原文核对证据',
      );
      const names = answer.tools?.map((tool) => tool.name) ?? [];
      assert.ok(names.includes('neo_act') && names.includes('neo_snapshot'), '未经过 Neo 宿主工具');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(output, `${cli}.png`) });
      Object.assign(report, {
        passed: true,
        version: info.version,
        elapsedMs: Date.now() - started,
        nativeSessionId: conversation?.agentSessionId,
        tools: names,
        submissions: submissions.slice(before),
        errors,
      });
    } catch (error) {
      report.failure = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
      await app?.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
      reports.push(report);
      await writeFile(path.join(output, `${cli}.json`), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
    }
  }
} finally {
  site.closeAllConnections();
  await new Promise<void>((resolve) => site.close(() => resolve()));
  await writeFile(path.join(output, 'verification.json'), JSON.stringify({ reports }, null, 2));
}
