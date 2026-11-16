import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CoderConnection } from '../src/main/coder-connection';
import { fakeCoder } from './coder-test-support';

async function world() {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-coder-connection-'));
  const coder = fakeCoder('token-one');
  const file = path.join(directory, 'coder', 'connection.json');
  const state = { locked: false, decrypted: 0 };
  const connection = () =>
    new CoderConnection({
      file,
      fetch: coder.fetch,
      encrypt: async (value) => 'enc:' + Buffer.from(value).toString('base64'),
      decrypt: async (value) => {
        state.decrypted++;
        if (state.locked) throw new Error('keychain is locked');
        return Buffer.from(value.slice(4), 'base64').toString();
      },
    });
  return { directory, coder, file, state, connection };
}

test('a connection is checked, stored without the token in the clear, and read back', async () => {
  const w = await world();
  try {
    const first = w.connection();
    await first.load();
    assert.deepEqual(first.connection(), { connected: false });
    assert.equal(await first.access(), undefined);
    assert.deepEqual(await first.templates(), []);

    await assert.rejects(first.connect('', 'token-one'), /请填写 Coder 地址/);
    await assert.rejects(first.connect('coder.example', '  '), /请填写 Coder 令牌/);
    await assert.rejects(first.connect('http://coder.example', 'token-one'), /HTTPS/);
    await assert.rejects(first.connect('coder.example', 'wrong'), /令牌无效或已过期/);
    assert.deepEqual(first.connection(), { connected: false });
    await assert.rejects(stat(w.file));

    await first.connect(' coder.example/login ', ' token-one ');
    assert.deepEqual(first.connection(), {
      connected: true,
      origin: 'https://coder.example',
      username: 'tester',
      insecure: false,
    });
    const saved = await readFile(w.file, 'utf8');
    assert.ok(!saved.includes('token-one'));
    assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), [
      'origin',
      'token',
      'username',
      'version',
    ]);
    assert.equal((await stat(w.file)).mode & 0o777, 0o600);
    // Deprecated templates are left out; the rest go by their display names.
    assert.deepEqual(await first.templates(), [
      { id: 'tpl-bare', name: 'bare' },
      { id: 'tpl-node', name: 'Node 工作区' },
    ]);

    // After a restart the address shows at once; the stored token is read when first needed.
    const second = w.connection();
    await second.load();
    assert.equal(second.connection().username, 'tester');
    assert.equal(w.state.decrypted, 0);
    assert.deepEqual(await second.access(), {
      origin: 'https://coder.example',
      token: 'token-one',
    });
    await second.access();
    assert.equal(w.state.decrypted, 1);
  } finally {
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('while connected only the token of the same account can be replaced', async () => {
  const w = await world();
  try {
    const connection = w.connection();
    await connection.connect('coder.example', 'token-one');
    await assert.rejects(
      connection.connect('other.example', 'token-one'),
      /已连接到另一个 Coder 地址或账号/,
    );
    w.coder.state.username = 'someone-else';
    await assert.rejects(
      connection.connect('coder.example', 'token-one'),
      /已连接到另一个 Coder 地址或账号/,
    );
    w.coder.state.username = 'tester';
    w.coder.state.token = 'token-two';
    await connection.connect('coder.example', 'token-two');
    assert.equal((await connection.access())?.token, 'token-two');

    await connection.disconnect();
    assert.deepEqual(connection.connection(), { connected: false });
    assert.equal(await connection.access(), undefined);
    await assert.rejects(stat(w.file));
    // Disconnected, any deployment can be connected again.
    await connection.connect('http://192.168.1.20:3000', 'token-two');
    assert.equal(connection.connection().insecure, true);
  } finally {
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('a token that cannot be read is asked for again, and a preset one is never written', async () => {
  const w = await world();
  try {
    await w.connection().connect('coder.example', 'token-one');
    const locked = w.connection();
    await locked.load();
    w.state.locked = true;
    await assert.rejects(locked.access(), /无法读取已保存的 Coder 令牌/);
    // Once the keychain answers, the same connection works without a restart.
    w.state.locked = false;
    assert.equal((await locked.access())?.token, 'token-one');

    await locked.disconnect();
    const preset = w.connection();
    await preset.connect('coder.example', 'token-one', false);
    assert.equal(preset.connection().connected, true);
    assert.equal((await preset.access())?.token, 'token-one');
    await assert.rejects(stat(w.file));

    await writeFile(w.file, '{"origin":"javascript:alert(1)","username":"x","token":"y"}');
    const broken = w.connection();
    await broken.load();
    assert.deepEqual(broken.connection(), { connected: false });
  } finally {
    await rm(w.directory, { recursive: true, force: true });
  }
});
