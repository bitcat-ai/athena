import { Button } from '@heroui/react';
import { failedStep, toolTarget, unverifiedChecks } from '../shared/phase';
import type { ChatMessage } from '../shared/types';
import { PhaseGlyph } from './PhaseGlyph';

const tail = (text: string, lines = 12) => text.trimEnd().split('\n').slice(-lines).join('\n');

/**
 * What is left for the user after a turn that did not simply succeed. It follows the reply, so the
 * agent's own account is read first and the next step comes last.
 */
export function OutcomeCard({
  message,
  outcome,
  readOnly,
  busy,
  onConfirm,
  onShowBrowser,
  onFollowUp,
  onShowOutput,
}: {
  message: ChatMessage;
  outcome: 'blocked' | 'failed';
  /** Leaves out the actions that change the conversation or continue it. */
  readOnly?: boolean;
  busy: boolean;
  onConfirm: () => void;
  onShowBrowser: () => void;
  onFollowUp: () => void;
  onShowOutput: (toolId: string) => void;
}) {
  if (outcome === 'blocked') {
    const checks = unverifiedChecks(message);
    const summary =
      checks.at(-1)?.summary ??
      message.execution?.findLast((event) =>
        ['recovery', 'checkpoint', 'human-help'].includes(event.kind),
      )?.summary;
    const title = `${Math.max(1, checks.length)} 处未能核对`;
    return (
      <div className="req outcome" role="group" aria-label={title} data-outcome="blocked">
        <div className="req-head">
          <PhaseGlyph kind="warn" />
          <b>{title}</b>
        </div>
        <p>
          {checks.length && summary
            ? `要核对的是「${summary}」。页面上没有读到这处改动。`
            : summary || '操作结果尚未核对，请先检查页面。'}
        </p>
        {!readOnly && (
          <div className="req-foot">
            <Button size="sm" variant="ghost" onPress={onConfirm}>
              标记为已完成
            </Button>
            <Button size="sm" variant="secondary" onPress={onShowBrowser}>
              查看网页 ↗
            </Button>
            <Button size="sm" variant="primary" isDisabled={busy} onPress={onFollowUp}>
              再核对一次
            </Button>
          </div>
        )}
      </div>
    );
  }
  const failed = failedStep(message);
  const output = failed?.tool.output?.trim();
  const title = failed ? `第 ${failed.index} 步失败` : '任务未完成';
  // The exit code leads: a long command is cut at the end, and the code must survive that.
  const why = failed
    ? [
        failed.tool.exitCode !== undefined ? `退出码 ${failed.tool.exitCode}` : '',
        toolTarget(failed.tool),
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  return (
    <div className="req outcome" role="group" aria-label={title} data-outcome="failed">
      <div className="req-head">
        <PhaseGlyph kind="fail" />
        <b>{title}</b>
        {why && (
          <span className="req-why" title={why}>
            {why}
          </span>
        )}
      </div>
      {output ? (
        <>
          <pre>{tail(output)}</pre>
          {message.failure && <p>{message.failure}</p>}
        </>
      ) : (
        <pre>{message.failure || '这一轮没有完成。'}</pre>
      )}
      {(failed || !readOnly) && (
        <div className="req-foot">
          {failed && (
            <Button size="sm" variant="ghost" onPress={() => onShowOutput(failed.tool.id)}>
              查看完整输出
            </Button>
          )}
          {!readOnly && (
            <Button size="sm" variant="primary" isDisabled={busy} onPress={onFollowUp}>
              {failed ? '修复并重试' : '重试'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
