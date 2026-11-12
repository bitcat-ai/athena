import { BookOpen01Icon, PlugSocketIcon } from '@hugeicons-pro/core-stroke-rounded';
import { toolIntegration } from '../shared/tool-integrations';
import type { ChatMessage } from '../shared/types';
import { Icon } from './ui';
import './integration-activity.css';

export function IntegrationActivity({ message }: { message: ChatMessage }) {
  const calls = (message.tools ?? []).flatMap((tool) => {
    const integration = toolIntegration(tool);
    return integration ? [{ tool, integration }] : [];
  });
  if (!calls.length) return null;
  return (
    <div className="integration-activity" aria-label="Skill 与 MCP 调用">
      {calls.map(({ tool, integration: item }) => {
        const state =
          tool.status === 'running'
            ? message.status === 'streaming'
              ? 'running'
              : 'stopped'
            : tool.status;
        const status =
          state === 'running'
            ? item.kind === 'skill'
              ? '正在读取'
              : '正在调用'
            : state === 'stopped'
              ? '已停止'
              : state === 'error'
                ? '调用失败'
                : item.kind === 'skill'
                  ? '已读取'
                  : '已返回';
        return (
          <article
            key={tool.id}
            className="integration-card"
            data-kind={item.kind}
            data-state={state}
          >
            <header>
              <span className="integration-mark" aria-hidden>
                <Icon icon={item.kind === 'skill' ? BookOpen01Icon : PlugSocketIcon} size={18} />
              </span>
              <div className="integration-heading">
                <span className="integration-label">
                  {item.kind === 'skill' ? 'Skill' : 'MCP'}
                  <span>·</span>
                  {item.action}
                </span>
                <strong>{item.name}</strong>
              </div>
              <span className="integration-status" role="status">
                <i aria-hidden />
                {status}
              </span>
            </header>
            {item.description && <p className="integration-description">{item.description}</p>}
            {item.facts.length > 0 && (
              <dl className="integration-facts">
                {item.facts.map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {state === 'error' && tool.output && (
              <p className="integration-error">{tool.output.slice(0, 500)}</p>
            )}
          </article>
        );
      })}
    </div>
  );
}
