import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderSkillDiscoveryAdapter } from '../src/main/provider-skill-discovery';

const providers = [
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
  ['gemini', 'Gemini CLI'],
  ['pi', 'Pi'],
  ['cursor', 'Cursor Agent'],
] as const;

for (const [id, name] of providers) {
  test(`${id} provider fixture normalizes the common discovery contract`, async () => {
    const adapter = createProviderSkillDiscoveryAdapter({ id, name }, async () => ({
      capability: 'supported',
      skills: [
        { name: 'zeta', description: 'Z', userInvocable: true, providerExtra: 'ignored' },
        { name: 'alpha', shortDescription: 'A', userInvocable: true, size: 100_000 },
        { name: 'alpha', description: 'duplicate', userInvocable: true },
        { name: 'internal', description: 'hidden', userInvocable: false },
      ],
    }), { approvedRoot: '/workspace' });
    const result = await adapter.discover();
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.skills.map((skill) => skill.name), ['alpha', 'zeta']);
    assert.equal(result.skills[0]?.description, '未提供描述');
    assert.equal(result.skills[0]?.shortDescription, 'A');
    assert.equal(result.skills[0]?.provider.id, id);
  });
}

test('provider discovery reports unavailable and malformed without local fallback', async () => {
  const unavailable = createProviderSkillDiscoveryAdapter({ id: 'codex', name: 'Codex' }, async () => {
    throw new Error('fixture unavailable');
  });
  assert.equal((await unavailable.discover()).status, 'unavailable');
  const malformed = createProviderSkillDiscoveryAdapter({ id: 'pi', name: 'Pi' }, async () => ({ capability: 'supported', skills: [{ name: '' }] }));
  const result = await malformed.discover();
  assert.equal(result.status, 'malformed');
  assert.equal(result.skills.length, 0);
});

test('unsupported provider discovery is explicit and deterministic', async () => {
  const adapter = createProviderSkillDiscoveryAdapter({ id: 'cursor', name: 'Cursor Agent' }, async () => ({ capability: 'unsupported' }));
  const result = await adapter.discover();
  assert.equal(result.status, 'unsupported');
  assert.deepEqual(result.skills, []);
});
