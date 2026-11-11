import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverSkills, discoverWorkspaceSkills } from '../src/main/skill-registry';

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'athena-skills-'));
  await mkdir(path.join(root, '.agents', 'skills'), { recursive: true });
  return root;
}
async function skill(root: string, name: string, content: string) {
  const dir = path.join(root, '.agents', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), content);
}

 test('discovers valid skills with metadata and a stable content hash', async () => {
  const root = await workspace();
  await skill(root, 'review', '---\nname: review\ndescription: Review code\n---\nBe careful.\n');
  const [found] = await discoverWorkspaceSkills(root);
  assert.equal(found.name, 'review');
  assert.equal(found.description, 'Review code');
  assert.equal(found.source, 'workspace');
  assert.equal(found.availability, 'usable');
  assert.equal(found.entryPath, path.join(root, '.agents', 'skills', 'review', 'SKILL.md'));
  assert.match(found.contentHash ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(found.diagnostics, []);
});

test('reads quoted, folded and colon-bearing descriptions', async () => {
  const root = await workspace();
  await skill(root, 'folded', '---\nname: folded\ndescription: >\n  Review code\n  before merging.\n---\n');
  await skill(root, 'quoted', '---\nname: quoted\ndescription: "Use when: reviewing"\n---\n');
  await skill(root, 'plain', '---\nname: plain\ndescription: Use when: reviewing\n---\n');
  const found = await discoverWorkspaceSkills(root);
  assert.deepEqual(
    found.map((item) => [item.name, item.description, item.availability]),
    [
      ['folded', 'Review code before merging.', 'usable'],
      ['plain', 'Use when: reviewing', 'usable'],
      ['quoted', 'Use when: reviewing', 'usable'],
    ],
  );
});

test('isolates malformed and oversized packages from valid packages', async () => {
  const root = await workspace();
  await skill(root, 'valid', '---\nname: valid\ndescription: Valid\n---\n');
  await mkdir(path.join(root, '.agents', 'skills', 'missing'), { recursive: true });
  await skill(root, 'large', `---\nname: large\ndescription: Large\n---\n${'x'.repeat(12 * 1024)}`);
  const found = await discoverWorkspaceSkills(root);
  assert.equal(found.length, 3);
  assert.equal(found.find((item) => item.name === 'valid')?.availability, 'usable');
  assert.equal(found.find((item) => item.packagePath.endsWith('/missing'))?.diagnostics[0]?.code, 'missing-entry');
  assert.equal(found.find((item) => item.name === 'large')?.diagnostics[0]?.code, 'oversized-entry');
});

test('rejects invalid metadata and path traversal without reading outside the boundary', async () => {
  const root = await workspace();
  await skill(root, 'bad', '---\nname: wrong name\ndescription: \n---\n');
  const found = await discoverWorkspaceSkills(root);
  assert.equal(found[0].availability, 'unavailable');
  assert.equal(found[0].diagnostics[0]?.code, 'invalid-metadata');
  assert.equal(found.some((item) => item.entryPath.includes('..')), false);
});

test('rejects a skills root symlink that escapes the workspace', async () => {
  const root = await workspace();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'athena-outside-'));
  await mkdir(path.join(outside, 'skill'), { recursive: true });
  await writeFile(path.join(outside, 'skill', 'SKILL.md'), '---\nname: escaped\ndescription: Escaped\n---\n');
  await rm(path.join(root, '.agents', 'skills'), { recursive: true, force: true });
  await symlink(outside, path.join(root, '.agents', 'skills'));
  await assert.rejects(() => discoverWorkspaceSkills(root), /outside the workspace boundary/);
});

test('discovers global skills and workspace skills override duplicate names', async () => {
  const root = await workspace();
  const home = await mkdtemp(path.join(os.tmpdir(), 'athena-home-'));
  await mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
  await skill(root, 'shared', '---\nname: shared\ndescription: Workspace\n---\nworkspace\n');
  await mkdir(path.join(home, '.agents', 'skills', 'shared'), { recursive: true });
  await writeFile(path.join(home, '.agents', 'skills', 'shared', 'SKILL.md'), '---\nname: shared\ndescription: Global\n---\nglobal\n');
  await mkdir(path.join(home, '.agents', 'skills', 'global-only'), { recursive: true });
  await writeFile(path.join(home, '.agents', 'skills', 'global-only', 'SKILL.md'), '---\nname: global-only\ndescription: Global only\n---\n');

  const result = await discoverSkills(root, home);
  assert.deepEqual(result.skills.map((item) => [item.name, item.source]), [['global-only', 'global'], ['shared', 'workspace']]);
  assert.equal(result.skills.find((item) => item.name === 'shared')?.description, 'Workspace');
  assert.equal(result.global.diagnostics.length, 0);
});

