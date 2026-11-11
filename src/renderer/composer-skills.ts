import type { ProviderSkill, ProviderSkillDiscovery, WorkspaceSkill } from '../shared/skills';
import type { ElementMention } from '../shared/types';

/** What an inline token of the composer stands for: a page element or a Skill of the current CLI. */
export type ComposerToken = ElementMention | { skill: string };
export const MAX_SKILLS = 3;

interface Segment {
  type: 'text' | 'token';
  text: string;
  value?: ComposerToken;
}

export function isSkillToken(value?: ComposerToken): value is { skill: string } {
  return !!value && 'skill' in value;
}

/** Skills referenced by `/name` tokens in the draft, in order of appearance. */
export function referencedSkills(segments: readonly Segment[]) {
  const names = segments.flatMap((segment) =>
    segment.type === 'token' && isSkillToken(segment.value) ? [segment.value.skill] : [],
  );
  return [...new Set(names)];
}

/** Skills the `/` menu offers for what has been typed after the slash. A path is not a Skill query. */
export function slashSkillOptions(
  skills: readonly ProviderSkill[],
  discovery: ProviderSkillDiscovery | undefined,
  query: string,
) {
  if (discovery?.status !== 'ready' || !/^[a-zA-Z0-9:._-]*$/.test(query)) return [];
  const prefix = query.toLowerCase();
  return skills.filter(
    (skill, index) =>
      skill.userInvocable &&
      skill.name.toLowerCase().startsWith(prefix) &&
      skills.findIndex((other) => other.name === skill.name) === index,
  );
}

export interface SkillSubmission {
  /** The task without its `/name` references. */
  text: string;
  /** The task as typed. Present only when it differs from `text`. */
  displayText?: string;
  selectedSkills: string[];
  /** Only Skills owned by the CLI carry metadata. The host looks the others up in the workspace. */
  selectedSkillMetadata: Array<{
    name: string;
    providerId: string;
    providerPath?: string;
    contentHash?: string;
  }>;
}

/**
 * What a send carries for the Skills of a draft. Skills picked in the toolbar belong to the
 * workspace, Skills referenced inline belong to the CLI: each is checked against its own list.
 */
export function buildSkillSubmission(input: {
  segments: readonly Segment[];
  picked: readonly string[];
  localSkills: readonly WorkspaceSkill[];
  providerSkills: readonly ProviderSkill[];
  discovery?: ProviderSkillDiscovery;
}): SkillSubmission | { error: string } {
  const referenced = referencedSkills(input.segments);
  const picked = input.picked.filter((name) => !referenced.includes(name));
  const selectedSkills = [...picked, ...referenced];
  if (selectedSkills.length > MAX_SKILLS) return { error: `最多选择 ${MAX_SKILLS} 个 Skill` };
  const owned = referenced.map((name) =>
    input.discovery?.status === 'ready'
      ? input.providerSkills.find((skill) => skill.name === name && skill.userInvocable)
      : undefined,
  );
  const local = (name: string) =>
    input.localSkills.some((skill) => skill.name === name && skill.availability === 'usable');
  if (owned.includes(undefined) || !picked.every(local))
    return { error: '引用的 Skill 当前不可用，请刷新或移除引用后重试。' };
  const text = (skipSkills: boolean) =>
    input.segments
      .map((segment) =>
        skipSkills && segment.type === 'token' && isSkillToken(segment.value) ? '' : segment.text,
      )
      .join('')
      .trim();
  return {
    text: text(true),
    ...(referenced.length ? { displayText: text(false) } : {}),
    selectedSkills,
    selectedSkillMetadata: owned.flatMap((skill) =>
      skill
        ? [
            {
              name: skill.name,
              providerId: skill.provider.id,
              ...(skill.providerPath === undefined ? {} : { providerPath: skill.providerPath }),
              ...(skill.contentHash === undefined ? {} : { contentHash: skill.contentHash }),
            },
          ]
        : [],
    ),
  };
}
