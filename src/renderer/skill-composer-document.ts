import type { JSONContent } from '@tiptap/core';

export const emptySkillDocument: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

export function skillDocumentFromText(text: string, names: readonly string[] = []): JSONContent {
  const known = new Set(names);
  return {
    type: 'doc',
    content: text.split('\n').map((line) => {
      const content: JSONContent[] = [];
      const pattern = /(^|\s)\/([a-zA-Z0-9][a-zA-Z0-9:._-]*)(?=\s|$)/g;
      let offset = 0;
      for (const match of line.matchAll(pattern)) {
        if (!known.has(match[2])) continue;
        const start = match.index! + match[1].length;
        if (start > offset) content.push({ type: 'text', text: line.slice(offset, start) });
        content.push({ type: 'athenaSkill', attrs: { name: match[2] } });
        offset = start + match[2].length + 1;
      }
      if (offset < line.length) content.push({ type: 'text', text: line.slice(offset) });
      return { type: 'paragraph', ...(content.length ? { content } : {}) };
    }),
  };
}

/** Display text retains references; task text separates them at the provider boundary. */
export function serializeSkillDocument(doc: JSONContent) {
  const names: string[] = [];
  function text(node: JSONContent, includeReferences: boolean): string {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'athenaSkill') {
      const name = node.attrs?.name;
      if (typeof name !== 'string') return '';
      if (!names.includes(name)) names.push(name);
      return includeReferences ? `/${name}` : '';
    }
    return (node.content ?? []).map((child) => text(child, includeReferences)).join(node.type === 'doc' ? '\n' : '');
  }
  const displayText = text(doc, true);
  const taskText = text(doc, false);
  return { displayText, text: taskText, names };
}

export function buildSkillSubmission(doc: JSONContent, selectedSkills: readonly string[]) {
  const parsed = serializeSkillDocument(doc);
  const names = [...new Set([...selectedSkills, ...parsed.names])];
  return {
    text: parsed.text.trim(),
    selectedSkills: names,
    promptText: names.length ? `${names.map((name) => `/skill:${name}`).join('\n')}\n\n${parsed.text.trim()}` : parsed.text.trim(),
  };
}
