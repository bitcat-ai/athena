import { useEffect, useState } from 'react';
import { Input } from '@heroui/react';
import {
  BookOpen01Icon,
  Link02Icon,
  RefreshCwIcon,
  Tick02Icon,
} from '@hugeicons-pro/core-stroke-rounded';
import { ActionButton, Icon } from './ui';
import type { ProviderSkill, ProviderSkillDiscovery, WorkspaceSkill } from '../shared/skills';
import type { LocalMcpState } from '../shared/local-mcp';
import './local-integrations.css';

export function SkillsSettings({
  local,
  provider,
  discovery,
  selected,
  onUse,
  onRefresh,
}: {
  local: WorkspaceSkill[];
  provider: ProviderSkill[];
  discovery?: ProviderSkillDiscovery;
  selected: Set<string>;
  onUse: (name: string, source: 'local' | 'provider') => void;
  onRefresh: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const all = [
    ...provider.map((skill) => ({
      ...skill,
      key: `provider:${skill.name}`,
      available: skill.userInvocable,
      sourceName: skill.provider.name,
      location: skill.providerPath,
      issue: skill.userInvocable ? '' : '此 Skill 由 CLI 自动使用',
    })),
    ...local.map((skill) => ({
      ...skill,
      key: `local:${skill.name}`,
      source: 'local' as const,
      available: skill.availability === 'usable',
      sourceName: skill.source === 'workspace' ? '当前项目' : '本机共享',
      location: skill.entryPath,
      issue: skill.diagnostics.map((x) => x.message).join('；'),
    })),
  ];
  const filtered = all.filter((skill) =>
    `${skill.name} ${skill.description} ${skill.sourceName}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="local-integrations">
      <div className="settings-section-heading">
        <div>
          <h3>本机 Skills</h3>
          <p>选择 Skill 加入当前草稿，也可以在输入框使用 / 引用。</p>
        </div>
        <ActionButton
          aria-label="刷新 Skills"
          isDisabled={refreshing}
          onPress={() => {
            setRefreshing(true);
            void onRefresh().finally(() => setRefreshing(false));
          }}
        >
          <Icon icon={RefreshCwIcon} size={16} />
        </ActionButton>
      </div>
      <Input
        aria-label="搜索 Skills"
        placeholder="搜索名称、用途或来源"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {discovery && !['ready', 'empty'].includes(discovery.status) && (
        <p role="status" className="integration-notice">
          {discovery.provider.name} 的 Skill 暂不可用。可刷新重试，或使用本机共享 Skill。
        </p>
      )}
      <p className="integration-count">
        {filtered.length} 个 Skill · 已选择 {selected.size}/3
      </p>
      {!filtered.length && (
        <p className="integration-empty">
          {query
            ? '没有匹配的 Skill'
            : '还没有发现可用 Skill。安装到本机 CLI 或项目 .agents/skills 后刷新。'}
        </p>
      )}
      <ul className="integration-list" aria-label="Skills 列表">
        {filtered.map((skill) => (
          <li key={skill.key}>
            <Icon icon={BookOpen01Icon} size={18} />
            <div className="integration-copy">
              <strong>{skill.name}</strong>
              <span className="integration-source">{skill.sourceName}</span>
              <p>{skill.description}</p>
              <details>
                <summary>来源与状态</summary>
                <code>{skill.location ?? '由 CLI 提供'}</code>
                <p>{skill.issue || '可用于任务'}</p>
              </details>
            </div>
            <ActionButton
              variant="secondary"
              isDisabled={!skill.available || selected.has(skill.name) || selected.size >= 3}
              onPress={() => onUse(skill.name, skill.source === 'provider' ? 'provider' : 'local')}
            >
              {selected.has(skill.name) ? (
                <>
                  <Icon icon={Tick02Icon} size={14} />
                  已选择
                </>
              ) : (
                '用于任务'
              )}
            </ActionButton>
          </li>
        ))}
      </ul>
    </div>
  );
}

const statusLabel = {
  discovered: '未连接',
  connecting: '正在连接',
  connected: '已连接',
  error: '连接异常',
};
export function McpSettings({ busy }: { busy: boolean }) {
  const [state, setState] = useState<LocalMcpState>();
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const showError = (error: unknown) =>
    setError(
      (error instanceof Error ? error.message : String(error)).replace(
        /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
        '',
      ),
    );
  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.workbench.onEvent((event) => {
      if (event.type === 'local-mcp:state') setState(event.state);
    });
    void window.workbench
      .invoke<LocalMcpState>('local-mcp:list')
      .then((result) => {
        if (!disposed) setState(result);
      })
      .catch((error) => {
        if (!disposed) showError(error);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      setState(await window.workbench.invoke<LocalMcpState>('local-mcp:list', { refresh: true }));
    } catch (error) {
      showError(error);
    } finally {
      setLoading(false);
    }
  };
  const connect = async (id: string, enabled: boolean) => {
    setPending(id);
    setError('');
    try {
      setState(await window.workbench.invoke<LocalMcpState>('local-mcp:connect', { id, enabled }));
    } catch (error) {
      showError(error);
    } finally {
      setPending('');
    }
  };
  const servers =
    state?.servers.filter((server) =>
      `${server.name} ${server.source}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  return (
    <div className="local-integrations">
      <div className="settings-section-heading">
        <div>
          <h3>MCP 服务</h3>
          <p>连接本机已配置的服务，在任务中使用它的工具。</p>
        </div>
        <ActionButton
          aria-label="刷新 MCP 服务"
          isDisabled={busy || loading || Boolean(pending)}
          onPress={() => void refresh()}
        >
          <Icon icon={RefreshCwIcon} size={16} />
        </ActionButton>
      </div>
      <Input
        aria-label="搜索 MCP 服务"
        placeholder="搜索服务或来源"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {state && !state.available && (
        <p role="status" className="integration-notice">
          连接 MCP 需要本机 Codex。请在「本机 Agent」完成安装后刷新。
        </p>
      )}
      {busy && <p className="integration-notice">当前任务结束后可以更改连接。</p>}
      <p className="integration-count" role="status">
        {loading ? '正在读取本机配置…' : `${servers.length} 个服务`}
      </p>
      {!loading && !servers.length && (
        <p className="integration-empty">
          {query ? '没有匹配的服务' : '尚未发现 MCP。请先在本机 CLI 中配置服务，再刷新列表。'}
        </p>
      )}
      <ul className="integration-list" aria-label="MCP 服务列表">
        {servers.map((server) => (
          <li key={server.id}>
            <Icon icon={Link02Icon} size={18} />
            <div className="integration-copy">
              <strong>{server.name}</strong>
              <span className="integration-source">{server.source}</span>
              <p>
                {statusLabel[server.status]}
                {server.toolCount !== undefined ? ` · ${server.toolCount} 个工具` : ''}
                {server.enabled && server.status === 'discovered' ? ' · 下次使用时连接' : ''}
              </p>
              {server.message && <p className="inline-error">{server.message}</p>}
              <details>
                <summary>连接来源</summary>
                <code>{server.location}</code>
                <p>{server.transport === 'stdio' ? '本机进程' : 'HTTP 服务'} · 沿用原 CLI 配置</p>
              </details>
            </div>
            <div className="integration-actions">
              {(server.status === 'error' || server.needsReview) && server.enabled && (
                <ActionButton
                  variant="secondary"
                  isDisabled={busy || Boolean(pending)}
                  onPress={() => void connect(server.id, true)}
                >
                  核对后重连
                </ActionButton>
              )}
              <ActionButton
                variant="secondary"
                isDisabled={
                  busy ||
                  !state?.available ||
                  loading ||
                  Boolean(pending) ||
                  server.status === 'connecting'
                }
                onPress={() => void connect(server.id, !server.enabled)}
              >
                {pending === server.id || server.status === 'connecting'
                  ? '连接中…'
                  : server.enabled
                    ? '断开'
                    : '连接'}
              </ActionButton>
            </div>
          </li>
        ))}
      </ul>
      {Boolean(state?.diagnostics.length) && (
        <details className="integration-notice">
          <summary>部分来源未能读取</summary>
          {state?.diagnostics.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </details>
      )}
    </div>
  );
}
