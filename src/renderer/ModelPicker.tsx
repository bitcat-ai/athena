import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, ListBox, Popover } from '@heroui/react';
import { ArrowDown01Icon, RotateCwIcon, XIcon } from '@hugeicons-pro/core-stroke-rounded';
import { Icon } from './ui';
import { ReasoningSlider, effortName } from './ReasoningSlider';
import type { Settings } from '../shared/types';
import { agentModelSelection } from '../shared/agents';
import type { ModelOption, ModelSelection } from '../shared/usage';

export function ModelPicker({
  settings,
  busy,
  connectionReady = false,
  conversationId,
  onChange,
}: {
  settings: Settings;
  busy: boolean;
  connectionReady?: boolean;
  conversationId?: string;
  onChange: (settings: Settings) => void;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const loading = catalogStatus === 'loading';
  const retriedConnection = useRef(connectionReady);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const savingRef = useRef(false);
  const saveFocus = useRef<HTMLElement | null>(null);
  const selection = agentModelSelection(settings, settings.agent);
  const current = models.find((model) => model.model === selection?.model);
  const modelName = current?.name ?? selection?.model ?? '默认模型';
  const levelName = selection?.effort && effortName(selection.effort);
  const disabled = busy || catalogStatus !== 'ready' || saving;
  const unavailable = selection && !current && catalogStatus === 'ready';

  const refresh = useCallback(
    async (force = false) => {
      const id = ++request.current;
      setCatalogStatus('loading');
      setError('');
      try {
        const value = await window.workbench.invoke<ModelOption[]>('models:list', {
          refresh: force,
          conversationId,
          agent: settings.agent,
        });
        if (id === request.current) {
          setModels(value);
          setCatalogStatus('ready');
        }
      } catch {
        if (id === request.current) {
          setCatalogStatus('failed');
          setError('无法读取模型目录，请刷新后重试。');
        }
      }
    },
    [conversationId, settings.agent],
  );
  useEffect(() => {
    setModels([]);
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh, settings.workspace]);
  useEffect(() => {
    if (!connectionReady) retriedConnection.current = false;
    else if (catalogStatus === 'failed' && !retriedConnection.current) {
      retriedConnection.current = true;
      void refresh(true);
    }
  }, [connectionReady, catalogStatus, refresh]);

  useLayoutEffect(() => {
    if (saving) return;
    // Temporarily disabling the active range or button during IPC blurs it in Chromium.
    if (document.activeElement === document.body && saveFocus.current?.isConnected)
      saveFocus.current.focus({ preventScroll: true });
    saveFocus.current = null;
  }, [saving]);

  const select = async (next: ModelSelection) => {
    if (disabled || savingRef.current) return;
    savingRef.current = true;
    saveFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSaving(true);
    setError('');
    try {
      onChange(
        await window.workbench.invoke<Settings>('settings:model', {
          ...next,
          conversationId,
          agent: settings.agent,
        }),
      );
    } catch (error) {
      setError(
        (error instanceof Error ? error.message : String(error)).replace(
          /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
          '',
        ),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="md"
        className="model-picker"
        aria-label="选择模型"
        aria-description={levelName ? `${modelName}，${levelName}` : modelName}
      >
        <span className="model-picker-name">{modelName}</span>
        {levelName && <span className="model-picker-effort">{levelName}</span>}
        <Icon icon={ArrowDown01Icon} className="picker-chevron" size={12} />
      </Button>
      <Popover.Content placement="top start" offset={10} className="model-controls">
        <Popover.Dialog>
          <div className="model-controls-heading">
            <Popover.Heading>模型</Popover.Heading>
            <div>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label="刷新模型"
                isPending={loading}
                isDisabled={saving}
                onPress={() => void refresh(true)}
              >
                <Icon icon={RotateCwIcon} size={16} className={loading ? 'is-refreshing' : ''} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label="关闭模型选择"
                onPress={() => setOpen(false)}
              >
                <Icon icon={XIcon} size={16} />
              </Button>
            </div>
          </div>
          {(models.length > 0 || unavailable) && (
            <ListBox
              aria-label="模型"
              className="model-options"
              selectionMode="single"
              selectionBehavior="toggle"
              disallowEmptySelection
              selectedKeys={selection ? [selection.model] : []}
              onSelectionChange={(keys) => {
                if (keys === 'all') return;
                const model = models.find((option) => keys.has(option.model));
                if (model && model.model !== selection?.model)
                  void select({ model: model.model, effort: model.defaultEffort });
              }}
            >
              {unavailable && (
                <ListBox.Item id={selection.model} textValue={selection.model} isDisabled>
                  <span>{selection.model} · 暂不可用</span>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              )}
              {models.map((model) => (
                <ListBox.Item
                  key={model.model}
                  id={model.model}
                  textValue={model.name}
                  isDisabled={disabled}
                >
                  <span>
                    {model.name}
                    {models.some(
                      (other) => other.model !== model.model && other.name === model.name,
                    ) && <small className="model-option-id">{model.model}</small>}
                  </span>
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          )}
          {current && (
            <ReasoningSlider
              key={current.model}
              model={current}
              effort={selection?.effort}
              disabled={disabled}
              onSelect={(effort) => select({ model: current.model, effort })}
            />
          )}
          {error && (
            <p className="model-control-error" role="alert">
              {error}
            </p>
          )}
          <p className="model-control-status" role="status">
            {busy
              ? '任务结束后可调整'
              : saving
                ? '正在保存…'
                : loading
                  ? '正在读取可用模型…'
                  : catalogStatus === 'ready' && !models.length
                    ? '当前没有可选模型，沿用 CLI 默认配置'
                    : !selection
                      ? '使用本机 CLI 默认配置'
                      : '用于下一次任务'}
          </p>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
