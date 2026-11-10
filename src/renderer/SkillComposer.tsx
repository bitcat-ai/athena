import { Node, mergeAttributes } from '@tiptap/core';
import type { Editor, JSONContent } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useId, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ProviderSkillDiscovery, ProviderSkill } from '../shared/skills';
import { serializeSkillDocument, skillDocumentFromText } from './skill-composer-document';

const SkillNode = Node.create({
  name: 'athenaSkill', group: 'inline', inline: true, atom: true, selectable: true,
  addAttributes() { return { name: { default: '', parseHTML: (element) => element.getAttribute('data-skill-name') } }; },
  parseHTML() { return [{ tag: 'span[data-skill-name]' }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-skill-name': node.attrs.name, class: 'composer-skill-reference', contenteditable: 'false' }), `/${node.attrs.name}`];
  },
  renderText({ node }) { return `/${node.attrs.name}`; },
});

function findTrigger(editor: Editor) {
  const { empty, $from } = editor.state.selection;
  if (!empty || !$from.parent.isTextblock) return;
  // Leaf placeholders occupy one document position, just like inline atoms.
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const after = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, undefined, '￼');
  const match = /(?:^|\s)\/([a-zA-Z0-9:._-]*)$/.exec(before);
  if (!match || /^[a-zA-Z0-9:._-]*\//.test(after)) return;
  const from = $from.pos - match[1].length - 1;
  const suffix = /^[a-zA-Z0-9:._-]*/.exec(after)![0];
  return { from, to: $from.pos + suffix.length, query: match[1] };
}

export function SkillComposer({ value, skills, selectedSkills, editorRef, onValueChange, onSubmit, onMenuOpenChange, discovery, placeholder }: {
  value: JSONContent;
  skills: ProviderSkill[];
  selectedSkills: string[];
  editorRef: MutableRefObject<Editor | null>;
  onValueChange: (doc: JSONContent) => void;
  onSubmit: () => void;
  onMenuOpenChange: (open: boolean) => void;
  discovery?: ProviderSkillDiscovery;
  placeholder: string;
}) {
  const id = useId();
  const [trigger, setTrigger] = useState<ReturnType<typeof findTrigger>>();
  const [active, setActive] = useState(0);
  const dismissed = useRef<string | undefined>(undefined);
  const latest = useRef({ value, skills, selectedSkills, onValueChange, onSubmit });
  latest.current = { value, skills, selectedSkills, onValueChange, onSubmit };
  const keyboard = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, blockquote: false, bulletList: false, orderedList: false, codeBlock: false, horizontalRule: false, bold: false, italic: false, strike: false, code: false, link: false, underline: false }), SkillNode],
    content: value,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': '发送给 Agent 的任务', 'aria-multiline': 'true', class: 'composer-rich-text' },
      handleKeyDown: (_view, event) => keyboard.current(event),
      clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, '\n', (node) => node.type.name === 'athenaSkill' ? `/${node.attrs.name}` : ''),
      handlePaste: (_view, event) => {
        const text = event.clipboardData?.getData('text/plain');
        const current = editorRef.current;
        if (!text || !current) return false;
        event.preventDefault();
        const doc = skillDocumentFromText(text, latest.current.skills.filter((skill) => skill.userInvocable).map((skill) => skill.name));
        current.commands.insertContent(doc.content ?? []);
        return true;
      },
    },
    onUpdate: ({ editor }) => latest.current.onValueChange(editor.getJSON()),
    onTransaction: ({ editor }) => {
      const next = findTrigger(editor);
      const key = next ? `${next.from}:${next.to}:${next.query}` : undefined;
      if (key !== dismissed.current) dismissed.current = undefined;
      setTrigger(key && key !== dismissed.current ? next : undefined);
    },
  });
  const available = discovery?.status === 'ready' ? skills.filter((skill) => skill.userInvocable) : [];
  const chosen = new Set([...selectedSkills, ...serializeSkillDocument(value).names]);
  const options = available.filter((skill, index) => available.findIndex((other) => other.name === skill.name) === index)
    .filter((skill) => skill.name.toLowerCase().startsWith(trigger?.query.toLowerCase() ?? ''));
  const open = Boolean(trigger);
  useEffect(() => { onMenuOpenChange(open); }, [open, onMenuOpenChange]);
  useEffect(() => { setActive(0); }, [trigger?.from, trigger?.query]);
  useEffect(() => {
    editorRef.current = editor;
    return () => { if (editorRef.current === editor) editorRef.current = null; };
  }, [editor, editorRef]);
  useEffect(() => {
    if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(value)) {
      editor.commands.setContent(value, { emitUpdate: false });
      setTrigger(undefined);
    }
  }, [editor, value]);
  const close = () => {
    dismissed.current = trigger ? `${trigger.from}:${trigger.to}:${trigger.query}` : undefined;
    setTrigger(undefined);
  };
  const choose = (skill: ProviderSkill) => {
    if (!editor || !trigger || chosen.has(skill.name) || chosen.size >= 3) return;
    const current = findTrigger(editor);
    if (!current || current.from !== trigger.from || current.to !== trigger.to) return;
    const trailingSpace = editor.state.doc.textBetween(current.to, current.to + 1) === ' ';
    editor.chain().focus().insertContentAt({ from: current.from, to: current.to + (trailingSpace ? 1 : 0) }, [
      { type: 'athenaSkill', attrs: { name: skill.name } }, { type: 'text', text: ' ' },
    ]).run();
    close();
  };
  keyboard.current = (event) => {
    if (event.isComposing || event.keyCode === 229 || editor?.view.composing) {
      if (event.key === 'Enter') event.stopPropagation();
      return false;
    }
    if (open && ['Escape', 'ArrowDown', 'ArrowUp', 'Tab', 'Enter'].includes(event.key) && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') close();
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (options.length) setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
      } else if (options.length) choose(options[Math.min(active, options.length - 1)]);
      return true;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation(); latest.current.onSubmit(); return true;
    }
    return false;
  };
  return <div className="skill-composer">
    <EditorContent editor={editor} data-placeholder={placeholder} aria-controls={open ? id : undefined} />
    {open && <div id={id} className="skill-slash-menu" role="listbox" aria-label="可用 Skill">
      {options.length ? options.map((skill, index) => <button key={skill.name} type="button" role="option"
        aria-selected={index === Math.min(active, options.length - 1)} aria-disabled={chosen.has(skill.name) || chosen.size >= 3}
        onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(skill)}>
        <strong>/{skill.name}</strong><span>{skill.description}</span>
      </button>) : <div role="status">{discovery?.status === 'ready' ? '没有匹配的 Skill' : '当前没有可用 Skill'}</div>}
    </div>}
  </div>;
}
