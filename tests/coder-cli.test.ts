import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { coderCli } from '../src/main/coder-cli';

const binary = Buffer.alloc(1_200_000, 7);
const sha1 = createHash('sha1').update(binary).digest('hex');

async function world(t: TestContext, respond?: () => Response) {
  const directory = path.join(await mkdtemp(path.join(tmpdir(), 'athena-coder-cli-')), 'bin');
  t.after(() => rm(path.dirname(directory), { recursive: true, force: true }));
  const requests: string[] = [];
  const fetch = async (url: string) => {
    requests.push(url);
    return respond ? respond() : new Response(binary, { headers: { etag: `"${sha1}"` } });
  };
  return { directory, requests, fetch };
}

test('a coder command already on this machine is used as it is, and nothing is downloaded', async (t) => {
  const w = await world(t);
  const cli = coderCli({ ...w, installed: async () => '/opt/homebrew/bin/coder' });
  assert.equal(await cli('http://10.0.0.5:7080'), '/opt/homebrew/bin/coder');
  assert.deepEqual(w.requests, []);
});

test('without one, the deployment’s own build is fetched once, for this machine, and kept', async (t) => {
  const w = await world(t);
  const cli = coderCli({ ...w, installed: async () => undefined, platform: 'darwin', arch: 'arm64' });
  // Two sandboxes starting together share one download.
  const [first, second] = await Promise.all([cli('http://10.0.0.5:7080'), cli('http://10.0.0.5:7080')]);
  assert.equal(first, second);
  assert.deepEqual(w.requests, ['http://10.0.0.5:7080/bin/coder-darwin-arm64']);
  assert.deepEqual(await readFile(first), binary);
  assert.equal((await stat(first)).mode & 0o777, 0o755);
  assert.equal(await cli('http://10.0.0.5:7080'), first);
  assert.equal(w.requests.length, 1, 'the kept file is used again');
  // Another deployment may run another version: it gets its own file.
  const intel = coderCli({ ...w, installed: async () => undefined, platform: 'darwin', arch: 'x64' });
  assert.notEqual(await intel('https://coder.example'), first);
  assert.equal(w.requests[1], 'https://coder.example/bin/coder-darwin-amd64');
});

test('a download that does not match what the deployment states is refused and leaves nothing behind', async (t) => {
  const damaged = await world(t, () => new Response(binary, { headers: { etag: `"${'0'.repeat(40)}"` } }));
  const cli = coderCli({ ...damaged, installed: async () => undefined });
  await assert.rejects(cli('http://10.0.0.5:7080'), /校验值不一致/);
  assert.deepEqual(await readdir(damaged.directory), []);

  const short = await world(t, () => new Response('<html>login</html>'));
  await assert.rejects(
    coderCli({ ...short, installed: async () => undefined })('http://10.0.0.5:7080'),
    /不完整/,
  );
  assert.deepEqual(await readdir(short.directory), []);

  const missing = await world(t, () => new Response('no', { status: 404 }));
  const absent = coderCli({ ...missing, installed: async () => undefined });
  await assert.rejects(absent('http://10.0.0.5:7080'), /部署返回 404.*安装 Coder CLI/s);
  // A failure is not remembered: the next attempt asks again.
  await assert.rejects(absent('http://10.0.0.5:7080'), /404/);
  assert.equal(missing.requests.length, 2);
});

test('a deployment with no build for this system says so instead of fetching something else', async (t) => {
  const w = await world(t);
  const cli = coderCli({ ...w, installed: async () => undefined, platform: 'win32', arch: 'x64' });
  await assert.rejects(cli('http://10.0.0.5:7080'), /没有适用于本机系统/);
  assert.deepEqual(w.requests, []);
});
