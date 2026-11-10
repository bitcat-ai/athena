import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nodeShebang } from './node-script';
import { OnboardingRuntime, managedCodexPath } from '../src/main/onboarding';
import { Store } from '../src/main/store';
import { detectAgents } from '../src/main/agents';
import type { AgentInfo, Settings } from '../src/shared/types';
import type { OnboardingProgress, OnboardingState } from '../src/shared/onboarding';

const exec = promisify(execFile);
const present = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );
const missing = (): AgentInfo[] => [
  { id: 'codex', name: 'Codex', supported: true, available: false },
];
const ready = (executable = '/fixture/codex'): AgentInfo[] => [
  {
    id: 'codex',
    name: 'Codex',
    supported: true,
    available: true,
    path: executable,
    version: 'codex-cli 0.166.0',
  },
];
async function until(check: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 300; index++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Fixture condition timed out');
}
async function fixture(
  options: {
    existingData?: boolean;
    progress?: OnboardingProgress;
    initialAgents?: AgentInfo[];
  } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-onboarding-test-'));
  const old = path.join(directory, 'existing-project');
  await mkdir(old);
  const settings: Settings = { agent: 'codex', workspace: old };
  const data = {
    agents: options.initialAgents ?? ready(),
    candidate: undefined as string | undefined,
    progress: options.progress,
    saved: [] as Array<OnboardingProgress | undefined>,
    commits: [] as string[],
    events: [] as OnboardingState[],
    external: [] as string[],
    browserPath: undefined as string | undefined,
    browserReady: false,
    browserCalls: 0,
    busy: false,
    downloadCalls: [] as string[],
    probe: undefined as (() => Promise<AgentInfo[]>) | undefined,
    download: undefined as ((url: string, options?: RequestInit) => Promise<Response>) | undefined,
    prepare: undefined as ((signal: AbortSignal) => Promise<void>) | undefined,
  };
  const runtime = new OnboardingRuntime({
    directory,
    existingData: options.existingData ?? false,
    progress: options.progress,
    initialAgents: data.agents,
    settings: () => settings,
    isBusy: () => data.busy,
    probeAgents: () => (data.probe ? data.probe() : Promise.resolve(data.agents)),
    onAgents: (agents) => {
      data.agents = agents;
    },
    pickWorkspace: async () => data.candidate,
    commitWorkspace: async (value, mode) => {
      data.commits.push(value);
      settings.workspace = value;
      settings.workspaceMode = mode;
    },
    saveProgress: async (value) => {
      data.progress = value;
      data.saved.push(value);
    },
    discoverBrowser: async () => data.browserPath,
    browserReady: () => data.browserReady,
    prepareBrowser: async (_binary, signal) => {
      data.browserCalls++;
      if (data.prepare) await data.prepare(signal);
      else data.browserReady = true;
    },
    openExternal: async (url) => {
      data.external.push(url);
    },
    onState: (state) => {
      data.events.push(state);
    },
    download: async (url, options) => {
      data.downloadCalls.push(url);
      if (!data.download) throw new Error('Unexpected network request');
      return data.download(url, options);
    },
    platform: 'darwin',
    arch: 'arm64',
  });
  return {
    directory,
    settings,
    data,
    runtime,
    close: async () => {
      await runtime.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
async function confirmProject(f: Awaited<ReturnType<typeof fixture>>) {
  const project = path.join(f.directory, 'chosen-project');
  await mkdir(project);
  f.data.candidate = project;
  f.runtime.pickWorkspace();
  await f.runtime.settled();
  f.runtime.confirmWorkspace(f.runtime.getState().workspace.candidate!.id);
  await f.runtime.settled();
  return project;
}
async function archive(f: Awaited<ReturnType<typeof fixture>>) {
  const root = path.join(f.directory, 'package-fixture');
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await mkdir(path.join(root, 'codex-path'));
  const executed = path.join(f.directory, 'version-executed');
  await writeFile(
    path.join(root, 'bin/codex'),
    `${nodeShebang()}\nrequire('node:fs').writeFileSync(${JSON.stringify(executed)},'yes');console.log('codex-cli 0.166.0');\n`,
  );
  await writeFile(path.join(root, 'bin/codex-code-mode-host'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(root, 'codex-path/rg'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(root, 'codex-package.json'), '{}');
  const file = path.join(f.directory, 'package.tar.gz');
  await exec('/usr/bin/tar', ['-czf', file, '-C', root, '.']);
  const bytes = await readFile(file);
  const metadata = {
    tag_name: 'rust-v0.166.0',
    assets: [
      {
        name: 'codex-package-aarch64-apple-darwin.tar.gz',
        digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      },
    ],
  };
  return { bytes, metadata, executed };
}

test('fresh profiles persist a welcome marker without creating a project or conversation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-onboarding-store-'));
  try {
    const store = new Store(directory);
    await store.load();
    assert.equal(store.existingData, false);
    assert.equal(store.data.onboarding?.stage, 'welcome');
    assert.equal(store.data.onboarding?.required, true);
    assert.equal(store.data.conversations.length, 0);
    assert.equal(await present(store.data.settings.workspace), false);
    await store.save();
    const restored = new Store(directory);
    await restored.load();
    assert.equal(restored.existingData, true);
    assert.equal(restored.data.onboarding?.required, true);
    assert.equal(await present(restored.data.settings.workspace), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy missing projects remain recoverable and reopening then deferring does not block tasks', async () => {
  const f = await fixture({ existingData: true });
  try {
    const moved = path.join(f.directory, 'moved-project');
    await writeFile(
      path.join(f.directory, 'workspace.json'),
      JSON.stringify({
        settings: { agent: 'codex', workspace: moved },
        conversations: [],
        recordings: [],
      }),
    );
    const store = new Store(f.directory);
    await store.load();
    assert.equal(store.existingData, true);
    assert.equal(store.data.onboarding, undefined);
    assert.equal(await present(moved), false);
    assert.equal(f.runtime.getState().status, 'legacy');
    await f.runtime.open();
    assert.equal(f.runtime.blocksTasks, false);
    await f.runtime.defer();
    assert.equal(f.runtime.getState().status, 'legacy');
    assert.equal(f.runtime.blocksTasks, false);
    assert.deepEqual(f.data.saved, []);
  } finally {
    await f.close();
  }
});

test('candidate IDs and access checks precede committing a selected directory', async () => {
  const f = await fixture();
  try {
    const old = f.settings.workspace;
    f.data.candidate = path.join(f.directory, 'removed-before-confirm');
    await mkdir(f.data.candidate);
    f.runtime.pickWorkspace();
    await f.runtime.settled();
    const candidate = f.runtime.getState().workspace.candidate!;
    assert.equal(f.settings.workspace, old);
    assert.throws(() => f.runtime.confirmWorkspace('stale-candidate'), /失效/);
    await rm(candidate.path, { recursive: true });
    f.runtime.confirmWorkspace(candidate.id);
    await f.runtime.settled();
    assert.equal(f.settings.workspace, old);
    assert.deepEqual(f.data.commits, []);
    assert(f.runtime.getState().workspace.error);
    const chosen = await confirmProject(f);
    assert.equal(f.settings.workspace, chosen);
    assert.equal(f.runtime.getState().workspace.status, 'ready');
    assert.equal(f.runtime.blocksTasks, false);
    assert.equal(f.data.progress?.workspaceConfirmed, chosen);
  } finally {
    await f.close();
  }
});

test('project-free setup uses a private workspace, persists the choice and can later select a project', async () => {
  const f = await fixture();
  try {
    const previous = f.settings.workspace;
    const marker = path.join(previous, 'keep.txt');
    await writeFile(marker, 'existing work');
    f.runtime.skipWorkspace();
    await f.runtime.settled();
    const state = f.runtime.getState();
    assert.equal(state.workspace.path, path.join(f.directory, 'workspace'));
    assert.equal(state.workspace.mode, 'personal');
    assert.equal(state.workspace.status, 'ready');
    assert.equal(f.settings.workspaceMode, 'personal');
    assert.equal(f.runtime.blocksTasks, false);
    assert.equal(await readFile(marker, 'utf8'), 'existing work');
    await f.runtime.complete();
    await f.runtime.settled();
    assert.equal(f.runtime.getState().status, 'complete');
    const store = new Store(f.directory);
    store.data.settings = { ...f.settings };
    store.data.onboarding = f.data.progress;
    await store.save();
    const restored = new Store(f.directory);
    await restored.load();
    assert.equal(restored.data.settings.workspaceMode, 'personal');
    assert.equal(restored.data.onboarding?.workspaceConfirmed, state.workspace.path);
    await f.runtime.open();
    const project = await confirmProject(f);
    assert.equal(f.settings.workspace, project);
    assert.equal(f.settings.workspaceMode, 'project');
    assert.equal(f.runtime.getState().workspace.mode, 'project');
  } finally {
    await f.close();
  }
});

test('skipping a project never bypasses agent readiness or an active task', async () => {
  const f = await fixture({ initialAgents: missing() });
  try {
    f.data.busy = true;
    assert.throws(() => f.runtime.skipWorkspace(), /结束当前任务/);
    assert.equal(await present(path.join(f.directory, 'workspace')), false);
    f.data.busy = false;
    f.runtime.skipWorkspace();
    await f.runtime.settled();
    assert.equal(f.runtime.getState().workspace.mode, 'personal');
    assert.equal(f.runtime.blocksTasks, true);
    await f.runtime.complete();
    await f.runtime.settled();
    assert.notEqual(f.runtime.getState().status, 'complete');
    assert.equal(f.runtime.getState().coreReady, false);
  } finally {
    await f.close();
  }
});

test('fresh defer keeps the task gate; core completion can defer optional browser and resumes truthfully', async () => {
  const f = await fixture();
  try {
    await f.runtime.defer();
    assert.equal(f.runtime.blocksTasks, true);
    await f.runtime.open();
    await confirmProject(f);
    await f.runtime.complete();
    await f.runtime.settled();
    const state = f.runtime.getState();
    assert.equal(state.status, 'complete');
    assert.equal(state.coreReady, true);
    assert.equal(state.browser.status, 'deferred');
    assert.equal(state.requiresSetup, false);
    assert.equal(f.data.progress?.browserDeferred, true);
    assert.equal(f.runtime.allowsBrowserStartup, false);
    const restored = await fixture({ existingData: true, progress: f.data.progress });
    try {
      assert.equal(restored.runtime.getState().status, 'complete');
      assert.equal(
        restored.runtime.getState().coreReady,
        false,
        'Ready is not rehydrated from a durable claim',
      );
      assert.equal(restored.runtime.blocksTasks, false);
    } finally {
      await restored.close();
    }
  } finally {
    await f.close();
  }
});

test('completion rechecks a browser that disconnected after preparation', async () => {
  const f = await fixture();
  try {
    await confirmProject(f);
    f.data.browserPath = '/fixture/BrowserOS neo.app';
    f.runtime.prepareBrowser();
    await f.runtime.settled();
    assert.equal(f.runtime.getState().browser.status, 'ready');
    f.data.browserReady = false;
    await f.runtime.complete();
    await f.runtime.settled();
    assert.equal(f.runtime.getState().status, 'complete');
    assert.equal(f.runtime.getState().browser.status, 'deferred');
    assert.equal(f.runtime.getState().coreReady, true);
    assert.equal(f.data.progress?.browserDeferred, true);
  } finally {
    await f.close();
  }
});

test('existing usable Codex is reused without downloading or replacing it', async () => {
  const f = await fixture({ initialAgents: ready('/existing/user/codex') });
  try {
    f.runtime.planInstall('codex');
    await f.runtime.settled();
    assert.equal(f.runtime.getState().plan, undefined);
    assert.equal(f.runtime.getState().codex.path, '/existing/user/codex');
    assert.deepEqual(f.data.downloadCalls, []);
    assert.equal(await present(path.join(f.directory, 'runtime')), false);
  } finally {
    await f.close();
  }
});

test('private installation verifies the full package, deduplicates confirmation and preserves all global locations', async () => {
  const f = await fixture({ initialAgents: missing() });
  try {
    const data = await archive(f),
      binary = managedCodexPath(f.directory, 'arm64');
    f.data.download = async (url) =>
      url.endsWith('/release.json')
        ? Response.json(data.metadata)
        : new Response(data.bytes, { headers: { 'content-length': String(data.bytes.length) } });
    f.data.probe = async () => ((await present(binary)) ? ready(binary) : missing());
    f.runtime.planInstall('codex');
    await f.runtime.settled();
    const plan = f.runtime.getState().plan!;
    assert.equal(plan.downloadBytes, data.bytes.length);
    assert(plan.destination.startsWith(f.directory + path.sep));
    assert.throws(() => f.runtime.install('old-plan'), /过期/);
    const first = f.runtime.install(plan.id),
      second = f.runtime.install(plan.id);
    assert.equal(first.operation?.id, second.operation?.id);
    await f.runtime.settled();
    assert.equal(f.runtime.getState().error, undefined);
    assert.equal(f.runtime.getState().codex.path, binary);
    assert.equal(await present(data.executed), true);
    assert.equal(f.data.downloadCalls.filter((url) => url.endsWith('.tar.gz')).length, 1);
    assert.equal((await exec(binary, ['--version'])).stdout.trim(), 'codex-cli 0.166.0');
    assert(
      !(await readdir(path.dirname(plan.destination))).some((name) =>
        name.startsWith('.onboarding-'),
      ),
    );
  } finally {
    await f.close();
  }
});

test('a checksum mismatch never extracts or executes the downloaded package', async () => {
  const f = await fixture({ initialAgents: missing() });
  try {
    const data = await archive(f);
    f.data.download = async (url) =>
      url.endsWith('/release.json')
        ? Response.json(data.metadata)
        : new Response('corrupted archive');
    f.runtime.planInstall('codex');
    await f.runtime.settled();
    const plan = f.runtime.getState().plan!;
    f.runtime.install(plan.id);
    await f.runtime.settled();
    assert.match(f.runtime.getState().error!, /SHA-256/);
    assert.equal(await present(plan.destination), false);
    assert.equal(await present(data.executed), false);
  } finally {
    await f.close();
  }
});

test('a private target appearing after the plan is never overwritten', async () => {
  const f = await fixture({ initialAgents: missing() });
  try {
    const data = await archive(f);
    f.data.download = async () => Response.json(data.metadata);
    f.runtime.planInstall('codex');
    await f.runtime.settled();
    const plan = f.runtime.getState().plan!;
    await mkdir(plan.destination, { recursive: true });
    const marker = path.join(plan.destination, 'preserve');
    await writeFile(marker, 'untouched');
    f.runtime.install(plan.id);
    await f.runtime.settled();
    assert.match(f.runtime.getState().error!, /不会覆盖/);
    assert.equal(await readFile(marker, 'utf8'), 'untouched');
    assert.equal(f.data.downloadCalls.length, 1);
  } finally {
    await f.close();
  }
});

test('cancel waits for owned cleanup and late download completion cannot install or cancel a newer operation', async () => {
  const f = await fixture({ initialAgents: missing() });
  try {
    const data = await archive(f);
    let finishDownload: ((response: Response) => void) | undefined;
    f.data.download = async (url) =>
      url.endsWith('/release.json')
        ? Response.json(data.metadata)
        : await new Promise<Response>((resolve) => {
            finishDownload = resolve;
          });
    f.runtime.planInstall('codex');
    await f.runtime.settled();
    const plan = f.runtime.getState().plan!,
      started = f.runtime.install(plan.id);
    await until(() => Boolean(finishDownload));
    const cancellation = f.runtime.cancel(started.operation!.id);
    assert.throws(() => f.runtime.refresh(), /当前准备/);
    finishDownload!(new Response(data.bytes));
    await cancellation;
    assert.equal(f.runtime.getState().plan, undefined);
    assert.throws(() => f.runtime.install(plan.id), /过期/);
    assert.equal(await present(plan.destination), false);
    assert.equal(await present(data.executed), false);
    let finishProbe: ((agents: AgentInfo[]) => void) | undefined;
    f.data.probe = async () =>
      await new Promise((resolve) => {
        finishProbe = resolve;
      });
    const current = f.runtime.refresh();
    await until(() => Boolean(finishProbe));
    await f.runtime.cancel(started.operation!.id);
    assert.equal(f.runtime.getState().operation?.id, current.operation?.id);
    finishProbe!(missing());
    await f.runtime.settled();
    const revisions = f.data.events.map((event) => event.revision);
    assert(revisions.every((value, index) => index === 0 || value > revisions[index - 1]));
  } finally {
    await f.close();
  }
});

async function loginFixture(exitCode = 0) {
  const f = await fixture();
  const binary = path.join(f.directory, 'codex-login-fixture');
  const pid = path.join(f.directory, 'login.pid'),
    finish = path.join(f.directory, 'login.finish');
  await writeFile(
    binary,
    `${nodeShebang()}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));console.error('https://auth.openai.com/oauth/authorize?state=private-fixture-state');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)}))process.exit(${exitCode})},10);process.on('SIGTERM',()=>{clearInterval(timer);setTimeout(()=>{console.error('https://auth.openai.com/late?state=old');process.exit(0)},20)});\n`,
  );
  await chmod(binary, 0o755);
  f.data.agents = ready(binary);
  let probes = 0;
  f.data.probe = async () => {
    probes++;
    return ready(binary);
  };
  return { ...f, binary, pid, finish, probes: () => probes };
}

test('a detected runtime is ready without any login state, and an old login stage resumes at the CLI step', async () => {
  const f = await fixture();
  try {
    f.runtime.refresh();
    await f.runtime.settled();
    const state = f.runtime.getState();
    assert.equal(state.codex.status, 'ready');
    assert.equal('authentication' in state.codex, false);
    assert.equal(state.stage, 'workspace');
    assert.equal(state.login, undefined);
  } finally {
    await f.close();
  }
  const resumed = await fixture({
    existingData: true,
    progress: { version: 1, status: 'in-progress', stage: 'login' as never, required: true },
  });
  try {
    assert.equal(resumed.runtime.getState().status, 'in-progress');
    assert.equal(resumed.runtime.getState().stage, 'codex');
    assert.equal(resumed.runtime.getState().requiresSetup, true);
  } finally {
    await resumed.close();
  }
});

test('a login the user starts keeps its URL out of state, reopens only its owned URL, and ends on the exit status', async () => {
  const f = await loginFixture();
  try {
    const first = f.runtime.startLogin(),
      again = f.runtime.startLogin();
    assert.equal(first.operation?.id, again.operation?.id);
    assert.equal(f.runtime.changingEnvironment, true);
    await until(() => f.runtime.getState().login?.canReopen === true);
    assert(!JSON.stringify(f.runtime.getState()).includes('private-fixture-state'));
    assert.deepEqual(f.data.external, []);
    await f.runtime.reopenLogin();
    assert.equal(f.data.external.length, 1);
    // A waiting login is never interrupted or judged by a refresh.
    assert.throws(() => f.runtime.refresh(), /等待当前准备完成/);
    const before = f.probes();
    await writeFile(f.finish, 'finish');
    await f.runtime.settled();
    assert.equal(f.runtime.getState().error, undefined);
    assert.equal(f.runtime.getState().stage, 'workspace');
    assert.equal(f.runtime.getState().login, undefined);
    assert.equal(f.runtime.changingEnvironment, false);
    assert.equal(f.probes(), before + 1, 'Open connections are refreshed to pick up the login');
    await assert.rejects(() => f.runtime.reopenLogin(), /失效/);
  } finally {
    await f.close();
  }
});

test('login cancellation ignores late output and ends only the owned process', async () => {
  const f = await loginFixture();
  try {
    const started = f.runtime.startLogin();
    await until(() => f.runtime.getState().login?.canReopen === true);
    await f.runtime.cancel(started.operation!.id);
    assert.equal(f.runtime.getState().login, undefined);
    assert.equal(f.runtime.getState().codex.status, 'ready');
    const child = Number(await readFile(f.pid, 'utf8'));
    assert.throws(() => process.kill(child, 0));
    await assert.rejects(() => f.runtime.reopenLogin(), /失效/);
  } finally {
    await f.close();
  }
});

test('an unfinished login is reported and leaves the detected runtime usable', async () => {
  const f = await loginFixture(1);
  try {
    f.runtime.startLogin();
    await until(() => f.runtime.getState().login?.canReopen === true);
    await writeFile(f.finish, 'finish');
    await f.runtime.settled();
    const state = f.runtime.getState();
    assert.match(state.error!, /登录未完成/);
    assert.equal(state.login, undefined);
    assert.equal(state.codex.status, 'ready');
    await assert.rejects(() => f.runtime.reopenLogin(), /失效/);
  } finally {
    await f.close();
  }
});

test('browser preparation is optional and missing BrowserOS produces a reviewable plan before any download', async () => {
  const f = await fixture();
  try {
    await confirmProject(f);
    f.runtime.prepareBrowser();
    await f.runtime.settled();
    assert.equal(f.runtime.getState().plan?.kind, 'browser');
    assert.equal(f.data.downloadCalls.length, 0);
    assert.equal(f.runtime.blocksTasks, false);
    f.data.browserPath = '/fixture/existing/BrowserOS neo.app';
    f.runtime.prepareBrowser();
    await f.runtime.settled();
    assert.equal(f.data.browserCalls, 1);
    assert.equal(f.runtime.getState().browser.status, 'ready');
    assert.equal(f.data.downloadCalls.length, 0);
  } finally {
    await f.close();
  }
});

test('environment writes refuse an existing task while a read-only probe remains available', async () => {
  const f = await fixture({ existingData: true });
  try {
    f.data.busy = true;
    assert.throws(() => f.runtime.startLogin(), /结束当前任务/);
    assert.throws(() => f.runtime.pickWorkspace(), /结束当前任务/);
    assert.throws(() => f.runtime.prepareBrowser(), /结束当前任务/);
    f.runtime.refresh();
    assert.equal(f.runtime.changingEnvironment, false);
    await f.runtime.settled();
    assert.equal(f.runtime.getState().codex.status, 'ready');
    assert.equal(f.runtime.blocksTasks, false);
  } finally {
    await f.close();
  }
});

test('deferring revokes an unconfirmed directory candidate', async () => {
  const f = await fixture();
  try {
    f.data.candidate = path.join(f.directory, 'next-project');
    await mkdir(f.data.candidate);
    f.runtime.pickWorkspace();
    await f.runtime.settled();
    const candidate = f.runtime.getState().workspace.candidate!;
    await f.runtime.defer();
    assert.equal(f.runtime.getState().workspace.candidate, undefined);
    assert.throws(() => f.runtime.confirmWorkspace(candidate.id), /失效/);
    assert.deepEqual(f.data.commits, []);
  } finally {
    await f.close();
  }
});

test('the private CLI fallback is usable once it reports its version, whatever its login status says', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-private-detection-'));
  const previousPath = process.env.PATH;
  try {
    for (const name of ['codex', 'claude', 'opencode', 'gemini']) {
      const file = path.join(directory, name);
      await writeFile(file, `${nodeShebang()}\nprocess.exit(1);\n`);
      await chmod(file, 0o755);
    }
    const fallback = path.join(directory, 'private-codex');
    await writeFile(
      fallback,
      `${nodeShebang()}\nif(process.argv.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0)}console.error('Logged in using ChatGPT, but status validation failed');process.exit(1);\n`,
    );
    await chmod(fallback, 0o755);
    process.env.PATH = directory;
    const codex = (await detectAgents(fallback)).find((item) => item.id === 'codex')!;
    assert.equal(codex.available, true);
    assert.equal(codex.path, fallback);
    assert.equal('authentication' in codex, false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
