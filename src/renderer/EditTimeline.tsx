import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Label, Slider } from '@heroui/react';
import type { EditTimeline as Timeline, EditTimelineEntry } from '../shared/types';
import './edit-timeline.css';

const kinds: Record<EditTimelineEntry['kind'], string> = {
  text: '改文字',
  style: '改样式',
  animation: '加动效',
  insert: '添加元素',
  restyle: '整页换风格',
  layout: '调整排布',
  stress: '内容试穿',
};
const describe = (entry: EditTimelineEntry) =>
  `${entry.by === 'agent' ? 'Athena' : '你'} · ${kinds[entry.kind]}${entry.name ? `「${entry.name}」` : ''}`;

/**
 * The page's preview edits as one line that can be dragged. Moving along it only shows the page
 * as it was at that point; nothing is dropped until a new edit is made from an earlier point.
 */
export function EditTimeline({
  timeline,
  disabled,
  onScrub,
}: {
  timeline: Timeline;
  disabled: boolean;
  onScrub: (position: number) => Promise<Timeline>;
}) {
  const total = timeline.entries.length;
  const [draft, setDraft] = useState<number | null>(null);
  const [blocked, setBlocked] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // The page moves one request at a time; while it does, only the newest wish is kept.
  const busy = useRef(false);
  const wanted = useRef<number | null>(null);
  const position = Math.min(draft ?? timeline.position, total);
  const entry = position > 0 ? timeline.entries[position - 1] : undefined;
  const label =
    position === 0
      ? '原始页面'
      : `${describe(entry!)}${position < total ? '' : total > 1 ? ' · 最新' : ''}`;

  const pump = async () => {
    if (busy.current) return;
    busy.current = true;
    let settled: number | null = null;
    try {
      while (wanted.current !== null) {
        const next = wanted.current;
        wanted.current = null;
        try {
          const result = await onScrub(next);
          settled = result.position;
          setBlocked(result.blocked ? '页面在这之后变过，停在能回到的最近一步' : '');
        } catch {
          settled = null;
          setBlocked('这一页暂时无法回看');
        }
      }
    } finally {
      busy.current = false;
      // Where the page actually is, until the pane's own state says the same.
      setDraft(settled);
    }
  };
  const move = (value: number) => {
    wanted.current = value;
    void pump();
  };

  useEffect(() => setBlocked(''), [total]);
  // The pane's state is the authority once nothing is on its way to the page.
  useEffect(() => {
    if (!busy.current && wanted.current === null) setDraft(null);
  }, [timeline]);
  // React Aria announces the bare number; say which change the thumb is on instead.
  useLayoutEffect(() => {
    input.current?.setAttribute('aria-valuetext', `第 ${position} 步，共 ${total} 步，${label}`);
  }, [position, total, label]);

  return (
    <Slider
      className="edit-timeline"
      data-rewound={position < total || undefined}
      minValue={0}
      maxValue={total}
      step={1}
      value={position}
      isDisabled={disabled}
      onChange={(value) => {
        if (typeof value !== 'number') return;
        setDraft(value);
        move(value);
      }}
      onChangeEnd={(value) => {
        if (typeof value === 'number') move(value);
      }}
    >
      <Label className="edit-timeline-title">改动</Label>
      <Slider.Track>
        <div className="edit-timeline-marks" aria-hidden="true">
          {Array.from({ length: total + 1 }, (_, index) => (
            <span
              key={index}
              className="edit-timeline-mark"
              data-shown={index <= position || undefined}
              data-agent={(index > 0 && timeline.entries[index - 1].by === 'agent') || undefined}
            />
          ))}
        </div>
        <Slider.Thumb inputRef={input} />
      </Slider.Track>
      <Slider.Output className="edit-timeline-count">
        {position} / {total}
      </Slider.Output>
      <span className="edit-timeline-label" title={blocked || label}>
        {blocked || label}
      </span>
    </Slider>
  );
}
