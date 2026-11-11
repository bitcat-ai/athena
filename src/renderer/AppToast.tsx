import { useEffect, useRef, useState } from 'react';
import { AlertCircleIcon, Tick02Icon, XIcon } from '@hugeicons-pro/core-stroke-rounded';
import { ActionButton, Icon } from './ui';

export interface AppToastMessage {
  text: string;
  error: boolean;
  copiedMessageId?: string;
}

export function AppToast({
  message,
  onDismiss,
}: {
  message: AppToastMessage;
  onDismiss: (message: AppToastMessage) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = setTimeout(() => onDismiss(message), message.error ? 6500 : 3200);
    return () => clearTimeout(timer);
  }, [message, hovered, focused, onDismiss]);
  const close = () => {
    const restore =
      root.current?.contains(document.activeElement) && previousFocus.current?.isConnected;
    onDismiss(message);
    if (restore) previousFocus.current!.focus({ preventScroll: true });
  };
  return (
    <div
      ref={root}
      className={`app-toast ${message.error ? 'error' : ''}`}
      role={message.error ? 'alert' : 'status'}
      tabIndex={0}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          previousFocus.current =
            event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
        setFocused(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <Icon icon={message.error ? AlertCircleIcon : Tick02Icon} size={16} />
      <span className="app-toast-message">{message.text}</span>
      <ActionButton isIconOnly className="app-toast-dismiss" aria-label="关闭提示" onPress={close}>
        <Icon icon={XIcon} size={14} />
      </ActionButton>
    </div>
  );
}
