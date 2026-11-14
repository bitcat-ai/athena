import { Card, Switch } from '@heroui/react';
import { Delete02Icon, Download01Icon } from '@hugeicons-pro/core-stroke-rounded';
import { useState } from 'react';
import type { LearnedItem, LearnedRepository, LearningState } from '../shared/learning';
import { ActionButton, Icon } from './ui';
import './learning.css';

const day = (at: number) => new Date(at).toLocaleDateString('zh-CN');
const proof = (item: LearnedItem) =>
  [
    item.basis === 'said'
      ? `你说过「${item.evidence}」`
      : item.basis === 'did'
        ? `你的操作：${item.evidence}`
        : '',
    item.source ? `出处 ${item.source}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
const code = (item?: { repository: string; root: string; branch?: string }) =>
  item ? `${item.repository} · ${item.root}${item.branch ? ' · ' + item.branch : ''}` : '';

/** What Athena has kept from working with the user, for them to review, switch off or remove. */
export function LearningPanel({
  state,
  onChange,
  invoke,
  onExported,
}: {
  state: LearningState;
  onChange: (state: LearningState) => void;
  invoke: <T>(name: string, payload?: unknown) => Promise<T>;
  onExported: () => void;
}) {
  const [confirming, setConfirming] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const run = async (name: string, payload: unknown) => {
    const next = await invoke<LearningState | undefined>(name, payload);
    if (next) onChange(next);
  };
  // Removal cannot be taken back, so the same button asks once before it acts.
  const removal = (id: string, label: string, remove: () => Promise<void>) =>
    confirming === id ? (
      <ActionButton
        className="learning-remove confirming"
        variant="danger-soft"
        autoFocus
        onBlur={() => setConfirming(undefined)}
        onPress={() => {
          setConfirming(undefined);
          void remove();
        }}
      >
        确认删除
      </ActionButton>
    ) : (
      <ActionButton
        className="icon-button learning-remove"
        aria-label={`删除${label}`}
        onPress={() => setConfirming(id)}
      >
        <Icon icon={Delete02Icon} size={16} />
      </ActionButton>
    );
  const entry = (item: LearnedItem) => (
    <li key={item.id} className={item.enabled ? '' : 'is-off'}>
      <div className="learning-text">
        <strong>{item.title}</strong>
        <p>{item.body}</p>
        <small>
          {[
            proof(item),
            item.scope ? `仅用于 ${item.scope}` : '',
            day(item.createdAt) +
              (item.conversationTitle ? ` 对话「${item.conversationTitle}」` : ''),
            item.revisions ? `更正 ${item.revisions} 次` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </small>
      </div>
      <div className="learning-controls">
        <Switch
          size="sm"
          aria-label={`启用「${item.title}」`}
          isSelected={item.enabled}
          isDisabled={!state.enabled}
          onChange={(enabled) => void run('learning:toggle', { id: item.id, enabled })}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
        {removal(item.id, `「${item.title}」`, () => run('learning:remove', { id: item.id }))}
      </div>
    </li>
  );
  const repository = (item: LearnedRepository) => (
    <li key={item.id}>
      <div className="learning-text">
        <strong>
          {item.origin}
          {item.module ? ` · ${item.module}` : ''}
        </strong>
        {(['frontend', 'backend'] as const).map(
          (component) =>
            item.components[component] && (
              <p key={component} className="learning-code">
                {component === 'frontend' ? '前端' : '后端'} {code(item.components[component])}
              </p>
            ),
        )}
        <small>
          {[item.source ? `出处 ${item.source}` : '', `${day(item.confirmedAt)} 确认`]
            .filter(Boolean)
            .join(' · ')}
        </small>
      </div>
      <div className="learning-controls">
        {removal(item.id, `${item.origin} 的仓库对应关系`, () =>
          run('learning:forget-repository', { id: item.id }),
        )}
      </div>
    </li>
  );
  const section = (title: string, empty: string, rows: React.ReactNode[]) => (
    <section className="learning-section" aria-label={title}>
      <h4>
        {title}
        {rows.length > 0 && <span>{rows.length}</span>}
      </h4>
      {rows.length ? <ul>{rows}</ul> : <p className="learning-empty">{empty}</p>}
    </section>
  );
  return (
    <>
      <div className="settings-section-heading">
        <div>
          <h3>记忆</h3>
          <p>我从你的要求和操作里记下的做法与知识。之后的对话会带上它们。</p>
        </div>
      </div>
      <Card className="learning-switch-card">
        <Card.Content>
          <Switch
            aria-label="从对话中学习"
            isSelected={state.enabled}
            onChange={(enabled) => void run('learning:enable', { enabled })}
          >
            <Switch.Content>
              <span className="learning-switch-text">
                <strong>从对话中学习</strong>
                <small>
                  只记你本人说过的要求和做过的操作，网页内容不算。关闭后不再记录，也不再带入对话。
                </small>
              </span>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Content>
          </Switch>
          {/* Kept out of the heading row: app notices float over the window's top-right corner. */}
          <div className="learning-export">
            <span className="learning-switch-text">
              <strong>导出为文档</strong>
              <small>
                把下面的内容连同依据整理成一份 Markdown 文档，便于核对后归入团队知识库。
              </small>
            </span>
            <ActionButton
              className="secondary-button"
              isDisabled={exporting}
              onPress={() => {
                setExporting(true);
                void invoke<boolean>('learning:export')
                  .then((saved) => saved && onExported())
                  .finally(() => setExporting(false));
              }}
            >
              <Icon icon={Download01Icon} size={14} />
              导出文档
            </ActionButton>
          </div>
        </Card.Content>
      </Card>
      {section(
        '行为规范',
        '还没有记录。在对话里告诉我以后希望怎么做，我会记在这里。',
        state.items.filter((item) => item.kind === 'rule').map(entry),
      )}
      {section(
        '业务知识',
        '还没有记录。任务中确认过、以后还用得上的事实会出现在这里。',
        state.items.filter((item) => item.kind === 'knowledge').map(entry),
      )}
      {section(
        '页面与代码仓库',
        '还没有记录。把页面改动落到源码时确认过的对应关系会出现在这里。',
        state.repositories.map(repository),
      )}
    </>
  );
}
