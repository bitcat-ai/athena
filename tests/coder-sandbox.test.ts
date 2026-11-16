import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  CoderSandbox,
  coderCliTransport,
  coderOwner,
  type CoderTransport,
} from '../src/main/coder-sandbox';
import type { LocalSandboxUpdate, SandboxArtifact } from '../src/main/sandbox-runtime';
import { fakeCoder } from './coder-test-support';

const exec = promisify(execFile);
const program = path.resolve('packages/athena-sandbox/athena-sandbox.mjs');
const owner = '0a1b2c3d';

/**
 * Workspaces that are directories on this machine: the scripts Athena would send over ssh run
 * in a local shell whose home is the workspace's. Coder itself is `fakeCoder`.
 */
async function world() {
  // Short on purpose: the daemon's socket lives below it and socket paths are limited.
  const directory = await mkdtemp('/tmp/athena-coder-');
  const coder = fakeCoder();
  const artifacts: SandboxArtifact[] = [];
  const updates: LocalSandboxUpdate[] = [];
  const scripts: string[] = [];
  const home = (workspace: string) => path.join(directory, 'homes', workspace);
  const env = (workspace: string) => ({ ...process.env, HOME: home(workspace) });
  const transport: CoderTransport = {
    async shell(workspace, script) {
      // As with a real workspace, there is no shell to reach unless it runs.
      if (coder.byName(workspace)?.status !== 'running')
        return { command: '/bin/sh', args: ['-c', 'echo "workspace is not running" >&2; exit 1'] };
      await mkdir(home(workspace), { recursive: true });
      scripts.push(script);
      return { command: '/bin/sh', args: ['-c', script], env: env(workspace) };
    },
    forward: async () => {
      throw new Error('this test opens no preview');
    },
  };
  const templates = new Map<string, string>();
  const sandbox = (connected = true) =>
    new CoderSandbox({
      directory: path.join(directory, 'sandboxes'),
      owner,
      program,
      access: async () =>
        connected ? { origin: 'https://coder.example', token: 'test-token' } : undefined,
      template: (id) => templates.get(id),
      transport,
      onArtifact: (_turn, artifact) => artifacts.push(artifact),
      onUpdate: (update) => updates.push(update),
      fetch: coder.fetch,
      pollMs: 1,
    });
  const cleanup = async () => {
    for (const workspace of coder.workspaces.values())
      await exec(
        'node',
        [path.join(home(workspace.name), '.athena-sandbox/athena-sandbox.mjs'), 'stop'],
        {
          env: env(workspace.name),
        },
      ).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, coder, artifacts, updates, scripts, templates, home, sandbox, cleanup };
}
const context = (conversationId: string, signal = new AbortController().signal) => ({
  conversationId,
  turnId: 'turn-' + conversationId,
  signal,
});

