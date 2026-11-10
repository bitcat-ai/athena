import { useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import { Command } from '@heroui-pro/react';
import {
  Folder01Icon,
  Loading02Icon,
  MessageSquareIcon,
  Search01Icon,
  XIcon,
} from '@hugeicons-pro/core-stroke-rounded';
import { Icon } from './ui';
import { isArchived, type Conversation } from '../shared/types';

export function ConversationSearch({
  open,
  loaded,
  workspace,
  conversations,
  onOpenChange,
  onSelect,
  onNew,
}: {
  open: boolean;
  loaded: boolean;
  workspace: string;
  conversations: Conversation[];
  onOpenChange: (open: boolean) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...conversations]
      .filter(
        (conversation) =>
          !isArchived(conversation) &&
          (!conversation.workspace || conversation.workspace === workspace),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .flatMap((conversation) => {
        const message = needle
          ? conversation.messages.find((item) => item.text.toLocaleLowerCase().includes(needle))
          : undefined;
        if (needle && !conversation.title.toLocaleLowerCase().includes(needle) && !message)
          return [];
        const offset = message
          ? Math.max(0, message.text.toLocaleLowerCase().indexOf(needle) - 24)
          : 0;
        return [
          {
            conversation,
            preview: message
              ? `${offset ? '…' : ''}${message.text.slice(offset, offset + 120).replace(/\s+/g, ' ')}`
              : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(
                  conversation.updatedAt,
                ),
          },
        ];
      });
  }, [conversations, query, workspace]);

  const close = () => {
    onOpenChange(false);
    setQuery('');
  };
  return (
    <Command>
      <Command.Backdrop
        isOpen={open}
        onOpenChange={(next) => {
          onOpenChange(next);
          if (!next) setQuery('');
        }}
        className="conversation-search-backdrop"
      >
        <Command.Container className="conversation-search-container">
          <Command.Dialog
            aria-label="搜索对话"
            className="conversation-search"
            inputValue={query}
            onInputChange={setQuery}
            filter={() => true}
          >
            <Command.Header className="conversation-search-heading">
              <h2>搜索对话</h2>
              <Button isIconOnly variant="ghost" size="sm" aria-label="关闭搜索" onPress={close}>
                <Icon icon={XIcon} size={18} />
              </Button>
            </Command.Header>
            <Command.InputGroup
              aria-label="搜索对话标题或消息"
              className="conversation-search-field"
            >
              <Command.InputGroup.Prefix>
                <Icon icon={Search01Icon} size={16} />
              </Command.InputGroup.Prefix>
              <Command.InputGroup.Input
                autoFocus
                placeholder="搜索当前工作区的对话"
                onKeyDownCapture={(event) => {
                  const composing =
                    event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
                  if (composing) {
                    if (event.key === 'Enter') event.stopPropagation();
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    close();
                  }
                }}
              />
              <Command.InputGroup.ClearButton aria-label="清空搜索" />
            </Command.InputGroup>
            <p className="conversation-search-caption">{query.trim() ? '搜索结果' : '最近对话'}</p>
            <Command.List
              aria-label="对话搜索结果"
              className="conversation-search-results"
              onAction={(id) => {
                onSelect(String(id));
                close();
                setQuery('');
              }}
              renderEmptyState={() =>
                loaded ? (
                  <p>{query.trim() ? '没有找到相关对话' : '还没有对话'}</p>
                ) : (
                  <span role="status">
                    <Icon icon={Loading02Icon} size={16} className="spin" />
                    正在读取对话…
                  </span>
                )
              }
            >
              {results.map(({ conversation, preview }) => (
                <Command.Item
                  id={conversation.id}
                  key={conversation.id}
                  textValue={conversation.title}
                >
                  <Icon icon={MessageSquareIcon} size={16} />
                  <div className="conversation-search-copy">
                    <strong>{conversation.title}</strong>
                    <span>{preview}</span>
                  </div>
                </Command.Item>
              ))}
            </Command.List>
            {loaded && !results.length && (
              <Button
                variant="secondary"
                className="search-new-conversation"
                onPress={() => {
                  close();
                  setQuery('');
                  onNew();
                }}
              >
                新对话
              </Button>
            )}
            <Command.Footer className="conversation-search-footer">
              <span title={workspace}>
                <Icon icon={Folder01Icon} size={14} />
                {workspace.split(/[\\/]/).filter(Boolean).pop() || '本机工作区'}
              </span>
              <span>↑ ↓ 选择　 Enter 打开　 Esc 关闭</span>
            </Command.Footer>
          </Command.Dialog>
        </Command.Container>
      </Command.Backdrop>
    </Command>
  );
}
