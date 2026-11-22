import { randomUUID } from 'node:crypto';

/**
 * A guide is the agent showing the user how to do something on the page instead of doing it:
 * step by step it points at an element and says what to do there, and the user clicks and types.
 * This file is the host's side of it: it decides which step is on screen, follows the user from
 * page to page, and tells the agent how it ended. The page's side is in `browser-page-guide.ts`.
 */
export type GuideAction = 'look' | 'click' | 'input';
export interface GuideStep {
  note: string;
  action: GuideAction;
  selector?: string;
  text?: string;
  ref?: string;
}
export interface GuidePlan {
  title?: string;
  steps: GuideStep[];
}
export interface GuideProgress {
  title?: string;
  steps: Array<{ note: string; status: 'pending' | 'current' | 'done' | 'skipped' }>;
}
export type GuideEnd =
  'completed' | 'ended_by_user' | 'handed_over' | 'stopped' | 'timed_out' | 'page_closed';
export interface GuideResult {
  started: boolean;
  /** Why nothing was shown, when `started` is false. */
  reason?: string;
  ended?: GuideEnd;
  steps?: Array<{
    note: string;
    status: 'done' | 'skipped' | 'pending';
    /** How the user passed the step: by doing it, or with the card's button. */
    by?: 'click' | 'input' | 'button';
    /** False when the step's element was never found on the page. */
    located?: boolean;
    /** Whether the field held something when the user moved on. Never what it held. */
    filled?: boolean;
  }>;
  /** The first step that is not done, counted from 1. */
  next?: number;
  page?: { url: string; title: string };
  outline?: string;
  message: string;
}

export interface GuideShownStep extends GuideStep {
  practice?: PracticeTarget;
  token: string;
  index: number;
  total: number;
  title: string;
  back: boolean;
  handover: boolean;
  /** When false the step is shown even though its element is not on the page yet. */
  require: boolean;
}
/** A recording is practised on the same page, with a newly chosen business object. */
export interface PracticeTarget {
  origin: string;
  pathname: string;
  object: string;
  inRow: boolean;
  tag?: string;
  checked?: boolean;
}
export type GuideShown = { shown: true; located: boolean } | { shown: false; reason: string };
export type GuideSignal =
  | {
      kind: 'page';
      token: string;
      index: number;
      event: 'advance' | 'back' | 'end' | 'handover';
      by?: string;
      located?: boolean;
      filled?: boolean;
    }
  | { kind: 'navigated' };

/** What a guide needs from the browser. `undefined` means the page did not answer. */
export interface GuideHost {
  alive(): boolean;
  /** The tab the user is looking at. */
  where(): string | undefined;
  show(step: GuideShownStep): Promise<GuideShown | undefined>;
  shown(): Promise<{ token?: string; located?: boolean } | undefined>;
  clear(tabId?: string, farewell?: string): Promise<void>;
  settle(timeout: number): Promise<void>;
  page(): Promise<{ url: string; title: string; outline?: string }>;
}
export interface GuideOptions {
  practice?: { tabId: string; targets: PracticeTarget[] };
  /** Whether the user may hand the remaining steps to the agent. */
  handover?: boolean;
  /** Ends the guide. Aborted with the reason `ended_by_user` it ends as the user's own decision. */
  signal?: AbortSignal;
  onProgress?: (progress: GuideProgress) => void;
  pace?: Partial<typeof PACE>;
}

const PACE = {
  /** Between two attempts to place a step. */
  retry: 250,
  /** How long the first step may take to appear before the guide is not started. */
  first: 2500,
  /** How long a later step waits for its element before it is shown without one. */
  later: 1200,
  /** How long a page that does not answer is waited for. */
  silent: 8000,
  /** How often the loop looks around when nothing happens. */
  idle: 400,
  /** How often the page is asked whether the step is still on it. */
  check: 2000,
  /** How long the page may take to come to rest after the user's click. */
  settle: 2500,
  /** A guide nobody finishes ends by itself. */
  limit: 15 * 60_000,
};
const ACTIONS: GuideAction[] = ['look', 'click', 'input'];
const REASONS: Record<string, string> = {
  not_found: '页面上没有匹配 selector 的元素',
  hidden: '匹配的元素当前不可见',
  invalid_selector: 'selector 不是有效的 CSS 选择器',
  text_not_found: '页面上没有找到这段可见文字',
  stale_ref: '元素引用已失效，请重新读取页面',
  no_answer: '页面没有响应，可能正在加载',
};

