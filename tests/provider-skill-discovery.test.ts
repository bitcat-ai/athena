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

test('provider discovery normalizes skill metadata without imposing a local size limit', async () => {
  const adapter = createProviderSkillDiscoveryAdapter({ id: 'pi', name: 'Pi' }, async () => ({
    capability: 'supported',
    skills: [
      { name: 'large-skill', description: 'Useful', userInvocable: true, size: 100_000 },
      { name: 'without-description', userInvocable: true },
      { name: 'internal', description: 'Hidden', userInvocable: false },
    ],
  }));
  const result = await adapter.discover();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.skills.map((skill) => skill.name), ['large-skill', 'without-description']);
  assert.equal(result.skills[0]?.description, 'Useful');
  assert.equal(result.skills[1]?.description, '未提供描述');
});

test('provider discovery preserves provider-owned global paths as opaque optional metadata', async () => {
  const managed = createProviderSkillDiscoveryAdapter({ id: 'pi', name: 'Pi' }, async () => ({
    capability: 'supported',
    skills: [
      { name: 'global', path: '/Users/example/.pi/agent/skills/global/SKILL.md', userInvocable: true },
      { name: 'without-path', userInvocable: true },
    ],
  }), { approvedRoot: '/workspace', providerManagedPaths: true });
  const result = await managed.discover();
  assert.equal(result.status, 'ready');
  assert.equal(result.skills.find((skill) => skill.name === 'global')?.providerPath, '/Users/example/.pi/agent/skills/global/SKILL.md');
  assert.equal(result.skills.find((skill) => skill.name === 'global')?.contentHash, undefined);
  assert.equal(result.skills.find((skill) => skill.name === 'without-path')?.providerPath, undefined);
  assert.equal(result.skills.find((skill) => skill.name === 'without-path')?.contentHash, undefined);
});

test('provider discovery rejects paths outside approved roots for local filesystem skills', async () => {
  const local = createProviderSkillDiscoveryAdapter({ id: 'codex', name: 'Codex' }, async () => ({
    capability: 'supported',
    skills: [{ name: 'outside', path: '/other/skill.md', userInvocable: true }],
  }), { approvedRoot: '/workspace' });
  assert.equal((await local.discover()).status, 'malformed');
});

test('provider fixture normalizes the common discovery contract', async () => {
  for (const [id, name] of providers) {
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
  }
});

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
