import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { readTaskSkill } from '../src/main/task-skills';

test('business skills load actual files and reject names outside the catalog', async () => {
  const directory = path.resolve('resources/skills');
  const signal = new AbortController().signal;
  const catalog = JSON.parse(
    (await readTaskSkill(directory, 'workbench_skill_list', {}, signal)).text,
  );
  for (const skill of catalog.skills) {
    const loaded = JSON.parse(
      (await readTaskSkill(directory, 'workbench_skill_read', { name: skill.name }, signal)).text,
    );
    assert.match(loaded.content, new RegExp(`name: ${skill.name}`));
    assert.match(loaded.sha256, /^[a-f0-9]{64}$/);
    assert.equal(loaded.title, skill.title);
  }
  await assert.rejects(
    readTaskSkill(directory, 'workbench_skill_read', { name: '../../package.json' }, signal),
  );
  await assert.rejects(
    readTaskSkill(
      directory,
      'workbench_skill_read',
      { name: 'business-context' },
      AbortSignal.abort(),
    ),
  );
});
