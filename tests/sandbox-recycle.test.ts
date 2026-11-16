import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultSandboxPolicy,
  makeRoom,
  normalizePolicy,
  planRecycle,
  recycleTimes,
  type RecycleItem,
} from '../src/main/sandbox-recycle';

const MINUTE = 60_000,
  DAY = 24 * 60 * MINUTE,
  now = 100 * DAY;
const item = (id: string, idle: number, extra: Partial<RecycleItem> = {}): RecycleItem => ({
  id,
  lastUsedAt: now - idle,
  keep: false,
  running: false,
  busy: false,
  held: false,
  ...extra,
});

test('a saved policy outside the offered choices falls back to the defaults', () => {
  assert.deepEqual(normalizePolicy(undefined), defaultSandboxPolicy);
  assert.deepEqual(normalizePolicy({ idleStopMinutes: 1, retainDays: 9999, maxRunning: 'x' }), {
    idleStopMinutes: 30,
    retainDays: 7,
    maxRunning: 4,
  });
  assert.deepEqual(normalizePolicy({ idleStopMinutes: 120, retainDays: 3, maxRunning: 8 }), {
    idleStopMinutes: 120,
    retainDays: 3,
    maxRunning: 8,
  });
});

test('idle sandboxes stop, unused ones are removed, kept ones only stop', () => {
  const plan = planRecycle(
    [
      item('fresh', 5 * MINUTE, { running: true }),
      item('idle', 31 * MINUTE, { running: true }),
      item('stopped', 2 * DAY),
      item('expired', 8 * DAY),
      item('expired-running', 8 * DAY, { running: true }),
      item('kept', 30 * DAY, { keep: true, running: true }),
    ],
    defaultSandboxPolicy,
    now,
  );
  assert.deepEqual(plan.stop.sort(), ['idle', 'kept']);
  assert.deepEqual(plan.remove.sort(), ['expired', 'expired-running']);
});

test('nothing in use is recycled, whatever its age', () => {
  const plan = planRecycle(
    [
      item('busy', 30 * DAY, { running: true, busy: true }),
      item('held', 30 * DAY, { running: true, held: true }),
    ],
    defaultSandboxPolicy,
    now,
  );
  assert.deepEqual(plan, { stop: [], remove: [] });
});

test('a lowered limit stops the least recently used sandboxes first', () => {
  const plan = planRecycle(
    [
      item('a', 4 * MINUTE, { running: true }),
      item('b', 3 * MINUTE, { running: true, busy: true }),
      item('c', 2 * MINUTE, { running: true }),
      item('d', 1 * MINUTE, { running: true }),
    ],
    { ...defaultSandboxPolicy, maxRunning: 2 },
    now,
  );
  assert.deepEqual(plan, { stop: ['a', 'c'], remove: [] });
});

test('one more sandbox starts by stopping the oldest idle one, or not at all', () => {
  const policy = { ...defaultSandboxPolicy, maxRunning: 2 };
  assert.deepEqual(makeRoom([item('a', MINUTE, { running: true })], policy, now), { full: false });
  assert.deepEqual(
    makeRoom(
      [item('a', 5 * MINUTE, { running: true }), item('b', 9 * MINUTE, { running: true })],
      policy,
      now,
    ),
    { full: false, evict: 'b' },
  );
  // In use, or used a moment ago: interrupting it would lose someone's work.
  assert.deepEqual(
    makeRoom(
      [item('a', 5 * MINUTE, { running: true, held: true }), item('b', 10_000, { running: true })],
      policy,
      now,
    ),
    { full: true },
  );
});

test('the list tells when each sandbox stops and when it is removed', () => {
  const running = recycleTimes(item('a', 0, { running: true }), defaultSandboxPolicy);
  assert.equal(running.stopsAt, now + 30 * MINUTE);
  assert.equal(running.removesAt, now + 7 * DAY);
  const kept = recycleTimes(item('a', 0, { keep: true }), defaultSandboxPolicy);
  assert.deepEqual(kept, { stopsAt: undefined, removesAt: undefined });
});
