/** App → recording evidence, rule confirmation, practice and result. The host is isolated IPC. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { uiBrowserExecutable } from './ui-browser';
import type { Recording } from '../src/shared/types';

const question = '对外提供材料时如何处理内部备注？';
const recording: Recording = {
  id: 'recording',
  title: '导出客户材料',
  startedAt: 1,
  steps: [
    {
      id: 'open',
      timestamp: 1,
      url: 'https://example.test/',
      description: '查看客户',
      kind: 'click',
      source: 'human',
    },
    {
      id: 'export',
      timestamp: 2,
      url: 'https://example.test/',
      description: '点击导出',
      kind: 'click',
      source: 'human',
      outcome: { kind: 'download', status: 'completed', origin: 'link' },
    },
  ],
  workflow: {
    revision: 'r1',
    goal: '导出所选客户资料',
    steps: [{ note: '选择客户并导出', stepIds: ['open', 'export'] }],
    parameters: [{ name: '客户编号', example: 'C1001', stepIds: ['open'] }],
    questions: [{ question, stepIds: ['export'] }],
  },
};
const server = await createServer({
  cacheDir: '../../.runtime/recording-workflow-ui-vite',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: uiBrowserExecutable(),
  args: ['--use-mock-keychain', '--disable-sync'],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 820 },
    reducedMotion: 'reduce',
  });
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((sample: Recording) => {
    (window as any).__name = (fn: unknown) => fn;
    const w = window as any;
    const listeners = new Set<(e: unknown) => void>();
    w.calls = [];
    w.save = () =>
      listeners.forEach((fn) =>
        fn({ type: 'recording:saved', recording: structuredClone(sample) }),
      );
    w.finish = () => {
      if (sample.practice) {
        sample.practice.status = 'finished';
        sample.practice.verification = 'failed';
        sample.practice.detail = '下载文件属于其他客户';
        w.save();
      }
    };
    const state = {
      status: 'ready',
      engine: 'agent-browser',
      tabs: [],
      url: 'https://example.test/',
      title: '客户列表',
      loading: false,
      inspecting: false,
      recording: false,
    };
    w.workbench = {
      onEvent: (fn: (e: unknown) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      invoke: async (action: string, payload: any) => {
        w.calls.push({ action, payload });
        if (action === 'app:snapshot')
          return {
            settings: { workspace: '/workspace', agent: 'codex' },
            agents: [],
            conversations: [],
            localUser: { name: 'Fixture' },
            browser: state,
            web: { status: 'stopped' },
            feishu: { status: 'disconnected', paired: false },
            recordings: [structuredClone(sample)],
          };
        if (action === 'share:state') return { active: false, participants: [] };
        if (action === 'recording:answer') {
          sample.workflow!.questions[0].answer = payload.answer;
          w.save();
          return structuredClone(sample);
        }
        if (action === 'recording:practice') {
          sample.practice = {
            target: payload.target,
            status: 'guiding',
            progress: [{ note: '点击导出', status: 'current' }],
            verification: 'unknown',
            detail: '',
          };
          w.save();
          return true;
        }
        if (action === 'recording:practice-stop' && sample.practice) {
          sample.practice.status = 'stopped';
          w.save();
          return true;
        }
        if (action === 'models:list') return [];
      },
    };
  }, recording);
  await page.goto('http://127.0.0.1:' + (server.httpServer!.address() as { port: number }).port);
  await page.getByRole('button', { name: '展开浏览器' }).click();
  const pane = page.getByRole('region', { name: '浏览器', exact: true });
  await pane.locator('[data-slot="segment-item"]').filter({ hasText: '操作记录' }).click();
  await pane.getByRole('button', { name: '查看原始步骤 2' }).first().click();
  await expect(pane.locator('#recorded-step-export')).toBeFocused();
  await expect(pane.locator('#recorded-step-export')).toContainText('下载完成');
  await expect(pane.locator('#recorded-step-open')).toContainText('未记录操作结果');

  const answer = pane.getByRole('textbox', { name: question });
  const start = pane.getByRole('button', { name: '开始带做' });
  await answer.fill('只在对外导出时排除。');
  await pane.getByRole('button', { name: '确认规则' }).click();
  await expect(pane.getByRole('button', { name: '已确认' })).toBeDisabled();
  await expect(pane.getByRole('textbox', { name: '录制中的对象' })).toHaveValue('C1001');
  await pane.getByRole('textbox', { name: '本次对象' }).fill('C1008');
  await pane.getByText('核验客户材料 ZIP', { exact: true }).click();
  await pane.getByText('检查是否排除内部备注', { exact: true }).click();
  const results = 'test-results/recording-workflow-ui';
  await mkdir(results, { recursive: true });
  const view = pane.locator('.recordings-view');
  assert(
    await view.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    'Recording details fit the browser pane',
  );
  await pane.screenshot({ path: results + '/recording-details.png' });
  await expect(start).toBeDisabled();
  await pane.getByText('已确认上述规则适用于本次对象', { exact: true }).click();
  await start.click();
  const payload = await page.evaluate(
    () => (window as any).calls.find((c: any) => c.action === 'recording:practice').payload,
  );
  assert.deepEqual(payload, {
    id: 'recording',
    revision: 'r1',
    example: 'C1001',
    target: 'C1008',
    rulesReviewed: true,
    verifyCustomerZip: true,
    excludeInternal: true,
  });
  await pane.getByRole('button', { name: '停止带做' }).click();
  await pane.getByRole('button', { name: '查看带做结果' }).click();
  await expect(pane.getByRole('region', { name: '带做结果' })).toContainText('带做已停止');
  await expect(pane.getByRole('region', { name: '带做结果' })).toContainText('尚未核实');

  await answer.fill('只对外排除，内部交接保留。');
  await pane.getByRole('button', { name: '确认规则' }).click();
  await expect(start).toBeDisabled();
  const correction = await page.evaluate(
    () => (window as any).calls.filter((c: any) => c.action === 'recording:answer').at(-1).payload,
  );
  assert.equal(correction.previousAnswer, '只在对外导出时排除。');
  await pane.getByText('已确认上述规则适用于本次对象', { exact: true }).click();
  await start.click();
  await page.evaluate(() => (window as any).finish());
  await pane.getByRole('button', { name: '查看带做结果' }).click();
  await expect(pane.getByRole('region', { name: '带做结果' })).toContainText('未通过');
  await expect(pane.getByRole('region', { name: '带做结果' })).toContainText(
    '下载文件属于其他客户',
  );
  await expect(pane.getByRole('region', { name: '带做结果' })).toBeFocused();
  assert.deepEqual(errors, []);
  console.log('Recording workflow UI passed with isolated host events.');
} finally {
  await browser.close();
  await server.close();
}
