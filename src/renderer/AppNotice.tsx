import { Alert, Button } from '@heroui/react';
import { Download01Icon, XIcon } from '@hugeicons-pro/core-stroke-rounded';
import { ActionButton, Icon } from './ui';
import './app-notice.css';

export function AppNotice({
  title,
  description,
  actionLabel,
  onAction,
  onDismiss,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
}) {
  return (
    <Alert className="app-notice" role="region" aria-label="工作台提示">
      <Alert.Indicator>
        <Icon icon={Download01Icon} size={18} />
      </Alert.Indicator>
      <Alert.Content>
        <Alert.Title title={title}>{title}</Alert.Title>
        <Alert.Description title={description}>{description}</Alert.Description>
      </Alert.Content>
      <Button size="sm" variant="primary" className="app-notice-action" onPress={onAction}>
        <span>{actionLabel}</span>
      </Button>
      <ActionButton
        isIconOnly
        className="app-notice-dismiss"
        aria-label="收起提醒"
        onPress={onDismiss}
      >
        <Icon icon={XIcon} size={14} />
      </ActionButton>
    </Alert>
  );
}
