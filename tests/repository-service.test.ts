import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RepositoryService } from '../src/main/repository-service';
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec('git', [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      '-C',
      cwd,
      ...args,
    ])
  ).stdout.trim();
const local = (url: string) => url.replace('host.docker.internal', '127.0.0.1');

/** A remote with a frontend and a backend directory, as a website's code usually comes. */
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'athena-repositories-'));
  const baseline = path.join(dir, 'baseline'),
    remote = path.join(dir, 'remote.git');
  await mkdir(baseline);
  await git(baseline, 'init', '-b', 'main');
  for (const component of ['frontend', 'backend']) {
    await mkdir(path.join(baseline, component));
    await writeFile(path.join(baseline, component, 'app.txt'), 'baseline');
  }
  await git(baseline, 'add', '.');
  await git(baseline, 'commit', '-m', 'baseline');
  await exec('git', ['clone', '--bare', baseline, remote]);
  const approvals: Array<{ title: string; detail: string }> = [];
  let answer = true;
  const service = new RepositoryService(path.join(dir, 'service'), {
    allowLocal: true,
    approve: async (request) => {
      approvals.push(request);
      return answer;
    },
  });
  const context = { conversationId: 'c1', signal: new AbortController().signal };
  return {
    dir,
    baseline,
    remote,
    service,
    approvals,
    context,
    base: await git(baseline, 'rev-parse', 'HEAD'),
    answer: (value: boolean) => (answer = value),
    call: async (name: string, args: Record<string, unknown> = {}, at = context) =>
      service.call(name, args, at),
    /** What a sandbox does: clone the bundle, change its component, upload the commit. */
    async change(mapping: any, component: string, file = component + '/app.txt') {
      const item = mapping.components[component];
      const bundle = path.join(dir, component + '-base.bundle');
      const response = await fetch(local(item.bundleUrl));
      assert.equal(response.status, 200);
      await writeFile(bundle, Buffer.from(await response.arrayBuffer()));
      const clone = path.join(dir, component + '-' + Math.random().toString(16).slice(2));
      await exec('git', ['-c', 'init.defaultBranch=master', 'clone', bundle, clone]);
      assert.equal(await git(clone, 'rev-parse', 'HEAD'), item.baseCommit);
      await mkdir(path.dirname(path.join(clone, file)), { recursive: true });
      await writeFile(path.join(clone, file), 'changed in ' + component);
      await git(clone, 'add', '.');
      await git(clone, 'commit', '-m', component + ' change');
      const uploaded = path.join(dir, component + '.bundle');
      await git(clone, 'bundle', 'create', uploaded, item.baseCommit + '..HEAD');
      return fetch(local(item.uploadUrl), { method: 'POST', body: await readFile(uploaded) });
    },
    async close() {
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const proposal = (remote: string) => ({
  website_url: 'http://127.0.0.1:12345/customers?tab=1',
  module: 'customers',
  application: 'Customer centre',
  frontend: { repository: remote, root: 'frontend' },
  backend: { repository: remote, root: 'backend' },
  source: 'https://docs.example.test/wiki/repositories',
});

test('a website without a mapping sends the agent to the knowledge base, and a declined mapping is not kept', async () => {
  const t = await fixture();
  try {
    const unknown = JSON.parse(
      (await t.call('workbench_repository_resolve', { website_url: 'http://127.0.0.1:12345/' }))
        .text,
    );
    assert.equal(unknown.registered, false);
    assert.match(unknown.next, /知识库/);
    assert.equal(t.approvals.length, 0);
    t.answer(false);
    const declined = JSON.parse(
      (await t.call('workbench_repository_resolve', proposal(t.remote))).text,
    );
    assert.equal(declined.registered, false);
    assert.equal(t.approvals.length, 1);
    assert.match(t.approvals[0].detail, /http:\/\/127\.0\.0\.1:12345（customers）/);
    assert.match(t.approvals[0].detail, /docs\.example\.test/);
    assert.deepEqual(await t.service.list(), []);
  } finally {
    await t.close();
  }
});

test('a confirmed mapping is remembered and hands each sandbox the real code as a bundle', async () => {
  const t = await fixture();
  try {
    const mapping = JSON.parse(
      (await t.call('workbench_repository_resolve', proposal(t.remote))).text,
    );
    assert.equal(mapping.registered, true);
    assert.equal(mapping.components.frontend.baseCommit, t.base);
    assert.equal(mapping.components.backend.root, 'backend');
    assert.equal(mapping.components.frontend.branch, 'main');
    assert.match(mapping.targetBranch, /^athena\/customers-[a-f0-9]{8}$/);
    assert.equal(t.approvals.length, 1);
    const [stored] = await t.service.list();
    assert.equal(stored.origin, 'http://127.0.0.1:12345');
    assert.equal(stored.source, 'https://docs.example.test/wiki/repositories');
    assert.equal(
      (await stat(path.join(t.dir, 'service', 'mappings.json'))).mode & 0o777,
      0o600,
      'Mappings are private to the user',
    );
    // A later task on the same website, in another conversation and after a restart, needs no card.
    const restarted = new RepositoryService(path.join(t.dir, 'service'), {
      allowLocal: true,
      approve: async () => assert.fail('A known mapping must not ask again'),
    });
    try {
      const again = JSON.parse(
        (
          await restarted.call(
            'workbench_repository_resolve',
            { website_url: 'http://127.0.0.1:12345/orders' },
            { conversationId: 'c2', signal: t.context.signal },
          )
        ).text,
      );
      assert.equal(again.registered, true);
      assert.equal(again.module, 'customers');
      assert.notEqual(again.targetBranch, mapping.targetBranch);
    } finally {
      await restarted.dispose();
    }
    // The same proposal again changes nothing; a different one is a new decision for the user.
    await t.call('workbench_repository_resolve', proposal(t.remote));
    assert.equal(t.approvals.length, 1);
    await t.call('workbench_repository_resolve', {
      ...proposal(t.remote),
      backend: undefined,
    });
    assert.equal(t.approvals.length, 2);
    assert.deepEqual(Object.keys((await t.service.list())[0].components), ['frontend']);
    await t.service.forget(stored.id);
    assert.deepEqual(await t.service.list(), []);
  } finally {
    await t.close();
  }
});

test('addresses that could carry credentials or options, and directories outside the repository, are refused', async () => {
  const t = await fixture();
  try {
    for (const repository of [
      'https://user:secret@git.example.test/a/b.git',
      '--upload-pack=touch /tmp/x',
      'file:///etc',
      'ext::sh -c id',
      'git.example.test/a/b',
    ])
      await assert.rejects(
        t.call('workbench_repository_resolve', {
          website_url: 'http://127.0.0.1:12345/',
          frontend: { repository, root: '.' },
        }),
        /仓库地址/,
        repository,
      );
    for (const root of ['../other', '/etc', 'frontend/../../x', '.git/hooks', '-x'])
      await assert.rejects(
        t.call('workbench_repository_resolve', {
          website_url: 'http://127.0.0.1:12345/',
          frontend: { repository: t.remote, root },
        }),
        /组件目录/,
        root,
      );
    await assert.rejects(
      t.call('workbench_repository_resolve', {
        website_url: 'http://127.0.0.1:12345/',
        frontend: { repository: t.remote, root: 'missing' },
      }),
      /没有目录 missing/,
    );
    assert.deepEqual(await t.service.list(), [], 'A mapping that never resolved is not kept');
    const strict = new RepositoryService(path.join(t.dir, 'strict'), {
      approve: async () => true,
    });
    await assert.rejects(
      strict.call(
        'workbench_repository_resolve',
        { website_url: 'http://127.0.0.1:12345/', frontend: { repository: t.remote, root: '.' } },
        t.context,
      ),
      /仓库地址/,
      'Local paths are for tests only',
    );
    assert.equal(t.approvals.length, 1, 'Only the well-formed proposal reached the user');
  } finally {
    await t.close();
  }
});

for (const scenario of ['publishes', 'declined', 'escapes'] as const)
  test(`sandbox commits: ${scenario === 'publishes' ? 'verified commits go to a new test branch after the user allows the push' : scenario === 'declined' ? 'nothing is pushed when the user declines' : 'a commit outside its component is refused before the user is asked'}`, async () => {
    const t = await fixture();
    try {
      await assert.rejects(t.call('workbench_repository_publish'), /先调用/);
      const mapping = JSON.parse(
        (await t.call('workbench_repository_resolve', proposal(t.remote))).text,
      );
      await assert.rejects(t.call('workbench_repository_publish'), /尚未上传/);
      await assert.rejects(t.call('workbench_repository_checkout'), /尚未推送/);
      const transfer = local(mapping.components.frontend.uploadUrl);
      assert.equal((await fetch(transfer, { method: 'POST', body: 'not a bundle' })).status, 400);
      assert.equal(
        (
          await fetch(
            transfer.replace(/\/transfer\/[a-f0-9]+\//, '/transfer/' + '0'.repeat(48) + '/'),
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(local(mapping.components.frontend.bundleUrl), {
            headers: { origin: 'http://evil.test' },
          })
        ).status,
        403,
        'A web page cannot read the code through the transfer address',
      );
      assert.equal(
        (
          await t.change(
            mapping,
            'frontend',
            scenario === 'escapes' ? 'backend/app.txt' : 'frontend/app.txt',
          )
        ).status,
        200,
      );
      assert.equal((await t.change(mapping, 'backend')).status, 200);
      const branches = () => git(t.baseline, 'ls-remote', t.remote, 'refs/heads/*');
      if (scenario === 'escapes') {
        await assert.rejects(t.call('workbench_repository_publish'), /超出组件目录 frontend/);
        assert.equal(t.approvals.length, 1);
        assert.doesNotMatch(await branches(), /athena\//);
        return;
      }
      if (scenario === 'declined') {
        t.answer(false);
        const result = await t.call('workbench_repository_publish');
        assert.equal(result.isError, true);
        assert.doesNotMatch(await branches(), /athena\//);
        return;
      }
      const result = await t.call('workbench_repository_publish');
      assert.equal(result.isError, undefined, result.text);
      assert.equal(t.approvals.length, 2);
      assert.equal(t.approvals[1].title, '推送测试分支');
      assert.match(t.approvals[1].detail, new RegExp(mapping.targetBranch));
      const [published] = JSON.parse(result.text).published;
      assert.equal(published.branch, mapping.targetBranch);
      assert.equal(
        (await git(t.baseline, 'ls-remote', t.remote, 'refs/heads/' + published.branch)).split(
          /\s/,
        )[0],
        published.commit,
      );
      assert.equal(
        (await git(t.baseline, 'ls-remote', t.remote, 'refs/heads/main')).split(/\s/)[0],
        t.base,
        'The main branch stays where it was',
      );
      assert.equal((await t.call('workbench_repository_publish')).text, result.text);
      assert.equal(
        t.approvals.length,
        2,
        'A repeated call reports the push instead of repeating it',
      );
      assert.equal(
        (await fetch(transfer, { method: 'POST', body: '# v2 git bundle\n' })).status,
        409,
      );
      const checked = JSON.parse((await t.call('workbench_repository_checkout')).text);
      assert.equal(checked.repositories[0].commit, published.commit);
      const saved = path.join(t.dir, 'published.bundle');
      const bundle = await fetch(local(checked.repositories[0].bundleUrl));
      assert.equal(bundle.status, 200);
      await writeFile(saved, Buffer.from(await bundle.arrayBuffer()));
      const fresh = path.join(t.dir, 'fresh');
      await exec('git', ['clone', saved, fresh]);
      assert.equal(await git(fresh, 'rev-parse', 'HEAD'), published.commit);
      assert.equal(
        await readFile(path.join(fresh, 'frontend/app.txt'), 'utf8'),
        'changed in frontend',
      );
      assert.equal(
        await readFile(path.join(fresh, 'backend/app.txt'), 'utf8'),
        'changed in backend',
      );
      // The next task on this website starts from a fresh branch.
      const next = JSON.parse(
        (await t.call('workbench_repository_resolve', { website_url: mapping.website })).text,
      );
      assert.notEqual(next.targetBranch, mapping.targetBranch);
    } finally {
      await t.close();
    }
  });
