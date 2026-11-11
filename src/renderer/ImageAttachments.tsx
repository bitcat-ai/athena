import { ChatAttachment, ChatAttachmentGroup } from '@heroui-pro/react';
import { imageSource, type ImageAttachment } from '../shared/images';

export function ImageAttachments({
  images,
  onRemove,
}: {
  images: (ImageAttachment & { error?: string })[];
  onRemove?: (id: string) => void;
}) {
  return (
    <ChatAttachmentGroup
      className="image-attachments"
      aria-label={onRemove ? '待发送图片' : '消息图片'}
    >
      {images.map((image) => (
        <ChatAttachment
          key={image.id}
          name={image.name}
          mimeType={image.mimeType}
          src={image.data ? imageSource(image) : undefined}
          aria-busy={!image.data && !image.error}
        >
          {image.data ? (
            <ChatAttachment.Preview />
          ) : (
            <span className="image-reading" role="status">
              {image.error ? '读取失败' : '读取中…'}
            </span>
          )}
          {onRemove && (
            <ChatAttachment.Remove
              aria-label={`移除图片 ${image.name}`}
              onPress={() => onRemove(image.id)}
            />
          )}
        </ChatAttachment>
      ))}
    </ChatAttachmentGroup>
  );
}
