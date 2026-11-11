import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLeadingSkillReferences } from '../src/shared/skill-references';

test('parses one leading Skill reference and removes only its syntax', () => {
  assert.deepEqual(parseLeadingSkillReferences('/review 检查代码'), { names: ['review'], text: '检查代码' });
});

test('parses up to the leading sequence and preserves later slashes', () => {
  assert.deepEqual(parseLeadingSkillReferences('/one /two /three https://example.com/a/b'), {
    names: ['one', 'two', 'three'], text: 'https://example.com/a/b',
  });
});

test('does not interpret ordinary leading slash, paths, or inline slash', () => {
  for (const draft of ['/', '/tmp/file', '请检查 a/b', 'hello /review'])
    assert.deepEqual(parseLeadingSkillReferences(draft), { names: [], text: draft });
});

test('leaves malformed references and duplicate names observable for validation', () => {
  assert.deepEqual(parseLeadingSkillReferences('/bad/name task'), { names: [], text: '/bad/name task' });
  assert.deepEqual(parseLeadingSkillReferences('/quality:review /read_files.v2 task'), { names: ['quality:review', 'read_files.v2'], text: 'task' });
  assert.deepEqual(parseLeadingSkillReferences('/review /review task'), { names: ['review', 'review'], text: 'task' });
});
