import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  conversationAgent,
  agentModelSelection,
  conversationModelSelection,
  supportsBrowser,
} from '../src/shared/agents';
import {
  discoverExecutables,
  detectAgents,
  piIsolationArguments,
} from '../src/main/agent-discovery';
import { OnboardingRuntime } from '../src/main/onboarding';
import type { AgentInfo, Conversation, Settings } from '../src/shared/types';

test('default changes never rebind existing or legacy conversations or leak models across CLIs', () => {
  const settings: Settings = {
    agent: 'pi',
    workspace: '/project',
    modelSelection: { model: 'codex-only' },
    modelSelections: { pi: { model: 'local/pi-model' } },
  };
  const legacy: Conversation = { id: 'old', title: 'old', messages: [], updatedAt: 1 };
  const pi: Conversation = { ...legacy, id: 'pi', agent: 'pi', agentSessionId: 'pi-native-id' };
  assert.equal(conversationAgent(legacy), 'codex');
  assert.equal(conversationAgent(pi), 'pi');
  assert.equal(conversationModelSelection(settings, legacy)?.model, 'codex-only');
  assert.equal(conversationModelSelection(settings, pi)?.model, 'local/pi-model');
  assert.equal(agentModelSelection(settings, 'cursor'), undefined);
  settings.agent = 'claude';
  assert.equal(conversationAgent(pi), 'pi');
  assert.equal(pi.agentSessionId, 'pi-native-id');
  assert.equal(conversationAgent(legacy), 'codex');
  assert.equal(supportsBrowser('pi'), true);
  assert.equal(supportsBrowser('claude'), true);
  assert.equal(supportsBrowser('cursor'), false);
  assert.equal(supportsBrowser('codex'), true);
  assert.equal(supportsBrowser('opencode'), true);
});

async function executable(file: string, body: string) {
  await writeFile(file, '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
}

test('discovery deduplicates real installations and finds a healthy CLI after a broken shim', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'athena-cli-find-'));
  try {
    const first = path.join(root, 'first'),
      second = path.join(root, 'second');
    await mkdir(first);
    await mkdir(second);
    await executable(path.join(first, 'claude'), 'exit 1');
    await executable(
      path.join(second, 'claude'),
      'if [ "$1" = "--version" ]; then echo "Claude fixture"; else echo "--safe-mode --restricted --mcp-config --permission-prompts --tools"; fi',
    );
    await executable(
      path.join(first, 'cursor-agent'),
      'if [ "$1" = "--version" ]; then echo "Cursor fixture"; else echo "Start the Cursor Agent --mode --output-format --trust"; fi',
    );
    await symlink(path.join(first, 'cursor-agent'), path.join(first, 'agent'));
    assert.equal((await discoverExecutables(['cursor-agent', 'agent'], [first])).length, 1);
    const agents = await detectAgents(undefined, [first, second]);
    const claude = agents.find((a) => a.id === 'claude');
    assert.equal(claude?.path, path.join(second, 'claude'));
    assert.equal(claude?.available, true);
    assert.equal(agents.find((a) => a.id === 'gemini')?.available, false);
    assert.equal(agents.find((a) => a.id === 'cursor')?.path, path.join(first, 'cursor-agent'));
    assert.ok(agents.some((a) => a.id === 'pi'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Cursor editor and unrelated agent binaries are not execution adapters', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'athena-cli-editor-'));
  try {
    await executable(path.join(root, 'cursor'), 'echo editor');
    await executable(path.join(root, 'agent'), 'echo unrelated');
    const agents = await detectAgents(undefined, [root]);
    assert.equal(agents.find((a) => a.id === 'cursor')?.available, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('old native CLI without required safe-mode flags remains unselectable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'athena-cli-old-'));
  try {
    await executable(path.join(root, 'gemini'), 'echo "Gemini old version"');
    const agent = (await detectAgents(undefined, [root])).find((a) => a.id === 'gemini');
    assert.equal(agent?.available, true);
    assert.equal(agent?.supported, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi 1.x built-in extension isolation is accepted without the removed no-mcp flag', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'athena-pi-current-'));
  try {
    await executable(
      path.join(root, 'pi'),
      'if [ "$1" = "--version" ]; then echo "1.0.2"; else echo "--mode <mode> text, json, rpc"; echo "--no-extensions Disable extension discovery and built-in extensions"; echo "--no-skills --no-prompt-templates"; fi',
    );
    const pi = (await detectAgents(undefined, [root])).find((agent) => agent.id === 'pi');
    assert.equal(pi?.available, true);
    assert.equal(pi?.supported, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi startup requires a documented way to disable MCP in both supported layouts', () => {
  const common = '--no-skills --no-prompt-templates';
  assert.ok(piIsolationArguments(`--no-extensions --no-mcp ${common}`)?.includes('--no-mcp'));
  assert.equal(piIsolationArguments(`--no-extensions ${common}`), undefined);
  assert.equal(
    piIsolationArguments(`--no-extensions Does not disable built-in extensions ${common}`),
    undefined,
  );
  assert.equal(
    piIsolationArguments('--no-extensions Disable extension discovery and built-in extensions'),
    undefined,
  );
});

test('Pi setup is not blocked by absent Codex; changing the default does not make Codex ready', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'athena-cli-onboarding-'));
  const settings: Settings = { agent: 'pi', workspace: directory };
  const agents: AgentInfo[] = [
    { id: 'codex', name: 'Codex', supported: true, available: false },
    {
      id: 'pi',
      name: 'Pi',
      supported: true,
      available: true,
      path: '/fixture/pi',
    },
  ];
  const runtime = new OnboardingRuntime({
    directory,
    settings: () => settings,
    existingData: true,
    initialAgents: agents,
    isBusy: () => false,
    probeAgents: async () => agents,
    onAgents() {},
    pickWorkspace: async () => undefined,
    commitWorkspace: async () => {},
    saveProgress: async () => {},
    discoverBrowser: async () => undefined,
    browserReady: () => false,
    prepareBrowser: async () => {},
    openExternal: async () => {},
    onState() {},
    download: async () => {
      throw new Error('Unexpected download');
    },
  });
  try {
    await runtime.initialize();
    assert.equal(runtime.getState().coreReady, true);
    assert.equal(runtime.getState().executor?.id, 'pi');
    assert.equal(runtime.getState().codex.status, 'missing');
    settings.agent = 'codex';
    await runtime.refresh();
    await runtime.settled();
    assert.equal(runtime.getState().coreReady, false);
    assert.equal(runtime.getState().selectedAgent, 'codex');
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('OpenCode requires the verified 1.x ACP and plugin isolation flags', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'athena-opencode-find-'));
  try {
    for (const [version, help, supported] of [
      ['1.18.15', 'opencode acp --pure', true],
      ['2.0.0', 'opencode acp --pure', false],
      ['1.3.0', 'opencode acp', false],
    ] as const) {
      await executable(
        path.join(root, 'opencode'),
        `if [ "$1" = "--version" ]; then echo "${version}"; else echo "${help}" >&2; fi`,
      );
      const found = (await detectAgents(undefined, [root])).find(
        (agent) => agent.id === 'opencode',
      );
      assert.equal(found?.available, true);
      assert.equal(found?.supported, supported);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
