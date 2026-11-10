import assert from 'node:assert/strict';
import test from 'node:test';
import { collectDeletionTargets, assertNoSharedReferences, recordNativeSession, deleteConversation } from '../src/main/conversation-deletion';
import type { Conversation, NativeSessionRef } from '../src/shared/types';

const conversation = (extra: Partial<Conversation> = {}): Conversation => ({
  id: 'one', title: '测试', updatedAt: 1, messages: [], ...extra,
});
const ref = (extra: Partial<NativeSessionRef> = {}): NativeSessionRef => ({
  agent: 'pi', id: 'native', workspace: '/project', storageRoot: '/sessions', scopeVerified: true, ...extra,
});

test('删除取消时没有停止、预检或持久化副作用', async () => {
  const item = conversation();
  const calls: string[] = [];
  const backend = {
    async probe() { calls.push('probe'); return { status: 'missing' as const }; },
    async remove() { calls.push('remove'); return 'missing' as const; },
  };
  assert.equal(await deleteConversation({ conversationId: item.id }, {
    async confirm() { calls.push('confirm'); return false; },
    getConversations: () => [item],
    async persist() { calls.push('persist'); },
    async quiesce() { calls.push('quiesce'); },
    backend,
    async removeLocal() { calls.push('removeLocal'); },
  }), false);
  assert.deepEqual(calls, ['confirm']);
});


test('预检受阻不停止任务也不删除；空对话在确认后停止并本地收尾', async () => {
  for (const hasTarget of [true, false]) {
    const item = conversation({ nativeSessionRefs: hasTarget ? [ref()] : [] });
    const calls: string[] = [];
    const operation = deleteConversation({ conversationId: item.id }, {
      async confirm() { return true; },
      getConversations: () => [item],
      async persist() { calls.push('persist'); },
      async quiesce() { calls.push('stop'); },
      backend: {
        async probe() { return { status: 'blocked', reason: '无法确认存储归属' }; },
        async remove() { throw new Error('不可执行'); },
      },
      async removeLocal() { calls.push('local'); },
    });
    if (hasTarget) {
      await assert.rejects(operation, /归属/);
      assert.deepEqual(calls, []);
    } else {
      assert.equal(await operation, true);
      assert.deepEqual(calls, ['stop', 'local']);
    }
  }
});

test('部分失败持久化已完成目标，显式重试只删除剩余且复核已完成目标', async () => {
  const item = conversation({ nativeSessionRefs: [ref({ id: 'a' }), ref({ id: 'b' })] });
  const present = new Set(['a', 'b']);
  const removed: string[] = [];
  let fail = true;
  const deps = {
    async confirm() { return true; }, getConversations: () => [item],
    async persist() {}, async quiesce() {},
    backend: {
      async probe(target: NativeSessionRef) {
        return present.has(target.id)
          ? { status: 'ready' as const, target }
          : { status: 'missing' as const };
      },
      async remove(target: NativeSessionRef) {
        if (target.id === 'b' && fail) throw new Error('删除失败');
        removed.push(target.id); present.delete(target.id);
        return 'deleted' as const;
      },
    },
    async removeLocal() {},
  };
  await assert.rejects(deleteConversation({ conversationId: item.id }, deps), /部分.*保留/);
  assert.equal(item.deletion?.completed.length, 1);
  fail = false;
  assert.equal(await deleteConversation({ conversationId: item.id }, deps), true);
  assert.deepEqual(removed, ['a', 'b']);
  present.add('a');
  await assert.rejects(deleteConversation({ conversationId: item.id }, deps), /重新出现/);
});

test('进度保存失败立即停止，停止期间晚到的目标重新预检', async () => {
  const item = conversation({ nativeSessionRefs: [ref()] });
  let removes = 0;
  const deps = {
    async confirm() { return true; }, getConversations: () => [item],
    async persist() { throw new Error('磁盘失败'); },
    async quiesce() {},
    backend: {
      async probe(target: NativeSessionRef) { return { status: 'ready' as const, target }; },
      async remove() { removes++; return 'deleted' as const; },
    },
    async removeLocal() { throw new Error('不可执行'); },
  };
  await assert.rejects(deleteConversation({ conversationId: item.id }, deps), /保留/);
  assert.equal(removes, 0);
  await assert.rejects(deleteConversation({ conversationId: item.id }, {
    ...deps,
    async persist() {},
    async quiesce() { item.previousAgentSessionIds = ['late']; item.agent = 'pi'; },
    backend: {
      ...deps.backend,
      async probe(target: NativeSessionRef) {
        return target.id === 'late' ? { status: 'blocked' as const, reason: '晚到关联无法确认' }
          : { status: 'ready' as const, target };
      },
    },
  }), /晚到/);
  assert.equal(removes, 0);
});

