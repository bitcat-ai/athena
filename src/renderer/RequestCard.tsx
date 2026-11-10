import { Button, Description, Input, Label, TextArea } from '@heroui/react';
import { RadioButtonGroup } from '@heroui-pro/react';
import { Loading02Icon } from '@hugeicons-pro/core-stroke-rounded';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { requestKey, requestKind } from '../shared/phase';
import type { PendingAgentRequest } from '../shared/types';
import { PhaseGlyph } from './PhaseGlyph';
import { Icon } from './ui';

type Question = Extract<PendingAgentRequest, { kind: 'input' }>['request']['questions'][number];
const marks = { approval: 'shield', input: 'bubble', handoff: 'cursor' } as const;

/**
 * The one place a turn asks the user for something. It sits in the conversation right under the
 * activity row, so the question is read next to the work that raised it.
 */
export function RequestCard({
  pending,
  autoFocus,
  onRespond,
  onStop,
  onShowBrowser,
}: {
  pending: PendingAgentRequest;
  autoFocus?: boolean;
  onRespond: (action: string, payload: unknown) => Promise<unknown>;
  onStop: () => void;
  onShowBrowser: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, { selected?: number; text?: string }>>({});
  const [sending, setSending] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const type = requestKind(pending);

  useEffect(() => {
    const node = card.current;
    if (!node || !autoFocus) return;
    node.scrollIntoView({ block: 'nearest' });
    // Never pull focus from text being typed, and never land on a button: a stray Enter or Space
    // must not approve anything. Input cards go to their first field, the rest to the card itself.
    const active = document.activeElement as HTMLElement | null;
    const typing =
      !!active &&
      (active.isContentEditable || /^(?:INPUT|TEXTAREA)$/.test(active.tagName)) &&
      !!(active.textContent || (active as HTMLInputElement).value);
    if (typing) return;
    const field = type === 'input' ? node.querySelector<HTMLElement>('input, textarea') : undefined;
    (field ?? node).focus({ preventScroll: true });
  }, [autoFocus, type]);

  const respond = async (action: string, value: Record<string, unknown>) => {
    if (sending) return;
    setSending(true);
    try {
      await onRespond(action, {
        id: pending.request.id,
        conversationId: pending.conversationId,
        messageId: pending.messageId,
        ...value,
      });
    } finally {
      setSending(false);
    }
  };
  const answerFor = (question: Question) => {
    const value = answers[question.id];
    return (
      question.options?.[value?.selected ?? -1]?.label ??
      (question.isSecret ? value?.text : value?.text?.trim()) ??
      ''
    );
  };
  const answered =
    pending.kind === 'input' && pending.request.questions.every((question) => answerFor(question));
  const primary = () => {
    if (pending.kind === 'approval') return void respond('agent:approval', { approved: true });
    if (!answered) return;
    void respond('agent:user-input', {
      answers: Object.fromEntries(
        pending.request.questions.map((question) => [question.id, [answerFor(question)]]),
      ),
    });
  };
  const busyLabel = (label: string): ReactNode =>
    sending ? (
      <>
        <Icon icon={Loading02Icon} size={14} className="spin" />
        提交中
      </>
    ) : (
      label
    );
  const title = pending.kind === 'input' ? '需要你的回答' : pending.request.title;

  return (
    <div
      ref={card}
      className="req arrive"
      role="group"
      aria-label={title}
      data-type={type}
      data-request-key={requestKey(pending)}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          primary();
        }
        // Esc only declines an approval. Stopping a whole task takes a deliberate click.
        if (event.key === 'Escape' && type === 'approval') {
          event.preventDefault();
          void respond('agent:approval', { approved: false });
        }
      }}
    >
      <div className="req-head">
        <PhaseGlyph kind={marks[type]} />
        <b>{title}</b>
        {pending.kind === 'input' && pending.request.questions[0]?.header && (
          <span className="req-why">{pending.request.questions[0].header}</span>
        )}
      </div>
      {pending.kind === 'approval' ? (
        <>
          {type === 'handoff' ? (
            <p>{pending.request.detail}</p>
          ) : (
            <pre>{pending.request.detail}</pre>
          )}
          <div className="req-foot">
            {type === 'approval' && (
              <span className="req-keys">
                <kbd>⌘↩</kbd> 允许 · <kbd>Esc</kbd> 拒绝
              </span>
            )}
            <Button
              size="sm"
              variant={type === 'handoff' ? 'ghost' : 'secondary'}
              isDisabled={sending}
              onPress={() => void respond('agent:approval', { approved: false })}
            >
              {type === 'handoff' ? '停止处理' : '拒绝'}
            </Button>
            {type === 'handoff' && (
              <Button size="sm" variant="secondary" onPress={onShowBrowser}>
                去页面完成 ↗
              </Button>
            )}
            <Button size="sm" variant="primary" isDisabled={sending} onPress={primary}>
              {busyLabel(type === 'handoff' ? '已完成，继续' : '允许这次')}
            </Button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            primary();
          }}
        >
          <div className="req-questions">
            {pending.request.questions.map((question) => {
              const value = answers[question.id] ?? {};
              const options = question.options ?? [];
              const update = (patch: { selected?: number; text?: string }) =>
                setAnswers((previous) => ({
                  ...previous,
                  [question.id]: { ...previous[question.id], ...patch },
                }));
              const freeform =
                !options.length || (question.isOther && value.selected === options.length);
              return (
                <fieldset key={question.id} disabled={sending}>
                  <legend>{question.question}</legend>
                  {!!options.length && (
                    <RadioButtonGroup
                      aria-label={question.question}
                      value={value.selected === undefined ? null : String(value.selected)}
                      onChange={(selected) => update({ selected: Number(selected) })}
                      isDisabled={sending}
                    >
                      {options.map((option, index) => (
                        <RadioButtonGroup.Item key={index} value={String(index)}>
                          <RadioButtonGroup.Indicator />
                          <RadioButtonGroup.ItemContent>
                            <Label>{option.label}</Label>
                            {option.description && <Description>{option.description}</Description>}
                          </RadioButtonGroup.ItemContent>
                        </RadioButtonGroup.Item>
                      ))}
                      {question.isOther && (
                        <RadioButtonGroup.Item value={String(options.length)}>
                          <RadioButtonGroup.Indicator />
                          <RadioButtonGroup.ItemContent>自行填写</RadioButtonGroup.ItemContent>
                        </RadioButtonGroup.Item>
                      )}
                    </RadioButtonGroup>
                  )}
                  {freeform &&
                    (question.isSecret ? (
                      <Input
                        className="req-answer"
                        type="password"
                        aria-label={question.question}
                        autoComplete="off"
                        maxLength={20_000}
                        required
                        value={value.text ?? ''}
                        onChange={(event) => update({ text: event.target.value })}
                      />
                    ) : (
                      <TextArea
                        className="req-answer"
                        aria-label={question.question}
                        rows={2}
                        maxLength={20_000}
                        required
                        value={value.text ?? ''}
                        onChange={(event) => update({ text: event.target.value })}
                      />
                    ))}
                </fieldset>
              );
            })}
          </div>
          <div className="req-foot">
            <span className="req-keys">
              <kbd>⌘↩</kbd> 提交
            </span>
            <Button size="sm" type="button" variant="ghost" isDisabled={sending} onPress={onStop}>
              停止任务
            </Button>
            <Button size="sm" type="submit" variant="primary" isDisabled={sending || !answered}>
              {busyLabel('提交回答')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
