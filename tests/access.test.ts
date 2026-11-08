import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCESS_OPERATIONS, canAccess, normalizeTaskSelection } from '../src/shared/access';

test('access modes expose distinct operation sets', () => {
  assert.equal(canAccess('read-only', 'configuration.read'), true);
  assert.equal(canAccess('read-only', 'thread.start'), false);
  assert.equal(canAccess('supervised', 'thread.stop'), true);
  assert.equal(canAccess('supervised', 'configuration.write'), false);
  assert.equal(canAccess('full', 'configuration.write'), true);
  assert.notDeepEqual(ACCESS_OPERATIONS['read-only'], ACCESS_OPERATIONS.full);
});

test('task Skill and MCP selections stay independent and bounded', () => {
  assert.deepEqual(normalizeTaskSelection({ skills: ['review', 'review'], mcp: ['browser'] }), { skills: ['review'], mcp: ['browser'] });
  assert.throws(() => normalizeTaskSelection({ skills: ['a', 'b', 'c', 'd'] }), /三个 Skill/);
});
