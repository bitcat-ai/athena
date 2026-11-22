import assert from 'node:assert/strict';
import test from 'node:test';
import type { Recording } from '../src/shared/types';
import { pageFeedbackResult, recordingPracticePlan } from '../src/main/recording-practice';

const site = 'https://crm.example.test/customers';
const event = {
  id: 'e1',
  kind: 'click' as const,
  source: 'human' as const,
  timestamp: 1,
  url: site,
  description: '点击导出',
  scopeText: '云栖设计 C1001 · 华东',
  target: { tag: 'a', name: '导出材料', ref: 'old-tab:old-doc:1', selector: 'tr:nth-child(1) a' },
};
const recording: Recording = {
  id: 'rec',
  title: '客户材料',
  startedAt: 1,
  steps: [event],
  workflow: {
    revision: 'r1',
    goal: '导出当前客户材料',
    steps: [{ note: '从 C1001 导出材料', stepIds: ['e1'] }],
    questions: [],
  },
};
const input = {
  revision: 'r1',
  example: 'C1001',
  target: 'C1008',
  verifyCustomerZip: true,
  excludeInternal: true,
};

test('a new business object replaces the demonstrated one and drops positional selectors and prior node IDs', () => {
  const plan = recordingPracticePlan(recording, input, site);
  assert.equal(plan.steps[0].note, '从 C1008 导出材料');
  assert.equal(plan.targets[0].object, 'C1008');
  assert.equal(plan.targets[0].inRow, true);
  assert.equal(plan.steps[0].text, '导出材料');
  assert.equal(plan.steps[0].selector, undefined);
  assert.ok(!JSON.stringify(plan).includes('old-doc'));
  assert.throws(
    () => recordingPracticePlan(recording, { ...input, example: 'C100' }, site),
    /不一致/,
  );
  assert.throws(
    () => recordingPracticePlan(recording, input, 'https://other.example.test/customers'),
    /对应的网站/,
  );
  assert.throws(
    () => recordingPracticePlan({ ...recording, truncated: true }, input, site),
    /完整/,
  );
});

test('corrections change the guide and require a reviewed answer for the new target', () => {
  const question = { question: '内部交接也要导出吗？', stepIds: ['e1'] };
  const recorded = { ...recording, workflow: { ...recording.workflow!, questions: [question] } };
  assert.throws(() => recordingPracticePlan(recorded, input, site), /待确认/);
  const answered = {
    ...recording,
    workflow: { ...recording.workflow!, questions: [{ ...question, answer: '仅外发时导出。' }] },
  };
  assert.throws(() => recordingPracticePlan(answered, input, site), /适用于本次/);
  const plan = recordingPracticePlan(answered, { ...input, rulesReviewed: true }, site);
  assert.match(plan.steps[0].note, /仅外发时导出/);
  assert.deepEqual(
    plan.steps.map((s) => s.action),
    ['look', 'click'],
  );
});

test('only the final fresh main-frame response can satisfy a specified page outcome', () => {
  const click = { ...event, tabId: 'tab', frameId: 'root' };
  const feedback = {
    ...click,
    kind: 'feedback' as const,
    feedback: { role: 'status' as const, text: '已保存' },
  };
  const result = (steps: Recording['steps']) =>
    pageFeedbackResult({ ...recording, steps }, '已保存', 'tab', site).verification;
  assert.equal(result([click, feedback]), 'passed');
  assert.equal(result([click, feedback, click]), 'unknown');
  assert.equal(result([click, { ...feedback, frameId: 'other' }]), 'unknown');
  assert.equal(
    result([click, { ...feedback, feedback: { role: 'alert', text: '保存失败' } }]),
    'failed',
  );
});
