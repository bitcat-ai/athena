import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSkillSubmission,
  referencedSkills,
  slashSkillOptions,
  type ComposerToken,
} from '../src/renderer/composer-skills';
import type { ProviderSkill, ProviderSkillDiscovery, WorkspaceSkill } from '../src/shared/skills';

const provider = { id: 'codex', name: 'Codex' };
const owned = (name: string, extra: Partial<ProviderSkill> = {}): ProviderSkill => ({
  name,
  description: name,
  userInvocable: true,
  source: 'provider',
  provider,
  ...extra,
});
const local = (name: string, availability: WorkspaceSkill['availability'] = 'usable') =>
  ({ name, source: 'workspace', availability }) as WorkspaceSkill;
const discovery = (status: ProviderSkillDiscovery['status'] = 'ready'): ProviderSkillDiscovery => ({
  status,
  source: 'provider',
  provider,
  skills: [],
  diagnostics: [],
});
const text = (value: string) => ({ type: 'text' as const, text: value });
const skill = (name: string) => ({
  type: 'token' as const,
  text: `/${name}`,
  value: { skill: name } as ComposerToken,
});
const element = {
  type: 'token' as const,
  text: '[ele1]',
  value: { token: '[ele1]', ref: 'e1', tag: 'button', name: '提交' } as ComposerToken,
};

test('a Skill picked from the workspace is sent without provider metadata', () => {
  assert.deepEqual(
    buildSkillSubmission({
      segments: [text('检查改动')],
      picked: ['lint'],
      localSkills: [local('lint')],
      providerSkills: [],
      discovery: discovery('unsupported'),
    }),
    { text: '检查改动', selectedSkills: ['lint'], selectedSkillMetadata: [] },
  );
});

test('an inline reference is sent as a Skill of the CLI and leaves the task text', () => {
  assert.deepEqual(
    buildSkillSubmission({
      segments: [skill('review'), text(' 检查 '), element, text(' 的改动')],
      picked: [],
      localSkills: [],
      providerSkills: [owned('review', { providerPath: '/opt/codex/review/SKILL.md' })],
      discovery: discovery(),
    }),
    {
      text: '检查 [ele1] 的改动',
      displayText: '/review 检查 [ele1] 的改动',
      selectedSkills: ['review'],
      selectedSkillMetadata: [
        { name: 'review', providerId: 'codex', providerPath: '/opt/codex/review/SKILL.md' },
      ],
    },
  );
});

test('picked and referenced Skills are sent together, each named once', () => {
  const result = buildSkillSubmission({
    segments: [skill('review'), text(' 任务 '), skill('review')],
    picked: ['lint', 'review'],
    localSkills: [local('lint'), local('review')],
    providerSkills: [owned('review', { contentHash: 'abc' })],
    discovery: discovery(),
  });
  assert.deepEqual(result, {
    text: '任务',
    displayText: '/review 任务 /review',
    selectedSkills: ['lint', 'review'],
    selectedSkillMetadata: [{ name: 'review', providerId: 'codex', contentHash: 'abc' }],
  });
});

test('a Skill that is no longer available stops the send', () => {
  const unavailable = { error: '引用的 Skill 当前不可用，请刷新或移除引用后重试。' };
  const base = { picked: [], localSkills: [], providerSkills: [owned('review')] };
  assert.deepEqual(
    buildSkillSubmission({ ...base, segments: [skill('gone')], discovery: discovery() }),
    unavailable,
  );
  assert.deepEqual(
    buildSkillSubmission({ ...base, segments: [skill('review')], discovery: discovery('unavailable') }),
    unavailable,
  );
  assert.deepEqual(
    buildSkillSubmission({
      ...base,
      segments: [skill('review')],
      providerSkills: [owned('review', { userInvocable: false })],
      discovery: discovery(),
    }),
    unavailable,
  );
  assert.deepEqual(
    buildSkillSubmission({
      segments: [text('任务')],
      picked: ['lint'],
      localSkills: [local('lint', 'unavailable')],
      providerSkills: [owned('lint')],
      discovery: discovery(),
    }),
    unavailable,
  );
});

test('at most three Skills are sent', () => {
  assert.deepEqual(
    buildSkillSubmission({
      segments: [skill('review'), skill('research')],
      picked: ['a', 'b'],
      localSkills: [local('a'), local('b')],
      providerSkills: [owned('review'), owned('research')],
      discovery: discovery(),
    }),
    { error: '最多选择 3 个 Skill' },
  );
});

test('references are read from Skill tokens only', () => {
  assert.deepEqual(
    referencedSkills([text('/unknown /tmp/review '), element, skill('review'), skill('review')]),
    ['review'],
  );
});

test('the slash menu offers invocable Skills matching the typed prefix', () => {
  const skills = [
    owned('review'),
    owned('research'),
    owned('review', { description: 'duplicate' }),
    owned('hidden', { userInvocable: false }),
    owned('lint'),
  ];
  const names = (query: string, status?: ProviderSkillDiscovery['status']) =>
    slashSkillOptions(skills, discovery(status), query).map((item) => item.name);
  assert.deepEqual(names(''), ['review', 'research', 'lint']);
  assert.deepEqual(names('RE'), ['review', 'research']);
  assert.deepEqual(names('rev'), ['review']);
  assert.deepEqual(names('tmp/file'), []);
  assert.deepEqual(names('', 'unavailable'), []);
  assert.deepEqual(slashSkillOptions(skills, undefined, ''), []);
});
