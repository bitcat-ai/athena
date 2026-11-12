import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FeishuKnowledge } from '../src/main/feishu-knowledge';
import type { ReadCommand } from '../src/main/feishu-documents';

const root = 'https://fixture.feishu.cn/wiki/Root';
const ok = (data: unknown) => ({ ok: true, identity: 'user', data });
const mock: ReadCommand = async (args) => {
  if (args[1] === '+inspect')
    return ok({
      type: 'docx',
      title: args.at(-1)?.endsWith('Root') ? '构建知识库' : '前端项目配置',
      token: args.at(-1)?.split('/').at(-1),
    });
  if (args[1] === '+fetch')
    return ok({
      document: {
        revision_id: 3,
        content:
          args[args.indexOf('--doc') + 1] === 'Root'
            ? `前端构建参考 [静态部署](https://fixture.feishu.cn/docx/Frontend)；外部资料 https://other.feishu.cn/wiki/Private`
            : '应用名称必须与 package.json name 一致。静态资源构建输出 dist。',
      },
    });
  if (args[1] === '+node-get')
    return ok({ space_id: '123456', node_token: 'Root', has_child: true });
  if (args[1] === '+node-list') return ok({ nodes: [{ node_token: 'Child' }], has_more: false });
  throw new Error('Unexpected read ' + args.join(' '));
};
test('indexes linked and child documents and searches real cached paragraphs with provenance', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-knowledge-'));
  const seen: string[][] = [];
  const knowledge = new FeishuKnowledge(directory, async (...args) => {
    seen.push(args[0]);
    return mock(...args);
  });
  try {
    const index = await knowledge.index(root, 3);
    assert.equal(index.documents.length, 3);
    assert.ok(!seen.some((args) => args.join(' ').includes('other.feishu.cn')));
    const result = await knowledge.search(root, '静态 package.json');
    assert.ok(
      result.hits.some((hit) => hit.url.endsWith('/Frontend') && hit.excerpt.includes('name')),
    );
    assert.equal(result.hits[0].untrusted, true);
    assert.equal(result.hits[0].revision, 3);
    assert.match(result.hits[0].sha256, /^[a-f0-9]{64}$/);
    assert.ok(
      (await knowledge.search(root, '我想构建一个前端应用程序')).hits.some((hit) =>
        hit.url.endsWith('/Frontend'),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('authentication failure never creates a fake index; limits are explicitly partial', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-knowledge-denied-'));
  try {
    const denied = new FeishuKnowledge(directory, async () => ({
      ok: false,
      identity: 'user',
      error: { type: 'authorization', subtype: 'token_expired' },
    }));
    await assert.rejects(denied.index(root), /授权已失效/);
    assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.json')));
    const partial = await new FeishuKnowledge(directory, mock).index(root, 1);
    assert.equal(partial.partial, true);
    assert.equal(partial.documents.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('repeated cursors are partial and cancellation never commits an index', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-knowledge-cancel-'));
  try {
    let pages = 0;
    const looping = new FeishuKnowledge(directory, async (...args) =>
      args[0][1] === '+node-list'
        ? (pages++, ok({ nodes: [], has_more: true, page_token: 'same' }))
        : mock(...args),
    );
    const partial = await looping.index(root);
    assert.equal(pages, 2);
    assert.equal(partial.partial, true);
    assert.match(partial.failures[0].message, /游标/);
    const abortedDir = path.join(directory, 'aborted');
    const controller = new AbortController();
    const cancelled = new FeishuKnowledge(abortedDir, async (...args) => {
      const result = await mock(...args);
      controller.abort();
      return result;
    });
    await assert.rejects(cancelled.index(root, 20, controller.signal));
    assert.ok(!(await readdir(abortedDir)).some((name) => /\.json$|\.tmp$/.test(name)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
