import type { NativeSessionRef } from '../shared/types';
import type { NativeSessionDeletionBackend } from './conversation-deletion';

export type NativeDeletionProbe = Awaited<ReturnType<NativeSessionDeletionBackend['probe']>>;

export function createNativeSessionDeletionBackend(): NativeSessionDeletionBackend {
  const reason = (ref: NativeSessionRef) => !ref.scopeVerified
    ? '无法确认 CLI 原始会话的存储归属，暂不能删除'
    : `${ref.agent} 尚未验证安全的单会话删除与写入保护，暂不能删除`;
  return {
    async probe(ref) { return { status: 'blocked', reason: reason(ref) }; },
    async remove(ref) { throw new Error(reason(ref)); },
  };
}
