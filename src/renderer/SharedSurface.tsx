import { useEffect, useRef, useState } from 'react';
import type { BrowserFrame, BrowserInput } from '../shared/types';
import type { ShareConnection } from './share-connection';
import { sharedPoint } from '../shared/shared-coordinates';
const modifiers = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

export function SharedSurface({
  connection,
  frameSource,
  enabled,
  onReady,
  onError,
}: {
  connection: ShareConnection;
  frameSource: { subscribe(callback: (frame: BrowserFrame) => void): () => void };
  enabled: boolean;
  onReady(ready: boolean): void;
  onError(message: string): void;
}) {
  const image = useRef<HTMLImageElement>(null);
  const [frameReady, setFrameReady] = useState(false);
  const keyboard = useRef<HTMLTextAreaElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const frame = useRef<BrowserFrame | undefined>(undefined);
  const displayed = useRef<BrowserFrame | undefined>(undefined);
  const composing = useRef(false);
  const compositionGeneration = useRef(0);
  const compositionEpoch = useRef<number | undefined>(undefined);
  const duplicate = useRef({ text: '', at: 0 });
  const current = useRef({ enabled, onError });
  current.current = { enabled, onError };
  const matchesViewport = (value: BrowserFrame | undefined) =>
    !!value && connection.frameIsCurrent(value);
  useEffect(() => () => onReady(false), [onReady]);
  useEffect(() => {
    const ready = matchesViewport(displayed.current);
    setFrameReady(ready);
    onReady(ready);
  }, [
    onReady,
    connection.browser?.loading,
    connection.browser?.viewport?.epoch,
    connection.browser?.viewport?.width,
    connection.browser?.viewport?.height,
  ]);
  const send = (input: BrowserInput) => {
    if (!matchesViewport(displayed.current)) return;
    if (!current.current.enabled || !displayed.current || connection.frame !== displayed.current)
      return;
    void connection
      .invoke('browser:input', { ...input, tabId: displayed.current.tabId })
      .catch((e) => current.current.onError(e.message));
  };
  useEffect(
    () =>
      frameSource.subscribe((next) => {
        frame.current = next;
        if (image.current) image.current.src = next.data;
      }),
    [frameSource],
  );
  const point = (e: { clientX: number; clientY: number }) => {
    const bounds = image.current?.getBoundingClientRect(),
      view = displayed.current;
    return bounds && view ? sharedPoint(e.clientX, e.clientY, bounds, view) : undefined;
  };
  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = point(e);
      if (p)
        send({
          type: 'wheel',
          x: p.x,
          y: p.y,
          deltaX: (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) / p.scale,
          deltaY: (e.shiftKey && !e.deltaX ? 0 : e.deltaY) / p.scale,
          modifiers: modifiers(e),
        });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [connection]);
  const pointer = (e: React.PointerEvent, action: 'down' | 'up' | 'move') => {
    if (e.target === keyboard.current) return;
    const p = point(e);
    if (!p) return;
    if (action === 'down') {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      keyboard.current?.focus({ preventScroll: true });
    }
    send({
      type: 'mouse',
      action,
      x: p.x,
      y: p.y,
      button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left',
      buttons: e.buttons,
      clickCount: action === 'move' ? 0 : e.detail || 1,
      modifiers: modifiers(e),
    });
  };
  const key = (e: React.KeyboardEvent<HTMLTextAreaElement>, action: 'down' | 'up') => {
    if (composing.current || e.nativeEvent.isComposing || ['Process', 'Dead'].includes(e.key))
      return;
    if ((e.metaKey || e.ctrlKey) && ['v', 'l', 't', 'w'].includes(e.key.toLowerCase())) return;
    e.preventDefault();
    send({
      type: 'key',
      action,
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      modifiers: modifiers(e),
      text:
        action === 'down' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
          ? e.key
          : undefined,
    });
  };
  return (
    <div
      className={`shared-surface ${enabled ? 'can-control' : ''}`}
      ref={surface}
      aria-label="共享网页画面"
      onPointerDown={(e) => pointer(e, 'down')}
      onPointerUp={(e) => pointer(e, 'up')}
      onPointerMove={(e) => pointer(e, 'move')}
      onContextMenu={(e) => e.preventDefault()}
    >
      <img
        ref={image}
        className="shared-frame"
        alt="共享页面"
        draggable={false}
        onLoad={() => {
          const node = image.current,
            next = frame.current;
          if (!node || !next) return;
          void node
            .decode()
            .then(() => {
              if (node !== image.current || frame.current !== next || node.currentSrc !== next.data)
                return;
              if (Math.abs(node.naturalWidth - (node.naturalHeight * next.width) / next.height) > 2)
                return;
              if (!connection.acknowledge(next)) return;
              displayed.current = next;
              const ready = matchesViewport(next);
              setFrameReady(ready);
              onReady(ready);
              node.dataset.sequence = String(next.sequence);
              node.dataset.epoch = String(next.epoch);
            })
            .catch(() => {
              if (node === image.current && connection.receivedFrame === next)
                onError('画面解码失败，请重新连接');
            });
        }}
      />
      {!frameReady && (
        <div className="shared-frame-loading" role="status">
          正在同步页面…
        </div>
      )}
      <textarea
        className="browser-keyboard"
        ref={keyboard}
        aria-label="共享网页键盘输入"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={!enabled || !frameReady}
        onKeyDown={(e) => key(e, 'down')}
        onKeyUp={(e) => key(e, 'up')}
        onPaste={(e) => {
          e.preventDefault();
          send({ type: 'text', text: e.clipboardData.getData('text/plain') });
        }}
        onCompositionStart={() => {
          composing.current = true;
          compositionGeneration.current = connection.state?.generation ?? 0;
          compositionEpoch.current = displayed.current?.epoch;
        }}
        onCompositionEnd={(e) => {
          composing.current = false;
          duplicate.current = { text: e.data, at: Date.now() };
          if (
            compositionGeneration.current === connection.state?.generation &&
            compositionEpoch.current === displayed.current?.epoch
          )
            send({ type: 'text', text: e.data });
          e.currentTarget.value = '';
        }}
        onInput={(e) => {
          if (composing.current || (e.nativeEvent as InputEvent).isComposing) return;
          const text = e.currentTarget.value;
          if (text && !(duplicate.current.text === text && Date.now() - duplicate.current.at < 100))
            send({ type: 'text', text });
          e.currentTarget.value = '';
        }}
      />
    </div>
  );
}
