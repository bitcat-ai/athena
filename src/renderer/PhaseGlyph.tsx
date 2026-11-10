import type { ReactNode } from 'react';
import type { GlyphKind } from '../shared/phase';

/** Static marks that share the glyph grid: a verified checkpoint, handled requests, a file. */
export type MarkKind = 'checked' | 'shield' | 'bubble' | 'cursor' | 'file';

// One 16px drawing per phase. Each animates a single part, so the shape alone tells phases apart.
const glyphs: Record<GlyphKind | MarkKind, ReactNode> = {
  connect: (
    <>
      <circle className="fill" cx="3.4" cy="8" r="1.7" />
      <circle className="fill" cx="12.6" cy="8" r="1.7" />
      <path className="g-link" d="M5.6 8h4.8" />
    </>
  ),
  think: (
    <>
      <path
        className="fill g-star"
        d="M7 3.5c.5 3 2 4.5 5 5-3 .5-4.5 2-5 5-.5-3-2-4.5-5-5 3-.5 4.5-2 5-5z"
      />
      <circle className="fill g-twinkle" cx="12.6" cy="3.6" r="1.25" />
    </>
  ),
  read: (
    <>
      <path d="M4.5 2.5H9l3 3v8H4.5v-11zM9 2.5v3h3" />
      <path className="g-l" d="M6.4 7.8h3.7" />
      <path className="g-l" d="M6.4 9.7h3.7" />
      <path className="g-l" d="M6.4 11.6h2.2" />
    </>
  ),
  edit: (
    <>
      <path className="g-pencil" d="M3 13l.6-2.8L10.8 3 13 5.2 5.8 12.4 3 13z" />
      <path className="g-stroke" d="M8.5 13.5h5" />
    </>
  ),
  run: (
    <>
      <path d="M3 4.5L6.5 8 3 11.5" />
      <path className="g-caret" d="M8.5 11.5h4.5" />
    </>
  ),
  web: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11" />
      <ellipse className="g-meridian" cx="8" cy="8" rx="2.6" ry="5.5" />
    </>
  ),
  click: (
    <>
      <circle className="g-ripple" cx="5" cy="5" r="3.6" />
      <path d="M5 5l7.7 3.9-3.3 1-1 3.3L5 5z" />
    </>
  ),
  verify: (
    <>
      <path d="M3 6V4a1 1 0 011-1h2M10 3h2a1 1 0 011 1v2M13 10v2a1 1 0 01-1 1h-2M6 13H4a1 1 0 01-1-1v-2" />
      <path className="g-scan" d="M5.2 8h5.6" />
    </>
  ),
  wait: (
    <>
      <circle className="g-halo" cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="5.5" />
      <circle className="fill" cx="8" cy="8" r="2.3" />
    </>
  ),
  stopping: <rect className="fill g-box" x="4" y="4" width="8" height="8" rx="1.8" />,
  done: <path d="M3.5 8.5l3 3 6-7" />,
  warn: <path d="M8 2.5l6 10.5H2L8 2.5zM8 6.6v3M8 11.4v.1" />,
  fail: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  stopped: <rect className="fill" x="4" y="4" width="8" height="8" rx="1.8" />,
  checked: (
    <path d="M3 6V4a1 1 0 011-1h2M10 3h2a1 1 0 011 1v2M13 10v2a1 1 0 01-1 1h-2M6 13H4a1 1 0 01-1-1v-2M6 8.2l1.4 1.4L10 6.6" />
  ),
  shield: (
    <>
      <path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4l5-2z" />
      <path d="M5.9 8l1.5 1.5 2.7-3" />
    </>
  ),
  bubble: (
    <path d="M4.5 3h7A1.5 1.5 0 0113 4.5v5a1.5 1.5 0 01-1.5 1.5H7.5l-3 2.5V11A1.5 1.5 0 013 9.5v-5A1.5 1.5 0 014.5 3z" />
  ),
  cursor: <path d="M4 3l8.5 4.3-3.6 1.1L7.6 12 4 3z" />,
  file: <path d="M4.5 2.5H9l3 3v8H4.5v-11zM9 2.5v3h3" />,
};

type Tone = 'ok' | 'warn' | 'fail' | 'mute';
const tones: Partial<Record<GlyphKind | MarkKind, Tone>> = {
  done: 'ok',
  warn: 'warn',
  fail: 'fail',
  stopped: 'mute',
  stopping: 'mute',
};

/**
 * The small drawing that stands for a phase or tool kind. `still` freezes it for places that
 * only echo a state (sidebar, composer hint, finished timeline rows); `draw` plays the check once.
 */
export function PhaseGlyph({
  kind,
  still,
  draw,
  tone,
}: {
  kind: GlyphKind | MarkKind;
  still?: boolean;
  draw?: boolean;
  tone?: Tone;
}) {
  const color = tone ?? tones[kind];
  return (
    <svg
      className={[
        'phase-glyph',
        `g-${kind}`,
        still ? 'still' : '',
        draw ? 'draw' : '',
        color ? `tone-${color}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      {glyphs[kind]}
    </svg>
  );
}
