import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RepositoryMcp } from '../src/main/repository-mcp';
import { startRepositoryRegistry } from './customer-export-registry';
const exec = promisify(execFile);

for (const invalid of [false, true])
  test(`repository registry ${invalid ? 'rejects cross-component changes' : 'publishes verified sandbox commits and preserves main'}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'athena-registry-'));
    const baseline = path.join(dir, 'baseline'),
      remote = path.join(dir, 'remote.git');
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
    let registry: Awaited<ReturnType<typeof startRepositoryRegistry>> | undefined;
    try {
      await mkdir(baseline);
      await git(baseline, 'init', '-b', 'main');
      for (const component of ['frontend', 'backend']) {
        await mkdir(path.join(baseline, component));
        await writeFile(path.join(baseline, component, 'app.txt'), 'baseline');
      }
      await git(baseline, 'add', '.');
      await git(baseline, 'commit', '-m', 'baseline');
      await exec('git', ['clone', '--bare', baseline, remote]);
      registry = await startRepositoryRegistry(
        path.join(dir, 'registry'),
        baseline,
        'http://127.0.0.1:12345',
        remote,
      );
      const client = new RepositoryMcp(registry.endpoint, registry.token),
        signal = new AbortController().signal;
      assert.equal((await fetch(registry.endpoint, { method: 'POST' })).status, 403);
      assert.equal(
        (
          await client.call(
            'workbench_repository_resolve',
            { website_url: 'http://127.0.0.1:54321', module: 'customers' },
            signal,
          )
        ).isError,
        true,
      );
      const resolved = await client.call(
        'workbench_repository_resolve',
        { website_url: 'http://127.0.0.1:12345/customers', module: 'customers' },
        signal,
      );
      const mapping = JSON.parse(resolved.text);
      const bundle = path.join(dir, 'base.bundle');
      const response = await fetch(mapping.bundleUrl.replace('host.docker.internal', '127.0.0.1'));
      await writeFile(bundle, Buffer.from(await response.arrayBuffer()));
      for (const component of ['frontend', 'backend']) {
        const clone = path.join(dir, component);
        await exec('git', ['-c', 'init.defaultBranch=master', 'clone', bundle, clone]);
        assert.equal(
          await git(clone, 'rev-parse', 'HEAD'),
          registry.base,
          'Bundle must check out without host default-branch assumptions',
        );
        const changed = invalid && component === 'frontend' ? 'backend' : component;
        await writeFile(path.join(clone, changed, 'app.txt'), 'changed in ' + component);
        await git(clone, 'add', changed);
        await git(clone, 'commit', '-m', component + ' change');
        const uploaded = path.join(dir, component + '.bundle');
        await git(clone, 'bundle', 'create', uploaded, 'HEAD');
        const upload = await fetch(
          mapping.uploadUrls[component].replace('host.docker.internal', '127.0.0.1'),
          { method: 'POST', body: await readFile(uploaded) },
        );
        assert.equal(upload.status, 200);
      }
      const result = await client.call('workbench_repository_publish', {}, signal);
      if (invalid) {
        assert.equal(result.isError, true);
        assert.match(result.text, /组件目录/);
        assert.equal(registry.published, undefined);
      } else {
        assert.equal(result.isError, false, result.text);
        const published = JSON.parse(result.text);
        const remoteSha = (
          await git(baseline, 'ls-remote', remote, 'refs/heads/' + published.branch)
        ).split(/\s/)[0];
        assert.equal(remoteSha, published.commit);
        assert.equal(
          (await git(baseline, 'ls-remote', remote, 'refs/heads/main')).split(/\s/)[0],
          registry.base,
        );
        assert.equal(
          (await client.call('workbench_repository_publish', {}, signal)).text,
          result.text,
          'Reconciliation must return the same published result',
        );
        const checked = JSON.parse(
          (await client.call('workbench_repository_checkout', {}, signal)).text,
        );
        assert.equal(checked.commit, published.commit);
        const bundle = await fetch(checked.bundleUrl.replace('host.docker.internal', '127.0.0.1'));
        assert.equal(bundle.status, 200);
        const saved = path.join(dir, 'published.bundle');
        await writeFile(saved, Buffer.from(await bundle.arrayBuffer()));
        const fresh = path.join(dir, 'fresh');
        await exec('git', ['clone', saved, fresh]);
        assert.equal(await git(fresh, 'rev-parse', 'HEAD'), published.commit);
      }
    } finally {
      registry?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
