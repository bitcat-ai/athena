import { NavigationArrow, TurnIcon } from './HoverIcons';
import { Input, Tabs } from '@heroui/react';
import { Segment } from '@heroui-pro/react';
import { ChoiceSelect } from './ChoiceSelect';
import { ActionButton, Icon } from './ui';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight01Icon,
  CircleIcon,
  Cursor01Icon,
  Download01Icon,
  EarthIcon,
  Loading02Icon,
  PlayIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  StopIcon,
  Tick02Icon,
  XIcon,
} from '@hugeicons-pro/core-stroke-rounded';
import type {
  BrowserFrame,
  BrowserInput,
  BrowserState,
  BrowserViewport,
  NativeNeoState,
  RecordedStep,
  Recording,
} from '../shared/types';
import type { GlyphKind } from '../shared/phase';
import { NeoHistory } from './NeoHistory';
import { PhaseGlyph } from './PhaseGlyph';
import { SharePanel } from './SharePanel';
import type { ShareState } from '../shared/share';
import './sharing.css';

interface Props {
  state: BrowserState;
  recordings: Recording[];
  liveSteps: RecordedStep[];
  onAction: <T = unknown>(action: string, payload?: unknown) => Promise<T>;
  onOpenSettings: () => void;
  onAnalyze: (id: string) => void;
  onClose: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  initialFrame?: BrowserFrame;
  /** What the running turn is doing, echoed next to the page it works on. */
  agentStatus?: { text: string; glyph: GlyphKind };
  neo?: NativeNeoState;
  nativeRecordId?: string;
}
function modifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}
export function BrowserPane({
  state,
  recordings,
  liveSteps,
  onAction,
  onOpenSettings,
  onAnalyze,
  onClose,
  inspectorOpen,
  onToggleInspector,
  initialFrame,
  agentStatus,
  neo,
  nativeRecordId,
}: Props) {
  const [share, setShare] = useState<ShareState>();
  const shareRef = useRef<ShareState | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    void window.workbench.invoke<ShareState>('share:state').then((s) => {
      if (!disposed) {
        shareRef.current = s;
        setShare(s);
      }
    });
    const unsubscribe = window.workbench.onEvent((e) => {
      if (e.type === 'share:state') {
        shareRef.current = e.state;
        setShare(e.state);
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  const [url, setUrl] = useState(state.url);
  const [mode, setMode] = useState<'page' | 'recordings' | 'neo'>('page');
  const [recordingId, setRecordingId] = useState<string>();
  const [frameLoading, setFrameLoading] = useState(!initialFrame?.data);
  const [viewportPending, setViewportPending] = useState(false);
  const [tabBusy, setTabBusy] = useState(false);
  const [zoomModes, setZoomModes] = useState<Record<string, 'fit' | 'actual'>>({});
  const [zoomPercent, setZoomPercent] = useState(100);
  const [fitLimited, setFitLimited] = useState(false);
  const [viewportError, setViewportError] = useState(false);
  const [viewportRetry, setViewportRetry] = useState(0);
  const zoomMode = zoomModes[state.activeTabId ?? ''] ?? 'fit';
  const image = useRef<HTMLImageElement>(null);
  const lastFrame = useRef(initialFrame?.data || '');
  const receivedEpoch = useRef(initialFrame?.epoch);
  const decodedEpoch = useRef<number | undefined>(undefined);
  const expectedEpoch = useRef(state.viewport?.epoch);
  expectedEpoch.current = state.viewport?.epoch;
  const activeTab = useRef(state.activeTabId);
  const tabList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = tabList.current;
    if (!list) return;
    const observer = new ResizeObserver(() => {
      const tab = list.querySelector('.is-active')?.getBoundingClientRect();
      if (!tab) return;
      const bounds = list.getBoundingClientRect();
      if (tab.left < bounds.left) list.scrollLeft += tab.left - bounds.left;
      else if (tab.right > bounds.right) list.scrollLeft += tab.right - bounds.right;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [state.activeTabId, state.tabs?.length]);
  const surface = useRef<HTMLDivElement>(null);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const viewport = useRef({
    width: initialFrame?.width || 960,
    height: initialFrame?.height || 720,
  });
  const decodedViewport = useRef<BrowserViewport | undefined>(undefined);
  const expectedViewport = useRef<
    | (BrowserViewport & {
        surfaceWidth: number;
        surfaceHeight: number;
        epoch?: number;
        zoomMode: 'fit' | 'actual';
      })
    | undefined
  >(undefined);
  const resizeRequest = useRef(0);
  const composing = useRef(false);
  const compositionTab = useRef<string | undefined>(undefined);
  const compositionEpoch = useRef<number | undefined>(undefined);
  const compositionGeneration = useRef<number | undefined>(undefined);
  const compositionCommit = useRef<{ value: string; time: number } | undefined>(undefined);
  const pointerFrame = useRef<number>(0);
  const inspectActive = useRef(false);
  const busy = state.status === 'starting' || state.loading;
  const ready = state.status === 'ready';
  const recording = recordings.find((item) => item.id === recordingId) || recordings[0];
  const alignedViewport = () => {
    const bounds = surface.current?.getBoundingClientRect();
    const expected = expectedViewport.current;
    const bitmap = image.current;
    return Boolean(
      bounds &&
      expected &&
      (expectedEpoch.current === undefined || decodedEpoch.current === expectedEpoch.current) &&
      bitmap?.naturalWidth &&
      Math.abs(
        bitmap.naturalWidth -
          (bitmap.naturalHeight * viewport.current.width) / viewport.current.height,
      ) <= 2 &&
      expected.tabId === activeTab.current &&
      Math.abs(expected.surfaceWidth - Math.floor(bounds.width)) <= 1 &&
      Math.abs(expected.surfaceHeight - Math.floor(bounds.height)) <= 1 &&
      Math.abs(viewport.current.width - expected.width) <= 1 &&
      Math.abs(viewport.current.height - expected.height) <= 1 &&
      decodedViewport.current?.tabId === expected.tabId &&
      decodedViewport.current?.width === viewport.current.width &&
      decodedViewport.current?.height === viewport.current.height,
    );
  };
  const sendInput = (input: BrowserInput) => {
    if (
      shareRef.current?.active &&
      (shareRef.current.controllerId !== 'host' || shareRef.current.changingControl)
    )
      return;
    if (ready && !frameLoading && !viewportPending && alignedViewport())
      void window.workbench
        .invoke('browser:input', {
          ...input,
          tabId: input.tabId ?? activeTab.current,
          frameEpoch: decodedEpoch.current,
        })
        .catch(() => {});
  };

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        (!state.inspecting && !inspectActive.current) ||
        document.querySelector('dialog[open]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void onAction('browser:inspect', { enabled: false });
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [state.inspecting, onAction]);
  useEffect(() => {
    if (mode !== 'page' && state.inspecting) void onAction('browser:inspect', { enabled: false });
  }, [mode, state.inspecting, onAction]);
  useEffect(() => {
    if (nativeRecordId) setMode('neo');
  }, [nativeRecordId]);
  useEffect(() => () => cancelAnimationFrame(pointerFrame.current), []);
  useEffect(() => {
    if (document.activeElement !== address.current)
      setUrl(state.url === 'about:blank' ? '' : state.url);
  }, [state.url]);
  useEffect(() => {
    if (state.selectedElement) {
      setMode('page');
    }
  }, [state.selectedElement?.ref]);
  useEffect(() => {
    if (state.activeTabId !== activeTab.current) {
      activeTab.current = state.activeTabId;
      lastFrame.current = '';
      decodedViewport.current = undefined;
      image.current?.removeAttribute('src');
      setFrameLoading(true);
    }
  }, [state.activeTabId]);
  useEffect(
    () =>
      window.workbench.onEvent((event) => {
        if (event.type === 'browser:state') {
          inspectActive.current = event.state.inspecting;
          expectedEpoch.current = event.state.viewport?.epoch;
          // A new document must finish its fit check before accepting input,
          // even if its first bitmap happens to have the previous dimensions.
          if (event.state.loading && expectedViewport.current?.epoch !== expectedEpoch.current)
            expectedViewport.current = undefined;
          if (expectedEpoch.current !== undefined && decodedEpoch.current !== expectedEpoch.current)
            setViewportPending(true);
        }
        if (event.type === 'browser:state' && event.state.activeTabId !== activeTab.current) {
          activeTab.current = event.state.activeTabId;
          lastFrame.current = '';
          decodedViewport.current = undefined;
          image.current?.removeAttribute('src');
          setFrameLoading(true);
        }
        if (event.type === 'browser:frame') {
          if (event.frame.tabId && event.frame.tabId !== activeTab.current) return;
          if (!event.frame.data) {
            lastFrame.current = '';
            decodedViewport.current = undefined;
            image.current?.removeAttribute('src');
            setFrameLoading(true);
            return;
          }
          receivedEpoch.current = event.frame.epoch;
          viewport.current = { width: event.frame.width, height: event.frame.height };
          lastFrame.current = event.frame.data.startsWith('data:')
            ? event.frame.data
            : `data:image/jpeg;base64,${event.frame.data}`;
          if (image.current) image.current.src = lastFrame.current;
        }
      }),
    [],
  );
  useEffect(() => {
    if (!surface.current || mode !== 'page' || !ready) {
      expectedViewport.current = undefined;
      setViewportPending(true);
      return;
    }
    // Same-document URL updates can briefly report loading (e.g. a live search).
    // Keep the displayed geometry: once loading ends it is usable immediately
    // if the document epoch and surface still match. Real navigations fail that check.
    if (expectedViewport.current?.zoomMode !== zoomMode) expectedViewport.current = undefined;
    setViewportPending(state.loading || !alignedViewport());
    if (state.loading) return;
    let timer: ReturnType<typeof setTimeout>;
    const resize = (bounds: DOMRectReadOnly) => {
      clearTimeout(timer);
      const expected = expectedViewport.current;
      if (
        !expected ||
        expected.tabId !== state.activeTabId ||
        Math.abs(expected.surfaceWidth - Math.floor(bounds.width)) > 1 ||
        Math.abs(expected.surfaceHeight - Math.floor(bounds.height)) > 1 ||
        // A fitted wide page may need a temporary layout probe at the pane width.
        // Keep input blocked until that probe has finished.
        (zoomMode === 'fit' && Math.abs(expected.width - Math.floor(bounds.width)) > 1)
      ) {
        expectedViewport.current = undefined;
        setViewportPending(true);
      }
      setViewportError(false);
      const current = ++resizeRequest.current;
      const tabId = state.activeTabId;
      timer = setTimeout(() => {
        if (bounds.width > 100 && bounds.height > 100)
          void window.workbench
            .invoke<BrowserViewport>('browser:resize', {
              width: Math.floor(bounds.width),
              height: Math.floor(bounds.height),
              pixelRatio: window.devicePixelRatio,
              fitToWidth: zoomMode === 'fit',
              tabId,
            })
            .then((value) => {
              if (
                !value ||
                current !== resizeRequest.current ||
                tabId !== activeTab.current ||
                value.tabId !== tabId
              )
                return;
              expectedViewport.current = {
                ...value,
                epoch: expectedEpoch.current,
                zoomMode,
                surfaceWidth: Math.floor(bounds.width),
                surfaceHeight: Math.floor(bounds.height),
              };
              setZoomPercent(Math.round((bounds.width / value.width) * 100));
              setFitLimited(Boolean(value.limited));
              setViewportPending(!alignedViewport());
            })
            .catch(() => {
              if (current === resizeRequest.current && tabId === activeTab.current)
                setViewportError(true);
            });
      }, 120);
    };
    const observer = new ResizeObserver((entries) => resize(entries[0].contentRect));
    // Moving between screens can change physical pixels without changing CSS geometry.
    let density = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const densityChanged = () => {
      density.removeEventListener('change', densityChanged);
      density = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      density.addEventListener('change', densityChanged);
      if (surface.current) resize(surface.current.getBoundingClientRect());
    };
    density.addEventListener('change', densityChanged);
    observer.observe(surface.current);
    return () => {
      observer.disconnect();
      density.removeEventListener('change', densityChanged);
      clearTimeout(timer);
      resizeRequest.current++;
    };
  }, [mode, ready, zoomMode, state.activeTabId, state.url, state.loading, viewportRetry]);
  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!ready) return;
      event.preventDefault();
      const bounds = node.getBoundingClientRect();
      const scale = viewport.current.width / bounds.width;
      sendInput({
        type: 'wheel',
        x: (event.clientX - bounds.left) * scale,
        y: (event.clientY - bounds.top) * scale,
        deltaX: (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * scale,
        deltaY: (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * scale,
        modifiers: modifiers(event),
      });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [ready, frameLoading, viewportPending, mode]);

  const point = (event: React.MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const scale = viewport.current.width / bounds.width;
    return {
      x: (event.clientX - bounds.left) * scale,
      y: (event.clientY - bounds.top) * scale,
    };
  };
  const pointer = (event: React.MouseEvent<HTMLDivElement>, action: 'move' | 'down' | 'up') => {
    if (!ready || frameLoading || viewportPending || event.target === keyboard.current) return;
    if (!alignedViewport()) return;
    if (action === 'down') {
      event.preventDefault();
      keyboard.current?.focus({ preventScroll: true });
    }
    const data: BrowserInput = {
      type: 'mouse',
      tabId: activeTab.current,
      action,
      ...point(event),
      button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left',
      buttons: event.buttons,
      clickCount: action === 'move' ? 0 : event.detail || 1,
      modifiers: modifiers(event),
    };
    if (action === 'move') {
      cancelAnimationFrame(pointerFrame.current);
      pointerFrame.current = requestAnimationFrame(() => sendInput(data));
    } else sendInput(data);
  };
  const key = (event: React.KeyboardEvent<HTMLTextAreaElement>, action: 'down' | 'up') => {
    if (
      composing.current ||
      event.nativeEvent.isComposing ||
      event.key === 'Process' ||
      event.key === 'Dead'
    )
      return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return;
    if ((event.metaKey || event.ctrlKey) && ['k', 'l', 't', 'w'].includes(event.key.toLowerCase()))
      return;
    if (event.key === 'Tab' && event.shiftKey && event.ctrlKey) return;
    event.preventDefault();
    sendInput({
      type: 'key',
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      modifiers: modifiers(event),
      text:
        action === 'down' &&
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
          ? event.key
          : undefined,
    });
  };
  const navigate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (tabBusy || !ready) return;
    const target = url.trim();
    if (!target) return;
    await onAction('browser:navigate', { url: target });
    address.current?.blur();
  };
  const toggleRecord = async () => {
    if (state.recording) {
      const saved = await onAction<Recording>(share?.active ? 'share:stop' : 'recording:stop');
      if (saved) {
        setRecordingId(saved.id);
        setMode('recordings');
      }
    } else {
      setMode('page');
      await onAction('recording:start');
    }
  };
  const newTab = async () => {
    if (tabBusy) return;
    setTabBusy(true);
    setMode('page');
    setUrl('');
    address.current?.focus();
    try {
      await onAction('browser:new-tab');
    } finally {
      setTabBusy(false);
    }
  };
  const changeTab = async (action: 'browser:switch-tab' | 'browser:close-tab', id: string) => {
    if (tabBusy) return;
    setTabBusy(true);
    setMode('page');
    try {
      await onAction(action, { id });
    } finally {
      setTabBusy(false);
    }
  };
  const neoStatus =
    neo?.status === 'ready' ? '已连接' : neo?.status === 'starting' ? '连接中' : '未连接';
  return (
    <section className="browser-pane" aria-label="浏览器">
      <header className="browser-heading">
        <span className="engine-label" title={neo?.error || neo?.version || `Neo ${neoStatus}`}>
          <span aria-hidden className={`status-dot ${neo?.status === 'ready' ? 'online' : ''}`} />
          Neo {neoStatus}
        </span>
        <Tabs
          className="browser-tabstrip"
          selectedKey={state.activeTabId || ''}
          onSelectionChange={(key) => {
            setMode('page');
            void changeTab('browser:switch-tab', String(key));
          }}
        >
          <Tabs.List ref={tabList} className="browser-tabbar" aria-label="网页标签">
            {(state.tabs ?? []).map((tab) => (
              <Tabs.Tab
                className={`browser-tab ${tab.id === state.activeTabId ? 'is-active' : ''}`}
                key={tab.id}
                id={tab.id}
                aria-label={tab.title || '新标签页'}
                isDisabled={tabBusy}
              >
                {tab.loading ? (
                  <Icon icon={Loading02Icon} size={12} className="spin" />
                ) : (
                  <Icon icon={EarthIcon} size={12} />
                )}
                <span title={tab.url === 'about:blank' ? '新标签页' : tab.url}>
                  {tab.title || '新标签页'}
                </span>
                <ActionButton
                  className="tab-close"
                  aria-label={`关闭标签 ${tab.title || '新标签页'}`}
                  isDisabled={tabBusy}
                  onPress={() => void changeTab('browser:close-tab', tab.id)}
                >
                  <Icon icon={XIcon} size={12} />
                </ActionButton>
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <ActionButton
            className="icon-button new-tab-button"
            aria-label="新建标签页"
            title="新建标签页 ⌘ T"
            isDisabled={!ready || tabBusy}
            onPress={() => void newTab()}
          >
            {({ isHovered, isDisabled }) => (
              <TurnIcon kind="plus" size={15} hovered={isHovered && !isDisabled} />
            )}
          </ActionButton>
        </Tabs>
        <SharePanel state={share} ready={ready} onAction={onAction} />
        <ActionButton
          className="icon-button quiet"
          aria-label="收起浏览器"
          title="收起浏览器"
          onPress={onClose}
        >
          <Icon icon={XIcon} size={16} />
        </ActionButton>
      </header>
      {share?.active && (
        <div className="share-control-strip">
          <span>
            {share.changingControl
              ? '正在交接控制权'
              : share.controllerId === 'host'
                ? '你正在操作 · 双方操作自动记录'
                : `${share.participants.find((p) => p.id === share.controllerId)?.name || '参与者'}正在操作`}
          </span>
          {share.controllerId !== 'host' && (
            <ActionButton
              isDisabled={share.changingControl}
              onPress={() => void onAction('share:control', { id: 'host' })}
            >
              收回控制权
            </ActionButton>
          )}
        </div>
      )}
      <div className="browser-navigation">
        <div className="nav-buttons">
          <ActionButton
            className="icon-button"
            title="后退"
            aria-label="后退"
            isDisabled={!ready || !state.canGoBack}
            onPress={() => void onAction('browser:back')}
          >
            {({ isHovered, isDisabled }) => <NavigationArrow hovered={isHovered && !isDisabled} />}
          </ActionButton>
          <ActionButton
            className="icon-button"
            title="前进"
            aria-label="前进"
            isDisabled={!ready || !state.canGoForward}
            onPress={() => void onAction('browser:forward')}
          >
            {({ isHovered, isDisabled }) => (
              <NavigationArrow forward hovered={isHovered && !isDisabled} />
            )}
          </ActionButton>
          <ActionButton
            className="icon-button"
            title="刷新"
            aria-label="刷新"
            isDisabled={!ready}
            onPress={() => void onAction('browser:reload')}
          >
            {({ isHovered, isDisabled }) =>
              busy ? (
                <Icon icon={RefreshCwIcon} aria-hidden size={15} className="spin" />
              ) : (
                <TurnIcon kind="refresh" size={15} hovered={isHovered && !isDisabled} />
              )
            }
          </ActionButton>
        </div>
        <form className="address-field" onSubmit={(event) => void navigate(event)}>
          <Icon icon={EarthIcon} size={13} />
          <Input
            ref={address}
            aria-label="网页地址"
            placeholder="输入网址"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onFocus={(event) => event.target.select()}
            spellCheck={false}
          />
          <ActionButton
            aria-label="打开网页"
            title="打开网页"
            type="submit"
            isDisabled={!ready || tabBusy}
          >
            <Icon icon={ArrowUpRight01Icon} size={14} />
          </ActionButton>
        </form>
      </div>
      <div className="browser-tools">
        <Segment
          className="browser-modes"
          aria-label="浏览器视图"
          size="sm"
          selectedKey={mode}
          onSelectionChange={(key) => setMode(key as typeof mode)}
        >
          <Segment.Item id="page">网页</Segment.Item>
          <Segment.Item id="recordings">
            操作记录
            {recordings.length > 0 && <span className="record-count">{recordings.length}</span>}
          </Segment.Item>
          <Segment.Item id="neo">网页任务</Segment.Item>
        </Segment>
        <div className="tool-buttons">
          <ActionButton
            className={`icon-button ${inspectorOpen ? 'is-on' : ''}`}
            title="元素检查器"
            aria-label="元素检查器"
            isDisabled={!ready}
            onPress={() => {
              setMode('page');
              onToggleInspector();
            }}
          >
            <Icon icon={SlidersHorizontalIcon} size={15} />
          </ActionButton>
          <ActionButton
            className={`subtle-button ${state.inspecting ? 'selected' : ''}`}
            aria-pressed={state.inspecting}
            isDisabled={!ready}
            onPress={() => {
              setMode('page');
              inspectActive.current = !state.inspecting;
              void onAction<boolean>('browser:inspect', { enabled: !state.inspecting }).then(
                (ok) => {
                  if (!ok) inspectActive.current = false;
                },
              );
            }}
          >
            <Icon icon={Cursor01Icon} size={14} />
            选取元素
          </ActionButton>
          <ActionButton
            className={`subtle-button ${state.recording ? 'recording' : ''}`}
            isDisabled={!ready}
            onPress={() => void toggleRecord()}
          >
            {state.recording ? (
              <Icon icon={StopIcon} size={11} fill="currentColor" />
            ) : (
              <Icon icon={CircleIcon} size={12} />
            )}
            <span>{share?.active ? '结束共享' : state.recording ? '结束录制' : '录制'}</span>
          </ActionButton>
        </div>
      </div>
      {mode === 'page' ? (
        <div className="browser-canvas-wrap">
          {state.inspecting && (
            <div className="inspect-tip">
              <Icon icon={Cursor01Icon} size={13} />
              悬停预览，点击选中
              <kbd>Esc 取消</kbd>
              <ActionButton
                aria-label="取消选取"
                onPress={() => void onAction('browser:inspect', { enabled: false })}
              >
                <Icon icon={XIcon} size={13} />
              </ActionButton>
            </div>
          )}
          <div
            ref={surface}
            className={`browser-surface ${state.inspecting ? 'inspecting' : ''}`}
            onMouseDown={(event) => pointer(event, 'down')}
            onMouseUp={(event) => pointer(event, 'up')}
            onMouseMove={(event) => pointer(event, 'move')}
            onMouseLeave={() => {
              cancelAnimationFrame(pointerFrame.current);
              if (state.inspecting) sendInput({ type: 'mouse', action: 'leave', x: 0, y: 0 });
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <img
              ref={(node) => {
                image.current = node;
                if (node && lastFrame.current) node.src = lastFrame.current;
              }}
              className="browser-frame"
              alt={state.title ? `${state.title}，可交互网页` : 'BrowserOS neo 页面'}
              draggable={false}
              onLoad={() => {
                const node = image.current;
                const source = lastFrame.current;
                const frame = { ...viewport.current, tabId: activeTab.current };
                const epoch = receivedEpoch.current;
                if (!node) return;
                void node
                  .decode()
                  .then(() => {
                    if (
                      image.current !== node ||
                      lastFrame.current !== source ||
                      node.currentSrc !== source ||
                      activeTab.current !== frame.tabId
                    )
                      return;
                    if (
                      Math.abs(
                        node.naturalWidth - (node.naturalHeight * frame.width) / frame.height,
                      ) > 2
                    ) {
                      decodedViewport.current = undefined;
                      setViewportPending(true);
                      return;
                    }
                    decodedViewport.current = frame;
                    decodedEpoch.current = epoch;
                    setFrameLoading(false);
                    setViewportPending(!alignedViewport());
                  })
                  .catch(() => {});
              }}
            />
            {ready && (frameLoading || viewportPending) && (
              <div className="frame-loading">
                {viewportError ? (
                  <>
                    <span>页面显示调整失败</span>
                    <ActionButton
                      className="secondary-button"
                      onPress={() => setViewportRetry((value) => value + 1)}
                    >
                      重试
                    </ActionButton>
                  </>
                ) : (
                  <>
                    <Icon icon={Loading02Icon} size={19} className="spin" />
                    <span>正在显示页面</span>
                  </>
                )}
              </div>
            )}
            <textarea
              ref={keyboard}
              className="browser-keyboard"
              aria-label="网页键盘输入"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onKeyDown={(event) => key(event, 'down')}
              onKeyUp={(event) => key(event, 'up')}
              onCompositionStart={() => {
                composing.current = true;
                compositionTab.current = activeTab.current;
                compositionEpoch.current = decodedEpoch.current;
                compositionGeneration.current = shareRef.current?.generation;
              }}
              onCompositionEnd={(event) => {
                composing.current = false;
                compositionCommit.current = { value: event.data, time: Date.now() };
                if (
                  compositionEpoch.current === decodedEpoch.current &&
                  compositionGeneration.current === shareRef.current?.generation
                )
                  sendInput({ type: 'text', text: event.data, tabId: compositionTab.current });
                event.currentTarget.value = '';
              }}
              onInput={(event) => {
                if (composing.current || (event.nativeEvent as InputEvent).isComposing) return;
                const text = event.currentTarget.value;
                const duplicate =
                  compositionCommit.current?.value === text &&
                  Date.now() - compositionCommit.current.time < 100;
                if (text && !duplicate) sendInput({ type: 'text', text });
                event.currentTarget.value = '';
              }}
              onPaste={(event) => {
                event.preventDefault();
                sendInput({ type: 'text', text: event.clipboardData.getData('text/plain') });
              }}
            />
            {!ready && (
              <div className="browser-unavailable">
                <div className="browser-unavailable-icon">
                  {state.status === 'starting' ? (
                    <Icon icon={Loading02Icon} size={28} className="spin" />
                  ) : (
                    <Icon icon={EarthIcon} size={28} />
                  )}
                </div>
                <h3>
                  {state.status === 'starting'
                    ? '正在打开浏览器'
                    : state.status === 'missing'
                      ? '连接 BrowserOS neo'
                      : '浏览器尚未就绪'}
                </h3>
                <p>{state.error || '选择本机的 BrowserOS neo，即可在这里浏览和操作网页。'}</p>
                {state.status !== 'starting' && (
                  <div className="button-row">
                    <ActionButton className="primary-button" onPress={onOpenSettings}>
                      浏览器设置
                    </ActionButton>
                    <ActionButton
                      className="secondary-button"
                      onPress={() => void onAction('browser:start')}
                    >
                      重新连接
                    </ActionButton>
                  </div>
                )}
              </div>
            )}
          </div>
          {state.recording && (
            <div className="recording-strip">
              <span className="record-dot" />
              <span>正在记录操作</span>
              <span className="muted">{liveSteps.length} 步</span>
              <ActionButton onPress={() => void toggleRecord()}>
                {share?.active ? '结束共享并查看' : '结束并查看'}
              </ActionButton>
            </div>
          )}
          <div className="browser-status">
            <span className={`status-dot ${ready ? 'online' : ''}`} />
            <span>
              {ready
                ? state.title || 'BrowserOS neo 已连接'
                : state.status === 'starting'
                  ? '正在连接'
                  : '未连接'}
            </span>
            <ChoiceSelect
              className="viewport-select"
              triggerClassName="viewport-mode"
              label="页面缩放"
              title={fitLimited ? '页面超宽，可按住 Shift 滚轮横向查看' : '选择页面显示比例'}
              value={zoomMode}
              isDisabled={!ready || state.loading}
              onChange={(value) => {
                if (state.activeTabId)
                  setZoomModes((previous) => ({
                    ...previous,
                    [state.activeTabId!]: value as 'fit' | 'actual',
                  }));
              }}
              options={[
                {
                  value: 'fit',
                  label: `适应宽度${zoomMode === 'fit' && zoomPercent < 100 ? ` · ${zoomPercent}%` : ''}`,
                },
                { value: 'actual', label: '100%' },
              ]}
            />
            {fitLimited && zoomMode === 'fit' && <span className="viewport-limit">可横向滚动</span>}
            {state.inspecting ? (
              <span className="status-right">选择元素</span>
            ) : agentStatus ? (
              <span className="browser-agent-status" role="status">
                <PhaseGlyph kind={agentStatus.glyph} still={agentStatus.glyph === 'wait'} />
                {agentStatus.text}
              </span>
            ) : null}
          </div>
        </div>
      ) : mode === 'neo' ? (
        <NeoHistory state={neo} selectedId={nativeRecordId} onAction={onAction} />
      ) : (
        <div className="recordings-view">
          {!recording ? (
            <div className="recording-empty">
              <Icon icon={CircleIcon} size={30} strokeWidth={1.2} />
              <h3>保留操作发生的过程</h3>
              <p>点击录制，完成一段网页操作。结束后可以交给 Agent 理解和整理。</p>
              <ActionButton
                className="secondary-button"
                isDisabled={!ready}
                onPress={() => void toggleRecord()}
              >
                <Icon icon={CircleIcon} size={13} />
                开始录制
              </ActionButton>
            </div>
          ) : (
            <>
              <div className="recording-header">
                <div>
                  <span className="eyebrow">操作记录</span>
                  <h3>{recording.title}</h3>
                  <p>
                    {recording.steps.length} 个步骤 ·{' '}
                    {new Date(recording.startedAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <ActionButton
                  className="icon-button"
                  title="导出操作记录"
                  aria-label="导出操作记录"
                  onPress={() => void onAction('recording:export', { id: recording.id })}
                >
                  <Icon icon={Download01Icon} size={16} />
                </ActionButton>
              </div>
              {recordings.length > 1 && (
                <ChoiceSelect
                  triggerClassName="recording-select"
                  label="选择操作记录"
                  value={recording.id}
                  onChange={setRecordingId}
                  options={recordings.map((item) => ({
                    value: item.id,
                    label: `${item.title} · ${item.steps.length} 步`,
                  }))}
                />
              )}
              <ol className="step-list">
                {recording.steps.map((step, index) => (
                  <li key={step.id}>
                    <span className="step-index">{index + 1}</span>
                    <div>
                      <strong>{step.description}</strong>
                      {step.target?.name && <span className="step-target">{step.target.name}</span>}
                      {step.value && <code>{step.value}</code>}
                      <span className="step-meta">
                        {Math.max(0, (step.timestamp - recording.startedAt) / 1000).toFixed(1)}s
                        {step.actor?.name
                          ? ` · ${step.actor.name}`
                          : step.source === 'agent'
                            ? ' · Agent'
                            : ''}
                      </span>
                    </div>
                    <Icon icon={Tick02Icon} size={13} className="step-check" />
                  </li>
                ))}
              </ol>
              {!recording.steps.length && (
                <p className="empty-detail">这段录制没有捕获到操作。回到网页重新录制一段流程。</p>
              )}
              <div className="recording-footer">
                <ActionButton
                  className="primary-button"
                  isDisabled={!recording.steps.length}
                  onPress={() => onAnalyze(recording.id)}
                >
                  <Icon icon={PlayIcon} size={14} />让 Agent 理解这段操作
                </ActionButton>
                <p>
                  {recording.summary
                    ? '已有分析结果，再次分析会创建新的对话。'
                    : '整理操作目标、关键步骤和需要确认的预期。'}
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
