/** Real Electron + installed Claude/Pi/OpenCode + Neo; local model responses, zero remote model calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { AppSnapshot, ElementQueryResult } from '../src/shared/types';

const root = process.cwd();
await mkdir(path.join(root, '.runtime'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.runtime/native-browser-interop-'));
const profile = path.join(directory, 'profile');
const workspace = path.join(directory, 'workspace');
const piDirectory = path.join(directory, 'pi');
const output = path.resolve('test-results/native-browser-interop');
for (const value of [profile, workspace, piDirectory, output])
  await mkdir(value, { recursive: true });
const requests: Array<{ cli: string; step: number; tool?: string }> = [];
const fixtureErrors: string[] = [];
const textContent = (value: any): string =>
  typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map((part) => (part.type === 'text' ? part.text : '')).join('\n')
      : '';
let origin = '';
const server = createServer(async (request, response) => {
  if (request.method !== 'POST') {
    response.setHeader('content-type', 'text/html;charset=utf-8');
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Neo native fixture</title><style>body{font:16px sans-serif;margin:24px}h1{font-size:24px}main{min-height:400px}input{padding:10px;width:200px}section{margin:12px 0;padding:18px}a{display:block;margin:12px 0}</style><main id="workspace"><h1>Native browser fixture</h1><p id="retained">Original content stays</p></main>`,
    );
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const data = JSON.parse(body || '{}');
  if (request.url?.includes('count_tokens')) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ input_tokens: 10 }));
    return;
  }
  const tools = (data.tools || []).map((tool: any) => tool.name);
  const cli = tools.includes('mcp__athena__neo_snapshot')
    ? 'claude'
    : tools.includes('athena_neo_snapshot')
      ? 'opencode'
      : tools.includes('neo_snapshot')
        ? 'pi'
        : 'unknown';
  const prefix = cli === 'claude' ? 'mcp__athena__' : cli === 'opencode' ? 'athena_' : '';
  const messages = data.messages || [];
  const result = (step: number) => {
    const id = `interop-${cli}-${step}`;
    const block = messages
      .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
      .find((part: any) => part.type === 'tool_result' && part.tool_use_id === id);
    if (block?.is_error)
      throw new Error(
        `Native ${cli} tool ${step} failed: ${textContent(block.content).slice(0, 500)}`,
      );
    return block ? textContent(block.content) : undefined;
  };
  let call: { name: string; input: Record<string, unknown> } | undefined;
  let step = 0;
  let reply = `${cli.toUpperCase()}_BROWSER_DONE [Open next page](${origin}/next)`;
  try {
    if (!tools.length) throw new Error('TITLE_ONLY');
    assert.notEqual(cli, 'unknown', 'Native CLI must receive the actual Neo tool catalog');
    while (result(step) !== undefined) step++;
    const source = messages.map((message: any) => textContent(message.content)).join('\n');
    const context = source.match(/<neo_browser_context>\n([^\n]+)/)?.[1];
    assert.ok(context, 'Host must attach the current visible Neo page');
    const pageId = JSON.parse(context).currentPage.pageId;
    const invoke = (name: string, input: Record<string, unknown>) => {
      call = { name: prefix + name, input };
      assert.ok(tools.includes(call.name));
    };
    const parsed = (index: number) => JSON.parse(result(index)!);
    if (step === 0) invoke('neo_snapshot', { page: pageId });
    if (step === 1) invoke('workbench_browser_query', { selector: '#workspace' });
    if (step === 2)
      invoke('workbench_browser_edit', {
        ref: parsed(1).elements[0].ref,
        insert: {
          node: {
            tag: 'section',
            attributes: { id: `created-${cli}` },
            styles: { padding: '18px', 'background-color': '#f2f2f2' },
            children: [
              { tag: 'h2', text: `Created by ${cli}` },
              {
                tag: 'input',
                attributes: {
                  id: `search-${cli}`,
                  type: 'search',
                  'aria-label': `${cli} search`,
                  placeholder: 'Search items',
                },
              },
              { tag: 'a', text: 'Visit next page', attributes: { href: `${origin}/next` } },
            ],
          },
        },
      });
    if (step === 3)
      invoke('workbench_browser_edit', {
        ref: parsed(2).element.ref,
        styles: { 'border-radius': '16px', 'background-color': '#e8f0ff' },
      });
    if (step === 4) invoke('neo_snapshot', { page: pageId });
    if (step === 5) {
      const line = result(4)!
        .split('\n')
        .find((line) => line.includes(`${cli} search`) && line.includes('[ref='));
      const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
      assert.ok(ref, `No native ref for new ${cli} input: ${result(4)!.slice(0, 1200)}`);
      invoke('neo_act', { page: pageId, kind: 'fill', ref, value: `typed-${cli}` });
    }
    if (step === 6) invoke('neo_snapshot', { page: pageId });
    if (step === 7) {
      const observationId = result(6)!.match(/Athena observationId: ([a-f0-9-]+)/)?.[1];
      assert.ok(observationId);
      assert.ok(result(6)!.includes(`typed-${cli}`));
      invoke('neo_checkpoint', {
        observationId,
        summary: 'Created and operated the new page controls',
        evidence: `typed-${cli}`,
        outcome: 'verified',
      });
    }
    requests.push({ cli, step, tool: call?.name });
  } catch (error) {
    if (error instanceof Error && error.message === 'TITLE_ONLY') reply = 'Local browser check';
    else {
      reply = `FIXTURE_ERROR: ${error instanceof Error ? error.message : String(error)}`;
      fixtureErrors.push(reply);
    }
  }
  const message = {
    id: `fixture-${requests.length}`,
    type: 'message',
    role: 'assistant',
    model: data.model || 'fixture',
    stop_reason: call ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    content: [
      call
        ? { type: 'tool_use', id: `interop-${cli}-${step}`, ...call }
        : { type: 'text', text: reply },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  if (!data.stream) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (type: string, value: unknown) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(value as object) })}\n\n`);
  event('message_start', {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  event('content_block_start', {
    index: 0,
    content_block: call
      ? { type: 'tool_use', id: `interop-${cli}-${step}`, name: call.name, input: {} }
      : { type: 'text', text: '' },
  });
  event('content_block_delta', {
    index: 0,
    delta: call
      ? { type: 'input_json_delta', partial_json: JSON.stringify(call.input) }
      : { type: 'text_delta', text: reply },
  });
  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  event('message_stop', {});
  response.end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
await writeFile(
  path.join(piDirectory, 'models.json'),
  JSON.stringify({
    providers: {
      'athena-fixture': {
        baseUrl: origin,
        api: 'anthropic-messages',
        apiKey: 'fixture-only',
        models: [
          {
            id: 'fixture-model',
            name: 'Local fixture',
            reasoning: false,
            input: ['text', 'image'],
            contextWindow: 200000,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
);
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: {
      workspace,
      agent: 'claude',
      modelSelections: {
        claude: { model: 'sonnet', effort: 'low' },
        pi: { model: 'athena-fixture/fixture-model' },
        opencode: { model: 'athena-fixture/fixture-model' },
      },
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
        id: 'claude-run',
        agent: 'claude',
        title: 'Claude native',
        workspace,
        updatedAt: 2,
        messages: [
          {
            id: 'link',
            role: 'assistant',
            text: `[Open fixture](${origin}/linked)`,
            status: 'done',
            createdAt: 2,
          },
        ],
      },
      { id: 'pi-run', agent: 'pi', title: 'Pi native', workspace, updatedAt: 1, messages: [] },
      {
        id: 'opencode-run',
        agent: 'opencode',
        title: 'OpenCode native',
        workspace,
        updatedAt: 0,
        messages: [],
      },
    ],
  }),
);
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
Object.assign(env, {
  WORKBENCH_USER_DATA_DIR: profile,
  ANTHROPIC_BASE_URL: origin,
  ANTHROPIC_API_KEY: 'fixture-only',
  ANTHROPIC_AUTH_TOKEN: 'fixture-only',
  PI_CODING_AGENT_DIR: piDirectory,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  XDG_CONFIG_HOME: path.join(directory, 'opencode-config'),
  XDG_DATA_HOME: path.join(directory, 'opencode-data'),
  XDG_CACHE_HOME: path.join(directory, 'opencode-cache'),
  OPENCODE_CONFIG_DIR: path.join(directory, 'opencode-config', 'opencode'),
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    enabled_providers: ['athena-fixture'],
    model: 'athena-fixture/fixture-model',
    small_model: 'athena-fixture/fixture-model',
    autoupdate: false,
    provider: {
      'athena-fixture': {
        npm: '@ai-sdk/anthropic',
        name: 'Local fixture',
        options: { baseURL: `${origin}/v1`, apiKey: 'fixture-only' },
        models: {
          'fixture-model': { name: 'Fixture model', limit: { context: 200000, output: 4096 } },
        },
      },
    },
  }),
});
for (const key of [
  'WORKBENCH_DEV_SERVER_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
])
  delete env[key];
let app: ElectronApplication | undefined;
let page!: Page;
const checks: string[] = [],
  errors: string[] = [];
const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
const query = (selector: string) =>
  page.evaluate(
    (selector) => window.workbench.invoke<ElementQueryResult>('browser:query', { selector }),
    selector,
  );
const timer = setTimeout(() => void app?.close(), 210000);
try {
  app = await electron.launch({
    args: [path.join(root, 'tests/electron-background.cjs')],
    cwd: root,
    env,
  });
  page = await app.firstWindow();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
    ),
    false,
  );
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate('window.__name = fn => fn');
  await app.evaluate(({ shell }) => {
    (globalThis as any).__externalLinks = [];
    shell.openExternal = async (url) => {
      (globalThis as any).__externalLinks.push(url);
      throw new Error('External browser is not part of this local test');
    };
  });
  await page.getByRole('link', { name: 'Open fixture', exact: true }).click();
  await expect(page.locator('.browser-drawer')).toHaveClass(/is-open/);
  await expect
    .poll(async () => (await snapshot()).browser.url, { timeout: 30000 })
    .toBe(`${origin}/linked`);
  assert.ok((await snapshot()).browser.tabs.length >= 2);
  assert.equal(await app.evaluate(() => (globalThis as any).__externalLinks.length), 0);
  checks.push(
    'A conversation link starts real Neo, opens a visible new tab and preserves the previous tab without opening the system browser',
  );
  for (const cli of ['claude', 'pi', 'opencode']) {
    const info = (await snapshot()).agents.find((agent) => agent.id === cli);
    assert.ok(info?.available && info.supported, JSON.stringify(info));
    if (cli !== 'claude') {
      await page.evaluate(() => window.workbench.invoke('browser:reload'));
      await expect.poll(async () => (await query('section')).elements.length).toBe(0);
      await page
        .locator(`.conversation-row[data-conversation="${cli}-run"] .conversation-link`)
        .click();
    }
    await expect
      .poll(
        async () => {
          const connection = (await snapshot()).codexConnection;
          return connection?.conversationId === `${cli}-run` ? connection.status : 'idle';
        },
        { timeout: 30000 },
      )
      .toBe('ready');
    await page
      .getByRole('textbox', { name: '发送给 Agent 的任务' })
      .fill(
        'Create a section in the current visible page, restyle it, fill its search field and verify the page result.',
      );
    await page.locator('.composer [data-slot="prompt-input-send"]').click();
    await expect
      .poll(
        async () =>
          (await snapshot()).conversations.find((c) => c.id === `${cli}-run`)?.messages.at(-1)
            ?.status,
        { timeout: 90000 },
      )
      .toMatch(/^(done|error)$/);
    const state = await snapshot();
    const message = state.conversations.find((c) => c.id === `${cli}-run`)!.messages.at(-1)!;
    assert.equal(message.status, 'done', message.failure || message.text);
    assert.ok(message.text.includes(`${cli.toUpperCase()}_BROWSER_DONE`), message.text);
    assert.equal((await query(`#search-${cli}`)).elements[0].value, `typed-${cli}`);
    assert.equal((await query('#retained')).elements[0].name, 'Original content stays');
    assert.ok(
      message.execution?.some(
        (event) => event.kind === 'checkpoint' && event.outcome === 'verified',
      ),
    );
    assert.equal(message.tools?.filter((tool) => tool.status === 'running').length, 0);
    const previews = state.browser.previewEdits!;
    assert.equal(previews.length, 2);
    assert.ok(previews[0].changes.insert);
    assert.equal(previews[0].nodeId, state.browser.selectedElement?.nodeId);
    const element = await page.evaluate(
      (ref) => window.workbench.invoke<any>('browser:element-details', { ref }),
      state.browser.selectedElement!.ref,
    );
    assert.equal(element.computed['border-radius'], '16px');
    await page.screenshot({ path: path.join(output, `${cli}-native.png`), animations: 'disabled' });
    await page.evaluate(
      (editId) => window.workbench.invoke('browser:undo', { editId }),
      previews[1].editId,
    );
    const protectedUndo = await page.evaluate(
      (editId) =>
        window.workbench.invoke('browser:undo', { editId }).then(
          () => 'removed',
          (error: Error) => error.message,
        ),
      previews[0].editId,
    );
    assert.match(protectedUndo, /newer changes/);
    assert.equal((await query(`#search-${cli}`)).elements[0].value, `typed-${cli}`);
    checks.push(
      `${cli}: real CLI -> host tools -> visible Neo -> nested element creation, restyling, native fill, page checkpoint, conversation result and protected undo`,
    );
    const sessionId = state.conversations.find((c) => c.id === `${cli}-run`)!.agentSessionId;
    assert.ok(sessionId);
    await page
      .getByRole('textbox', { name: '发送给 Agent 的任务' })
      .fill('Continue this same conversation and report the verified result.');
    await expect(page.locator('.composer [data-slot="prompt-input-send"]')).toBeEnabled();
    await page.locator('.composer [data-slot="prompt-input-send"]').click();
    await expect
      .poll(
        async () => {
          const conversation = (await snapshot()).conversations.find((c) => c.id === `${cli}-run`)!;
          return (
            conversation.messages.at(-1)?.id !== message.id &&
            conversation.messages.at(-1)?.status === 'done'
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);
    assert.equal(
      (await snapshot()).conversations.find((c) => c.id === `${cli}-run`)!.agentSessionId,
      sessionId,
    );
    checks.push(`${cli}: a second UI turn completes with the same native session ID`);
  }
  const oldTab = (await snapshot()).browser.activeTabId;
  await page.getByRole('link', { name: 'Open next page', exact: true }).last().click();
  await expect.poll(async () => (await snapshot()).browser.url).toBe(`${origin}/next`);
  assert.notEqual((await snapshot()).browser.activeTabId, oldTab);
  assert.equal(await app.evaluate(() => (globalThis as any).__externalLinks.length), 0);
  checks.push(
    'A link returned through the native Agent response opens in a new right-side Neo tab',
  );
  assert.deepEqual(fixtureErrors, []);
  assert.deepEqual(errors, []);
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible() || window.isFocused()),
    ),
    false,
  );
  checks.push('Electron windows remain hidden and unfocused throughout the background check');
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        passed: true,
        realRemoteModelCalls: 0,
        model: 'local deterministic Anthropic protocol fixture',
        nativeCLIs: ['claude', 'pi', 'opencode'],
        checks,
        requests,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks, output }));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(JSON.stringify({ checks, fixtureErrors, requests, errors }));
  throw error;
} finally {
  clearTimeout(timer);
  await app?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
