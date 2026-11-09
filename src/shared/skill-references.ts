export interface ParsedSkillReferences {
  names: string[];
  text: string;
}

const REFERENCE = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/;

/** Parse only the consecutive, leading Skill references in a task draft. */
export function parseLeadingSkillReferences(draft: string): ParsedSkillReferences {
  let remaining = draft;
  const names: string[] = [];
  while (true) {
    const match = remaining.match(REFERENCE);
    if (!match) break;
    names.push(match[1]);
    remaining = remaining.slice(match[0].length).replace(/^\s+/, '');
  }
  return { names, text: remaining };
}
