import { useEffect, useState } from 'react';
import { Input } from '@heroui/react';
import { CubeIcon, RefreshCwIcon } from '@hugeicons-pro/core-stroke-rounded';
import { ActionButton, Icon } from './ui';
import { ChoiceSelect } from './ChoiceSelect';
import {
  SANDBOX_POLICY_CHOICES,
  SANDBOX_RUNTIMES,
  sandboxEnvironment,
  type SandboxInstanceView,
  type SandboxInstancesState,
  type SandboxPolicy,
  type SandboxTarget,
} from '../shared/sandbox';
import './sandbox-settings.css';

const MINUTE = 60_000;
const statusLabel: Record<SandboxInstanceView['status'], string> = {
  starting: '启动中',
  running: '运行中',
  stopped: '已停止',
  failed: '启动失败',
};
/** A span of time in the largest unit that fits, e.g. "25 分钟". */
function span(ms: number) {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} 小时`;
  return `${Math.round(minutes / 60 / 24)} 天`;
}
const policyFields: Array<{
  key: keyof SandboxPolicy;
  label: string;
  option: (value: number) => string;
}> = [
  {
    key: 'idleStopMinutes',
    label: '闲置多久后停止',
    option: (value) => (value < 60 ? `${value} 分钟` : `${value / 60} 小时`),
  },
  { key: 'retainDays', label: '多久不用后删除', option: (value) => `${value} 天` },
  { key: 'maxRunning', label: '同时运行上限', option: (value) => `${value} 个` },
];

export function SandboxSettings({ conversations }: { conversations: Map<string, string> }) {
  const [state, setState] = useState<SandboxInstancesState>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [confirming, setConfirming] = useState('');
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [choice, setChoice] = useState('');
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [now, setNow] = useState(Date.now());
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
      if (event.type === 'sandbox:instances') setState(event.state);
    });
    void window.workbench
      .invoke<SandboxInstancesState>('sandbox:instances')
      .then((result) => {
        if (!disposed) setState(result);
      })
      .catch((error) => {
        if (!disposed) showError(error);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      disposed = true;
      unsubscribe();
      clearInterval(clock);
    };
  }, []);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(''), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);
  const run = async (action: string, payload?: Record<string, unknown>, key = action) => {
    setPending(key);
    setError('');
    try {
      const result = await window.workbench.invoke<SandboxInstancesState | true>(action, payload);
      if (result !== true) setState(result);
      return true;
    } catch (error) {
      showError(error);
      return false;
    } finally {
      setPending('');
      setNow(Date.now());
    }
  };
  const instances = state?.instances ?? [];
  const running = instances.filter((item) => item.status === 'running').length;
  const dockerReady = state?.docker.available ?? false;
  const coder = state?.coder;
  const ready = (provider: SandboxInstanceView['provider']) =>
    provider === 'coder' ? (coder?.available ?? false) : dockerReady;
  // Where a new sandbox runs: `coder:<template id>` or `docker:<environment>`.
  const environments = [
    ...(coder?.connected ? coder.templates : []).map((template) => ({
      value: 'coder:' + template.id,
      label: 'Coder · ' + template.name,
    })),
    ...(Object.keys(SANDBOX_RUNTIMES) as SandboxTarget[]).map((value) => ({
      value: 'docker:' + value,
      label: '本机 · ' + SANDBOX_RUNTIMES[value],
    })),
  ];
  const environment = environments.some((item) => item.value === choice)
    ? choice
    : environments[0].value;
  const onCoder = environment.startsWith('coder:');
  const coderCount = instances.filter((item) => item.provider === 'coder').length;
  const title = name.trim();
  const connect = () => {
    if (!token.trim() || pending) return;
    void run('sandbox:coder/connect', {
      origin: coder?.connected ? coder.origin : address,
      token,
    }).then((connected) => {
      if (!connected) return;
      setToken('');
      setAddress('');
    });
  };
  const source = (instance: SandboxInstanceView) =>
    instance.origin === 'user'
      ? '自建'
      : instance.origin === 'legacy'
        ? '对话已删除'
        : `对话「${conversations.get(instance.conversationId ?? '') || '未命名'}」`;
  const recycle = (instance: SandboxInstanceView) => {
    const parts = [`上次使用 ${span(now - instance.lastUsedAt)}前`];
    if (instance.busy) parts.push('正在使用');
    else if (instance.stopsAt)
      parts.push(
        instance.stopsAt > now ? `再闲置 ${span(instance.stopsAt - now)}后停止` : '即将停止',
      );
    parts.push(
      instance.keep
        ? '长期保留'
        : instance.removesAt && instance.removesAt > now
          ? `再闲置 ${span(instance.removesAt - now)}后删除`
          : '即将删除',
    );
    return parts.join(' · ');
  };
  return (
    <div className="local-integrations sandbox-settings">
      <div className="settings-section-heading">
        <div>
          <h3>沙箱</h3>
          <p>
            独立的运行环境：本机的 Docker 容器，或 Coder
            上的工作区。用来运行命令、构建和预览，不挂载本机项目和凭据。在对话里说出沙箱名称，Athena
            就在其中工作。
          </p>
        </div>
        <ActionButton
          aria-label="刷新沙箱"
          isDisabled={loading || Boolean(pending)}
          onPress={() => {
            setLoading(true);
            void run('sandbox:instances').finally(() => setLoading(false));
          }}
        >
          <Icon icon={RefreshCwIcon} size={16} />
        </ActionButton>
      </div>
      <form
        className="sandbox-create"
        onSubmit={(event) => {
          event.preventDefault();
          if (!title || pending) return;
          void run(
            'sandbox:instance/create',
            onCoder
              ? { name: title, template: environment.slice('coder:'.length) }
              : { name: title, runtime: environment.slice('docker:'.length) },
          ).then((created) => {
            if (created) setName('');
          });
        }}
      >
        <Input
          aria-label="沙箱名称"
          placeholder="新沙箱的名称"
          maxLength={40}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <ChoiceSelect
          label="运行环境"
          value={environment}
          onChange={setChoice}
          options={environments}
        />
        <ActionButton
          type="submit"
          variant="primary"
          isDisabled={!title || !ready(onCoder ? 'coder' : 'docker') || Boolean(pending)}
        >
          {pending === 'sandbox:instance/create' ? '创建中…' : '新建'}
        </ActionButton>
      </form>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {state && !state.docker.available && (
        <p role="status" className="integration-notice">
          {state.docker.message || 'Docker 不可用'}。启动后点击刷新。
        </p>
      )}
      {coder?.connected && !coder.available && (
        <p role="status" className="integration-notice">
          {coder.message || 'Coder 不可用'}
        </p>
      )}
      <p className="integration-count" role="status">
        {loading && !state
          ? '正在读取沙箱…'
          : `${instances.length} 个沙箱${running ? `，${running} 个运行中` : ''}`}
      </p>
      {state && !instances.length && (
        <p className="integration-empty">
          还没有沙箱。新建一个，或在任务需要独立环境时由 Athena 自动创建。
        </p>
      )}
      <ul className="integration-list" aria-label="沙箱列表">
        {instances.map((instance) => {
          const acting = pending.endsWith(':' + instance.id);
          const disabled = Boolean(pending) || instance.status === 'starting';
          return (
            <li key={instance.id} data-status={instance.status}>
              <Icon icon={CubeIcon} size={18} />
              <div className="integration-copy">
                <strong>{instance.name}</strong>
                <span className="integration-source">{source(instance)}</span>
                <p>
                  <span className="sandbox-status" data-status={instance.status}>
                    {statusLabel[instance.status]}
                  </span>
                  {' · '}
                  {sandboxEnvironment(instance)}
                  {instance.status === 'starting' ? ' · 首次使用会先准备环境，可能需要几分钟' : ''}
                </p>
                <p>{recycle(instance)}</p>
                {instance.message && <p className="inline-error">{instance.message}</p>}
              </div>
              <div className="integration-actions">
                {instance.previewUrl && (
                  <ActionButton
                    variant="secondary"
                    isDisabled={disabled}
                    onPress={() => void run('sandbox:instance/preview', { id: instance.id })}
                  >
                    打开预览
                  </ActionButton>
                )}
                {instance.origin !== 'legacy' && (
                  <ActionButton
                    variant="secondary"
                    isDisabled={
                      disabled || (instance.status !== 'running' && !ready(instance.provider))
                    }
                    onPress={() =>
                      void run(
                        instance.status === 'running'
                          ? 'sandbox:instance/stop'
                          : 'sandbox:instance/start',
                        { id: instance.id },
                        'toggle:' + instance.id,
                      )
                    }
                  >
                    {instance.status === 'starting' || (acting && pending.startsWith('toggle'))
                      ? '处理中…'
                      : instance.status === 'running'
                        ? '停止'
                        : '启动'}
                  </ActionButton>
                )}
                <ActionButton
                  aria-pressed={instance.keep}
                  isDisabled={disabled}
                  onPress={() =>
                    void run(
                      'sandbox:instance/keep',
                      { id: instance.id, keep: !instance.keep },
                      'keep:' + instance.id,
                    )
                  }
                >
                  {instance.keep ? '取消保留' : '保留'}
                </ActionButton>
                <ActionButton
                  className="sandbox-remove"
                  isDisabled={Boolean(pending) || !ready(instance.provider)}
                  onPress={() => {
                    if (confirming !== instance.id) return setConfirming(instance.id);
                    setConfirming('');
                    void run(
                      'sandbox:instance/remove',
                      { id: instance.id },
                      'remove:' + instance.id,
                    );
                  }}
                >
                  {acting && pending.startsWith('remove')
                    ? '删除中…'
                    : confirming === instance.id
                      ? '确认删除文件'
                      : '删除'}
                </ActionButton>
              </div>
            </li>
          );
        })}
      </ul>
      {coder && (
        <section className="sandbox-coder" aria-label="Coder">
          <h4 className="settings-subheading">Coder</h4>
          <p className="settings-card-caption">
            连接后可以按 Coder 模板新建沙箱，它运行在 Coder 的工作区里，回收规则同样适用。需要这台
            Mac 装有 Coder CLI，模板里带 Node.js。令牌加密保存在本机。
          </p>
          {coder.connected && (
            <div className="settings-value-row">
              <span>
                已连接 {coder.origin} · {coder.username}
                {coder.insecure ? ' · HTTP 未加密' : ''}
              </span>
              <ActionButton
                className="sandbox-remove"
                isDisabled={Boolean(pending)}
                onPress={() => {
                  if (confirming !== 'coder') return setConfirming('coder');
                  setConfirming('');
                  void run('sandbox:coder/disconnect');
                }}
              >
                {pending === 'sandbox:coder/disconnect'
                  ? '断开中…'
                  : confirming === 'coder'
                    ? '确认断开'
                    : '断开'}
              </ActionButton>
            </div>
          )}
          {confirming === 'coder' && coderCount > 0 && (
            <p role="status" className="integration-notice">
              断开后，{coderCount} 个 Coder 沙箱从列表移除，运行中的会停止；它们的工作区留在 Coder
              上，之后需在 Coder 中删除。
            </p>
          )}
          {(!coder.connected || !coder.available) && (
            <form
              className="sandbox-coder-connect"
              onSubmit={(event) => {
                event.preventDefault();
                connect();
              }}
            >
              {!coder.connected && (
                <Input
                  aria-label="Coder 地址"
                  placeholder="Coder 地址，例如 https://coder.example.com"
                  maxLength={300}
                  autoComplete="off"
                  spellCheck={false}
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                />
              )}
              <Input
                aria-label="Coder 令牌"
                type="password"
                placeholder={coder.connected ? '新的令牌' : '令牌'}
                maxLength={500}
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <ActionButton
                type="submit"
                variant={coder.connected ? 'secondary' : 'primary'}
                isDisabled={
                  !token.trim() || (!coder.connected && !address.trim()) || Boolean(pending)
                }
              >
                {pending === 'sandbox:coder/connect'
                  ? '连接中…'
                  : coder.connected
                    ? '更新令牌'
                    : '连接'}
              </ActionButton>
            </form>
          )}
        </section>
      )}
      {state && (
        <section className="sandbox-policy" aria-label="回收规则">
          <h4 className="settings-subheading">回收规则</h4>
          <p className="settings-card-caption">
            停止只结束进程，文件保留，下次使用时自动启动。删除会移除容器或 Coder
            工作区，连同其中的全部文件；标记为保留的沙箱不会被删除。正在使用的沙箱不受影响。退出
            Athena 时，运行中的沙箱会停止。
          </p>
          {policyFields.map((field) => (
            <div className="settings-value-row" key={field.key}>
              <span>{field.label}</span>
              <ChoiceSelect
                label={field.label}
                value={String(state.policy[field.key])}
                isDisabled={Boolean(pending)}
                onChange={(value) =>
                  void run('sandbox:policy', { policy: { [field.key]: Number(value) } })
                }
                options={SANDBOX_POLICY_CHOICES[field.key].map((value) => ({
                  value: String(value),
                  label: field.option(value),
                }))}
              />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
