import { Button } from '@heroui/react';
import { FolderOpenIcon } from '@hugeicons-pro/core-stroke-rounded';
import { activityItems, type ActivityItem } from '../shared/activity';
import type { AgentId, ChatMessage } from '../shared/types';
import { PhaseGlyph } from './PhaseGlyph';
import { Icon } from './ui';

const requestMarks = { approval: 'shield', input: 'bubble', handoff: 'cursor' } as const;
const modelSources = {
  unconfirmed: '所选模型，等待执行确认',
  'thread-response': 'CLI 已确认的配置',
};
const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`;
const pretty = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);

/** Everything a turn did, in the order it happened: plan, actions, requests, checks, artifacts. */
export function ActivityTimeline({
  message,
  agent,
  conversationId,
  openToolId,
  onOpenTool,
  onAction,
}: {
  message: ChatMessage;
  agent: AgentId;
  conversationId: string;
  openToolId?: string;
  onOpenTool: (id?: string) => void;
  onAction: <T = unknown>(action: string, payload?: unknown) => Promise<T>;
}) {
  const row = (item: ActivityItem) => {
    if (item.kind === 'plan')
      return (
        <li key={item.id} className={`plan ${item.state}`}>
          {item.text}
        </li>
      );
    if (item.kind === 'tool') {
      const open = openToolId === item.id;
      const { tool } = item;
      return (
        <li key={item.id} data-kind="tool" data-state={item.state}>
          <button
            type="button"
            className="tl-row"
            aria-expanded={open}
            onClick={() => onOpenTool(open ? undefined : item.id)}
          >
            {item.state === 'fail' ? (
              <PhaseGlyph kind="fail" />
            ) : item.state === 'stopped' ? (
              <PhaseGlyph kind="stopped" />
            ) : (
              <PhaseGlyph kind={item.glyph} still={item.state !== 'run'} />
            )}
            <span className="tl-text" title={item.target || undefined}>
              <span className="tl-title">{item.title}</span>
              {item.target && <span className="tl-target">{item.target}</span>}
            </span>
            {tool.durationMs !== undefined && (
              <span className="tl-dur">{(tool.durationMs / 1000).toFixed(1)}s</span>
            )}
          </button>
          {open && (
            <div className="tl-detail">
              {tool.output && (
                <>
                  <small>
                    {tool.status === 'error' ? '返回的问题' : '返回结果'}
                    {tool.exitCode !== undefined ? ` · 退出码 ${tool.exitCode}` : ''}
                  </small>
                  <pre>{tool.output}</pre>
                </>
              )}
              <small>动作参数</small>
              <pre>{pretty(tool.input)}</pre>
            </div>
          )}
        </li>
      );
    }
    if (item.kind === 'check')
      return (
        <li key={item.id} data-kind="check" data-state={item.state}>
          <div className="tl-line">
            {item.state === 'run' ? (
              <PhaseGlyph kind="verify" />
            ) : item.state === 'ok' ? (
              <PhaseGlyph kind="checked" tone="ok" />
            ) : (
              <PhaseGlyph kind={item.state === 'missing' ? 'fail' : 'warn'} />
            )}
            <span className="tl-col">
              <span className="tl-title">{item.text}</span>
              {item.evidence && <blockquote>{item.evidence}</blockquote>}
            </span>
          </div>
        </li>
      );
    if (item.kind === 'request') {
      const declined = ['rejected', 'dismissed'].includes(item.request.resolution);
      return (
        <li key={item.id} data-kind="request">
          <div className="tl-line">
            <PhaseGlyph kind={requestMarks[item.request.kind]} tone={declined ? 'fail' : 'ok'} />
            <span className="tl-text tl-title" title={item.text}>
              {item.text}
            </span>
          </div>
        </li>
      );
    }
    return (
      <li key={item.id} data-kind="artifact">
        <div className="tl-line">
          <PhaseGlyph kind="file" />
          <span className="tl-artifact">
            {item.name}
            <small>{bytes(item.bytes)}</small>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label={`在 Finder 中显示 ${item.name}`}
              onPress={() =>
                void onAction('artifact:reveal', {
                  conversationId,
                  messageId: message.id,
                  eventId: item.id,
                })
              }
            >
              <Icon icon={FolderOpenIcon} size={14} />
            </Button>
          </span>
        </div>
      </li>
    );
  };
  const { model } = message;
  return (
    <>
      {model && (
        <div
          className="tl-model"
          title={modelSources[model.source as keyof typeof modelSources] ?? '本轮 CLI 执行记录'}
        >
          {model.model ?? model.requested ?? '模型待确认'}
          {model.source === 'unconfirmed' ? ' · 待确认' : ''}
        </div>
      )}
      <ul
        className="tl"
        onKeyDown={(event) => {
          const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('.tl-row'));
          const index = rows.indexOf(event.target as HTMLElement);
          if (index < 0) return;
          const next = {
            ArrowUp: index - 1,
            ArrowDown: index + 1,
            Home: 0,
            End: rows.length - 1,
          }[event.key];
          if (next === undefined) return;
          event.preventDefault();
          rows[Math.max(0, Math.min(rows.length - 1, next))].focus();
        }}
      >
        {activityItems(message, agent).map(row)}
      </ul>
    </>
  );
}