test('同一对话的重复删除请求在确认期间就被阻止，取消后可重试', async () => {
  const item = conversation();
  let release: ((value: boolean) => void) | undefined;
  const deps = {
    confirm: () => release ? Promise.resolve(false)
      : new Promise<boolean>((resolve) => { release = resolve; }),
    getConversations: () => [item], async persist() {}, async quiesce() {},
    backend: { async probe() { return { status: 'missing' as const }; }, async remove() { return 'missing' as const; } },
    async removeLocal() {},
  };
  const first = deleteConversation({ conversationId: item.id }, deps);
  await assert.rejects(deleteConversation({ conversationId: item.id }, deps), /正在删除/);
  release?.(false);
  assert.equal(await first, false);
  const retry = deleteConversation({ conversationId: item.id }, deps);
  release?.(false);
  assert.equal(await retry, false);
});

test('记录新归属时保留旧编号且不追认历史作用域', () => {
  const item = conversation({ agent: 'pi', agentSessionId: 'old' });
  recordNativeSession(item, ref());
  recordNativeSession(item, ref());
  assert.equal(item.agentSessionId, 'native');
  assert.deepEqual(item.previousAgentSessionIds, ['old']);
  assert.deepEqual(item.nativeSessionRefs, [ref()]);
  assert.equal(collectDeletionTargets(item).find((target) => target.id === 'old')?.scopeVerified, false);
});

test('删除目标合并当前历史关联且不伪造旧数据作用域', () => {
  const targets = collectDeletionTargets(conversation({ agentSessionId: 'current', previousAgentSessionIds: ['past', 'current'], workspace: '/old' }));
  assert.deepEqual(targets.map(({ agent, id, workspace, scopeVerified }) => ({ agent, id, workspace, scopeVerified })), [
    { agent: 'codex', id: 'current', workspace: '/old', scopeVerified: false },
    { agent: 'codex', id: 'past', workspace: '/old', scopeVerified: false },
  ]);
  assert.deepEqual(collectDeletionTargets(conversation()), []);
});

test('明确归属替代旧字段但不丢失未覆盖的历史ID', () => {
  const targets = collectDeletionTargets(conversation({ agent: 'pi', agentSessionId: 'native', previousAgentSessionIds: ['old'], nativeSessionRefs: [ref(), ref()] }));
  assert.equal(targets.length, 2);
  assert.equal(targets[0].scopeVerified, true);
  assert.equal(targets[1].id, 'old');
  assert.equal(targets[1].scopeVerified, false);
});

test('共享当前或历史关联均阻止删除，未知作用域不绕过检查', () => {
  const target = conversation({ nativeSessionRefs: [ref()] });
  for (const other of [
    conversation({ id: 'two', agent: 'pi', agentSessionId: 'native' }),
    conversation({ id: 'two', agent: 'pi', previousAgentSessionIds: ['native'] }),
    conversation({ id: 'two', nativeSessionRefs: [ref()] }),
  ]) assert.throws(() => assertNoSharedReferences(target, [target, other]), /引用/);
});

test('同一 session-dir 中不同工作区和 ID 仍是不同 Pi 会话', () => {
  const target = conversation({ nativeSessionRefs: [ref()] });
  assert.doesNotThrow(() => assertNoSharedReferences(target, [
    target,
    conversation({
      id: 'two',
      nativeSessionRefs: [ref({ id: 'other', workspace: '/other' })],
    }),
  ]));
});

test('已证实不同存储根目录不视为共享，同一根目录不因工作区不同放行', () => {
  const target = conversation({ nativeSessionRefs: [ref()] });
  assert.doesNotThrow(() => assertNoSharedReferences(target, [target, conversation({ id: 'two', nativeSessionRefs: [ref({ storageRoot: '/elsewhere' })] })]));
  assert.throws(() => assertNoSharedReferences(target, [target, conversation({ id: 'two', nativeSessionRefs: [ref({ workspace: '/other' })] })]), /引用/);
});
