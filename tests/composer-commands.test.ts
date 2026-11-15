import assert from 'node:assert/strict';
import test from 'node:test';
import { parseComposerCommand, slashCommands } from '../src/renderer/composer-commands';
import { buildSkillSubmission } from '../src/renderer/composer-skills';

test('commands parse only whole commands, with arguments; paths and prose stay task text', () => {
  assert.equal(parseComposerCommand('/model gpt-supported')?.argument, 'gpt-supported');
  assert.equal(parseComposerCommand('/settings mcp')?.command.name, 'settings');
  assert.equal(parseComposerCommand('/tmp/skills'), undefined);
  assert.equal(parseComposerCommand('explain /new'), undefined);
  assert.equal(parseComposerCommand('/new\nkeep this'), undefined);
  assert.equal(parseComposerCommand('/review'), undefined);
  assert.equal(slashCommands('', false).length, 0);
  assert.deepEqual(
    slashCommands('mc', true).map((x) => x.name),
    ['mcp'],
  );
});

test('inline local skills keep their source without pretending to be provider skills', () => {
  const result = buildSkillSubmission({
    segments: [
      { type: 'token', text: '/local:review', value: { skill: 'review', source: 'local' } },
      { type: 'text', text: ' check the page' },
    ],
    picked: [],
    localSkills: [
      {
        name: 'review',
        source: 'global',
        packagePath: '/skills/review',
        entryPath: '/skills/review/SKILL.md',
        availability: 'usable',
        diagnostics: [],
      },
    ],
    providerSkills: [],
  });
  assert.deepEqual(result, {
    text: 'check the page',
    displayText: '/local:review check the page',
    selectedSkills: ['review'],
    selectedSkillMetadata: [],
  });
});
