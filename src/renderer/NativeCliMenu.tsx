import { useState } from 'react';
import { Button, Dropdown, Label } from '@heroui/react';

export function NativeCliMenu({
  onAction,
}: {
  onAction: <T = unknown>(action: string, payload?: unknown) => Promise<T>;
}) {
  const [found, setFound] = useState<{ id: string; name: string }[]>([]);
  return (
    <Dropdown
      onOpenChange={(open) => {
        if (open)
          void onAction<typeof found>('runtime:list-native').then((items) => setFound(items ?? []));
      }}
    >
      <Button size="sm" variant="secondary">
        其他本机 CLI
      </Button>
      <Dropdown.Popover placement="bottom start">
        <Dropdown.Menu
          aria-label="其他原生运行时"
          onAction={(key) => {
            if (key === 'pick') void onAction('runtime:pick-native');
            else void onAction('runtime:open-native', { nativeId: String(key) });
          }}
        >
          {found.map((item) => (
            <Dropdown.Item key={item.id} id={item.id} textValue={item.name}>
              <Label>{item.name}</Label>
            </Dropdown.Item>
          ))}
          <Dropdown.Item id="pick" textValue="选择可执行文件">
            <Label>选择可执行文件…</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
