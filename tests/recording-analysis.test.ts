import assert from 'node:assert/strict';
import test from 'node:test';
import type { Recording } from '../src/shared/types';
import {
  answerRecordingQuestion,
  parseRecordingWorkflow,
  recordingContext,
} from '../src/main/recording-analysis';

const recording: Recording = {
  id: 'demo',
  title: 'Customers',
  startedAt: 1,
  summary: 'previous model speculation',
  steps: [
    {
      id: 'click-a',
      kind: 'click',
      description: '导出',
      timestamp: 2,
      url: 'https://customer.example/test?token=private',
      source: 'human',
      scopeText: '客户 C1001',
      checked: false,
      target: { name: '导出', selector: '[hidden-project-selector]', value: 'private value' },
      outcome: { kind: 'download', origin: 'link', status: 'completed' },
    },
  ],
};
const draft = {
  goal: '导出客户材料',
  steps: [{ note: '在客户详情选择导出', stepIds: ['click-a'] }],
  parameters: [
    { name: '客户', example: 'C1001', stepIds: ['click-a'] },
    { name: '编造参数', example: 'C1008', stepIds: ['click-a'] },
    { name: '不完整编号', example: 'C100', stepIds: ['click-a'] },
  ],
  questions: [
    { question: '交给内部同事时仍排除备注吗？', stepIds: ['click-a'], answer: '模型伪造回答' },
  ],
};

test('recording evidence contains only selected observations and explicitly confirmed answers', () => {
  const context = recordingContext(recording);
  assert.doesNotMatch(context, /private|previous model|hidden-project-selector/);
  assert.equal(JSON.parse(context).steps[0].outcome.status, 'completed');
  assert.equal(JSON.parse(context).steps[0].scope, '客户 C1001');
  assert.equal(JSON.parse(context).steps[0].checked, false);
  assert.deepEqual(
    JSON.parse(
      recordingContext({
        ...recording,
        steps: [
          {
            ...recording.steps[0],
            kind: 'feedback',
            source: 'page',
            feedback: { role: 'alert', text: '导出失败，可检查凭据 token=private' },
          },
        ],
      }),
    ).steps[0].feedback,
    { role: 'alert', text: '导出失败，可检查凭据 token=[hidden]' },
  );
  const original = parseRecordingWorkflow(JSON.stringify(draft), recording);
  assert.deepEqual(original.parameters, [draft.parameters[0]]);
  assert.equal(original.questions[0].answer, undefined);
  const current = { ...recording, workflow: original };
  const input = {
    revision: original.revision,
    question: draft.questions[0].question,
    answer: '仅对外导出',
  };
  current.workflow = answerRecordingQuestion(current, input);
  assert.throws(() => answerRecordingQuestion(current, input), /已更新/);
  assert.throws(
    () => answerRecordingQuestion(current, { ...input, revision: 'outdated' }),
    /已更新/,
  );
  const refreshed = parseRecordingWorkflow(JSON.stringify({ ...draft, questions: [] }), current);
  assert.notEqual(original.revision, refreshed.revision);
  assert.deepEqual(refreshed.questions, current.workflow.questions);
  const evidence = recordingContext(current);
  assert.match(evidence, /仅对外导出/);
  assert.doesNotMatch(evidence, /模型伪造回答|客户详情选择导出|previous model/);
});

test('workflow rejects foreign evidence, malformed output and empty recordings', () => {
  for (const output of [
    'an unstructured summary',
    'null',
    JSON.stringify({ ...draft, steps: [{ note: 'missing', stepIds: ['outside'] }] }),
    JSON.stringify({ ...draft, questions: [{ question: 'why', stepIds: [] }] }),
    JSON.stringify({ ...draft, steps: [] }),
  ])
    assert.throws(() => parseRecordingWorkflow(output, recording));
  assert.throws(() => recordingContext({ ...recording, steps: [] }));
});