function text(value: unknown, name: string, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 需要是非空文字`);
  if (value.length > max) throw new Error(`${name} 不能超过 ${max} 个字符`);
  return value.trim();
}
function only(value: object, allowed: string[], name: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new Error(`${name} 不支持 ${extra}`);
}
export function parseGuide(args: unknown, noteLimit = 280): GuidePlan {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('带做需要 steps 列表');
  only(args, ['title', 'steps'], '带做');
  const input = args as { title?: unknown; steps?: unknown };
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 12)
    throw new Error('steps 需要 1 到 12 步');
  const steps = input.steps.map((item, at): GuideStep => {
    const name = `第 ${at + 1} 步`;
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error(`${name}需要是对象`);
    only(item, ['note', 'selector', 'text', 'ref', 'action'], name);
    const step = item as Record<string, unknown>;
    const action = step.action === undefined ? 'look' : (step.action as GuideAction);
    if (!ACTIONS.includes(action)) throw new Error(`${name}的 action 只能是 look、click 或 input`);
    const parsed: GuideStep = {
      note: text(step.note, `${name}的 note`, noteLimit, true)!,
      action,
      selector: text(step.selector, `${name}的 selector`, 1000),
      text: text(step.text, `${name}的 text`, 200),
      ref: text(step.ref, `${name}的 ref`, 200),
    };
    if (action !== 'look' && !parsed.selector && !parsed.text && !parsed.ref)
      throw new Error(
        `${name}要用户${action === 'click' ? '点击' : '填写'}，需要 selector 或 text 指明位置`,
      );
    return parsed;
  });
  return { title: text(input.title, 'title', 80), steps };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Guide {
  private readonly pace: typeof PACE;
  private readonly signals: GuideSignal[] = [];
  private readonly steps: NonNullable<GuideResult['steps']>;
  private wake?: () => void;
  private token = '';
  private index = 0;
  constructor(
    private readonly host: GuideHost,
    private readonly plan: GuidePlan,
    private readonly options: GuideOptions = {},
  ) {
    this.pace = { ...PACE, ...options.pace };
    this.steps = plan.steps.map((step) => ({ note: step.note, status: 'pending' }));
  }
  /** What the page reports and where the browser goes reach the guide through here. */
  push(signal: GuideSignal): void {
    this.signals.push(signal);
    this.wake?.();
  }
  private get stopped(): boolean {
    return Boolean(this.options.signal?.aborted);
  }
  private next(): Promise<GuideSignal | undefined> {
    if (this.signals.length || this.stopped) return Promise.resolve(this.signals.shift());
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve(this.signals.shift());
      };
      const timer = setTimeout(done, this.pace.idle);
      this.wake = done;
    });
  }
  private progress(current: boolean): void {
    this.options.onProgress?.({
      title: this.plan.title,
      steps: this.steps.map((step, at) => ({
        note: step.note,
        status: current && at === this.index ? 'current' : step.status,
      })),
    });
  }
  /**
   * Puts the current step on the page. A step whose element is not there yet gets a moment; after
   * that a first step fails, and a later one is shown anyway and anchors once the element appears.
   */
  private async present(first = false): Promise<GuideShown> {
    this.token = randomUUID().slice(0, 12);
    const step: GuideShownStep = {
      ...this.plan.steps[this.index],
      practice: this.options.practice?.targets[this.index],
      token: this.token,
      index: this.index,
      total: this.plan.steps.length,
      title: this.plan.title ?? '',
      back: this.index > 0,
      handover: Boolean(this.options.handover),
      require: true,
    };
    const began = Date.now();
    let answered = 0,
      reason = 'no_answer';
    while (!this.stopped && this.host.alive()) {
      if (this.options.practice && this.host.where() !== this.options.practice.tabId)
        return { shown: false, reason: '带做标签页已改变' };
      const answer = await this.host.show(step);
      if (answer?.shown) return answer;
      const now = Date.now();
      if (answer) {
        reason = answer.reason;
        answered ||= now;
        // Nothing that appears later makes these two right.
        if (
          reason === 'invalid_selector' ||
          reason === 'stale_ref' ||
          reason === 'ambiguous_target' ||
          reason === 'wrong_origin'
        )
          break;
        if (now - answered >= (first ? this.pace.first : this.pace.later)) break;
      } else if (now - began >= this.pace.silent) break;
      await sleep(this.pace.retry);
    }
    if (first || this.options.practice || this.stopped || !this.host.alive())
      return { shown: false, reason };
    return (await this.host.show({ ...step, require: false })) ?? { shown: false, reason };
  }
  async run(): Promise<GuideResult> {
    const signal = this.options.signal;
    const wake = () => this.wake?.();
    signal?.addEventListener('abort', wake);
    try {
      return await this.loop();
    } finally {
      signal?.removeEventListener('abort', wake);
    }
  }
  private async loop(): Promise<GuideResult> {
    const { host, pace } = this;
    const began = Date.now();
    let tab = host.where();
    const first = await this.present(true);
    if (!first.shown) {
      await host.clear(tab);
      const why = REASONS[first.reason] ?? first.reason;
      return {
        started: false,
        reason: first.reason,
        message: `没有开始带做，页面上没有显示任何内容：第 1 步的位置没找到（${why}）。先用 web_page_outline 或 workbench_browser_query 确认元素，再重新调用。`,
      };
    }
    this.progress(true);
    let checked = Date.now(),
      ended: GuideEnd | undefined,
      reason: string | undefined;
    const present = async () => {
      const result = await this.present();
      if (!result.shown && this.options.practice) {
        ended = 'stopped';
        reason = result.reason;
      }
    };
    while (!ended) {
      const signal = await this.next();
      if (this.stopped)
        ended = this.options.signal?.reason === 'ended_by_user' ? 'ended_by_user' : 'stopped';
      else if (!host.alive()) ended = 'page_closed';
      else if (this.options.practice && host.where() !== this.options.practice.tabId) {
        await host.clear(this.options.practice.tabId);
        ended = 'stopped';
        reason = 'wrong_tab';
      } else if (Date.now() - began > pace.limit) ended = 'timed_out';
      else if (!signal) {
        // The guide stays with the tab the user is looking at.
        const where = host.where();
        if (where !== tab) {
          await host.clear(tab);
          tab = where;
          await present();
          checked = Date.now();
        } else if (Date.now() - checked >= pace.check) {
          const shown = await host.shown();
          const step = this.plan.steps[this.index];
          if (
            shown &&
            (shown.token !== this.token ||
              (this.options.practice && shown.located === false && (step.text || step.selector)))
          )
            await present();
          checked = Date.now();
        }
      } else if (signal.kind === 'navigated') {
        // A new document starts empty: the step is put on it again.
        const shown = await host.shown();
        if (!shown || shown.token !== this.token) await present();
        checked = Date.now();
      } else if (signal.token === this.token && signal.index === this.index) {
        const step = this.steps[this.index];
        if (signal.event === 'end') ended = 'ended_by_user';
        else if (signal.event === 'handover') {
          if (this.options.handover) ended = 'handed_over';
          else await this.present();
        } else if (signal.event === 'back') {
          if (this.index > 0) {
            this.index--;
            this.steps[this.index] = { note: this.steps[this.index].note, status: 'pending' };
          }
          this.progress(true);
          await present();
        } else {
          const by = signal.by === 'click' || signal.by === 'input' ? signal.by : 'button';
          step.status = signal.by === 'skip' ? 'skipped' : 'done';
          if (step.status === 'done') step.by = by;
          else delete step.by;
          if (signal.located === false) step.located = false;
          else delete step.located;
          if (typeof signal.filled === 'boolean') step.filled = signal.filled;
          else delete step.filled;
          if (this.index + 1 >= this.steps.length) ended = 'completed';
          else {
            this.index++;
            this.progress(true);
            // What the click set in motion comes first; the next step goes onto what follows.
            if (by === 'click' && step.status === 'done') await host.settle(pace.settle);
            await present();
          }
        }
        checked = Date.now();
      }
    }
    const result = await this.finish(ended);
    if (reason) result.reason = reason;
    return result;
  }
  private async finish(ended: GuideEnd): Promise<GuideResult> {
    const farewell =
      ended === 'completed' && this.options.practice
        ? '带做结束'
        : ended === 'completed'
          ? '完成了'
          : ended === 'handed_over'
            ? '好，接下来交给我'
            : undefined;
    await this.host.clear(undefined, farewell).catch(() => {});
    this.progress(false);
    const open = this.steps.findIndex((step) => step.status !== 'done');
    const next = ended === 'completed' || open < 0 ? undefined : open + 1;
    if (this.options.practice)
      return { started: true, ended, steps: this.steps, next, message: '录制带做已结束' };
    const page = await this.host
      .page()
      .catch(() => ({ url: '', title: '', outline: undefined as string | undefined }));
    const done = this.steps.filter((step) => step.status === 'done').length;
    const tally = `用户亲手完成了 ${done}/${this.steps.length} 步`;
    const reread = '页面已经变化，继续前先用 web_snapshot 重新读取页面。';
    const message = {
      completed: `带做结束，${tally}${done < this.steps.length ? '，其余步骤被跳过' : ''}。${reread}`,
      ended_by_user: `用户在第 ${this.index + 1} 步结束了带做（${tally}）。不要重新开始带做，也不要替用户完成剩下的步骤；按用户接下来的话继续。`,
      handed_over: `用户在第 ${this.index + 1} 步把剩下的交给你（${tally}）。${reread}然后从第 ${next ?? this.index + 1} 步起由你完成。`,
      stopped: `带做已停止（${tally}）。`,
      timed_out: `带做等待太久已自动结束（${tally}）。向用户说明停在第 ${this.index + 1} 步，不要自行重新开始。`,
      page_closed: `页面已关闭，带做结束（${tally}）。`,
    }[ended];
    return {
      started: true,
      ended,
      steps: this.steps,
      next,
      page: { url: page.url, title: page.title },
      outline: page.outline,
      message,
    };
  }
}
