import { ArrowExpand01Icon, Cancel01Icon, CloudIcon } from '@hugeicons-pro/core-stroke-rounded';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { SandboxPipState } from '../shared/sandbox';
import { Icon } from './ui';
import './sandbox.css';

const STORAGE_KEY = 'athena.sandbox-pip.position';
const MARGIN = 16;
type Offset = { right: number; top: number };

function savedOffset(key: string, index: number): Offset {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (Number.isFinite(value?.right) && Number.isFinite(value?.top)) return value;
  } catch {
    /* default below */
  }
  // Cascade under the title bar, leaving the rear window reachable.
  return { right: MARGIN + index * 28, top: 56 + index * 14 };
}

/**
 * Picture-in-picture of the anonymous sandbox, floating inside the Athena window with a
 * frosted-glass surface. Drag the bar to move it; it stays within the window.
 */
export function SandboxPip({
  state,
  index,
  onClose,
  onExpand,
  onConnect,
  onOpenPreview,
}: {
  state: SandboxPipState;
  index: number;
  onClose: () => void;
  onExpand: () => void;
  onConnect: () => void;
  onOpenPreview: () => void;
}) {
  const card = useRef<HTMLElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; start: Offset } | undefined>(undefined);
  const storageKey = `${STORAGE_KEY}.${state.target}`;
  const [offset, setOffset] = useState<Offset>(() => savedOffset(storageKey, index));
  const [mode, setMode] = useState<'preview' | 'output'>('preview');

  // Keep the card reachable after the window shrinks.
  const clamp = (next: Offset): Offset => {
    const node = card.current;
    const parent = node?.offsetParent as HTMLElement | null;
    if (!node || !parent) return next;
    const maxRight = Math.max(MARGIN, parent.clientWidth - node.offsetWidth - MARGIN);
    const maxTop = Math.max(MARGIN, parent.clientHeight - node.offsetHeight - MARGIN);
    return {
      right: Math.min(maxRight, Math.max(MARGIN, next.right)),
      top: Math.min(maxTop, Math.max(MARGIN, next.top)),
    };
  };
  useLayoutEffect(() => {
    setOffset((value) => clamp(value));
    const onResize = () => setOffset((value) => clamp(value));
    const observer = new ResizeObserver(onResize);
    if (card.current?.offsetParent) observer.observe(card.current.offsetParent);
    return () => observer.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [state.lines]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button')) return;
    event.currentTarget.focus();
    drag.current = { x: event.clientX, y: event.clientY, start: offset };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const from = drag.current;
    if (!from) return;
    setOffset(
      clamp({
        right: from.start.right - (event.clientX - from.x),
        top: from.start.top + (event.clientY - from.y),
      }),
    );
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = undefined;
    try {
      localStorage.setItem(storageKey, JSON.stringify(offset));
    } catch {
      /* position is kept for this session */
    }
  };

  const { status } = state;
  return (
    <section
      ref={card}
      className={`sandbox-pip ${state.running ? 'is-running' : ''}`}
      aria-label={`${state.name ?? '独立沙箱'}预览`}
      data-target={state.target}
      style={{ right: offset.right, top: offset.top }}
    >
      <header
        className="sandbox-pip-bar"
        tabIndex={0}
        aria-label={`移动${state.name ?? '沙箱'}预览`}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          const step = event.shiftKey ? 24 : 8;
          const delta = {
            ArrowLeft: [step, 0],
            ArrowRight: [-step, 0],
            ArrowUp: [0, -step],
            ArrowDown: [0, step],
          }[event.key];
          if (!delta) return;
          event.preventDefault();
          setOffset((value) => clamp({ right: value.right + delta[0], top: value.top + delta[1] }));
        }}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="sandbox-pip-mark" aria-hidden>
          <Icon icon={CloudIcon} size={14} />
        </span>
        <span className="sandbox-pip-title">
          <strong>{state.name ?? '独立沙箱'}</strong>
          <span className={`sandbox-pip-status is-${status.tone}`} role="status">
            <span className="sandbox-pip-dot" aria-hidden />
            {state.running && status.tone === 'ok' ? 'AI 正在使用' : status.text}
          </span>
        </span>
        <button
          type="button"
          className="sandbox-pip-button"
          aria-label="回到对话"
          title="回到对话"
          onClick={onExpand}
        >
          <Icon icon={ArrowExpand01Icon} size={14} />
        </button>
        <button
          type="button"
          className="sandbox-pip-button"
          aria-label="关闭预览"
          title="关闭预览"
          onClick={onClose}
        >
          <Icon icon={Cancel01Icon} size={13} />
        </button>
      </header>
      <div className="sandbox-pip-controls">
        <div role="group" aria-label="沙箱视图">
          <button
            type="button"
            aria-pressed={mode === 'preview'}
            onClick={() => setMode('preview')}
          >
            预览
          </button>
          <button type="button" aria-pressed={mode === 'output'} onClick={() => setMode('output')}>
            输出
          </button>
        </div>
      </div>
      {state.frame && mode === 'preview' ? (
        <button
          type="button"
          className="sandbox-pip-screen"
          aria-label="在浏览器中打开沙箱预览"
          onClick={onOpenPreview}
        >
          <img
            src={state.frame}
            alt={state.frameTitle ? `${state.frameTitle} 页面` : '沙箱页面'}
            draggable={false}
          />
        </button>
      ) : (
        <div
          ref={log}
          className="sandbox-pip-terminal"
          role="log"
          aria-label="沙箱命令输出"
          tabIndex={0}
        >
          {state.lines.length ? (
            state.lines.map((line, index) => (
              <div key={index} className={`sandbox-pip-line is-${line.kind}`}>
                {line.text}
              </div>
            ))
          ) : (
            <div className="sandbox-pip-line is-status">等待 AI 在沙箱中执行命令…</div>
          )}
        </div>
      )}
      <footer className="sandbox-pip-footer">
        {status.tone === 'off' ? (
          <button type="button" onClick={onConnect}>
            连接沙箱
          </button>
        ) : (
          <span>{state.previewAvailable ? '应用预览已就绪' : status.text}</span>
        )}
        {state.previewAvailable && (state.runtime ?? state.target) !== 'backend' && (
          <button type="button" onClick={onOpenPreview}>
            打开预览 ↗
          </button>
        )}
      </footer>
    </section>
  );
}
