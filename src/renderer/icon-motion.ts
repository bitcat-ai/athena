import { useEffect, type RefObject } from 'react';
import {
  Archive01Icon,
  ArrowDown02Icon,
  ArrowExpand01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  BookOpen01Icon,
  Cancel01Icon,
  ChartNoAxesCombinedIcon,
  CloudIcon,
  CopyIcon,
  CubeIcon,
  Delete02Icon,
  Download01Icon,
  EarthIcon,
  ExternalLinkIcon,
  File01Icon,
  Folder01Icon,
  FolderOpenIcon,
  HandIcon,
  HelpCircleIcon,
  Image01Icon,
  InternetIcon,
  KeyboardIcon,
  Link02Icon,
  MagicWand01Icon,
  MessageSquareIcon,
  Mic01Icon,
  MoreHorizontalIcon,
  PaintbrushIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightOpenIcon,
  PencilEdit02Icon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  RotateCwIcon,
  ScanIcon,
  Search01Icon,
  Settings02Icon,
  Share02Icon,
  ShieldCheckIcon,
  SidebarLeftIcon,
  SlidersHorizontalIcon,
  Sun01Icon,
  TerminalIcon,
  UnplugIcon,
  Undo02Icon,
  UsersIcon,
  XIcon,
} from '@hugeicons-pro/core-stroke-rounded';

/**
 * What an icon does when the pointer enters the control it sits in. Each plays once and ends
 * where it began, so hit areas, labels and focus rings never move. Icons that are not listed
 * stay still: chevrons that turn with their menu, spinners, ticks and status marks.
 */
type Motion = (svg: SVGSVGElement) => Animation[];

const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';
const frames =
  (transforms: string[], duration = 420): Motion =>
  (svg) => [svg.animate({ transform: transforms }, { duration, easing: ease })];
const shift = (x: number, y = 0) =>
  frames(['translate(0, 0)', `translate(${x}px, ${y}px)`, 'translate(0, 0)']);
/** A turn that lands on the same picture: the angle is one step of the glyph's own symmetry. */
const turn = (degrees: number, duration = 480) =>
  frames(['rotate(0deg)', `rotate(${degrees}deg)`], duration);
const tilt = (degrees: number) =>
  frames([
    'rotate(0deg)',
    `rotate(${-degrees}deg)`,
    `rotate(${degrees * 0.8}deg)`,
    `rotate(${-degrees * 0.3}deg)`,
    'rotate(0deg)',
  ]);
const pop = frames(['scale(1)', 'scale(1.16)', 'scale(1)'], 360);
const lift = shift(0, -2);
const drop = shift(0, 2);
const left = shift(-2);
const right = shift(2);
const away = shift(2, -2);
/** Strokes drawn again from their start, one after another. */
const draw: Motion = (svg) =>
  [...svg.querySelectorAll<SVGGeometryElement>('path, circle, rect, line')].map((part, index) => {
    const length = part.getTotalLength?.() || 24;
    return part.animate(
      { strokeDasharray: [`${length}`, `${length}`], strokeDashoffset: [length, 0] },
      { duration: 460, delay: index * 70, easing: ease, fill: 'backwards' },
    );
  });

const motions = new Map<unknown, Motion>([
  [Search01Icon, frames(['translate(0, 0)', 'translate(-1.5px, -1px)', 'translate(1px, 0.5px)', 'translate(0, 0)'], 480)],
  [Settings02Icon, turn(120)],
  [Sun01Icon, turn(45)],
  [XIcon, turn(90, 360)],
  [Cancel01Icon, turn(90, 360)],
  [PlusIcon, turn(90, 360)],
  [RefreshCwIcon, turn(360, 560)],
  [RotateCwIcon, frames(['rotate(0deg)', 'rotate(50deg)', 'rotate(0deg)'])],
  [RotateCcwIcon, frames(['rotate(0deg)', 'rotate(-50deg)', 'rotate(0deg)'])],
  [ChartNoAxesCombinedIcon, draw],
  [ShieldCheckIcon, draw],
  [SlidersHorizontalIcon, draw],
  [Folder01Icon, lift],
  [FolderOpenIcon, lift],
  [Archive01Icon, lift],
  [CubeIcon, lift],
  [CloudIcon, lift],
  [MessageSquareIcon, lift],
  [File01Icon, lift],
  [Download01Icon, drop],
  [ArrowDown02Icon, drop],
  [PanelLeftCloseIcon, left],
  [PanelRightOpenIcon, left],
  [SidebarLeftIcon, left],
  [ArrowLeft01Icon, left],
  [Undo02Icon, left],
  [PanelLeftOpenIcon, right],
  [ArrowRight01Icon, right],
  [TerminalIcon, right],
  [PlayIcon, right],
  [ArrowUpRight01Icon, away],
  [ExternalLinkIcon, away],
  [Share02Icon, away],
  [Link02Icon, tilt(12)],
  [MagicWand01Icon, tilt(14)],
  [PaintbrushIcon, tilt(12)],
  [PencilEdit02Icon, tilt(10)],
  [Delete02Icon, tilt(10)],
  [HandIcon, tilt(12)],
  [HelpCircleIcon, tilt(10)],
  [UnplugIcon, tilt(10)],
  [EarthIcon, tilt(16)],
  [InternetIcon, tilt(16)],
  [Mic01Icon, pop],
  [CopyIcon, pop],
  [BookOpen01Icon, pop],
  [ArrowExpand01Icon, pop],
  [UsersIcon, pop],
  [KeyboardIcon, pop],
  [Image01Icon, pop],
  [ScanIcon, pop],
  [MoreHorizontalIcon, pop],
]);

const allowed = '(hover: hover) and (prefers-reduced-motion: no-preference)';
const controls = 'button, a, [role="tab"], [role="menuitem"], [role="option"], summary';
const idle = ':disabled, [aria-disabled="true"], [data-disabled="true"]';

/** Plays the icon's motion when the pointer enters the control around it. */
export function useIconMotion(ref: RefObject<SVGSVGElement | null>, icon: unknown) {
  useEffect(() => {
    const motion = motions.get(icon);
    const svg = ref.current;
    const control = svg?.closest(controls);
    if (!motion || !svg || !control) return;
    let playing: Animation[] = [];
    const play = () => {
      if (
        !window.matchMedia(allowed).matches ||
        control.matches(idle) ||
        // A spinner is already saying something; the hover must not interrupt it.
        svg.classList.contains('spin') ||
        playing.some((animation) => animation.playState === 'running')
      )
        return;
      playing = motion(svg);
    };
    control.addEventListener('pointerenter', play);
    return () => {
      control.removeEventListener('pointerenter', play);
      for (const animation of playing) animation.cancel();
    };
  }, [ref, icon]);
}
