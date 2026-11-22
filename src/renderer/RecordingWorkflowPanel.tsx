import { Checkbox, Input, Label } from '@heroui/react';
import { useState } from 'react';
import type { Recording } from '../shared/types';
import { ActionButton } from './ui';

type Workflow = NonNullable<Recording['workflow']>;
type AnswerEdit = { value: string; previousAnswer?: string };
export type RecordingDraft = {
  answers: Map<string, AnswerEdit>;
  example: string;
  target: string;
  reviewed?: string;
  verifyCustomerZip: boolean;
  expectedFeedback?: string;
  excludeInternal: boolean;
};

function Check({
  text,
  checked,
  disabled,
  onChange,
}: {
  text: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Checkbox isSelected={checked} isDisabled={disabled} onChange={onChange}>
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        <Label>{text}</Label>
      </Checkbox.Content>
    </Checkbox>
  );
}

export function RecordingWorkflowPanel({
  recording,
  workflow,
  available,
  drafts,
  onAction,
  onStarted,
  onStop,
}: {
  recording: Recording;
  workflow: Workflow;
  available: boolean;
  drafts: Map<string, RecordingDraft>;
  onAction: <T = unknown>(action: string, payload?: unknown) => Promise<T>;
  onStarted: () => void;
  onStop: () => void;
}) {
  const key = JSON.stringify([recording.id, workflow.revision]);
  const [draft, setDraft] = useState<RecordingDraft>(
    () =>
      drafts.get(key) ?? {
        answers: new Map(),
        example: workflow.parameters?.length === 1 ? workflow.parameters[0].example : '',
        target: '',
        verifyCustomerZip: false,
        excludeInternal: false,
      },
  );
  const [pending, setPending] = useState(false);
  function update(patch: Partial<RecordingDraft>) {
    setDraft((previous) => {
      const next = { ...previous, ...patch };
      drafts.set(key, next);
      return next;
    });
  }
  const sourceIndices = new Map(recording.steps.map((step, index) => [step.id, index]));
  function sources(ids: string[]) {
    return ids.map((id) => {
      const index = sourceIndices.get(id);
      if (index === undefined) return null;
      return (
        <ActionButton
          key={id}
          className="recording-source"
          aria-label={`查看原始步骤 ${index + 1}`}
          onPress={() => {
            const el = document.getElementById(`recorded-step-${id}`);
            el?.focus({ preventScroll: true });
            el?.scrollIntoView({ block: 'nearest' });
          }}
        >
          第 {index + 1} 步
        </ActionButton>
      );
    });
  }
  const identity = { id: recording.id, revision: workflow.revision };
  const rules = workflow.questions;
  const example = draft.example.trim(),
    target = draft.target.trim();
  const reviewKey = JSON.stringify([example, target, rules.map((q) => [q.question, q.answer])]);
  const rulesReviewed = draft.reviewed === reviewKey;
  const guiding = recording.practice?.status === 'guiding';
  const answersReady = rules.every((q) => q.answer?.trim() && !draft.answers.has(q.question));
  const canPractice =
    available &&
    !pending &&
    !guiding &&
    !!example &&
    !!target &&
    example.toLowerCase() !== target.toLowerCase() &&
    !recording.truncated &&
    answersReady &&
    (!rules.length || rulesReviewed);
  async function saveAnswer(question: string) {
    const edit = draft.answers.get(question);
    if (!edit?.value.trim() || pending) return;
    setPending(true);
    try {
      const saved = await onAction<Recording>('recording:answer', {
        ...identity,
        question,
        answer: edit.value.trim(),
        previousAnswer: edit.previousAnswer,
      });
      if (saved) {
        const answers = new Map(draft.answers);
        answers.delete(question);
        update({ answers, reviewed: undefined });
      }
    } finally {
      setPending(false);
    }
  }
  async function practice() {
    if (!canPractice) return;
    setPending(true);
    try {
      const ok = await onAction<boolean>('recording:practice', {
        ...identity,
        example,
        target,
        rulesReviewed,
        verifyCustomerZip: draft.verifyCustomerZip,
        ...(!draft.verifyCustomerZip && draft.expectedFeedback?.trim()
          ? { expectedFeedback: draft.expectedFeedback.trim() }
          : {}),
        excludeInternal: draft.verifyCustomerZip && draft.excludeInternal,
      });
      if (ok) onStarted();
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="recording-workflow">
      <section aria-label="流程草稿">
        <h4>流程草稿</h4>
        <p>{workflow.goal}</p>
        <ol className="workflow-steps">
          {workflow.steps.map((step, i) => (
            <li key={i}>
              {step.note} {sources(step.stepIds)}
            </li>
          ))}
        </ol>
      </section>
      {rules.length > 0 && (
        <section aria-label="业务规则">
          <h4>业务规则</h4>
          {rules.map((rule) => {
            const edit = draft.answers.get(rule.question);
            const dirty = !!edit && edit.value.trim() !== (rule.answer ?? '');
            return (
              <div className="workflow-rule" key={rule.question}>
                <label>
                  <span>{rule.question}</span>
                  <Input
                    aria-label={rule.question}
                    value={edit?.value ?? rule.answer ?? ''}
                    placeholder="填写规则及适用范围"
                    maxLength={1000}
                    disabled={guiding || pending}
                    onChange={(e) => {
                      const answers = new Map(draft.answers);
                      if (e.target.value === (rule.answer ?? '')) answers.delete(rule.question);
                      else
                        answers.set(rule.question, {
                          value: e.target.value,
                          previousAnswer: edit ? edit.previousAnswer : rule.answer,
                        });
                      update({ answers, reviewed: undefined });
                    }}
                  />
                </label>
                <div className="workflow-rule-actions">
                  {sources(rule.stepIds)}
                  <ActionButton
                    className="secondary-button"
                    isDisabled={guiding || pending || !dirty || !edit?.value.trim()}
                    onPress={() => void saveAnswer(rule.question)}
                  >
                    {rule.answer && !dirty ? '已确认' : '确认规则'}
                  </ActionButton>
                </div>
              </div>
            );
          })}
        </section>
      )}
      <section aria-label="换个对象带做">
        <h4>换个对象带做</h4>
        {workflow.parameters && workflow.parameters.length > 1 && (
          <div className="workflow-rule-actions" aria-label="录制中的可变对象">
            {workflow.parameters.map((parameter) => (
              <ActionButton
                key={parameter.name}
                className="secondary-button"
                isDisabled={guiding || pending}
                onPress={() => update({ example: parameter.example, reviewed: undefined })}
              >
                {parameter.name} · {parameter.example}
              </ActionButton>
            ))}
          </div>
        )}
        <div className="workflow-fields">
          <label>
            录制中的对象
            <Input
              aria-label="录制中的对象"
              maxLength={120}
              value={draft.example}
              disabled={guiding || pending}
              onChange={(e) => update({ example: e.target.value, reviewed: undefined })}
            />
          </label>
          <label>
            本次对象
            <Input
              aria-label="本次对象"
              maxLength={120}
              value={draft.target}
              disabled={guiding || pending}
              onChange={(e) => update({ target: e.target.value, reviewed: undefined })}
            />
          </label>
        </div>
        {rules.length > 0 && (
          <Check
            text="已确认上述规则适用于本次对象"
            disabled={guiding || pending || !answersReady || !target}
            checked={rulesReviewed}
            onChange={(value) => update({ reviewed: value ? reviewKey : undefined })}
          />
        )}
        <Check
          text="核验客户材料 ZIP"
          disabled={guiding || pending}
          checked={draft.verifyCustomerZip}
          onChange={(value) => update({ verifyCustomerZip: value, excludeInternal: false })}
        />
        {draft.verifyCustomerZip && (
          <Check
            text="检查是否排除内部备注"
            disabled={guiding || pending}
            checked={draft.excludeInternal}
            onChange={(value) => update({ excludeInternal: value })}
          />
        )}
        {!draft.verifyCustomerZip && (
          <label className="workflow-feedback">
            预期的页面提示（可选）
            <Input
              aria-label="预期的页面提示"
              maxLength={180}
              value={draft.expectedFeedback ?? ''}
              disabled={guiding || pending}
              onChange={(e) => update({ expectedFeedback: e.target.value })}
            />
          </label>
        )}
        <ActionButton
          className="primary-button"
          isDisabled={!canPractice}
          onPress={() => void practice()}
        >
          开始带做
        </ActionButton>
        {rules.some((q) => !q.answer?.trim()) && <p className="muted">请先确认待定的业务规则。</p>}
      </section>
      {recording.practice && (
        <section
          aria-label="带做结果"
          id="recording-practice-result"
          tabIndex={-1}
          className="workflow-result"
        >
          <h4>带做结果</h4>
          <p role="status">
            {' '}
            {recording.practice.target} ·{' '}
            {guiding
              ? '带做中'
              : recording.practice.status === 'stopped'
                ? '带做已停止'
                : '带做已结束'}
          </p>
          <ol className="workflow-steps">
            {recording.practice.progress.map((step, i) => (
              <li key={i}>
                {step.note}{' '}
                <span className="muted">
                  {
                    { done: '已完成', skipped: '已跳过', current: '当前步骤', pending: '待操作' }[
                      step.status
                    ]
                  }
                </span>
              </li>
            ))}
          </ol>
          <p>
            所选条件核验 ·{' '}
            {
              { passed: '已通过', failed: '未通过', unknown: '尚未核实' }[
                recording.practice.verification
              ]
            }
          </p>
          {recording.practice.detail && <p className="muted">{recording.practice.detail}</p>}
          {guiding && (
            <ActionButton className="secondary-button" onPress={onStop}>
              停止带做
            </ActionButton>
          )}
        </section>
      )}
    </div>
  );
}
