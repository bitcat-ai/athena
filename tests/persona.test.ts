import assert from 'node:assert/strict';
import test from 'node:test';
import { athenaPersona, personaBlock } from '../src/main/persona';

test('the persona names the runtime truthfully and leaves capabilities alone', () => {
  const text = athenaPersona('Claude Code');
  assert.match(text, /你是 Athena/);
  assert.match(text, /这次对话由 Claude Code 驱动/);
  assert.match(text, /不否认底层的运行时，也不声称存在「Athena 模型」/);
  assert.match(text, /不改变你可以使用的工具和能力/);
  // Style only: nothing that refuses a kind of task.
  assert.doesNotMatch(text, /不要做|禁止|拒绝|只能做/);
  // Short enough to travel with every turn of the runtimes that have no system entry.
  assert.ok(text.length < 900, String(text.length));
});

test('the per-turn form wraps the same text in one block', () => {
  assert.equal(personaBlock('Kimi'), `<athena_persona>\n${athenaPersona('Kimi')}\n</athena_persona>`);
});
