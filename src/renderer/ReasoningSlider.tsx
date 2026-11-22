import { useLayoutEffect, useRef, useState } from 'react';
import { Button, Label, Slider } from '@heroui/react';
import { RotateCcwIcon } from '@hugeicons-pro/core-stroke-rounded';
import { Icon } from './ui';
import type { ModelOption } from '../shared/usage';
import './reasoning-slider.css';

const effortNames: Record<string, string> = {
  none: '关闭',
  minimal: '轻量',
  low: '轻快',
  medium: '均衡',
  high: '深入',
  xhigh: '深度',
  max: '极致',
  ultra: 'Ultra',
};
export const effortName = (id: string) => effortNames[id] ?? id;
const ticks = Array.from({ length: 37 }, (_, i) => i / 36);

export function ReasoningSlider({
  model,
  effort = model.defaultEffort,
  disabled,
  saving,
  onSelect,
}: {
  model: ModelOption;
  effort?: string;
  disabled: boolean;
  saving: boolean;
  onSelect: (effort: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const [crest, setCrest] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { efforts, defaultEffort } = model;
  const last = efforts.length - 1;
  const index = draft ?? efforts.findIndex((option) => option.id === effort);
  const option = efforts[index];
  const label = option ? effortName(option.id) : effort ? `${effort} · 暂不可用` : '默认';
  const peak = last > 0 && index === last;

  // React Aria formats the discrete numeric index; announce the actual CLI level instead.
  useLayoutEffect(() => {
    input.current?.setAttribute('aria-valuetext', label);
  }, [label, index, last]);

  if (!efforts.length) return null;
  if (last === 0)
    return (
      <div className="reasoning-slider reasoning-single">
        <div className="reasoning-heading">
          <span>推理强度</span>
          {!option && <output>{label}</output>}
          <Button
            size="sm"
            variant={option ? 'ghost' : 'secondary'}
            isDisabled={disabled || saving}
            aria-disabled={!!option || undefined}
            excludeFromTabOrder={!!option}
            onPress={() => {
              if (!option) void onSelect(efforts[0].id);
            }}
          >
            {option ? label : `使用${effortName(efforts[0].id)}`}
          </Button>
        </div>
      </div>
    );

  const commit = async (value: number | number[]) => {
    const next = typeof value === 'number' && efforts[value];
    try {
      if (!disabled && !saving && next && next.id !== effort) await onSelect(next.id);
    } finally {
      setDraft(null);
    }
  };

  return (
    <Slider
      className="reasoning-slider"
      data-peak={peak || undefined}
      data-crest={(peak && crest) || undefined}
      data-unset={!option || undefined}
      minValue={0}
      maxValue={last}
      step={1}
      value={Math.max(0, index)}
      isDisabled={disabled}
      aria-busy={saving || undefined}
      onChange={(value) => {
        if (!saving && typeof value === 'number') {
          setDraft(value);
          setCrest(value === last);
        }
      }}
      onChangeEnd={(value) => void commit(value)}
    >
      <div className="reasoning-heading">
        <Label>推理强度</Label>
        <Slider.Output>{label}</Slider.Output>
        <Button
          variant="ghost"
          size="sm"
          isIconOnly
          className="reasoning-reset"
          aria-label="恢复默认推理强度"
          isDisabled={disabled || saving || !defaultEffort}
          onPress={() => {
            if (defaultEffort && defaultEffort !== effort) void onSelect(defaultEffort);
          }}
        >
          <Icon icon={RotateCcwIcon} size={13} />
        </Button>
      </div>
      <Slider.Track>
        <div className="reasoning-scale" aria-hidden="true">
          {ticks.map((position) => (
            <span
              key={position}
              className="reasoning-tick"
              data-filled={position * last <= index || undefined}
              style={{
                height: 6 + 15 * position ** 1.6,
                animationDelay: `${(1 - position) * 185}ms`,
              }}
            />
          ))}
        </div>
        <Slider.Thumb inputRef={input} />
      </Slider.Track>
      <div className="reasoning-range" aria-hidden="true">
        <span>{effortName(efforts[0].id)}</span>
        <span>{effortName(efforts[last].id)}</span>
      </div>
    </Slider>
  );
}
