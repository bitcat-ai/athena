/** Installed Gemini CLI against a local Google API fixture; no account changes or remote inference. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { StreamCliSession } from '../src/main/stream-cli-session';
import type { AgentEvent } from '../src/shared/types';
import type { AppSnapshot } from '../src/shared/types';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';

const executablePath = process.env.WORKBENCH_TEST_GEMINI_PATH;
if (!executablePath || !path.isAbsolute(executablePath))
  throw Error('Set WORKBENCH_TEST_GEMINI_PATH to an installed Gemini CLI.');
const directory = await mkdtemp(path.join(os.tmpdir(), 'athena-gemini-native-'));
const workspace = path.join(directory, 'workspace'),
  geminiHome = path.join(directory, 'gemini');
for (const item of [workspace, geminiHome, path.join(geminiHome, '.gemini')])
  await mkdir(item, { recursive: true });
const settings = JSON.stringify({
  security: { auth: { selectedType: 'gemini-api-key' } },
  telemetry: { enabled: false },
  general: { enableAutoUpdate: false },
});
await writeFile(path.join(geminiHome, 'settings.json'), settings);
await writeFile(path.join(geminiHome, '.gemini', 'settings.json'), settings);
const marker = randomUUID(),
  events: AgentEvent[] = [],
  requests: Array<{ phase: string; path: string; hasMarker: boolean }> = [];
let phase = 'first',
  session: StreamCliSession | undefined;
let firstDelta: () => void = () => {};
const streaming = new Promise<void>((resolve) => {
  firstDelta = resolve;
});
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname.includes('countTokens')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ totalTokens: 12 }));
    return;
  }
  const body = JSON.parse(raw || '{}');
  requests.push({
    phase,
    path: pathname,
    hasMarker: JSON.stringify(body.contents).includes(marker),
  });
  const answer =
    phase === 'first'
      ? marker
      : phase === 'resume'
        ? requests.at(-1)!.hasMarker
          ? 'RESUME_OK'
          : 'RESUME_MISSING'
        : 'running';
  const chunk = {
    candidates: [
      {
        content: { role: 'model', parts: [{ text: answer }] },
        index: 0,
        ...(phase === 'stop' ? {} : { finishReason: 'STOP' }),
      },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
    modelVersion: 'gemini-native-fixture',
  };
  if (pathname.includes('streamGenerateContent')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (phase !== 'stop') res.end();
  } else {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(chunk));
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
Object.assign(process.env, {
  GEMINI_CLI_HOME: geminiHome,
  GEMINI_API_KEY: 'fixture-only',
  GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${address.port}`,
  GOOGLE_GENAI_USE_VERTEXAI: 'false',
  GEMINI_CLI_NO_RELAUNCH: '1',
  NO_BROWSER: '1',
  NO_OPEN_BROWSER: '1',
});
const make = (sessionId?: string) =>
  new StreamCliSession({
    cli: 'gemini',
    workspace,
    executablePath,
    sessionId,
    tools: [],
    callTool: async () => {
      throw Error('Gemini tools are disabled');
    },
    onEvent(event) {
      events.push(event);
      if (event.type === 'approval')
        session!.resolveApproval(
          event.request.id,
          event.request.id.startsWith('gemini-workspace:') &&
            event.request.detail.startsWith(`${workspace}\n`),
        );
      if (phase === 'stop' && event.type === 'delta' && event.text) firstDelta();
    },
  });
const output = path.resolve('test-results/gemini-native');
await mkdir(output, { recursive: true });
let app: ElectronApplication | undefined;
const timer = setTimeout(() => {
  session?.close();
  void app?.close();
}, 150000);
try {
  session = make();
  const models = await session.listModels();
  const selected = models.find((m) => m.model !== 'auto');
  assert.ok(selected);
  await session.send(`Remember this marker: ${marker}. Reply with it.`, undefined, undefined, {
    model: selected.model,
  });
  assert.ok(events.some((e) => e.type === 'complete' && e.text?.includes(marker)));
  const id = session.sessionId;
  assert.ok(id);
  session.close();
  session = make(id);
  phase = 'resume';
  await session.send('Recall the prior marker without using tools.', undefined, undefined, {
    model: selected.model,
  });
  assert.ok(events.some((e) => e.type === 'complete' && e.text?.includes('RESUME_OK')));
  assert.equal(session.sessionId, id);
  phase = 'stop';
  const pending = assert.rejects(session.send('Keep responding.'), /停止/);
  await streaming;
  await session.interrupt();
  await pending;
  const profile = path.join(directory, 'profile');
  await mkdir(profile);
  await writeFile(
    path.join(profile, 'workspace.json'),
    JSON.stringify({
      settings: {
        workspace,
        agent: 'gemini',
        modelSelections: { gemini: { model: selected.model } },
      },
      recordings: [],
      onboarding: {
        version: 1,
        status: 'complete',
        stage: 'ready',
        required: false,
        workspaceConfirmed: workspace,
        browserDeferred: true,
      },
      conversations: [
        {
          id: 'gemini-ui',
          agent: 'gemini',
          title: 'Gemini local check',
          workspace,
          updatedAt: Date.now(),
          messages: [],
        },
      ],
    }),
  );
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.WORKBENCH_USER_DATA_DIR = profile;
  delete env.WORKBENCH_DEV_SERVER_URL;
  env.PATH = `${path.dirname(executablePath)}${path.delimiter}${env.PATH || ''}`;
  app = await electron.launch({ args: ['tests/electron-background.cjs'], cwd: process.cwd(), env });
  const page = await app.firstWindow();
  await expect(page.locator('#composer-agent-name')).toHaveText('Gemini CLI', { timeout: 30000 });
  const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
  const latest = async () =>
    (await snapshot()).conversations.find((c) => c.id === 'gemini-ui')!.messages.at(-1);
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  const send = async (text: string) => {
    await composer.fill(text);
    await page.getByRole('button', { name: '发送任务', exact: true }).click();
  };
  const approval = page.getByRole('group', { name: '允许 Gemini 使用这个工作目录？', exact: true });
  const before = requests.length;
  phase = 'first';
  await send('Check directory approval.');
  await expect(approval).toBeVisible();
  await page.screenshot({
    path: path.join(output, 'workspace-approval.png'),
    animations: 'disabled',
  });
  await approval.getByRole('button', { name: '拒绝', exact: true }).click();
  await expect.poll(async () => (await latest())?.status).toBe('error');
  assert.equal(requests.length, before, 'Denying the directory must not call a model');
  await send(`Remember this marker: ${marker}. Reply with it.`);
  await approval.getByRole('button', { name: '允许这次', exact: true }).click();
  await expect.poll(async () => (await latest())?.text, { timeout: 30000 }).toContain(marker);
  await expect.poll(async () => (await latest())?.status).toBe('done');
  const nativeId = (await snapshot()).conversations.find(
    (c) => c.id === 'gemini-ui',
  )!.agentSessionId;
  assert.ok(nativeId);
  phase = 'resume';
  await send('Recall the previous marker.');
  await approval.getByRole('button', { name: '允许这次', exact: true }).click();
  await expect.poll(async () => (await latest())?.text, { timeout: 30000 }).toContain('RESUME_OK');
  await expect.poll(async () => (await latest())?.status).toBe('done');
  assert.equal(
    (await snapshot()).conversations.find((c) => c.id === 'gemini-ui')!.agentSessionId,
    nativeId,
  );
  phase = 'stop';
  await send('Keep responding.');
  await approval.getByRole('button', { name: '允许这次', exact: true }).click();
  await expect.poll(async () => (await latest())?.text, { timeout: 30000 }).toContain('running');
  await composer.fill('下一条草稿');
  await page.getByRole('button', { name: '停止任务', exact: true }).click();
  await expect.poll(async () => (await latest())?.status).not.toBe('streaming');
  await expect(composer).toHaveText('下一条草稿');
  assert.ok(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
    ),
  );
  await app.close();
  app = undefined;
  const evidence = {
    passed: true,
    source: 'installed-gemini-loopback-model',
    remoteModelCalls: 0,
    models: models.length,
    selected: selected.model,
    requests,
    checks: [
      'native JSON model catalog',
      'native response and stream',
      'same native session resume',
      'interrupt after a text delta',
      'hidden Electron directory rejection sends no model request',
      'Electron approval, native resume and stop preserve the draft',
    ],
  };
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      {
        error: error instanceof Error ? error.message : 'unknown',
        requests,
        events: events.filter((e) => e.type === 'error' || e.type === 'complete'),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  clearTimeout(timer);
  session?.close();
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
