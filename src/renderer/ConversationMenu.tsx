import { AlertDialog, Button, Dropdown, Label } from '@heroui/react';
import {
  Archive01Icon,
  ArchiveRestoreIcon,
  Delete02Icon,
  MoreHorizontalIcon,
} from '@hugeicons-pro/core-stroke-rounded';
import { Icon } from './ui';

/** 侧栏里每段对话自己的操作菜单：归档或恢复，以及删除。 */
export function ConversationMenu({
  title,
  archived,
  running,
  onArchive,
  onDelete,
}: {
  title: string;
  archived: boolean;
  /** 任务还在进行的对话不能归档或删除，宿主同样会拒绝。 */
  running: boolean;
  /** 未归档时归档，已归档时恢复。 */
  onArchive: () => void;
  onDelete: () => void;
}) {
  const archiveLabel = archived ? '恢复对话' : '归档对话';
  return (
    <Dropdown>
      <Button
        isIconOnly
        variant="ghost"
        size="sm"
        className="conversation-menu-trigger"
        aria-label={`对话操作：${title}`}
      >
        <Icon icon={MoreHorizontalIcon} size={16} />
      </Button>
      <Dropdown.Popover placement="bottom end" offset={6} className="conversation-menu">
        <Dropdown.Menu
          onAction={(key) => {
            if (key === 'archive') onArchive();
            if (key === 'delete') onDelete();
          }}
        >
          <Dropdown.Item id="archive" textValue={archiveLabel} isDisabled={running}>
            <Icon icon={archived ? ArchiveRestoreIcon : Archive01Icon} size={16} />
            <Label>{archiveLabel}</Label>
          </Dropdown.Item>
          <Dropdown.Item id="delete" textValue="删除对话" variant="danger" isDisabled={running}>
            <Icon icon={Delete02Icon} size={16} />
            <Label>删除对话</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
        {running && <p className="conversation-menu-note">任务结束后才能归档或删除</p>}
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 删除前的确认：说清会删除什么、保留什么；只有确认按钮会删除。 */
export function DeleteConversationDialog({
  title,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  /** 删除请求发出后到宿主答复前，不能重复确认或取消。 */
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Backdrop
      isOpen
      isKeyboardDismissDisabled={pending}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <AlertDialog.Container size="sm">
        <AlertDialog.Dialog className="conversation-delete-dialog">
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger" />
            <AlertDialog.Heading>删除这段对话？</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p>将从 Athena 删除「{title}」的全部对话内容，删除后无法恢复。</p>
            <p>本机 CLI 自己保存的会话历史不受影响。</p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button autoFocus variant="tertiary" isDisabled={pending} onPress={onCancel}>
              取消
            </Button>
            <Button variant="danger" isPending={pending} onPress={onConfirm}>
              删除对话
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
