import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSkillSubmission, serializeSkillDocument, skillDocumentFromText } from '../src/renderer/skill-composer-document';

test('known inline references serialize names separately from task text', () => {
  const doc = skillDocumentFromText('请用 /review 检查\n第二行 /research', ['review', 'research']);
  assert.deepEqual(serializeSkillDocument(doc), {
    displayText: '请用 /review 检查\n第二行 /research', text: '请用  检查\n第二行 ', names: ['review', 'research'],
  });
  assert.deepEqual(serializeSkillDocument(JSON.parse(JSON.stringify(doc))), serializeSkillDocument(doc));
});

test('unknown references, URLs and paths remain ordinary task text', () => {
  const text = '/unknown https://example.com/review /tmp/review a/review';
  assert.deepEqual(serializeSkillDocument(skillDocumentFromText(text, ['review'])), { displayText: text, text, names: [] });
});

test('builds the provider-native prompt from the same structured draft references', () => {
  const doc = skillDocumentFromText('在 /review 位置检查', ['review']);
  assert.deepEqual(buildSkillSubmission(doc, []), {
    text: '在  位置检查', selectedSkills: ['review'], promptText: '/skill:review\n\n在  位置检查',
  });
});

test('references are deduplicated without losing display text or blank lines', () => {
  const doc = skillDocumentFromText('/review\n\n/review task', ['review']);
  assert.deepEqual(serializeSkillDocument(doc), { displayText: '/review\n\n/review task', text: '\n\n task', names: ['review'] });
});
