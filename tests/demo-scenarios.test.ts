import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { demoKnowledge, demoKnowledgeRoot, demoBase } from '../scripts/demo-session';
import { fixtureLarkCli } from './frontend-build-fixture';
import { FeishuKnowledge } from '../src/main/feishu-knowledge';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startCustomerRuntime } from './customer-export-runtime';

test('a cancelled demo setup starts no runtime', async () => {
  await assert.rejects(
    startCustomerRuntime('/not-read', '/not-created', 'demo', AbortSignal.abort()),
    { name: 'AbortError' },
  );
});

test('the demo knowledge can be indexed and read, identifies its fixture and resolves only the supplied site', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-demo-knowledge-'));
  try {
    const origin = 'http://127.0.0.1:43173';
    const docs = demoKnowledge(
      origin,
      'https://github.com/Dylan-Nihilo/athena-customer-materials-demo.git',
    );
    const file = path.join(directory, 'knowledge.json');
    await writeFile(file, JSON.stringify(docs));
    const cli = path.join(directory, 'lark.cjs');
    await writeFile(cli, fixtureLarkCli(process.execPath, file));
    const exec = promisify(execFile);
    const knowledge = new FeishuKnowledge(path.join(directory, 'cache'), async (args) =>
      JSON.parse((await exec(process.execPath, [cli, ...args])).stdout),
    );
    const index = await knowledge.index(demoKnowledgeRoot);
    assert.equal(index.documents.length, 5);
    assert.equal(index.partial, false);
    assert.match(index.documents[0].content, /离线|本地知识服务替身/);
    const hits = await knowledge.search(demoKnowledgeRoot, '对外材料 内部跟进');
    assert.equal(hits.hits[0].url, 'https://fixture.feishu.cn/docx/CustomerPolicy');
    const read = JSON.parse(
      (
        await knowledge.call('workbench_feishu_read', {
          url: 'https://fixture.feishu.cn/docx/RepositoryMap',
        })
      ).text,
    );
    assert.ok(read.content.includes(origin) && read.content.includes(demoBase));
    assert.match(docs.CustomerPolicy.content, /C1004、C1009、C1014/);
    assert.throws(() =>
      demoKnowledge('https://production.example', 'https://github.com/example/demo.git'),
    );
    assert.throws(() => demoKnowledge(origin, 'https://token@github.com/example/demo.git'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
