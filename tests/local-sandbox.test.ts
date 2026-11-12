import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { LocalSandbox, readOnlySandboxCall, type SandboxArtifact } from '../src/main/local-sandbox';

test('sandbox analysis cannot write files, start services or stop commands', () => {
  assert.equal(readOnlySandboxCall('athena_sandbox_status', {}), true);
  assert.equal(readOnlySandboxCall('athena_sandbox_command', {}), true);
  for (const name of [
    'athena_sandbox_write',
    'athena_sandbox_exec',
    'athena_sandbox_service_start',
  ])
    assert.equal(readOnlySandboxCall(name, {}), false);
  assert.equal(readOnlySandboxCall('athena_sandbox_command', { stop: true }), false);
});

test(
  'real Docker writes, builds, previews, exports and cancels inside its own sandbox',
  { skip: process.env.ATHENA_TEST_DOCKER !== '1', timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'athena-local-sandbox-'));
    const artifacts: SandboxArtifact[] = [];
    const sandbox = new LocalSandbox(
      directory,
      path.resolve('packages/athena-sandbox/athena-sandbox.mjs'),
      (_id, artifact) => artifacts.push(artifact),
    );
    const controller = new AbortController(),
      context = { conversationId: 'native-test', turnId: 'native-turn', signal: controller.signal };
    let container: string | undefined;
    try {
      await assert.rejects(sandbox.write(context, [{ path: '../outside', content: 'no' }]), /路径/);
      await sandbox.write(context, [
        {
          path: 'package.json',
          content: JSON.stringify({
            name: 'sandbox-proof',
            scripts: { build: 'node build.cjs', preview: 'node preview.cjs' },
          }),
        },
        {
          path: 'build.cjs',
          content:
            "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html','<!doctype html><h1>REAL_SANDBOX_BUILD</h1>')",
        },
        {
          path: 'preview.cjs',
          content:
            "require('http').createServer((q,s)=>s.end(require('fs').readFileSync('dist/index.html'))).listen(Number(process.env.PORT),'0.0.0.0')",
        },
      ]);
      container = (await sandbox.status(context.conversationId)).name;
      const built = await sandbox.run(context, 'npm run build');
      assert.equal(built.command.status, 'succeeded', built.output);
      assert.equal(built.command.exitCode, 0);
      const failed = await sandbox.run(context, 'exit 7');
      assert.equal(failed.command.exitCode, 7);
      const artifact = await sandbox.artifact(context, 'dist/index.html');
      assert.match(await readFile(artifact.path, 'utf8'), /REAL_SANDBOX_BUILD/);
      assert.equal(artifacts.length, 1);
      const preview = await sandbox.service(context, 'npm run preview');
      assert.match(await (await fetch(preview.url)).text(), /REAL_SANDBOX_BUILD/);
      const { stdout } = await promisify(execFile)('docker', ['inspect', container]);
      const [info] = JSON.parse(stdout);
      assert.equal(info.HostConfig.ReadonlyRootfs, true);
      assert.equal(info.HostConfig.Privileged, false);
      assert.equal(
        info.Mounts.some((mount: any) => mount.Destination.includes('docker.sock')),
        false,
      );
      assert.equal(info.Mounts.filter((mount: any) => mount.RW).length, 1);
      const long = await sandbox.run(context, 'sleep 60', 0);
      assert.equal(long.command.status, 'running');
      await sandbox.cancelTurn(context.turnId);
      assert.equal((await sandbox.result(context, long.command.id, 2)).command.status, 'cancelled');
      await assert.rejects(sandbox.artifact(context, '/etc/passwd'), /工作目录/);
      await promisify(execFile)('docker', ['stop', '--time', '2', container]);
      const resumed = await sandbox.run(context, 'node -e "console.log(42)"');
      assert.equal(resumed.command.exitCode, 0);
      assert.match(resumed.output, /42/);
    } finally {
      await sandbox.dispose();
      if (container) await promisify(execFile)('docker', ['rm', '-f', container]);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
