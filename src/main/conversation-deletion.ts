import type { Conversation, NativeSessionRef } from '../shared/types';

export interface NativeSessionDeletionBackend {
  probe(ref: NativeSessionRef): Promise<
    | { status: 'ready'; target: NativeSessionRef }
    | { status: 'missing' }
    | { status: 'blocked'; reason: string }
  >;
  remove(ref: NativeSessionRef): Promise<'deleted' | 'missing'>;
}

export interface ConversationDeletionDependencies {
  confirm(conversation: Conversation): Promise<boolean>;
  getConversations(): Conversation[];
  persist(): Promise<void>;
  quiesce(conversationId: string): Promise<void>;
  backend: NativeSessionDeletionBackend;
  removeLocal(conversationId: string): Promise<void>;
}

const deletingConversations = new Set<string>();

export async function deleteConversation(
  request: { conversationId: string },
  deps: ConversationDeletionDependencies,
): Promise<boolean> {
  if (deletingConversations.has(request.conversationId)) throw new Error('此对话正在删除');
  deletingConversations.add(request.conversationId);
  try {
    return await deleteConversationLocked(request, deps);
  } finally {
    deletingConversations.delete(request.conversationId);
  }
}

async function deleteConversationLocked(
  request: { conversationId: string },
  deps: ConversationDeletionDependencies,
): Promise<boolean> {
  const conversation = deps.getConversations().find((item) => item.id === request.conversationId);
  if (!conversation) throw new Error('找不到这个对话');
  if (!await deps.confirm(conversation)) return false;
  const preflight = async () => {
    if (!deps.getConversations().includes(conversation)) throw new Error('此对话已删除');
    assertNoSharedReferences(conversation, deps.getConversations());
    const targets = collectDeletionTargets(conversation);
    for (const target of targets) {
      const result = await deps.backend.probe(target);
      if (result.status === 'blocked') throw new Error(result.reason);
      if (conversation.deletion?.completed.includes(nativeSessionKey(target)) && result.status !== 'missing')
        throw new Error('已删除的原始会话重新出现，请重新核对后再操作');
    }
    return targets;
  };
  await preflight();
  await deps.quiesce(conversation.id);
  const targets = await preflight();
  if (!targets.length) {
    await deps.removeLocal(conversation.id);
    return true;
  }
  conversation.deletion = {
    targets,
    completed: [...(conversation.deletion?.completed ?? [])],
  };
  try {
    await deps.persist();
    for (const target of targets) {
      const key = nativeSessionKey(target);
      if (conversation.deletion.completed.includes(key)) continue;
      assertNoSharedReferences(conversation, deps.getConversations());
      const result = await deps.backend.probe(target);
      if (result.status === 'blocked') throw new Error(result.reason);
      if (result.status === 'ready') await deps.backend.remove(target);
      if ((await deps.backend.probe(target)).status !== 'missing')
        throw new Error('无法核实原始会话已删除');
      conversation.deletion.completed.push(key);
      await deps.persist();
    }
    await deps.removeLocal(conversation.id);
    return true;
  } catch {
    const message = conversation.deletion.completed.length
      ? 'CLI 原始记录已部分删除，Athena 对话仍保留；请重试剩余项'
      : '删除未完成，Athena 对话仍保留；请检查后重试';
    conversation.deletion.lastError = message;
    throw new Error(message);
  }
}

export function nativeSessionKey(ref: NativeSessionRef): string {
  return JSON.stringify([ref.agent, ref.storageRoot ?? null, ref.workspace, ref.id]);
}

export function recordNativeSession(conversation: Conversation, ref: NativeSessionRef): void {
  if (conversation.agentSessionId && conversation.agentSessionId !== ref.id) {
    conversation.previousAgentSessionIds = [...new Set([
      ...(conversation.previousAgentSessionIds ?? []), conversation.agentSessionId,
    ])];
  }
  conversation.agentSessionId = ref.id;
  const refs = conversation.nativeSessionRefs ??= [];
  const index = refs.findIndex((item) => nativeSessionKey(item) === nativeSessionKey(ref));
  if (index < 0) refs.push({ ...ref });
  else if (ref.scopeVerified) refs[index] = { ...ref };
}

export function collectDeletionTargets(conversation: Conversation): NativeSessionRef[] {
  const refs = new Map<string, NativeSessionRef>();
  for (const ref of [...(conversation.nativeSessionRefs ?? []), ...(conversation.deletion?.targets ?? [])]) {
    const key = nativeSessionKey(ref);
    if (!refs.has(key) || ref.scopeVerified) refs.set(key, { ...ref });
  }
  const agent = conversation.agent ?? 'codex';
  for (const id of [conversation.agentSessionId, ...(conversation.previousAgentSessionIds ?? [])]) {
    if (!id || [...refs.values()].some((ref) => ref.agent === agent && ref.id === id)) continue;
    const ref: NativeSessionRef = { agent, id, workspace: conversation.workspace ?? '', scopeVerified: false };
    refs.set(nativeSessionKey(ref), ref);
  }
  return [...refs.values()];
}

export function assertNoSharedReferences(target: Conversation, all: Conversation[]): void {
  const targets = collectDeletionTargets(target);
  for (const other of all) {
    if (other.id === target.id) continue;
    for (const candidate of collectDeletionTargets(other)) {
      if (targets.some((ref) => ref.agent === candidate.agent && ref.id === candidate.id && (
        !ref.scopeVerified || !candidate.scopeVerified || !ref.storageRoot || !candidate.storageRoot ||
        ref.storageRoot === candidate.storageRoot
      ))) throw new Error('CLI 原始会话仍被其他对话引用，无法删除');
    }
  }
}
