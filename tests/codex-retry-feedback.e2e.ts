/** Real Athena and Codex, with a loopback SSE service that times out before its first answer. */
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';

const root = await mkdtemp(path.join(tmpdir(), 'athena-codex-retry-'));
const profile = path.join(root, 'athena'),
  codexHome = path.join(root, 'codex');
await seedLegacyWorkspace(profile);
await mkdir(codexHome);
let requests = 0;
let recovered: ServerResponse | undefined;
function signal(response: ServerResponse, type: string, payload: object) {
  response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}
const server = createServer((request, response) => {
  request.resume();
  if (!request.url?.endsWith('/responses')) {
    response.writeHead(404).end();
    return;
  }
  requests++;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  signal(response, 'response.created', {
    response: { id: 'local-' + requests, status: 'in_progress', output: [] },
  });
  if (requests === 1) return; // The installed CLI must detect the idle stream and retry.
  recovered = response;
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
await writeFile(
  path.join(codexHome, 'config.toml'),
  `model = "gpt-5.4"
model_provider = "loopback"
[model_providers.loopback]
name = "Loopback"
base_url = "${origin}/v1"
wire_api = "responses"
supports_websockets = false
stream_idle_timeout_ms = 3000
stream_max_retries = 3
`,
);
const env = { ...process.env, HOME: root, CODEX_HOME: codexHome, WORKBENCH_USER_DATA_DIR: profile };
for (const key of [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'WORKBENCH_DEV_SERVER_URL',
])
  delete (env as NodeJS.ProcessEnv)[key];
const app = await electron.launch({ args: [path.resolve('tests/electron-background.cjs')], env });
try {
  const page = await app.firstWindow();
  await page
    .getByRole('textbox', { name: '发送给 Agent 的任务', exact: true })
    .fill('回复一行测试文字');
  await page.getByRole('button', { name: '发送任务', exact: true }).click();
  const title = page.locator('article.assistant .act-title').last();
  await expect(title).toHaveText('等待 Codex 输出', { timeout: 20_000 });
  await expect(title).toHaveText('Codex 连接超时，正在重试（1/3）', { timeout: 10_000 });
  await expect.poll(() => Boolean(recovered), { timeout: 5000 }).toBe(true);
  assert.ok(recovered);
  const item = { type: 'message', id: 'm2', role: 'assistant', phase: 'final_answer' };
  signal(recovered, 'response.output_item.added', {
    output_index: 0,
    item: { ...item, status: 'in_progress', content: [] },
  });
  signal(recovered, 'response.output_text.delta', {
    item_id: 'm2',
    output_index: 0,
    content_index: 0,
    delta: '已恢复',
  });
  await expect(title).toHaveText('正在回复');
  signal(recovered, 'response.output_item.done', {
    output_index: 0,
    item: { ...item, status: 'completed', content: [{ type: 'output_text', text: '已恢复' }] },
  });
  signal(recovered, 'response.completed', {
    response: {
      id: 'local-2',
      status: 'completed',
      output: [],
      usage: { input_tokens: 25, output_tokens: 5, total_tokens: 30 },
    },
  });
  recovered.end();
  await expect(title).toHaveText('已完成');
  await expect(page.locator('article.assistant .markdown').last()).toHaveText('已恢复');
  assert.equal(requests, 2);
  console.log(
    'Codex retry UI passed: native turn receipt, stream timeout 1/3, public reply and completion; two loopback HTTP connections.',
  );
} finally {
  server.closeAllConnections();
  server.close();
  await app.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
