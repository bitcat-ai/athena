import { TurnIcon } from './HoverIcons';
import { Icon } from './ui';
import {
  ChartNoAxesCombinedIcon,
  CircleDotIcon,
  Cursor01Icon,
  Folder01Icon,
  InternetIcon,
  MonitorIcon,
  MoonIcon,
  Settings02Icon,
  Sun01Icon,
  Tick02Icon,
  UnfoldMoreIcon,
} from '@hugeicons-pro/core-stroke-rounded';
import { useLayoutEffect, useState } from 'react';
import { Avatar, Button, Description, Dropdown, Label } from '@heroui/react';
import { PromptInput } from '@heroui-pro/react';

type Appearance = 'light' | 'dark' | 'system';
const appearanceLabels: Record<Appearance, string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    try {
      const saved = localStorage.getItem('athena.appearance');
      return saved === 'dark' || saved === 'system' ? saved : 'light';
    } catch {
      return 'light';
    }
  });
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = appearance === 'dark' || (appearance === 'system' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply();
    try {
      localStorage.setItem('athena.appearance', appearance);
    } catch {
      /* Keep the preference for this window when storage is unavailable. */
    }
    if (appearance === 'system') media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [appearance]);
  return [appearance, setAppearance] as const;
}

export function UserMenu({
  name,
  appearance,
  onAppearanceChange,
  onSettings,
  onUsage,
  onWorkspace,
}: {
  name: string;
  appearance: Appearance;
  onAppearanceChange: (value: Appearance) => void;
  onSettings: () => void;
  onUsage: () => void;
  onWorkspace: () => void;
}) {
  const displayName = name.trim() || '本机用户';
  const initial = Array.from(displayName)[0]?.toLocaleUpperCase() || '本';
  const identity = (
    <>
      <Avatar className="local-user-avatar">
        <Avatar.Fallback>{initial}</Avatar.Fallback>
      </Avatar>
      <span className="local-user-copy">
        <strong>{displayName}</strong>
        <span>
          <i />
          本机工作区
        </span>
      </span>
    </>
  );
  return (
    <Dropdown>
      <Button variant="ghost" className="local-user-trigger" aria-label="本机用户菜单">
        {identity}
        <Icon icon={UnfoldMoreIcon} size={14} />
      </Button>
      <Dropdown.Popover placement="top start" offset={8} className="local-user-menu">
        <div className="local-user-menu-identity">{identity}</div>
        <Dropdown.Menu
          aria-label="本机用户操作"
          onAction={(key) => {
            if (key === 'settings') onSettings();
            if (key === 'usage') onUsage();
            if (key === 'workspace') onWorkspace();
          }}
        >
          <Dropdown.Item id="settings" textValue="设置">
            <Icon icon={Settings02Icon} size={16} />
            <Label>设置</Label>
          </Dropdown.Item>
          <Dropdown.Item id="usage" textValue="用量">
            <Icon icon={ChartNoAxesCombinedIcon} size={16} />
            <Label>用量</Label>
          </Dropdown.Item>
          <Dropdown.Item id="workspace" textValue="选择工作目录">
            <Icon icon={Folder01Icon} size={16} />
            <Label>选择工作目录…</Label>
          </Dropdown.Item>
          <Dropdown.SubmenuTrigger>
            <Dropdown.Item id="appearance" textValue="外观">
              <Icon icon={Sun01Icon} size={16} />
              <Label>外观</Label>
              <Description>{appearanceLabels[appearance]}</Description>
              <Dropdown.SubmenuIndicator />
            </Dropdown.Item>
            <Dropdown.Popover className="appearance-menu">
              <Dropdown.Menu
                aria-label="外观"
                selectionMode="single"
                selectedKeys={new Set([appearance])}
                onAction={(key) => onAppearanceChange(key as Appearance)}
              >
                {(['light', 'dark', 'system'] as const).map((value) => {
                  const icon =
                    value === 'light' ? Sun01Icon : value === 'dark' ? MoonIcon : MonitorIcon;
                  return (
                    <Dropdown.Item key={value} id={value} textValue={appearanceLabels[value]}>
                      <Icon icon={icon} size={16} />
                      <Label>{appearanceLabels[value]}</Label>
                      <Dropdown.ItemIndicator>
                        <Icon icon={Tick02Icon} size={14} />
                      </Dropdown.ItemIndicator>
                    </Dropdown.Item>
                  );
                })}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

export function WebContextMenu({
  ready,
  recording,
  onPage,
  onSelect,
  onRecord,
}: {
  ready: boolean;
  recording: boolean;
  onPage: () => void;
  onSelect: () => void;
  onRecord: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Dropdown>
      <PromptInput.Action aria-label="添加网页上下文" onHoverChange={setHovered}>
        <TurnIcon kind="plus" hovered={hovered} size={18} />
      </PromptInput.Action>
      <Dropdown.Popover placement="top start" offset={12} className="web-context-menu">
        <p className="web-context-heading">添加网页上下文</p>
        <Dropdown.Menu
          aria-label="网页上下文"
          onAction={(key) => {
            if (key === 'page') onPage();
            if (key === 'element') onSelect();
            if (key === 'record') onRecord();
          }}
        >
          <Dropdown.Item id="page" textValue="当前页面">
            <Icon icon={InternetIcon} size={16} />
            <Label>当前页面</Label>
          </Dropdown.Item>
          <Dropdown.Item id="element" textValue="选取页面元素" isDisabled={!ready}>
            <Icon icon={Cursor01Icon} size={16} />
            <Label>选取页面元素</Label>
          </Dropdown.Item>
          <Dropdown.Item id="record" textValue="录制网页操作" isDisabled={!ready || recording}>
            <Icon icon={CircleDotIcon} size={16} />
            <Label>{recording ? '正在录制网页操作' : '录制网页操作'}</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
        {!ready && <p className="web-context-note">浏览器就绪后，可选取元素或录制操作。</p>}
      </Dropdown.Popover>
    </Dropdown>
  );
}
