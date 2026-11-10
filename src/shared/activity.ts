/** One chronological view of a turn: plan steps, actions, checkpoints, handled requests, artifacts. */
import {
  changedFiles,
  isBookkeepingTool,
  phaseOfMessage,
  phaseTitle,
  resolvedText,
  toolKind,
  toolTarget,
  type ResolvedRequest,
  type ToolKind,
} from './phase';
import type { AgentId, ChatMessage, ToolCall } from './types';

export type ActivityItem =
  | { kind: 'plan'; id: string; text: string; state: 'done' | 'now' | 'todo' }
  | {
      kind: 'tool';
      id: string;
      tool: ToolCall;
      title: string;
      target: string;
      glyph: ToolKind;
      state: 'run' | 'done' | 'fail' | 'stopped';
    }
  | {
      kind: 'check';
      id: string;
      text: string;
      evidence?: string;
      state: 'run' | 'ok' | 'missing' | 'unknown';
    }
  | { kind: 'request'; id: string; request: ResolvedRequest; text: string }
  | { kind: 'artifact'; id: string; name: string; bytes: number };

const checkStates = { verified: 'ok', not_applied: 'missing', unknown: 'unknown' } as const;
const checkLabels = { run: '正在核对', ok: '已核对', missing: '未生效', unknown: '未能核对' };

export function activityItems(message: ChatMessage, agent: AgentId = 'codex'): ActivityItem[] {
  const running = message.status === 'streaming';
  const entries: Array<{ at: number; item: ActivityItem }> = [];
  message.plan?.forEach((step, index) =>
    entries.push({
      // Steps saved without a timestamp keep plan order: started ones lead, pending ones trail.
      at: step.startedAt ?? (step.status === 'pending' ? Infinity : message.createdAt),
      item: {
        kind: 'plan',
        id: `plan:${index}`,
        text: step.step,
        state:
          step.status === 'completed'
            ? 'done'
            : step.status === 'inProgress' && running
              ? 'now'
              : 'todo',
      },
    }),
  );
  let last = message.createdAt;
  for (const tool of message.tools ?? []) {
    last = tool.startedAt ?? last;
    if (isBookkeepingTool(tool.name)) {
      // A checkpoint in flight has no verdict yet; once it lands the execution event replaces it.
      const summary = (tool.input as { summary?: unknown } | null)?.summary;
      if (tool.status === 'running' && running && toolKind(tool.name) === 'verify')
        entries.push({
          at: last,
          item: {
            kind: 'check',
            id: tool.id,
            text: [checkLabels.run, typeof summary === 'string' ? summary : '']
              .filter(Boolean)
              .join(' · '),
            state: 'run',
          },
        });
      continue;
    }
    const target = toolTarget(tool);
    entries.push({
      at: last,
      item: {
        kind: 'tool',
        id: tool.id,
        tool,
        // With a target in view the short verb reads better: 运行 npm test, not 执行命令 npm test.
        title: phaseTitle(
          { kind: 'acting', tool: tool.name, ...(target ? { target } : {}) },
          agent,
        ),
        target,
        glyph: toolKind(tool.name, agent),
        state:
          tool.status === 'running'
            ? running
              ? 'run'
              : 'stopped'
            : tool.status === 'error'
              ? 'fail'
              : 'done',
      },
    });
  }
  for (const event of message.execution ?? []) {
    if (event.kind === 'checkpoint') {
      const state = checkStates[event.outcome ?? 'unknown'];
      entries.push({
        at: event.at,
        item: {
          kind: 'check',
          id: event.id,
          text: [checkLabels[state], event.summary].filter(Boolean).join(' · '),
          evidence: event.evidence,
          state,
        },
      });
    }
    if (event.kind === 'artifact' && event.artifact)
      entries.push({
        at: event.at,
        item: {
          kind: 'artifact',
          id: event.id,
          name: event.artifact.path.split('/').pop() ?? event.artifact.path,
          bytes: event.artifact.bytes,
        },
      });
  }
  for (const request of message.requests ?? [])
    entries.push({
      at: request.at,
      item: { kind: 'request', id: request.id, request, text: resolvedText(request) },
    });
  // Array.prototype.sort is stable, so equal timestamps keep the order they were collected in.
  return entries.sort((a, b) => a.at - b.at).map((entry) => entry.item);
}

export interface ActivitySummary {
  steps: number;
  checks: number;
  files: number;
  elapsedMs?: number;
}
export function activitySummary(message: ChatMessage, agent: AgentId = 'codex'): ActivitySummary {
  const tools = (message.tools ?? []).filter((tool) => !isBookkeepingTool(tool.name));
  const events = message.execution ?? [];
  // Messages saved before endedAt existed fall back to the last thing known to have happened.
  const end =
    message.endedAt ??
    Math.max(0, ...tools.map((tool) => tool.finishedAt ?? 0), ...events.map((event) => event.at));
  return {
    steps: tools.length,
    checks: events.filter((event) => event.kind === 'checkpoint').length,
    files: changedFiles(tools, agent),
    // Under a second there is nothing worth reporting.
    ...(end - message.createdAt >= 1000 ? { elapsedMs: end - message.createdAt } : {}),
  };
}
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
/** The trailing facts of the activity row, already in display order. */
export function summaryMeta(message: ChatMessage, agent: AgentId = 'codex'): string[] {
  const { steps, checks, files, elapsedMs } = activitySummary(message, agent);
  const time = elapsedMs === undefined ? '' : formatElapsed(elapsedMs);
  const phase = phaseOfMessage(message);
  // An interrupted turn reports how far it got; only finished actions count.
  if (phase.kind === 'ended' && (phase.outcome === 'failed' || phase.outcome === 'cancelled')) {
    const done = (message.tools ?? []).filter(
      (tool) => tool.status === 'done' && !isBookkeepingTool(tool.name),
    ).length;
    return [done ? `完成 ${done} 步` : '', time].filter(Boolean);
  }
  return [
    steps ? `${steps} 步` : '',
    checks ? `核对 ${checks} 处` : '',
    files ? `${files} 个文件` : '',
    time,
  ].filter(Boolean);
}
