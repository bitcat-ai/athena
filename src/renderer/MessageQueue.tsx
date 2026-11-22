import { PromptInput } from '@heroui-pro/react';
import { Delete02Icon, PencilEdit02Icon } from '@hugeicons-pro/core-stroke-rounded';
import type { QueuedMessage } from '../shared/queue';
import { ActionButton, Icon } from './ui';
import './message-queue.css';

/** Messages of this conversation that wait for their turn, shown above the field they came from. */
export function MessageQueue({
  items,
  paused,
  onEdit,
  onRemove,
  onResume,
}: {
  items: QueuedMessage[];
  /** The turn before them was stopped or failed; they stay until the user sends them on. */
  paused: boolean;
  onEdit: (item: QueuedMessage) => void;
  onRemove: (item: QueuedMessage) => void;
  onResume: () => void;
}) {
  if (!items.length) return null;
  return (
    <PromptInput.Queue
      actionsVisibility="always"
      className={`message-queue ${paused ? 'is-paused' : ''}`}
      role="group"
      aria-label="排队的消息"
    >
      <div className="message-queue-heading">
        <span role="status">
          {paused
            ? `上一轮没有完成，${items.length} 条消息暂未发送`
            : `${items.length} 条消息排队中，前面的任务完成后依次发送`}
        </span>
        {paused && (
          <ActionButton className="secondary-button" onPress={onResume}>
            继续发送
          </ActionButton>
        )}
      </div>
      <PromptInput.Queue.List>
        {items.map((item) => (
          <PromptInput.Queue.Item key={item.id}>
            <PromptInput.Queue.Item.Body>
              <PromptInput.Queue.Item.Content>
                {item.text.trim() || item.files?.join('、') || `${item.images} 张图片`}
              </PromptInput.Queue.Item.Content>
              {(item.images > 0 || Boolean(item.files?.length)) && item.text.trim() && (
                <PromptInput.Queue.Item.Description>
                  {[
                    item.images > 0 && `${item.images} 张图片`,
                    item.files?.length && `${item.files.length} 个文件`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </PromptInput.Queue.Item.Description>
              )}
            </PromptInput.Queue.Item.Body>
            <PromptInput.Queue.Item.Actions>
              <ActionButton
                className="icon-button"
                aria-label="取回编辑"
                onPress={() => onEdit(item)}
              >
                <Icon icon={PencilEdit02Icon} size={15} />
              </ActionButton>
              <ActionButton
                className="icon-button"
                aria-label="移出队列"
                onPress={() => onRemove(item)}
              >
                <Icon icon={Delete02Icon} size={15} />
              </ActionButton>
            </PromptInput.Queue.Item.Actions>
          </PromptInput.Queue.Item>
        ))}
      </PromptInput.Queue.List>
    </PromptInput.Queue>
  );
}
