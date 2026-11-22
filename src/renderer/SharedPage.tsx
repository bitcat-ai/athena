import { NavigationArrow, TurnIcon } from './HoverIcons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Input } from '@heroui/react';
import { Cursor01Icon, UsersIcon } from '@hugeicons-pro/core-stroke-rounded';
import { ActionButton, Icon } from './ui';
import { ElementInspector } from './ElementInspector';
import { SharedSurface } from './SharedSurface';
import { ShareConnection } from './share-connection';
import athenaLogo from './assets/brand/athena-profile.png';
import type { BrowserFrame, BrowserState, RecordedStep } from '../shared/types';
import type { ShareState } from '../shared/share';

export default function SharedPage() {
  const [name, setName] = useState('');
  const [connection, setConnection] = useState<ShareConnection>();
  const connectionRef = useRef<ShareConnection | undefined>(undefined);
  const [state, setState] = useState<ShareState>();
  const [browser, setBrowser] = useState<BrowserState>();
  const [status, setStatus] = useState('');
  const [frameReady, setFrameReady] = useState(false);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const [steps, setSteps] = useState<RecordedStep[]>([]);
  const [history, setHistory] = useState(false);
  const [inspector, setInspector] = useState(false);
  const [ended, setEnded] = useState(false);
  const latest = useRef<BrowserFrame | undefined>(undefined);
  const listeners = useRef(new Set<(frame: BrowserFrame) => void>());
  const frameSource = useRef({
    subscribe(callback: (frame: BrowserFrame) => void) {
      listeners.current.add(callback);
      if (latest.current) callback(latest.current);
      return () => {
        listeners.current.delete(callback);
      };
    },
  }).current;
  const [invite] = useState(() => {
    const value = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
    // The capability stays out of URLs, referrers and copied browser history after load.
    window.history.replaceState(null, '', location.pathname);
    return value;
  });
  useEffect(() => () => connectionRef.current?.close(), []);
  useEffect(() => {
    if (browser) setUrl(browser.url === 'about:blank' ? '' : browser.url);
  }, [browser?.url]);
  const join = () => {
    connectionRef.current?.close();
    latest.current = undefined;
    setFrameReady(false);
    setError('');
    setEnded(false);
    const next = new ShareConnection(
      name,
      invite,
      (message) => {
        if (message.type === 'state') {
          setState(message.state);
          if (message.browser) setBrowser(message.browser);
          if (message.steps) setSteps(message.steps);
        }
        if (message.type === 'frame') {
          latest.current = message.frame;
          for (const listener of listeners.current) listener(message.frame);
        }
        if (message.type === 'step')
          setSteps((old) => {
            const found = old.findIndex((s) => s.id === message.step.id);
            return found < 0
              ? [...old, message.step].slice(-2000)
              : old.map((s) => (s.id === message.step.id ? message.step : s));
          });
        if (message.type === 'error') setError(message.error);
        if (message.type === 'ended') {
          setEnded(true);
          setHistory(true);
          if (message.recording) setSteps(message.recording.steps);
        }
      },
      (value) => {
        if (value !== '已连接') {
          latest.current = undefined;
          setFrameReady(false);
        }
        setStatus(value);
      },
    );
    connectionRef.current = next;
    setConnection(next);
    next.connect();
  };
  const action = useCallback(async <T,>(action: string, payload?: unknown): Promise<T> => {
    try {
      const result = await connectionRef.current!.invoke<T>(action, payload);
      setError('');
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
      return undefined as T;
    }
  }, []);
  const me = state?.participants.find((p) => p.id === connection?.participantId);
  const controller = state?.participants.find((p) => p.id === state.controllerId);
  const host = state?.participants.find((p) => p.role === 'host');
  const approved = me?.status === 'connected';
  const hasControl = Boolean(
    approved &&
    status === '已连接' &&
    !ended &&
    !state?.changingControl &&
    state?.controllerId === me?.id,
  );
  const controlling = hasControl && frameReady && Boolean(connection?.frameIsCurrent());
  return (
    <main className="shared-app" data-role={me?.role || 'pending'}>
      <header className="shared-header">
        <div className="shared-brand">
          <img src={athenaLogo} alt="" />
          <strong>Athena</strong>
        </div>
        <span className="shared-role">
          {ended ? '已结束' : approved ? (me?.role === 'editor' ? '可操作' : '仅查看') : '共享页面'}
        </span>
        <span className="shared-connection" role="status">
          {status}
        </span>
        {connection && (
          <ActionButton
            onPress={() => {
              void connection
                .invoke('share:leave')
                .catch(() => {})
                .finally(() => {
                  connection.close();
                  sessionStorage.removeItem('athena-share-resume');
                  setStatus('已退出共享');
                  setEnded(true);
                });
            }}
          >
            退出共享
          </ActionButton>
        )}
      </header>
      {!connection ? (
        <form
          className="share-join"
          onSubmit={(e) => {
            e.preventDefault();
            join();
          }}
        >
          <Icon icon={UsersIcon} size={28} />
          <h1>一起浏览，一起修改</h1>
          <p>主持人确认后，你将看到同一个网页。操作会按参与者记录。</p>
          <label htmlFor="guest-name">你的称呼</label>
          <Input
            id="guest-name"
            autoComplete="name"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
          <ActionButton type="submit" className="primary-button" isDisabled={!name.trim()}>
            请求加入
          </ActionButton>
        </form>
      ) : !approved && !ended ? (
        <section className="share-waiting">
          <Icon icon={UsersIcon} size={28} />
          <h1>{error ? '暂时无法加入' : '等待主持人确认'}</h1>
          <p>{error || `${name}，请告知主持人你的称呼与身份编号。`}</p>
          {connection.participantId && <code>身份 {connection.participantId.slice(0, 8)}</code>}
          {error && (
            <ActionButton
              className="secondary-button"
              onPress={() => {
                connection.close();
                setConnection(undefined);
                setState(undefined);
                setStatus('');
              }}
            >
              返回
            </ActionButton>
          )}
        </section>
      ) : (
        <>
          <section className="shared-page-heading">
            <h1>{browser?.title || state?.title || '共享页面'}</h1>
            {!ended && <p>{host?.name || '主持人'} 正在共享此页面</p>}
          </section>
          <div className="shared-toolbar">
            <div className="shared-presence">
              <Icon icon={UsersIcon} size={15} />
              <span>
                {state?.participants
                  .map((p) => `${p.name}${p.status === 'disconnected' ? '（断开）' : ''}`)
                  .join(' · ')}
              </span>
            </div>
            <span className="shared-controller" role="status">
              <Icon icon={Cursor01Icon} size={15} />
              {ended
                ? '本次共享已结束'
                : state?.changingControl
                  ? '正在交接控制权'
                  : controlling
                    ? '你正在操作'
                    : hasControl
                      ? history
                        ? '你持有控制权'
                        : '正在同步页面…'
                      : `${controller?.name || '主持人'}正在操作`}
            </span>
            {!ended && me?.role === 'editor' && (
              <ActionButton
                className="primary-button shared-control-action"
                isDisabled={state?.changingControl || me.requestedControl}
                onPress={() =>
                  void action(hasControl ? 'share:release-control' : 'share:request-control')
                }
              >
                {hasControl ? '交回控制权' : me.requestedControl ? '已请求操作' : '请求操作'}
              </ActionButton>
            )}
            <ActionButton onPress={() => setHistory((v) => !v)}>
              {history ? '返回页面' : `操作记录 · ${steps.length}`}
            </ActionButton>
            {!ended && me?.role === 'viewer' && (
              <p className="shared-readonly-note">
                你以只读方式加入。操作页面需主持人授予权限并交接控制权。
              </p>
            )}
          </div>
          {error && (
            <div className="shared-error" role="alert">
              {error}
              <ActionButton onPress={() => setError('')}>知道了</ActionButton>
            </div>
          )}
          {status !== '已连接' && !ended && (
            <p className="shared-error">{status} 未确认的操作不会自动重试。</p>
          )}
          {history ? (
            <section className="shared-history">
              <h1>操作记录</h1>
              <p>按时间查看双方的操作；不会重新执行页面动作。</p>
              <ol className="step-list">
                {steps.map((step) => (
                  <li key={step.id}>
                    <span className="step-index">{step.actor?.name?.slice(0, 1) || '人'}</span>
                    <div>
                      <strong>
                        {step.actor?.name || (step.source === 'agent' ? 'Agent' : '参与者')} ·{' '}
                        {step.description}
                      </strong>
                      {step.value && <code>{step.value}</code>}
                      <span className="step-meta">
                        {new Date(step.timestamp).toLocaleTimeString('zh-CN')}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
              {!steps.length && <p>还没有页面操作。</p>}
            </section>
          ) : (
            <>
              <form
                className="shared-navigation"
                onSubmit={(e) => {
                  e.preventDefault();
                  void action('browser:navigate', { url });
                }}
              >
                <ActionButton
                  isIconOnly
                  aria-label="后退"
                  isDisabled={!controlling || !browser?.canGoBack}
                  onPress={() => void action('browser:back')}
                >
                  {({ isHovered, isDisabled }) => (
                    <NavigationArrow hovered={isHovered && !isDisabled} />
                  )}
                </ActionButton>
                <ActionButton
                  isIconOnly
                  aria-label="前进"
                  isDisabled={!controlling || !browser?.canGoForward}
                  onPress={() => void action('browser:forward')}
                >
                  {({ isHovered, isDisabled }) => (
                    <NavigationArrow forward hovered={isHovered && !isDisabled} />
                  )}
                </ActionButton>
                <ActionButton
                  isIconOnly
                  aria-label="刷新"
                  isDisabled={!controlling}
                  onPress={() => void action('browser:reload')}
                >
                  {({ isHovered, isDisabled }) => (
                    <TurnIcon kind="refresh" size={15} hovered={isHovered && !isDisabled} />
                  )}
                </ActionButton>
                <Input
                  aria-label="共享网页地址"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  readOnly={!controlling}
                />
                <ActionButton type="submit" isDisabled={!controlling}>
                  打开
                </ActionButton>
                <ActionButton
                  isDisabled={!controlling}
                  onPress={() => {
                    setInspector(true);
                    void action('browser:inspect', { enabled: true });
                  }}
                >
                  <Icon icon={Cursor01Icon} size={15} />
                  选择元素
                </ActionButton>
                <ActionButton isDisabled={!controlling} onPress={() => setInspector((v) => !v)}>
                  修改元素
                </ActionButton>
              </form>
              <div className="shared-page-content">
                <div className="shared-workspace">
                  <SharedSurface
                    key={status === '已连接' ? 'connected' : 'offline'}
                    connection={connection}
                    frameSource={frameSource}
                    enabled={controlling}
                    onReady={setFrameReady}
                    onError={setError}
                  />
                  {inspector && hasControl && (
                    <aside className="shared-inspector" inert={!controlling} aria-busy={!controlling}>
                      <ElementInspector
                        actorId={me?.id}
                        selected={browser?.selectedElement}
                        tabId={browser?.activeTabId}
                        previews={(browser?.previewEdits || []).filter(
                          (p) => !p.actor || p.actor.id === me?.id,
                        )}
                        controlSurface={browser?.elementControls}
                        onAction={action}
                        onClose={() => setInspector(false)}
                      />
                    </aside>
                  )}
                </div>
                <section className="shared-recent-activity" aria-label="最近操作">
                  <h2>最近操作</h2>
                  {steps.length ? (
                    <ol>
                      {steps
                        .slice(-3)
                        .reverse()
                        .map((step) => (
                          <li key={step.id}>
                            <span>
                              {step.actor?.name || (step.source === 'agent' ? 'Agent' : '参与者')} ·{' '}
                              {step.description}
                            </span>
                            <time>
                              {new Date(step.timestamp).toLocaleTimeString('zh-CN', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </time>
                          </li>
                        ))}
                    </ol>
                  ) : (
                    <p>还没有页面操作。</p>
                  )}
                </section>
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}
