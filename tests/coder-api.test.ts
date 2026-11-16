import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderApi, CoderApiError, coderOrigin, isPrivateHost } from '../src/main/coder-api';
import { fakeCoder } from './coder-test-support';

test('a Coder address is reduced to its origin and must be encrypted outside private networks', () => {
  assert.equal(coderOrigin(' coder.example.com/workspaces '), 'https://coder.example.com');
  assert.equal(coderOrigin('https://coder.example.com:8443/x?y'), 'https://coder.example.com:8443');
  assert.equal(coderOrigin('http://10.1.2.3:3000'), 'http://10.1.2.3:3000');
  assert.equal(coderOrigin('http://localhost:3000/'), 'http://localhost:3000');
  assert.throws(() => coderOrigin('http://coder.example.com'), /必须使用 HTTPS/);
  assert.throws(() => coderOrigin('ftp://10.0.0.1'), /必须使用 HTTPS/);
  assert.throws(() => coderOrigin('https://user:pass@coder.example.com'), /不能包含账号信息/);
  assert.throws(() => coderOrigin('https://'), /格式不正确/);
  for (const host of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.1', '192.168.1.1'])
    assert.equal(isPrivateHost(host), true, host);
  for (const host of [
    '172.32.0.1',
    '11.0.0.1',
    '192.169.1.1',
    'example.com',
    '10.0.0',
    '10.0.0.256',
  ])
    assert.equal(isPrivateHost(host), false, host);
});

test('requests carry the token as a header and answers are read into what Athena uses', async () => {
  const coder = fakeCoder();
  const api = new CoderApi('https://coder.example', coder.state.token, coder.fetch);
  assert.deepEqual(await api.me(), { id: 'user-1', username: 'tester' });
  assert.deepEqual(
    (await api.templates()).map((template) => template.name),
    ['node', 'old', 'bare'],
  );
  assert.deepEqual(await api.workspaces(), []);
  assert.equal(await api.workspaceByName('athena-none'), undefined);

  const created = await api.createWorkspace('tpl-node', 'athena-one');
  assert.equal(created.latest_build.status, 'pending');
  assert.equal((await api.workspaceByName('athena-one'))?.id, created.id);
  // One build at a time: Coder refuses a second while the first is active.
  await assert.rejects(
    api.build(created.id, 'stop'),
    (error: CoderApiError) => error.status === 409,
  );
  await assert.rejects(
    api.createWorkspace('tpl-missing', 'athena-two'),
    /Coder 请求失败（400）：Template not found/,
  );
  await assert.rejects(api.workspace('nope'), (error: CoderApiError) => error.status === 404);
  assert.ok(coder.state.requests.includes('GET /api/v2/workspaces?q=owner%3Ame'));
});

test('a wrong token, an unreachable address and a foreign answer are told apart', async () => {
  const coder = fakeCoder();
  await assert.rejects(
    new CoderApi('https://coder.example', 'wrong', coder.fetch).me(),
    (error: CoderApiError) => error.status === 401 && /令牌无效或已过期/.test(error.message),
  );
  coder.state.down = true;
  await assert.rejects(
    new CoderApi('https://coder.example', coder.state.token, coder.fetch).me(),
    (error: CoderApiError) =>
      error.status === 0 && /无法连接 Coder（https:\/\/coder\.example）/.test(error.message),
  );
  const html = async () => new Response('<html>login</html>', { status: 200 });
  await assert.rejects(
    new CoderApi('https://not-coder.example', 't', html).me(),
    /无法识别，请确认地址指向 Coder/,
  );
  // The token is never part of a message.
  const echo = async (_url: string, init: RequestInit) =>
    new Response(
      JSON.stringify({
        message: 'bad ' + (init.headers as Record<string, string>)['Coder-Session-Token'],
      }),
      { status: 500 },
    );
  await assert.rejects(
    new CoderApi('https://coder.example', 'plain-1234567890abcdef', echo).me(),
    (error: Error) => /Coder 请求失败（500）：bad \[hidden\]$/.test(error.message),
  );
});
