import { useState, type ReactNode } from 'react';
import { displayPhase } from '../shared/phase';
import type { AgentId, ChatMessage, PendingAgentRequest } from '../shared/types';
import { ActivityRow } from './ActivityRow';
import { ActivityTimeline } from './ActivityTimeline';
import { OutcomeCard } from './OutcomeCard';
import { RequestCard } from './RequestCard';
import { IntegrationActivity } from './IntegrationActivity';
import { PrdArtifact } from './PrdArtifact';
import { isPrdArtifact } from '../shared/activity';

/**
 * Status of one assistant turn, laid out in reading order: what it is doing, what it needs from
 * the user, the reply (`children`), and what is left to decide once it has ended. Identity,
 * status and copy share one header; detailed history stays inside the expanded activity.
 */
export function AssistantTurn({
  message,
  conversationId,
  agent,
  requests,
  last,
  readOnly,
  busy,
  onAction,
  onShowBrowser,
  heading,
  historyAction,
  actions,
  children,
}: {
  message: ChatMessage;
  conversationId: string;
  agent: AgentId;
  /** Requests of this turn that still wait for the user, oldest first. */
  requests: PendingAgentRequest[];
  /** Only the latest turn can be followed up. */
  last: boolean;
  /** An archived conversation is only read: its outcome is shown without follow-up actions. */
  readOnly?: boolean;
  busy: boolean;
  onAction: <T = unknown>(action: string, payload?: unknown) => Promise<T>;
  onShowBrowser: () => void;
  heading?: ReactNode;
  historyAction?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [openToolId, setOpenToolId] = useState<string>();
  const phase = displayPhase(message, requests);
  const detailed = !!(
    message.tools?.length ||
    message.plan?.length ||
    message.execution?.length ||
    message.requests?.length ||
    message.model ||
    historyAction
  );
  // A plain answer needs no status line once it is there to read.
  const quiet = phase.kind === 'ended' && phase.outcome === 'succeeded' && !detailed;
  const outcome = phase.kind === 'ended' ? phase.outcome : undefined;
  const target = { conversationId, messageId: message.id };
  return (
    <>
      {quiet ? (
        (heading || actions) && (
          <div className="assistant-turn-heading">
            {heading}
            {actions}
          </div>
        )
      ) : (
        <ActivityRow
          message={message}
          phase={phase}
          agent={agent}
          expanded={expanded}
          onExpandedChange={setExpanded}
          heading={heading}
          actions={actions}
        >
          {detailed && (
            <>
              <ActivityTimeline
                message={message}
                agent={agent}
                conversationId={conversationId}
                openToolId={openToolId}
                onOpenTool={setOpenToolId}
                onAction={onAction}
              />
              {historyAction && <div className="activity-history-action">{historyAction}</div>}
            </>
          )}
        </ActivityRow>
      )}
      {!expanded && detailed && (
        <ActivityTimeline
          overview
          message={message}
          agent={agent}
          conversationId={conversationId}
          onOpenTool={(id) => {
            setExpanded(true);
            setOpenToolId(id);
          }}
          onAction={onAction}
        />
      )}
      {phase.kind === 'waiting' &&
        requests.map((pending, index) => (
          <RequestCard
            key={pending.request.id}
            pending={pending}
            autoFocus={index === 0}
            onRespond={onAction}
            onStop={() => void onAction('conversation:stop')}
            onShowBrowser={onShowBrowser}
          />
        ))}
      <IntegrationActivity message={message} />
      {message.execution
        ?.filter(
          (event) =>
            event.kind === 'artifact' && event.artifact && isPrdArtifact(event.artifact.path),
        )
        .map((event) => (
          <PrdArtifact
            key={event.id}
            conversationId={conversationId}
            messageId={message.id}
            eventId={event.id}
            onAction={onAction}
          />
        ))}
      {children}
      {last && (outcome === 'blocked' || outcome === 'failed') && (
        <OutcomeCard
          message={message}
          outcome={outcome}
          readOnly={readOnly}
          busy={busy}
          onConfirm={() => void onAction('conversation:confirm-outcome', target)}
          onShowBrowser={onShowBrowser}
          onFollowUp={() => void onAction('conversation:follow-up', target)}
          onShowOutput={(toolId) => {
            setExpanded(true);
            setOpenToolId(toolId);
          }}
        />
      )}
    </>
  );
}
