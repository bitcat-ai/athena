import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { formatElapsed, summaryMeta } from '../shared/activity';
import { isBookkeepingTool, phaseGlyph, phaseTitle, type TurnPhase } from '../shared/phase';
import type { AgentId, ChatMessage } from '../shared/types';
import { PhaseGlyph } from './PhaseGlyph';

/** Ticks on its own so a running row is not re-rendered every second. */
function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((count) => count + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="act-meta">{formatElapsed(Date.now() - since)}</span>;
}

/**
 * The one line that says what the turn is doing, or how it ended. `children` is the timeline it
 * expands into; without one the row is plain text.
 */
export function ActivityRow({
  message,
  phase,
  agent,
  expanded,
  onExpandedChange,
  children,
}: {
  message: ChatMessage;
  phase: TurnPhase;
  agent: AgentId;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  children?: ReactNode;
}) {
  const body = useId();
  const ended = phase.kind === 'ended';
  // The check is only drawn for a turn seen finishing, never when history is opened.
  const watched = useRef(!ended);
  const step = (message.tools ?? []).filter((tool) => !isBookkeepingTool(tool.name)).length;
  const content = (
    <>
      <PhaseGlyph kind={phaseGlyph(phase, agent)} draw={ended && watched.current} />
      <span className="act-title">
        <span
          className={phase.kind === 'thinking' || phase.kind === 'stopping' ? 'act-shimmer' : ''}
        >
          {phaseTitle(phase, agent)}
        </span>
        {phase.kind === 'acting' && phase.target && (
          <span className="act-target">{phase.target}</span>
        )}
      </span>
      {ended ? (
        summaryMeta(message, agent).map((item) => (
          <span key={item} className="act-meta">
            {item}
          </span>
        ))
      ) : (
        <>
          {step > 0 && <span className="act-meta">第 {step} 步</span>}
          <Elapsed since={message.createdAt} />
        </>
      )}
    </>
  );
  return (
    <div
      className="activity"
      data-phase={phase.kind}
      data-outcome={ended ? phase.outcome : undefined}
    >
      {children ? (
        <button
          type="button"
          className="act"
          aria-expanded={expanded}
          aria-controls={body}
          onClick={() => onExpandedChange(!expanded)}
        >
          {content}
          <svg className="act-chev" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 6.5L8 10l3.5-3.5" />
          </svg>
        </button>
      ) : (
        <div className="act">{content}</div>
      )}
      {children && expanded && (
        <div id={body} className="act-body">
          {children}
        </div>
      )}
    </div>
  );
}