test('each profile marks its Coder workspaces with an id of its own', async () => {
  const directory = await mkdtemp('/tmp/athena-coder-owner-');
  try {
    const first = await coderOwner(path.join(directory, 'a'));
    assert.match(first, /^[0-9a-f]{8}$/);
    assert.equal(await coderOwner(path.join(directory, 'a')), first);
    assert.equal((await stat(path.join(directory, 'a', 'coder-owner'))).mode & 0o777, 0o600);
    // Same path on another machine would be another file: the id is not derived from the path.
    assert.notEqual(await coderOwner(path.join(directory, 'b')), first);
    await writeFile(path.join(directory, 'a', 'coder-owner'), 'not an id');
    assert.match(await coderOwner(path.join(directory, 'a')), /^[0-9a-f]{8}$/);
    assert.equal(
      new Set(await Promise.all([1, 2, 3].map(() => coderOwner(path.join(directory, 'c'))))).size,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a workspace is created, set up and used through the same tools as a local sandbox', async () => {
  const w = await world();
  const sandbox = w.sandbox();
  try {
    w.templates.set('sbx_one', 'tpl-node');
    const name = sandbox.containerName('sbx_one');
    assert.match(name, /^athena-0a1b2c3d-[0-9a-f]{10}$/);
    assert.ok(name.length <= 32);
    assert.equal((await sandbox.status('sbx_one')).status, 'missing');

    assert.equal(await sandbox.open(context('sbx_one')), name);
    const created = w.coder.byName(name)!;
    assert.equal(created.template, 'node');
    assert.equal(created.status, 'running');
    assert.deepEqual([...(await sandbox.containers())], [[name, 'running']]);
    assert.ok(
      w.updates.some((update) => update.type === 'connection' && update.status === 'ready'),
    );
    // Installed under the .mjs name, with the daemon's state beside it.
    const installed = path.join(w.home(name), '.athena-sandbox/athena-sandbox.mjs');
    assert.deepEqual(await readFile(installed), await readFile(program));

    await assert.rejects(
      sandbox.write(context('sbx_one'), [{ path: '../outside', content: 'no' }]),
      /路径须相对 工作区主目录/,
    );
    await sandbox.write(context('sbx_one'), [
      { path: 'app/note.txt', content: "it's here" },
      {
        path: 'build.cjs',
        content: "require('fs').writeFileSync('out.txt','BUILT_'+process.argv[2])",
      },
    ]);
    assert.equal(await readFile(path.join(w.home(name), 'app/note.txt'), 'utf8'), "it's here");

    // Commands start in the home directory, and quoting survives the trip.
    const built = await sandbox.run(
      context('sbx_one'),
      'node build.cjs "a b" && cat out.txt && pwd',
    );
    assert.equal(built.command.status, 'succeeded', built.output);
    assert.match(built.output, /BUILT_a b/);
    assert.match(built.output, new RegExp(`${path.basename(name)}\\n?$`));
    const failed = await sandbox.call(
      'athena_sandbox_exec',
      { command: 'exit 3' },
      context('sbx_one'),
    );
    assert.equal(failed.isError, true);

    const artifact = await sandbox.artifact(context('sbx_one'), 'out.txt');
    assert.equal(artifact.bytes, 9);
    assert.equal(await readFile(artifact.path, 'utf8'), 'BUILT_a b');
    assert.deepEqual(w.artifacts, [artifact]);
    await assert.rejects(sandbox.artifact(context('sbx_one'), '/etc/hosts'), /沙箱工作目录内/);
    await assert.rejects(sandbox.artifact(context('sbx_one'), 'missing.txt'));

    // A second sandbox is a second workspace with files of its own.
    w.templates.set('sbx_two', 'tpl-node');
    await sandbox.open(context('sbx_two'));
    const other = await sandbox.run(context('sbx_two'), 'cat out.txt');
    assert.notEqual(other.command.exitCode, 0);
    assert.equal((await sandbox.containers()).size, 2);

    // Stopping keeps the workspace and its files; using it again starts it.
    await sandbox.release(name, false);
    assert.equal(w.coder.byName(name)!.status, 'stopped');
    assert.equal((await sandbox.containers()).get(name), 'stopped');
    const again = await sandbox.run(context('sbx_one'), 'cat out.txt');
    assert.match(again.output, /BUILT_a b/);
    assert.equal(w.coder.byName(name)!.status, 'running');

    await sandbox.release(name, true);
    assert.equal(w.coder.byName(name), undefined);
    assert.deepEqual([...(await sandbox.containers()).keys()], [sandbox.containerName('sbx_two')]);
    // Gone is gone: a second removal has nothing left to do.
    await sandbox.release(name, true);
    assert.deepEqual(await sandbox.workspaces(), []);
  } finally {
    await sandbox.dispose();
    await w.cleanup();
  }
});

test('only workspaces with this profile’s mark are listed, stopped or deleted', async () => {
  const w = await world();
  const sandbox = w.sandbox();
  try {
    const mine = w.coder.add(`athena-${owner}-0123456789`);
    const colleagueMac = w.coder.add('athena-ffffffff-0123456789');
    const own = w.coder.add('my-dev-box');
    const lookalike = w.coder.add(`athena-${owner}-notes`);
    assert.deepEqual([...(await sandbox.containers()).keys()], [mine.name]);
    for (const other of [colleagueMac, own, lookalike]) {
      await assert.rejects(sandbox.release(other.name, true), /不属于此 Athena 档案/);
      await assert.rejects(sandbox.release(other.name, false), /不属于此 Athena 档案/);
    }
    // Quitting stops what this profile runs and nothing else.
    await sandbox.dispose();
    assert.equal(mine.transition, 'stop');
    for (const other of [colleagueMac, own, lookalike])
      assert.deepEqual([other.transition, other.status], ['start', 'running']);
    await assert.rejects(sandbox.open(context('sbx_late')), /已停止/);
  } finally {
    await w.cleanup();
  }
});

test('a sandbox that was never used asks Coder nothing when Athena quits', async () => {
  const w = await world();
  const sandbox = w.sandbox();
  try {
    w.coder.add(`athena-${owner}-0123456789`);
    await sandbox.dispose();
    assert.deepEqual(w.coder.state.requests, []);
  } finally {
    await w.cleanup();
  }
});

test('what goes wrong on Coder is reported in words the user can act on', async () => {
  const w = await world();
  const sandbox = w.sandbox();
  try {
    await assert.rejects(sandbox.open(context('sbx_none')), /没有记录 Coder 模板/);

    w.templates.set('sbx_fail', 'tpl-node');
    w.coder.state.failing.add('node');
    await assert.rejects(
      sandbox.open(context('sbx_fail')),
      /启动失败（failed），请在 Coder 中查看构建日志/,
    );
    assert.ok(
      w.updates.some(
        (update) =>
          update.conversationId === 'sbx_fail' &&
          update.type === 'connection' &&
          update.status === 'failed',
      ),
    );
    // The failed workspace is there; trying again asks for a new build instead of a new workspace.
    w.coder.state.failing.clear();
    await sandbox.open(context('sbx_fail'));
    assert.equal(w.coder.workspaces.size, 1);

    w.templates.set('sbx_bare', 'tpl-bare');
    w.coder.state.agentless.add('bare');
    await assert.rejects(sandbox.open(context('sbx_bare')), /没有定义 agent/);

    const stopped = new AbortController();
    w.templates.set('sbx_slow', 'tpl-node');
    const pending = sandbox.open(context('sbx_slow', stopped.signal));
    stopped.abort();
    await assert.rejects(pending, /已停止/);

    w.coder.state.token = 'rotated';
    await assert.rejects(sandbox.containers(), /令牌无效或已过期/);
    w.coder.state.down = true;
    await assert.rejects(sandbox.containers(), /无法连接 Coder/);
    await assert.rejects(w.sandbox(false).containers(), /尚未连接 Coder/);
  } finally {
    w.coder.state.down = false;
    w.coder.state.token = 'test-token';
    await sandbox.dispose();
    await w.cleanup();
  }
});

test('a workspace without a usable Node.js is refused with the reason', async () => {
  const w = await world();
  const sandbox = w.sandbox();
  const bin = path.join(w.directory, 'bin');
  const path0 = process.env.PATH;
  try {
    // A PATH whose only `node` is too old; cat, chmod and the rest stay reachable.
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    w.templates.set('sbx_old', 'tpl-node');
    await assert.rejects(sandbox.open(context('sbx_old')), /没有 Node.js 18 或更高版本/);
  } finally {
    process.env.PATH = path0;
    await sandbox.dispose();
    await w.cleanup();
  }
});

test('the coder command gets the address and token in its environment, never as arguments', async () => {
  const access = { origin: 'https://coder.example', token: 'secret-token-value' };
  const transport = coderCliTransport(
    async () => access,
    '/profile/coder/cli',
    async () => "/opt/it's here/coder",
  );
  const shell = await transport.shell('athena-0a1b2c3d-0123456789', 'echo hi');
  assert.equal(shell.command, '/usr/bin/ssh');
  assert.ok(!shell.args.join(' ').includes(access.token));
  assert.ok(!shell.args.join(' ').includes('coder.example'));
  assert.equal(shell.env!.CODER_SESSION_TOKEN, access.token);
  assert.equal(shell.env!.CODER_URL, access.origin);
  assert.equal(shell.env!.CODER_CONFIG_DIR, '/profile/coder/cli');
  // The user's own ssh configuration is not read, and a stopped workspace is not started.
  assert.deepEqual(shell.args.slice(0, 2), ['-F', '/dev/null']);
  assert.ok(
    shell.args.includes(
      `ProxyCommand='/opt/it'\\''s here/coder' ssh --stdio --disable-autostart athena-0a1b2c3d-0123456789`,
    ),
  );
  assert.deepEqual(shell.args.slice(-3), ['--', 'coder.athena-0a1b2c3d-0123456789', 'echo hi']);

  const forward = await transport.forward('athena-0a1b2c3d-0123456789', 50123, 4173);
  assert.ok(forward.args.includes('-N'));
  assert.equal(forward.args[forward.args.indexOf('-L') + 1], '127.0.0.1:50123:127.0.0.1:4173');
  assert.equal(forward.args.at(-1), 'coder.athena-0a1b2c3d-0123456789');

  await assert.rejects(transport.shell('x; rm -rf ~', 'echo'), /名称无效/);
  await assert.rejects(
    coderCliTransport(async () => undefined, '/x').shell('athena-0a1b2c3d-0123456789', 'echo'),
    /尚未连接 Coder/,
  );
});
