import assert from 'node:assert/strict';
import test from 'node:test';
import { WebExecution } from '../src/main/web-execution';
import type { WebExecutionEvent } from '../src/shared/types';

test('confirmed insertions cannot be replayed in the same turn after a lost reply', () => {
  const flow = new WebExecution('insert-turn', () => {});
  flow.assertCanMutate('insert-section');
  flow.confirmMutation('insert-section');
  assert.throws(() => flow.assertCanMutate('insert-section'), /不能重复/);
  flow.assertCanMutate('insert-another-section');
  new WebExecution('next-turn', () => {}).assertCanMutate('insert-section');
});

test('recovery requires a fresh matching-page observation and literal evidence; unknown never unlocks mutations', () => {
  const events: WebExecutionEvent[] = [];
  const flow = new WebExecution('turn-1', (e) => events.push(e));
  const old = flow.observe('No order', 1);
  flow.mutate();
  flow.requireRecovery('submit', 1);
  flow.requireRecovery('', 2);
  assert.throws(() => flow.assertCanMutate('submit'), /核对/);
  assert.throws(
    () =>
      flow.checkpoint({
        observationId: old,
        summary: 'no order',
        evidence: 'No order',
        outcome: 'not_applied',
      }),
    /最近/,
  );
  const wrong = flow.observe('No order', 2);
  assert.throws(
    () =>
      flow.checkpoint({
        observationId: wrong,
        summary: 'no order',
        evidence: 'No order',
        outcome: 'not_applied',
      }),
    /所在页面/,
  );
  const current = flow.observe('Receipt unavailable', 1);
  assert.throws(
    () =>
      flow.checkpoint({
        observationId: current,
        summary: 'success',
        evidence: 'Order saved',
        outcome: 'verified',
      }),
    /原文/,
  );
  flow.checkpoint({
    observationId: current,
    summary: 'receipt unknown',
    evidence: 'Receipt unavailable',
    outcome: 'unknown',
  });
  assert.throws(
    () =>
      flow.checkpoint({
        observationId: current,
        summary: 'reinterpret old evidence',
        evidence: 'Receipt unavailable',
        outcome: 'verified',
      }),
    /最近/,
  );
  assert.throws(() => flow.assertCanMutate('different action'), /核对/);
  const receipt = flow.observe('Order #7 saved', 1);
  flow.checkpoint({
    observationId: receipt,
    summary: 'order committed',
    evidence: 'Order #7 saved',
    outcome: 'verified',
  });
  assert.throws(() => flow.assertCanMutate('submit'), /不能重复/);
  flow.assertCanMutate('next step');
  assert.equal(events.filter((e) => e.kind === 'recovery' && e.status === 'succeeded').length, 1);
  assert(events.every((e) => e.taskId === 'turn-1' && e.at > 0 && e.id));
});

test('confirmed non-application permits a new attempt, stale or replaced observations cannot certify results', () => {
  const flow = new WebExecution('turn-2', () => {});
  flow.requireRecovery('fill', 1);
  const previous = flow.observe('validation error', 1);
  const current = flow.observe('field empty', 1);
  assert.throws(() =>
    flow.checkpoint({
      observationId: previous,
      summary: 'failed',
      evidence: 'validation error',
      outcome: 'not_applied',
    }),
  );
  flow.checkpoint({
    observationId: current,
    summary: 'not filled',
    evidence: 'field empty',
    outcome: 'not_applied',
  });
  flow.assertCanMutate('fill');
  flow.mutate();
  assert.throws(() =>
    flow.checkpoint({
      observationId: current,
      summary: 'old evidence',
      evidence: 'field empty',
      outcome: 'verified',
    }),
  );
  const nextTask = new WebExecution('turn-3', () => {});
  assert.throws(() =>
    nextTask.checkpoint({
      observationId: current,
      summary: 'foreign evidence',
      evidence: 'field empty',
      outcome: 'verified',
    }),
  );
});

test('plans contain only bounded public steps and reject malformed states', () => {
  const events: WebExecutionEvent[] = [];
  const flow = new WebExecution('plan', (e) => events.push(e));
  assert.throws(() => flow.plan([{ step: 'Invented completion', status: '90%' }]));
  assert.throws(() => flow.plan([]));
  flow.plan([{ step: 'Read order receipt', status: 'inProgress', explanation: 'not forwarded' }]);
  assert.deepEqual(events.at(-1)?.plan, [{ step: 'Read order receipt', status: 'inProgress' }]);
});

test('cross-tab receipts explicitly identify the failed page and preserve the recovery barrier until reconciled', () => {
  const flow = new WebExecution('receipt', () => {});
  flow.requireRecovery('submit', 1);
  const receipt = flow.observe('ORDER-1 saved', 2);
  assert.throws(() =>
    flow.checkpoint({
      observationId: receipt,
      evidence: 'ORDER-1 saved',
      summary: 'saved',
      outcome: 'verified',
    }),
  );
  flow.checkpoint({
    observationId: receipt,
    evidence: 'ORDER-1 saved',
    summary: 'saved',
    outcome: 'verified',
    recoveryPage: 1,
  });
  assert.throws(() => flow.assertCanMutate('submit'), /不能重复/);
  flow.assertCanMutate('download receipt');
});
