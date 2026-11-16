import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { CoderApi } from '../src/main/coder-api';
import { CoderConnection } from '../src/main/coder-connection';
import { CoderSandbox, coderCliTransport, coderOwner } from '../src/main/coder-sandbox';
import { SandboxPool } from '../src/main/sandbox-pool';
import type { LocalSandboxUpdate } from '../src/main/sandbox-runtime';

// Runs against a real Coder deployment, with the real `coder` command and ssh:
//   ATHENA_TEST_CODER_URL         its address
//   ATHENA_TEST_CODER_TOKEN_FILE  a file holding a session token
//   ATHENA_TEST_CODER_TEMPLATE    template name (default: the first one); it needs Node.js
//   ATHENA_TEST_CODER_CLI         path of the coder command (default: the one on PATH)
// It creates two workspaces, and deletes them again.
const url = process.env.ATHENA_TEST_CODER_URL,
  tokenFile = process.env.ATHENA_TEST_CODER_TOKEN_FILE;
const MINUTE = 60_000,
  DAY = 24 * 60 * MINUTE;

test(
  'real Coder: two workspaces are created, used, stopped when idle, and deleted when unused',
  { skip: !url || !tokenFile, timeout: 30 * MINUTE },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'athena-coder-live-'));
    const token = (await readFile(tokenFile!, 'utf8')).trim();
    const connection = new CoderConnection({
      file: path.join(directory, 'coder', 'connection.json'),
      encrypt: async (value) => value,
      decrypt: async (value) => value,
    });
    await connection.connect(url, token, false);
    const { origin } = connection.connection();
    const api = new CoderApi(origin!, token, fetch);
    const templates = await connection.templates();
    const wanted = process.env.ATHENA_TEST_CODER_TEMPLATE;
    const template = wanted ? templates.find((item) => item.name === wanted) : templates[0];
    assert.ok(template, 'the deployment has no such template');

    const sandboxes = path.join(directory, 'sandboxes');
    const owner = await coderOwner(sandboxes);
    const cli = process.env.ATHENA_TEST_CODER_CLI;
    const backend = (
      onUpdate: (update: LocalSandboxUpdate) => void = () => {},
      source: (id: string) => string | undefined = () => undefined,
    ) =>
      new CoderSandbox({
        directory: sandboxes,
        owner,
        program: path.resolve('packages/athena-sandbox/athena-sandbox.mjs'),
        access: connection.access,
        template: source,
        transport: coderCliTransport(
          connection.access,
          path.join(directory, 'coder', 'cli'),
          cli ? async () => cli : undefined,
        ),
        onArtifact: () => {},
        onUpdate,
      });
    let now = Date.now();
    const pool = new SandboxPool(sandboxes, '/nowhere/athena-sandbox.mjs', () => {}, undefined, {
      now: () => now,
      coder: {
        backend,
        connection: () => connection.connection(),
        templates: () => connection.templates(),
      },
    });
    const signal = new AbortController().signal;
    const call = async (tool: string, args: Record<string, unknown>) =>
      JSON.parse(
        (await pool.call(tool, args, { conversationId: 'conversation-1', turnId: 'turn', signal }))
          .text,
      );
    const mine = async () =>
      new Map(
        (await api.workspaces())
          .filter((workspace) => workspace.name.startsWith(`athena-${owner}-`))
          .map((workspace) => [
            workspace.name,
            `${workspace.latest_build.transition} ${workspace.latest_build.status}`,
          ]),
      );
    const settled = async (name: string) => {
      for (;;) {
        const { instances } = await pool.instances();
        const instance = instances.find((item) => item.name === name)!;
        assert.notEqual(instance.status, 'failed', instance.message ?? '');
        if (instance.status !== 'starting') return instance;
        await wait(1000);
      }
    };
    try {
      await pool.load();
      await pool.reconcile();
      assert.equal((await pool.instances()).coder.available, true);
      await pool.create('one', 'default', template.id);
      await pool.create('two', 'default', template.id);
      const one = await settled('one'),
        two = await settled('two');
      assert.deepEqual([one.status, two.status, one.provider], ['running', 'running', 'coder']);
      assert.deepEqual([...(await mine()).values()], ['start running', 'start running']);

      // Files and commands, each workspace on its own.
      await call('athena_sandbox_write', {
        sandbox: 'one',
        files: [
          { path: 'athena-live/note.txt', content: "ONLY_IN_ONE it's" },
          {
            path: 'athena-live/server.cjs',
            content:
              "require('http').createServer((q,s)=>s.end('LIVE_PREVIEW '+require('os').hostname())).listen(Number(process.env.PORT),'0.0.0.0')",
          },
        ],
      });
      const read = await call('athena_sandbox_exec', {
        sandbox: 'one',
        command: 'cat athena-live/note.txt && echo && pwd && echo "$HOME" && node --version',
      });
      assert.equal(read.command.status, 'succeeded', read.output);
      const [note, cwd, home, version] = read.output.trim().split('\n');
      assert.equal(note, "ONLY_IN_ONE it's");
      assert.equal(cwd, home);
      assert.match(version, /^v\d+/);
      const absent = await call('athena_sandbox_exec', {
        sandbox: 'two',
        command: 'cat athena-live/note.txt',
      });
      assert.notEqual(absent.command.exitCode, 0);

      // The preview port of the workspace, reached through a loopback port on this machine.
      const service = await call('athena_sandbox_service_start', {
        sandbox: 'one',
        command: 'node athena-live/server.cjs',
      });
      assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(await (await fetch(service.url)).text(), /^LIVE_PREVIEW /);
      const artifact = await call('athena_sandbox_artifact', {
        sandbox: 'one',
        path: 'athena-live/note.txt',
      });
      assert.equal(await readFile(artifact.path, 'utf8'), "ONLY_IN_ONE it's");

      // Idle: both stop on Coder, and the forwarded preview goes with them.
      now += 31 * MINUTE;
      await pool.sweep();
      assert.deepEqual([...(await mine()).values()], ['stop stopped', 'stop stopped']);
      await assert.rejects(fetch(service.url, { signal: AbortSignal.timeout(3000) }));
      assert.deepEqual(
        (await pool.instances(true)).instances.map((instance) => instance.status),
        ['stopped', 'stopped'],
      );

      // Used again, the first starts with the files of its home directory still there.
      const kept = await call('athena_sandbox_exec', {
        sandbox: 'one',
        command: 'cat athena-live/note.txt',
      });
      assert.match(kept.output, /ONLY_IN_ONE/);
      assert.deepEqual([...(await mine()).values()].sort(), ['start running', 'stop stopped']);

      // Unused past the retention period: the one not kept is deleted on Coder.
      await pool.keep(one.id, true);
      now += 8 * DAY;
      await pool.sweep();
      assert.deepEqual(
        (await pool.instances(true)).instances.map((instance) => [instance.name, instance.status]),
        [['one', 'stopped']],
      );
      assert.deepEqual([...(await mine()).values()], ['stop stopped']);

      // Quitting asks whatever still runs to stop, without waiting for it.
      await pool.start(one.id);
      assert.deepEqual([...(await mine()).values()], ['start running']);
      await pool.dispose();
      assert.match([...(await mine()).values()][0], /^stop /);
    } finally {
      await pool.dispose();
      const cleaner = backend();
      for (const name of (await mine()).keys()) await cleaner.release(name, true).catch(() => {});
      assert.equal((await mine()).size, 0);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
