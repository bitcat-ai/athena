import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverWorkspaceSkills } from '../src/main/skill-registry';

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

test('updates the content hash when a skill changes', async () => {
  const root = await workspace();
  await skill(root, 'changing', '---\nname: changing\ndescription: Change\n---\none\n');
  const before = (await discoverWorkspaceSkills(root))[0].contentHash;
  await writeFile(path.join(root, '.agents', 'skills', 'changing', 'SKILL.md'), '---\nname: changing\ndescription: Change\n---\ntwo\n');
  const after = (await discoverWorkspaceSkills(root))[0].contentHash;
  assert.notEqual(before, after);
});
