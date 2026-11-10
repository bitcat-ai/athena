import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store';
import {
  assertOpenConversation,
  defaultConversation,
  deleteConversationRecord,
  feishuConversation,
  setConversationArchived,
} from '../src/main/conversation-records';
import { isArchived, type Conversation } from '../src/shared/types';

const workspace = '/workspace/athena';
function conversation(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: `对话 ${id}`,
    updatedAt: 10,
    workspace,
    agent: 'codex',
    agentSessionId: `thread-${id}`,
    messages: [
      { id: `${id}-u`, role: 'user', text: '检查发布说明', createdAt: 1, status: 'done' },
      { id: `${id}-a`, role: 'assistant', text: '已核对', createdAt: 2, status: 'done' },
    ],
    ...extra,
  };
}
/** 用真实的工作区存储落盘，再用新的实例读回，等同于重启后看到的数据。 */
async function withStore(run: (store: Store, reload: () => Promise<Store>) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'workbench-records-'));
  try {
    const store = new Store(directory);
    await store.load();
    store.data.settings.workspace = workspace;
    store.data.conversations.push(conversation('one'), conversation('two'));
    store.data.recordings.push({ id: 'recording', title: '录制', startedAt: 1, steps: [] });
    await store.save();
    await run(store, async () => {
      const next = new Store(directory);
      await next.load();
      return next;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('archiving keeps the whole record and the mark survives a restart', async () => {
  await withStore(async (store, reload) => {
    const archived = await setConversationArchived(store, 'one', true, undefined, 42);
    assert.equal(archived, store.data.conversations[0]);
    const restarted = await reload();
    assert.deepEqual(restarted.data.conversations, [
      conversation('one', { archivedAt: 42 }),
      conversation('two'),
    ]);
    assert.equal(isArchived(restarted.data.conversations[0]), true);
    assert.equal(isArchived(restarted.data.conversations[1]), false);
  });
});

test('archiving an archived conversation keeps the first archive time', async () => {
  await withStore(async (store, reload) => {
    await setConversationArchived(store, 'one', true, undefined, 42);
    await setConversationArchived(store, 'one', true, undefined, 99);
    assert.equal((await reload()).data.conversations[0].archivedAt, 42);
  });
});

test('restoring removes the archive mark and the record is unchanged after a restart', async () => {
  await withStore(async (store, reload) => {
    await setConversationArchived(store, 'one', true, undefined, 42);
    const restored = await setConversationArchived(store, 'one', false, undefined, 77);
    assert.equal('archivedAt' in restored, false);
    const restarted = await reload();
    assert.deepEqual(restarted.data.conversations, [conversation('one'), conversation('two')]);
    assert.equal('archivedAt' in restarted.data.conversations[0], false);
  });
});

test('deleting removes only that Athena record from the workspace file', async () => {
  await withStore(async (store, reload) => {
    const before = structuredClone(store.data);
    const removed = await deleteConversationRecord(store, 'one', undefined);
    assert.deepEqual(removed, before.conversations[0]);
    const restarted = await reload();
    assert.deepEqual(restarted.data.conversations, [before.conversations[1]]);
    assert.deepEqual(restarted.data.recordings, before.recordings);
    assert.deepEqual(restarted.data.settings, before.settings);
  });
});

test('the conversation whose task is running cannot be archived or deleted', async () => {
  await withStore(async (store, reload) => {
    const before = structuredClone(store.data);
    await assert.rejects(
      () => setConversationArchived(store, 'one', true, 'one', 42),
      /任务还在进行.*停止.*归档/,
    );
    await assert.rejects(
      () => deleteConversationRecord(store, 'one', 'one'),
      /任务还在进行.*停止.*删除/,
    );
    assert.deepEqual(store.data, before);
    assert.deepEqual((await reload()).data.conversations, before.conversations);
  });
});

test('other conversations can be archived or deleted while a task runs elsewhere', async () => {
  await withStore(async (store, reload) => {
    await setConversationArchived(store, 'one', true, 'two', 42);
    assert.equal((await reload()).data.conversations[0].archivedAt, 42);
    await deleteConversationRecord(store, 'one', 'two');
    assert.deepEqual(
      (await reload()).data.conversations.map((item) => item.id),
      ['two'],
    );
  });
});

test('an unknown conversation is reported instead of being ignored', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      () => setConversationArchived(store, 'missing', true, undefined),
      /找不到这个对话/,
    );
    await assert.rejects(
      () => deleteConversationRecord(store, 'missing', undefined),
      /找不到这个对话/,
    );
    assert.equal(store.data.conversations.length, 2);
  });
});

test('a change that cannot be saved is undone and reported', async () => {
  await withStore(async (store, reload) => {
    const before = structuredClone(store.data.conversations);
    const failing = {
      data: store.data,
      save: () => Promise.reject(new Error('磁盘已满')),
    };
    await assert.rejects(
      () => setConversationArchived(failing, 'two', true, undefined, 42),
      /磁盘已满/,
    );
    await assert.rejects(() => deleteConversationRecord(failing, 'one', undefined), /磁盘已满/);
    assert.deepEqual(store.data.conversations, before, 'memory matches what is still on disk');
    await setConversationArchived(store, 'one', true, undefined, 42);
    await setConversationArchived(failing, 'one', false, undefined).catch(() => {});
    assert.equal(store.data.conversations[0].archivedAt, 42, 'a failed restore keeps the mark');
    assert.equal((await reload()).data.conversations[0].archivedAt, 42);
  });
});

test('archived conversations are never opened by default', () => {
  const items = [
    conversation('archived', { archivedAt: 5 }),
    conversation('elsewhere', { workspace: '/workspace/other' }),
    conversation('legacy', { workspace: undefined }),
    conversation('recent'),
  ];
  assert.equal(defaultConversation(items, workspace, 'recent')?.id, 'recent');
  assert.equal(
    defaultConversation(items, workspace, 'archived')?.id,
    'legacy',
    'an archived selection falls back to the first open conversation of the workspace',
  );
  assert.equal(defaultConversation(items, workspace, 'elsewhere')?.id, 'legacy');
  assert.equal(defaultConversation(items, workspace, undefined)?.id, 'legacy');
  assert.equal(
    defaultConversation([items[0], items[1]], workspace, 'archived'),
    undefined,
    'nothing is opened when every conversation of the workspace is archived',
  );
});

test('Feishu messages are not routed into an archived conversation', () => {
  const items = [
    conversation('archived', { remoteChatId: 'chat', archivedAt: 5 }),
    conversation('other-chat', { remoteChatId: 'another' }),
    conversation('elsewhere', { remoteChatId: 'chat', workspace: '/workspace/other' }),
  ];
  assert.equal(feishuConversation(items, workspace, 'chat'), undefined);
  assert.equal(feishuConversation(items, workspace, 'another')?.id, 'other-chat');
  delete items[0].archivedAt;
  assert.equal(feishuConversation(items, workspace, 'chat')?.id, 'archived');
});

test('archived or deleted conversations cannot be prepared or continued', () => {
  const open = conversation('open');
  const archived = conversation('archived', { archivedAt: 5 });
  const items = [open, archived];
  assert.doesNotThrow(() => assertOpenConversation(items, open));
  assert.throws(() => assertOpenConversation(items, archived), /已归档.*恢复/);
  assert.throws(() => assertOpenConversation(items, conversation('deleted')), /找不到这个对话/);
});
