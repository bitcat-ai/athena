import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeSessionDeletionBackend } from '../src/main/native-session-deletion';
import type { AgentId } from '../src/shared/types';

test('缺少可靠删除证据时所有 CLI 明确阻止，不能伪报 missing', async () => {
  const backend = createNativeSessionDeletionBackend();
  for (const agent of ['codex', 'claude', 'gemini', 'cursor', 'pi', 'opencode'] satisfies AgentId[]) {
    const ref = { agent, id: 'native', workspace: '/project', scopeVerified: false };
    const result = await backend.probe(ref);
    assert.equal(result.status, 'blocked');
    await assert.rejects(backend.remove(ref), /无法|尚未/);
  }
});
