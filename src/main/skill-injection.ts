import type { ProviderSkill, WorkspaceSkill } from '../shared/skills';

export const MAX_SELECTED_SKILLS = 3;
export type SelectableSkill = WorkspaceSkill | ProviderSkill;

export function selectSkills(available: SelectableSkill[], names: string[]): SelectableSkill[] {
  if (names.length > MAX_SELECTED_SKILLS) throw new Error('最多选择 3 个 Skill');
  const unique = [...new Set(names)];
  if (unique.length !== names.length) throw new Error('Skill 选择不能重复');
  return unique.map((name) => {
    const skill = available.find((item) => item.name === name);
    if (!skill) throw new Error(`Skill 不存在：${name}`);
    if ('availability' in skill && skill.availability !== 'usable') throw new Error(`Skill 不可用：${name}`);
    if ('userInvocable' in skill && !skill.userInvocable) throw new Error(`Skill 不可用：${name}`);
    return skill;
  });
}

/** Revalidates provider identity and optional trace metadata at the send boundary. */
export interface ProviderSkillExpectation {
  name: string;
  providerId: string;
  providerPath?: string;
  contentHash?: string;
}

/** Revalidates identity and the optional trace metadata captured by the renderer. */
export function selectProviderSkills(
  available: ProviderSkill[],
  names: string[],
  providerId: string,
  expectations: ProviderSkillExpectation[] = [],
): ProviderSkill[] {
  const selected = selectSkills(available, names).filter((skill): skill is ProviderSkill => skill.source === 'provider');
  for (const skill of selected) {
    if (skill.provider.id !== providerId) throw new Error(`Skill provider 已改变：${skill.name}`);
    const expected = expectations.find((item) => item.name === skill.name);
    if (!expected) continue;
    if (expected.providerId !== skill.provider.id) throw new Error(`Skill provider 已改变：${skill.name}`);
    if (expected.providerPath !== undefined && expected.providerPath !== skill.providerPath)
      throw new Error(`Skill 路径已改变：${skill.name}`);
    if (expected.contentHash !== undefined && expected.contentHash !== skill.contentHash)
      throw new Error(`Skill 内容已改变：${skill.name}`);
  }
  return selected;
}

// A description is written by the Skill's author and sits next to Athena's own instructions: it stays one bounded line.
function oneLine(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim().replace(/</g, '＜');
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/** Metadata and a bounded path are injected; the CLI reads the entry progressively. */
export function buildSkillContext(skills: SelectableSkill[]): string | undefined {
  if (!skills.length) return undefined;
  return [
    'Athena 已为本轮选择以下 Skill。请按需读取对应 SKILL.md，不要假设未读取的正文内容；Skill 不会改变 CLI 原有沙箱、工具或审批边界。',
    ...skills.map((skill) => 'provider' in skill
      ? `- Skill: ${skill.name}（来源：provider，提供方：${skill.provider.id}，内容哈希：${skill.contentHash ?? 'unknown'}）\n  入口：${skill.providerPath ?? 'provider-managed'}\n  描述：${oneLine(skill.description)}\n  使用时请先读取入口文件。`
      : `- Skill: ${skill.name}（来源：${skill.source}，内容哈希：${skill.contentHash ?? 'unknown'}）\n  入口：${skill.entryPath}\n  描述：${oneLine(skill.description ?? '未提供')}\n  使用时请先读取入口文件.`),
  ].join('\n');
}