test('missing global root is diagnosable but does not block workspace skills', async () => {
  const root = await workspace();
  const home = await mkdtemp(path.join(os.tmpdir(), 'athena-home-'));
  await skill(root, 'local', '---\nname: local\ndescription: Local\n---\n');
  const result = await discoverSkills(root, home);
  assert.equal(result.skills[0]?.name, 'local');
  assert.equal(result.global.diagnostics[0]?.code, 'missing-root');
});

test('updates the content hash when a skill changes', async () => {
  const root = await workspace();
  await skill(root, 'changing', '---\nname: changing\ndescription: Change\n---\none\n');
  const before = (await discoverWorkspaceSkills(root))[0].contentHash;
  await writeFile(path.join(root, '.agents', 'skills', 'changing', 'SKILL.md'), '---\nname: changing\ndescription: Change\n---\ntwo\n');
  const after = (await discoverWorkspaceSkills(root))[0].contentHash;
  assert.notEqual(before, after);
});

test('normalizes a provider discovery response without applying local Skill file rules', async () => {
  const { normalizeProviderSkillDiscovery } = await import('../src/shared/provider-skills');
  const result = normalizeProviderSkillDiscovery({
    provider: { id: 'codex', name: 'Codex' },
    capability: 'supported',
    skills: [{ name: 'long-guide', description: '', shortDescription: 'Quick help', path: '/workspace/long-guide/SKILL.md', userInvocable: true, contentHash: 'abc' }],
  }, { approvedRoot: '/workspace' });
  assert.equal(result.status, 'ready');
  assert.equal(result.source, 'provider');
  assert.equal(result.provider.id, 'codex');
  assert.equal(result.skills[0]?.description, '未提供描述');
  assert.equal(result.skills[0]?.shortDescription, 'Quick help');
  assert.equal(result.skills[0]?.providerPath, '/workspace/long-guide/SKILL.md');
  assert.equal(result.skills[0]?.contentHash, 'abc');
});

test('reports explicit provider capability and malformed states', async () => {
  const { normalizeProviderSkillDiscovery } = await import('../src/shared/provider-skills');
  assert.equal(normalizeProviderSkillDiscovery({ provider: { id: 'gemini', name: 'Gemini' }, capability: 'unsupported' }).status, 'unsupported');
  assert.equal(normalizeProviderSkillDiscovery({ provider: { id: 'gemini', name: 'Gemini' }, capability: 'unavailable', error: 'not logged in' }).status, 'unavailable');
  assert.equal(normalizeProviderSkillDiscovery({ provider: { id: 'gemini', name: 'Gemini' }, capability: 'supported', skills: [] }).status, 'empty');
  assert.equal(normalizeProviderSkillDiscovery({ provider: { id: 'gemini', name: 'Gemini' }, capability: 'supported', skills: [{ name: '', userInvocable: true }] }).status, 'malformed');
});

test('deduplicates provider names, excludes non-user-invocable entries, and rejects unsafe paths', async () => {
  const { normalizeProviderSkillDiscovery } = await import('../src/shared/provider-skills');
  const result = normalizeProviderSkillDiscovery({ provider: { id: 'pi', name: 'Pi' }, capability: 'supported', skills: [
    { name: 'same', description: 'first', userInvocable: true },
    { name: 'same', description: 'second', userInvocable: true },
    { name: 'hidden', description: 'hidden', userInvocable: false },
    { name: 'escape', description: 'escape', path: '/tmp/secret/SKILL.md', userInvocable: true },
  ] }, { approvedRoot: '/workspace' });
  assert.deepEqual(result.skills.map((skill) => skill.name), ['same']);
  assert.equal(result.diagnostics.some((item) => item.code === 'unsafe-path'), true);
});
