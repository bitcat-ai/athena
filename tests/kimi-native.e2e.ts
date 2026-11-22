/** Installed Kimi ACP talks only to a loopback scripted model with disposable credentials. */
import assert from 'node:assert/strict';
import { BrowserRuntime } from '../src/main/browser';
import { testImage } from './image-fixture';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import { _electron as electron, expect } from '@playwright/test';
import type { AppSnapshot } from '../src/shared/types';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentSession } from '../src/main/agent-factory';
import type { AgentEvent } from '../src/shared/types';

const bin = execFileSync('which', ['kimi'], { encoding: 'utf8' }).trim();
const directory = await mkdtemp(path.join(tmpdir(), 'athena-kimi-fixture-'));
const original = path.join(directory, 'source'),
  workspace = path.join(directory, 'project');
await Promise.all([mkdir(original), mkdir(workspace)]);
const answers: string[] = [];
const toolsSeen = new Set<string>();
let round = 0,
  testingStop = false,
  imageReceived = false,
  skillActivated = false;
let seenStop!: () => void;
const stopping = new Promise<void>((r) => {
  seenStop = r;
});
const server = createServer(async (req, res) => {
  if (req.url === '/page') {
    res
      .writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
      .end('<h1>VERIFIED_HOST_RESPONSE</h1>');
    return;
  }
  if (!req.url?.includes('chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  assert.equal(req.headers.authorization, 'Bearer test-only');
  if (testingStop) {
    seenStop();
    return;
  }
  skillActivated ||= JSON.stringify(payload.messages).includes('KIMI_SKILL_EXECUTION_MARKER');
  imageReceived ||= payload.messages.some(
    (m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'image_url'),
  );
  const tools = payload.tools?.map((t: any) => t.function?.name) || [];
  for (const tool of tools) toolsSeen.add(tool);
  assert(
    !tools.includes('Write') && !tools.includes('Edit'),
    'native writes must not bypass the host in a Git tree',
  );
  let delta: any, finish: string;
  if (round === 0) {
    assert(tools.includes('mcp__athena__workbench_browser_query'), JSON.stringify(tools));
    delta = {
      tool_calls: [
        {
          index: 0,
          id: 'call-browser',
          type: 'function',
          function: {
            name: 'mcp__athena__workbench_browser_query',
            arguments: '{"selector":"h1"}',
          },
        },
      ],
    };
    finish = 'tool_calls';
  } else if (round === 1) {
    const tool = payload.messages.find((m: any) => m.role === 'tool');
    answers.push(JSON.stringify(tool?.content));
    delta = {
      tool_calls: [
        {
          index: 0,
          id: 'call-write',
          type: 'function',
          function: {
            name: 'Write',
            arguments: JSON.stringify({
              path: path.join(workspace, 'receipt.txt'),
              content: 'isolated test',
            }),
          },
        },
      ],
    };
    finish = 'tool_calls';
  } else if (round === 2) {
    delta = {
      tool_calls: [
        {
          index: 0,
          id: 'call-command',
          type: 'function',
          function: {
            name: 'Bash',
            arguments: JSON.stringify({ command: 'printf denied > receipt.txt' }),
          },
        },
      ],
    };
    finish = 'tool_calls';
  } else if (round === 3) {
    delta = {
      tool_calls: [
        {
          index: 0,
          id: 'call-question',
          type: 'function',
          function: {
            name: 'AskUserQuestion',
            arguments: JSON.stringify({
              questions: [
                { question: 'Which sample?', options: [{ label: 'alpha' }, { label: 'beta' }] },
              ],
            }),
          },
        },
      ],
    };
    finish = 'tool_calls';
  } else {
    delta = { content: 'KIMI_FIXTURE_DONE' };
    finish = 'stop';
  }
  round++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta: any, finish_reason: string | null) =>
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        '\n\n',
    );
  chunk({ role: 'assistant', ...delta }, null);
  chunk({}, finish);
  res.end('data: [DONE]\n\n');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
const browser = new BrowserRuntime({
  storageDir: path.join(directory, 'chrome'),
  onState() {},
  onFrame() {},
  onStep() {},
  onSelected() {},
  onHumanTakeover() {},
});
await browser.start(url.replace('/v1', '/page'));
execFileSync('git', ['init', '-q', workspace]);
const previous = process.env.KIMI_CODE_HOME;
process.env.KIMI_CODE_HOME = original;
for (const k of Object.keys(process.env)) if (k.startsWith('KIMI_MODEL_')) delete process.env[k];
process.env.KIMI_DISABLE_TELEMETRY = '1';
await writeFile(
  path.join(original, 'config.toml'),
  `default_model = "fixture"
[providers.test]
type = "openai"
base_url = "${url}"
api_key = "test-only"
[models.fixture]
provider = "test"
model = "fixture"
max_context_size = 64000
capabilities = ["image_in"]
`,
);
const bad = JSON.stringify({
  mcpServers: {
    unauthorized: {
      command: process.execPath,
      args: [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(path.join(directory, 'UNAUTHORIZED'))},'launched')`,
      ],
    },
  },
});
await writeFile(path.join(original, 'mcp.json'), bad);
await writeFile(path.join(workspace, '.mcp.json'), bad);
await mkdir(path.join(original, 'skills', 'trial'), { recursive: true });
await writeFile(
  path.join(original, 'skills', 'trial', 'SKILL.md'),
  '---\nname: trial\ndescription: A local trial.\n---\nKIMI_SKILL_EXECUTION_MARKER.\n',
);
const events: AgentEvent[] = [];
let hosts = 0;
let session = make();
function make(sessionId?: string) {
  return createAgentSession('kimi', {
    sessionId,
    workspace,
    executablePath: bin,
    sessionDirectory: path.join(directory, 'state'),
    tools: browser.getTools().filter((t) => t.name === 'workbench_browser_query'),
    callTool: async (name, args) => {
      assert.equal(name, 'workbench_browser_query');
      assert.equal(args.selector, 'h1');
      hosts++;
      return browser.callTool(name, args);
    },
    onEvent(e) {
      events.push(e);
      if (e.type === 'user-input') session.resolveUserInput(e.request.id, { choice: ['beta'] });
      if (e.type === 'approval') {
        console.log('Kimi approval', e.request.title);
        session.resolveApproval(e.request.id, !e.request.title.includes('Bash'));
      }
    },
  });
}
try {
  assert((await session.listModels()).some((m) => m.model === 'fixture'));
  await session.prepare();
  const skills = await session.discoverProviderSkills();
  assert(
    skills.skills.some((s) => s.name === 'skill:trial'),
    JSON.stringify({ status: skills.status, names: skills.skills.map((s) => s.name) }),
  );
  await session.send(
    'Use the page check, then write a receipt.',
    undefined,
    undefined,
    { model: 'fixture' },
    [],
    [testImage],
  );
  if (!hosts)
    console.error(
      JSON.stringify({
        round,
        answers,
        events: events.filter(
          (e) => e.type === 'error' || e.type === 'complete' || e.type === 'tool',
        ),
      }).slice(0, 1900),
    );
  assert(imageReceived, 'configured image must reach the native model request');
  assert.equal(hosts, 1);
  assert.match(answers.join(''), /VERIFIED_HOST_RESPONSE/);
  assert(events.some((e) => e.type === 'approval' && e.request.title.includes('Bash')));
  await assert.rejects(access(path.join(workspace, 'receipt.txt')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(directory, 'UNAUTHORIZED')), { code: 'ENOENT' });
  assert(
    (await readFile(path.join(directory, 'state/kimi/config.toml'), 'utf8')).includes(
      'api_key_env',
    ),
  );
  assert(
    !(await readFile(path.join(directory, 'state/kimi/config.toml'), 'utf8')).includes('test-only'),
  );
  const id = session.sessionId;
  assert(id);
  session.close();
  session = make(id);
  await session.prepare();
  await session.send(
    'Continue with one word.',
    undefined,
    undefined,
    undefined,
    skills.skills.filter((s) => s.name === 'skill:trial'),
  );
  assert.equal(session.sessionId, id);
  assert(skillActivated, 'native skill instructions reached the model');
  assert(events.some((e) => e.type === 'user-input'));
  assert(events.some((e) => e.type === 'complete' && e.text?.includes('KIMI_FIXTURE_DONE')));
  testingStop = true;
  const running = session.send('Stop the turn.');
  await stopping;
  await session.interrupt();
  await assert.rejects(running, /停止/);
  if (process.argv.includes('--electron')) {
    testingStop = false;
    const profile = path.join(directory, 'electron');
    await seedLegacyWorkspace(profile);
    const env = { ...process.env, WORKBENCH_USER_DATA_DIR: profile };
    delete (env as NodeJS.ProcessEnv).WORKBENCH_DEV_SERVER_URL;
    const app = await electron.launch({
      args: [path.resolve('tests/electron-background.cjs')],
      cwd: process.cwd(),
      env,
    });
    try {
      const page = await app.firstWindow();
      await page.getByRole('button', { name: '选择 Agent', exact: true }).click({ timeout: 30000 });
      await page.locator('.agent-menu [role^=menuitem]').filter({hasText:'Kimi Code CLI'}).click();
      await expect(page.locator('#composer-agent-name')).toHaveText('Kimi Code CLI');
      const snapshot = () =>
        page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
      await expect
        .poll(
          async () =>
            (await snapshot()).providerSkills?.some((skill) => skill.name === 'skill:trial'),
          { timeout: 15000 },
        )
        .toBe(true);
      await page
        .getByRole('textbox', { name: '发送给 Agent 的任务', exact: true })
        .fill('Kimi Electron integration check');
      await page.getByRole('button', { name: '发送任务', exact: true }).click();
      await expect
        .poll(
          async () =>
            (await snapshot()).conversations.some(
              (c) =>
                c.agent === 'kimi' &&
                c.agentSessionId?.startsWith('session_') &&
                c.messages.some(
                  (m) =>
                    m.role === 'assistant' &&
                    m.status === 'done' &&
                    m.text.includes('KIMI_FIXTURE_DONE'),
                ),
            ),
          { timeout: 30000 },
        )
        .toBe(true);
      console.log('Electron Agent picker, skills, Kimi session and final message verified');
    } finally {
      await app.close();
    }
  }
  console.log(
    JSON.stringify({
      browser: 'real Chrome',
      imageReceived,
      stopped: true,
      check: 'Kimi ACP native integration',
      modelTurns: 0,
      scriptedResponses: round,
      hostCalls: hosts,
      skill: true,
      resume: true,
      nativeWriteUnavailable: true,
      shellWriteDenied: true,
    }),
  );
} finally {
  session.close();
  await browser.dispose();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  if (previous) process.env.KIMI_CODE_HOME = previous;
  else delete process.env.KIMI_CODE_HOME;
  if (process.env.ATHENA_KEEP_KIMI_FIXTURE) console.log(directory);
  else await rm(directory, { recursive: true, force: true });
}
