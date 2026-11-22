import { useEffect, useRef, useState } from 'react';
import { ActionButton } from './ui';

export function GeneratedImage({
  conversationId,
  messageId,
  eventId,
  onAction,
}: {
  conversationId: string;
  messageId: string;
  eventId: string;
  onAction: <T = unknown>(action: string, payload?: unknown) => Promise<T>;
}) {
  const [src, setSrc] = useState(''),
    [failed, setFailed] = useState(false);
  const figure = useRef<HTMLElement>(null);
  useEffect(() => {
    let live = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void onAction<string>('artifact:image', { conversationId, messageId, eventId })
          .then((value) => {
            if (live) {
              setSrc(value || '');
              setFailed(!value);
            }
          })
          .catch(() => {
            if (live) setFailed(true);
          });
      },
      { rootMargin: '240px' },
    );
    if (figure.current) observer.observe(figure.current);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [conversationId, messageId, eventId, onAction]);
  return (
    <figure className="generated-image" ref={figure}>
      {src ? (
        <img
          src={src}
          alt="Codex 生成的图片"
          onError={() => {
            setSrc('');
            setFailed(true);
          }}
        />
      ) : (
        <span role="status">{failed ? '图片预览不可用' : '读取生成的图片…'}</span>
      )}
      <figcaption>
        <ActionButton
          className="secondary-button"
          onPress={() => void onAction('artifact:reveal', { conversationId, messageId, eventId })}
        >
          在访达中显示
        </ActionButton>
      </figcaption>
    </figure>
  );
}
