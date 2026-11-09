import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSkillContext, selectProviderSkills, selectSkills } from '../src/main/skill-injection';
import type { ProviderSkill, WorkspaceSkill } from '../src/shared/skills';

const usable = (name: string, hash = name): WorkspaceSkill => ({
  name,
  description: `${name} description`,
  source: 'workspace',
  packagePath: `/workspace/.agents/skills/${name}`,
  entryPath: `/workspace/.agents/skills/${name}/SKILL.md`,
  contentHash: hash,
  availability: 'usable',
  diagnostics: [],
});

test('selects up to three usable skills and rejects invalid selections', () => {
  const skills = [usable('one'), usable('two'), usable('three'), usable('four'), { ...usable('broken'), availability: 'unavailable' as const }];
  assert.deepEqual(selectSkills(skills, ['three', 'one']), [skills[2], skills[0]]);
  assert.throws(() => selectSkills(skills, ['one', 'broken']), /不可用/);
  assert.throws(() => selectSkills(skills, ['one', 'two', 'three', 'four']), /最多选择 3/);
  assert.throws(() => selectSkills(skills, ['missing']), /不存在/);
});

test('revalidates optional provider path and hash before injection', () => {
  const skill: ProviderSkill = {
    name: 'review', description: 'Review', source: 'provider', provider: { id: 'codex', name: 'Codex' },
    providerPath: '/workspace/review/SKILL.md', contentHash: 'v1', userInvocable: true,
  };
  assert.deepEqual(selectProviderSkills([skill], ['review'], 'codex', [{
    name: 'review', providerId: 'codex', providerPath: '/workspace/review/SKILL.md', contentHash: 'v1',
  }]), [skill]);
  assert.throws(() => selectProviderSkills([skill], ['review'], 'codex', [{ name: 'review', providerId: 'codex', contentHash: 'v2' }]), /内容已改变/);
  assert.throws(() => selectProviderSkills([skill], ['review'], 'codex', [{ name: 'review', providerId: 'codex', providerPath: '/workspace/other/SKILL.md' }]), /路径已改变/);
});
test('builds progressive context without copying skill bodies', () => {
  const context = buildSkillContext([usable('review', 'abc')]);
  assert.match(context!, /review/);
  assert.match(context!, /abc/);
  assert.match(context!, /SKILL\.md/);
  assert.doesNotMatch(context!, /description: review description/);
  assert.match(context!, /按需读取/);
});
