import { validateElementControls, controlProperties } from '../shared/element-controls';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  BrowserActor,
  BrowserFrame,
  BrowserViewport,
  BrowserTab,
  ElementDetails,
  ElementQuery,
  ElementQueryResult,
  ElementEdit,
  ElementEditResult,
  ElementAnimation,
  ElementInsertion,
  ElementNode,
  BrowserInput,
  BrowserState,
  BrowserTool,
  ElementRef,
  PageChange,
  RecordedStep,
  Recording,
  ToolResult,
} from '../shared/types';
import {
  ELEMENT_STYLE_PROPERTIES,
  ELEMENT_ANIMATION_PROPERTIES,
  ELEMENT_BACKGROUND_FUNCTIONS,
  ELEMENT_PREVIEW_LIMITS,
  ELEMENT_UNSAFE_CSS_PATTERN,
  ELEMENT_INSERT_TAGS,
  ELEMENT_INSERT_ATTRIBUTES,
} from '../shared/types';
import { CdpConnection } from './browser-cdp';
import { browserPageSource } from './browser-page';
import { BrowserFrameSession, type BrowserChannel } from './browser-frame-session';

const execFileAsync = promisify(execFile);
const WORLD = 'workbench-browser-observer';
const PREVIEW_MAX_EDGE = 2048;
const PREVIEW_INTERVAL = 1000 / 24;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Requests that can still change what the page shows; media and long polls are not waited for. */
const SETTLE_RESOURCES = new Set(['Document', 'Stylesheet', 'Script', 'XHR', 'Fetch']);

/** Chrome saves by GUID; the host restores a safe, unused file name. */
export async function uniqueDownloadPath(directory: string, suggested: string): Promise<string> {
  const safe = basename(
    suggested.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:]/g, '_'),
  ).replace(/^\.+/, '');
  const extension = extname(safe);
  const stem = (extension ? safe.slice(0, -extension.length) : safe).slice(0, 160) || 'download';
  for (let index = 0; index < 1000; index++) {
    const name = (index ? `${stem} (${index})` : stem) + extension.slice(0, 20);
    try {
      await stat(join(directory, name));
    } catch {
      return join(directory, name);
    }
  }
  throw new Error('下载目录中的同名文件过多');
}
const editableStyles = new Set<string>(ELEMENT_STYLE_PROPERTIES);
const animatedStyles = new Set<string>(ELEMENT_ANIMATION_PROPERTIES);
const backgroundFunctions = new Set<string>(ELEMENT_BACKGROUND_FUNCTIONS);
const unsafeCss = new RegExp(ELEMENT_UNSAFE_CSS_PATTERN, 'i');

function validateInsertion(value: unknown): asserts value is ElementInsertion {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['position', 'node'].includes(key))
  )
    throw new Error('新增元素格式无效');
  const insertion = value as ElementInsertion;
  if (
    !['append', 'prepend', 'before', 'after'].includes(insertion.position ?? 'append') ||
    JSON.stringify(value).length > 60_000
  )
    throw new Error('新增元素位置无效或内容过长');
  let count = 0,
    textLength = 0;
  const walk = (node: ElementNode, depth: number) => {
    if (++count > 80 || depth > 8) throw new Error('一次最多创建 80 个节点，嵌套最多 8 层');
    if (
      !node ||
      typeof node !== 'object' ||
      Array.isArray(node) ||
      !ELEMENT_INSERT_TAGS.includes(node.tag) ||
      Object.keys(node).some(
        (key) => !['tag', 'text', 'attributes', 'styles', 'children'].includes(key),
      )
    )
      throw new Error('仅支持安全的 HTML 元素结构');
    if (node.text !== undefined) {
      if (typeof node.text !== 'string' || (textLength += node.text.length) > 20_000)
        throw new Error('新增元素文字过长');
    }
    if (node.attributes !== undefined) {
      if (
        !node.attributes ||
        typeof node.attributes !== 'object' ||
        Array.isArray(node.attributes) ||
        Object.keys(node.attributes).length > 20
      )
        throw new Error('元素属性格式无效');
      for (const [key, item] of Object.entries(node.attributes)) {
        if (
          !(ELEMENT_INSERT_ATTRIBUTES as readonly string[]).includes(key) ||
          typeof item !== 'string' ||
          item.length > 4096
        )
          throw new Error('不支持的元素属性');
        if (key === 'href' || key === 'src') {
          if (key === 'src' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(item))
            continue;
          const url = new URL(item, 'https://athena.invalid');
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            throw new Error('元素链接仅支持 HTTP / HTTPS');
        }
        if (
          key === 'type' &&
          (node.tag === 'button'
            ? item !== 'button'
            : node.tag !== 'input' ||
              !['text', 'search', 'number', 'checkbox', 'radio'].includes(item))
        )
          throw new Error('不支持此输入控件类型');
      }
    }
    if (node.styles !== undefined) validateStyles(node.styles, editableStyles, true);
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new Error('子元素格式无效');
      node.children.forEach((child) => walk(child, depth + 1));
    }
    if (
      ['input', 'img', 'br', 'hr'].includes(node.tag) &&
      (node.text !== undefined || node.children?.length)
    )
      throw new Error('此元素不能包含子节点');
  };
  walk(insertion.node, 1);
}

function validateStyles(
  value: unknown,
  properties: ReadonlySet<string>,
  allowEmpty: boolean,
): asserts value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('样式修改格式无效');
  const entries = Object.entries(value);
  if (entries.length > ELEMENT_PREVIEW_LIMITS.styleCount || (!allowEmpty && !entries.length))
    throw new Error('样式属性数量无效');
  for (const [name, item] of entries) {
    if (
      !properties.has(name) ||
      typeof item !== 'string' ||
      item.length > ELEMENT_PREVIEW_LIMITS.styleValueLength ||
      (!allowEmpty && !item.trim()) ||
      unsafeCss.test(item)
    )
      throw new Error(`不支持的 CSS 属性或值：${name}`);
    if (['background', 'background-image'].includes(name)) {
      const functions = [...item.matchAll(/([a-z][a-z0-9-]*)\s*\(/gi)].map((match) =>
        match[1].toLowerCase(),
      );
      if (functions.some((fn) => !backgroundFunctions.has(fn)))
        throw new Error('背景仅支持安全渐变、颜色和布局函数');
    }
  }
}

function validEasing(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    value.length > ELEMENT_PREVIEW_LIMITS.easingLength ||
    unsafeCss.test(value)
  )
    return false;
  const easing = value.trim().toLowerCase();
  if (
    ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end'].includes(
      easing,
    )
  )
    return true;
  const curve = /^cubic-bezier\((.*)\)$/.exec(easing);
  if (curve) {
    const parts = curve[1].split(',').map((part) => part.trim());
    if (
      parts.length !== 4 ||
      parts.some((part) => !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(part))
    )
      return false;
    const numbers = parts.map(Number);
    return (
      numbers.every(Number.isFinite) &&
      numbers[0] >= 0 &&
      numbers[0] <= 1 &&
      numbers[2] >= 0 &&
      numbers[2] <= 1
    );
  }
  const steps =
    /^steps\(\s*(\d+)\s*(?:,\s*(start|end|jump-start|jump-end|jump-none|jump-both)\s*)?\)$/.exec(
      easing,
    );
  return (
    !!steps &&
    Number(steps[1]) >= (steps[2] === 'jump-none' ? 2 : 1) &&
    Number(steps[1]) <= ELEMENT_PREVIEW_LIMITS.stepsMax
  );
}

function validateAnimation(value: unknown): asserts value is ElementAnimation {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['keyframes', 'duration', 'iterations', 'easing', 'direction'].includes(key),
    )
  )
    throw new Error('动画配置格式无效');
  const animation = value as ElementAnimation;
  if (
    !Array.isArray(animation.keyframes) ||
    animation.keyframes.length < ELEMENT_PREVIEW_LIMITS.keyframesMin ||
    animation.keyframes.length > ELEMENT_PREVIEW_LIMITS.keyframesMax
  )
    throw new Error('动画需要 2–12 个关键帧');
  if (
    !Number.isFinite(animation.duration) ||
    animation.duration < ELEMENT_PREVIEW_LIMITS.durationMin ||
    animation.duration > ELEMENT_PREVIEW_LIMITS.durationMax
  )
    throw new Error('动画时长必须为 100–60000 毫秒');
  if (
    animation.iterations !== undefined &&
    animation.iterations !== 'infinite' &&
    (!Number.isFinite(animation.iterations) ||
      animation.iterations < 1 ||
      animation.iterations > ELEMENT_PREVIEW_LIMITS.iterationsMax)
  )
    throw new Error('动画次数必须为 1–100 或 infinite');
  if (animation.easing !== undefined && !validEasing(animation.easing))
    throw new Error('动画 easing 无效');
  if (
    animation.direction !== undefined &&
    !['normal', 'reverse', 'alternate', 'alternate-reverse'].includes(animation.direction)
  )
    throw new Error('动画方向无效');
  let previous = 0;
  for (const frame of animation.keyframes) {
    if (
      !frame ||
      typeof frame !== 'object' ||
      Array.isArray(frame) ||
      Object.keys(frame).some((key) => !['offset', 'styles'].includes(key))
    )
      throw new Error('动画关键帧格式无效');
    if (frame.offset !== undefined) {
      if (!Number.isFinite(frame.offset) || frame.offset < previous || frame.offset > 1)
        throw new Error('动画 offset 必须在 0–1 之间且非递减');
      previous = frame.offset;
    }
    validateStyles(frame.styles, animatedStyles, false);
  }
}

export function normalizeBrowserUrl(input: string): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096)
    throw new Error('请输入有效的 HTTP 或 HTTPS 地址');
  let value = input.trim();
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?(?:\/|$)/i.test(value))
    value = `http://${value}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error('浏览器仅允许不含凭据的 HTTP / HTTPS 地址');
  return url.href;
}

export function redactBrowserText(value: unknown, limit = 2000): string {
  return String(value ?? '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [hidden]')
    .replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[hidden]')
    .replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[hidden]')
    .slice(0, limit);
}

const PAGE_SHEET_LIMIT = 60_000;
function recordedEditValue(value: string): string {
  try {
    const input = JSON.parse(value);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Invalid edit');
    const output: Record<string, unknown> = {};
    let truncated = false;
    if (typeof input.text === 'string') {
      output.text = redactBrowserText(input.text, 20_000);
      truncated ||= input.text.length > 20_000;
    }
    if (input.styles && typeof input.styles === 'object' && !Array.isArray(input.styles)) {
      const entries = Object.entries(input.styles);
      output.styles = Object.fromEntries(
        entries.slice(0, 30).map(([key, item]) => {
          const text = typeof item === 'string' ? item : '[invalid style]';
          truncated ||= key.length > 100 || text.length > 500;
          return [redactBrowserText(key, 100), redactBrowserText(text, 500)];
        }),
      );
      truncated ||= entries.length > 30;
    }
    if (typeof input.editId === 'string') output.editId = redactBrowserText(input.editId, 1500);
    if (typeof input.sheet === 'string') {
      output.sheet = redactBrowserText(input.sheet, PAGE_SHEET_LIMIT);
      truncated ||= input.sheet.length > PAGE_SHEET_LIMIT;
    }
    if (Array.isArray(input.texts))
      output.texts = input.texts.slice(0, 60).map((item: any) => ({
        selector: redactBrowserText(item?.selector, 1000),
        text: redactBrowserText(item?.text, 20_000),
      }));
    if (input.insert !== undefined) {
      validateInsertion(input.insert);
      output.insert = JSON.parse(
        JSON.stringify(input.insert, (_key, item) =>
          typeof item === 'string' ? redactBrowserText(item, 20_000) : item,
        ),
      );
    }
    if (input.animation === null) output.animation = null;
    else if (input.animation !== undefined) {
      validateAnimation(input.animation);
      const animation = input.animation as ElementAnimation;
      output.animation = {
        ...animation,
        keyframes: animation.keyframes.map((frame) => ({
          ...frame,
          styles: Object.fromEntries(
            Object.entries(frame.styles).map(([key, item]) => [
              key,
              redactBrowserText(item, ELEMENT_PREVIEW_LIMITS.styleValueLength),
            ]),
          ),
        })),
      };
    }
    if (truncated) output.truncated = true;
    return JSON.stringify(output);
  } catch {
    return JSON.stringify({ unavailable: true, reason: 'Invalid edit payload' });
  }
}

export function evidenceUrl(value: string): string {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      ? `${url.origin}${url.pathname}`
      : url.protocol;
  } catch {
    return '';
  }
}

const CHROME_BUNDLES = ['com.google.Chrome', 'com.google.Chrome.canary', 'org.chromium.Chromium'];

async function brandedBinary(candidate: string): Promise<string | undefined> {
  try {
    const app = candidate.endsWith('.app')
      ? candidate
      : candidate.slice(0, candidate.lastIndexOf('.app/') + 4);
    if (!app.endsWith('.app')) return undefined;
    const { stdout } = await execFileAsync(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')],
      { timeout: 2000, maxBuffer: 64 * 1024 },
    );
    const info = JSON.parse(stdout);
    if (!CHROME_BUNDLES.includes(info.CFBundleIdentifier)) return undefined;
    if (typeof info.CFBundleExecutable !== 'string' || /[\/\\]/.test(info.CFBundleExecutable))
      return undefined;
    const binary = join(app, 'Contents/MacOS', info.CFBundleExecutable);
    if (!candidate.endsWith('.app') && resolve(candidate) !== resolve(binary)) return undefined;
    if (!(await stat(binary)).isFile()) return undefined;
    await access(binary, constants.X_OK);
    return binary;
  } catch {
    return undefined;
  }
}

/** Finds an installed Chrome; an explicit path is never replaced by another installation. */
export async function discoverChrome(explicit?: string): Promise<string | undefined> {
  if (explicit) return brandedBinary(resolve(explicit));
  const candidates = [
    process.env.ATHENA_CHROME_PATH,
    '/Applications/Google Chrome.app',
    join(homedir(), 'Applications/Google Chrome.app'),
    '/Applications/Chromium.app',
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const binary = await brandedBinary(candidate);
    if (binary) return binary;
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/osascript',
        [
          '-l',
          'JavaScript',
          '-e',
          "ObjC.import('AppKit'); const app = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier('com.google.Chrome'); JSON.stringify(app.isNil() ? null : ObjC.unwrap(app.path));",
        ],
        { timeout: 2000, maxBuffer: 64 * 1024 },
      );
      const candidate = JSON.parse(stdout);
      if (
        typeof candidate === 'string' &&
        !candidate.startsWith('/Volumes/') &&
        !/\/\.Trashes?\//.test(candidate)
      ) {
        const binary = await brandedBinary(candidate);
        if (binary) return binary;
      }
    } catch {
      /* Launch Services may not yet know about a newly copied application. */
    }
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/mdfind',
        ['-0', "kMDItemCFBundleIdentifier == 'com.google.Chrome'"],
        { timeout: 2000, maxBuffer: 1024 * 1024 },
      );
      for (const candidate of stdout.split('\0')) {
        if (
          !candidate.endsWith('.app') ||
          candidate.startsWith('/Volumes/') ||
          /\/\.Trashes?\//.test(candidate)
        )
          continue;
        const binary = await brandedBinary(candidate);
        if (binary) return binary;
      }
    } catch {
      /* Spotlight can be disabled; the next probe still checks known locations. */
    }
  }
  return undefined;
}

interface BrowserOptions {
  storageDir: string;
  binaryPath?: string;
  onState: (state: BrowserState) => void;
  onFrame: (frame: BrowserFrame) => void;
  onStep: (step: RecordedStep) => void;
  /** `pick`: the user chose an element in the inspector; `edit`: an edit or undo re-reported it. */
  onSelected: (element: ElementRef, reason: 'pick' | 'edit') => void;
  onHumanTakeover: () => void;
}

interface FrameContext {
  id: string;
  parentId?: string;
  url: string;
  channel: BrowserChannel;
  revision: number;
  contextId?: number;
  documentId?: string;
  source?: 'human' | 'agent';
  actorId?: string;
}
interface TabSession {
  info: BrowserTab;
  page: CdpConnection;
  mainFrameId: string;
  frames: Map<string, FrameContext>;
  channels: Set<BrowserChannel>;
  children: Set<BrowserFrameSession>;
  pendingFrames: Set<Promise<void>>;
  activation: number;
  source: 'human' | 'agent';
  actorId?: string;
  diagnostics: Array<{ time: number; kind: string; text: string }>;
  /** In-flight page work that native web tools wait out before observing. */
  requests: Map<string, number>;
  loadingFrames: Set<string>;
  documentStatus?: number;
  chooser?: { channel: BrowserChannel; backendNodeId: number; multiple: boolean };
  edits: Array<{
    transient?: boolean;
    actor?: BrowserActor;
    id: string;
    frameId: string;
    documentId: string;
    localId: string;
    localRef?: string;
    changes?: ElementEdit;
    /** Who made it: the person in the inspector, or the agent through a tool. */
    source?: 'human' | 'agent';
  }>;
}
interface ScopedElement {
  tabId: string;
  activation: number;
  frameId: string;
  revision: number;
  documentId: string;
  localRef: string;
}
interface FrameGeometry {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}
interface PreparedContext {
  channel: BrowserChannel;
  contextId: number;
  revision: number;
}

/** One BrowserHost owns all Chrome targets and grants input only to the visible tab. */
export class BrowserRuntime {
  private state: BrowserState = {
    status: 'missing',
    engine: 'agent-browser',
    tabs: [],
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    recording: false,
    inspecting: false,
  };
  private process?: ChildProcess;
  private browser?: CdpConnection;
  private endpoint = '';
  private tabs = new Map<string, TabSession>();
  private attaching = new Map<string, Promise<TabSession>>();
  private activeTabId = '';
  private refs = new Map<string, ScopedElement>();
  private width = 1100;
  private height = 760;
  private captureSize = { width: PREVIEW_MAX_EDGE, height: PREVIEW_MAX_EDGE };
  private fittedViewport?: {
    tabId: string;
    activation: number;
    url: string;
    paneWidth: number;
    width: number;
  };
  private frameAcks = new Set<() => void>();
  private nextIdleFrameAckAt = 0;
  private interactiveFrameUntil = 0;
  private starting?: Promise<void>;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingWheel?: {
    input: Extract<BrowserInput, { type: 'wheel' }>;
    result: Promise<void>;
    actorId: string;
    guard?: () => void;
    epoch: number;
  };
  private leaseGeneration = 0;
  private agentAllowed = true;
  private agentNeedsObservation = false;
  private nativeAgentActive = false;
  private pendingDialogs = new Map<
    string,
    { channel: BrowserChannel; type: string; message: string; defaultPrompt?: string }
  >();
  private downloads = new Map<
    string,
    {
      sequence: number;
      name: string;
      state: 'inProgress' | 'saving' | 'completed' | 'canceled';
      path?: string;
      size?: number;
    }
  >();
  private downloadSequence = 0;
  private downloadRenames: Promise<void> = Promise.resolve();
  private suppressMouseUp = false;
  private pointerMove?: Promise<void>;
  private latestMove?: Extract<BrowserInput, { type: 'mouse' }>;
  private hoverEpoch = 0;
  private workingFeedback?: ScopedElement & { ref: string };
  private recording?: Recording;
  private endingRecording?: Promise<Recording>;
  private actorContext = new AsyncLocalStorage<{
    actor: BrowserActor;
    guard?: () => void;
    epoch?: number;
  }>();
  private actors = new Map<string, BrowserActor>([['host', { id: 'host', name: '主持人' }]]);
  private queueDepth = 0;
  private frameSequence = 0;
  private surfaceEpoch = 0;
  private surfaceChangedAt = 0;
  private publishedEpoch = -1;
  private frameRefreshTimer?: ReturnType<typeof setTimeout>;
  private frameRefreshTab?: TabSession;
  private refreshingFrame = false;
  private resizingViewport = false;
  private sharedTab?: string;
  private sharedOrigin?: string;
  private sharedFrameOrigins = new Set<string>();
  private heldKeys = new Map<string, Extract<BrowserInput, { type: 'key' }>>();
  private heldButtons = new Map<string, { x: number; y: number; button: string }>();

  withActor<T>(
    actor: BrowserActor,
    guard: (() => void) | undefined,
    action: () => T,
    epoch?: number,
  ): T {
    this.actors.set(actor.id, { ...actor });
    return this.actorContext.run({ actor, guard, epoch }, action);
  }
  private currentActor(): BrowserActor {
    return this.actorContext.getStore()?.actor ?? this.actors.get('host')!;
  }
  private assertActor(): void {
    const context = this.actorContext.getStore();
    context?.guard?.();
    if (context?.epoch !== undefined && context.epoch !== this.surfaceEpoch)
      throw new Error('页面已改变，请等待新画面');
  }
  getSurfaceEpoch(): number {
    return this.surfaceEpoch;
  }
  getSurfaceViewport(): { width: number; height: number; tabId: string; loading: boolean } {
    return {
      width: this.width,
      height: this.height,
      tabId: this.activeTabId,
      loading: this.state.loading,
    };
  }
  private invalidateSurface(): void {
    this.surfaceEpoch++;
    this.surfaceChangedAt = Date.now();
  }
  /** Invisible document changes may not paint. Refresh once, then fan out the same frame. */
  private refreshUnpaintedSurface(tab: TabSession): void {
    if (!this.browser) return;
    // Rejected stream frames must not keep postponing the same recovery timer.
    if (this.frameRefreshTimer && this.frameRefreshTab === tab) return;
    clearTimeout(this.frameRefreshTimer);
    this.frameRefreshTab = tab;
    this.frameRefreshTimer = this.actorContext.exit(() =>
      setTimeout(() => {
        this.frameRefreshTimer = undefined;
        this.frameRefreshTab = undefined;
        if (
          this.disposed ||
          this.activeTabId !== tab.info.id ||
          this.state.loading ||
          this.publishedEpoch === this.surfaceEpoch ||
          this.refreshingFrame
        )
          return;
        this.refreshingFrame = true;
        const requestedEpoch = this.surfaceEpoch;
        void this.serialize(async () => {
          const epoch = this.surfaceEpoch,
            sequence = this.frameSequence;
          if (
            this.activeTabId !== tab.info.id ||
            this.state.loading ||
            this.publishedEpoch === epoch
          )
            return;
          const metrics = await tab.page.call('Page.getLayoutMetrics');
          if (epoch !== this.surfaceEpoch || this.activeTabId !== tab.info.id) return;
          const { data } = await tab.page.call('Page.captureScreenshot', {
            format: 'jpeg',
            quality: 88,
            captureBeyondViewport: false,
            clip: {
              x: metrics.cssVisualViewport?.pageX || 0,
              y: metrics.cssVisualViewport?.pageY || 0,
              width: this.width,
              height: this.height,
              scale: Math.min(
                1,
                this.captureSize.width / (this.width * 2),
                this.captureSize.height / (this.height * 2),
              ),
            },
          });
          if (
            this.disposed ||
            this.activeTabId !== tab.info.id ||
            epoch !== this.surfaceEpoch ||
            sequence !== this.frameSequence
          )
            return;
          this.publishedEpoch = epoch;
          this.options.onFrame({
            data: `data:image/jpeg;base64,${data}`,
            width: this.width,
            height: this.height,
            tabId: tab.info.id,
            epoch,
            sequence: ++this.frameSequence,
            capturedAt: Date.now(),
          });
        }, true)
          .catch((error) =>
            this.log(tab, 'frame.refresh', error instanceof Error ? error.message : error),
          )
          .finally(() => {
            this.refreshingFrame = false;
            if (
              !this.disposed &&
              requestedEpoch !== this.surfaceEpoch &&
              this.publishedEpoch !== this.surfaceEpoch
            )
              this.refreshUnpaintedSurface(tab);
          });
      }, 60),
    );
  }
  async setSharedTab(tabId?: string): Promise<void> {
    this.sharedTab = tabId;
    this.sharedOrigin = tabId ? new URL(this.requireActive(tabId).info.url).origin : undefined;
    this.sharedFrameOrigins.clear();
    if (tabId)
      for (const frame of this.requireActive(tabId).frames.values()) {
        try {
          this.sharedFrameOrigins.add(new URL(frame.url).origin);
        } catch {}
      }
    if (tabId) this.revokeAgentControl();
    await this.applyDownloadBehavior();
  }
  private async applyDownloadBehavior(): Promise<void> {
    if (!this.browser) return;
    if (this.sharedTab) {
      await this.browser.call('Browser.setDownloadBehavior', { behavior: 'deny' });
      return;
    }
    const downloadPath = this.getDownloadDirectory();
    await mkdir(downloadPath, { recursive: true, mode: 0o700 });
    // Chrome's plain "allow" overwrites an earlier file of the same name; GUID names never collide.
    await this.browser.call('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath,
      eventsEnabled: true,
    });
  }
  private finishDownload(p: any): void {
    const entry = this.downloads.get(p.guid);
    if (!entry || entry.state !== 'inProgress' || p.state === 'inProgress') return;
    if (p.state !== 'completed') {
      entry.state = 'canceled';
      return;
    }
    entry.state = 'saving';
    const directory = this.getDownloadDirectory();
    // Renames run one at a time so two files with the same name cannot pick the same target.
    this.downloadRenames = this.downloadRenames.then(async () => {
      try {
        const target = await uniqueDownloadPath(directory, entry.name);
        await rename(
          typeof p.filePath === 'string' && p.filePath ? p.filePath : join(directory, p.guid),
          target,
        );
        entry.path = target;
        entry.size = (await stat(target)).size;
        entry.state = 'completed';
      } catch {
        entry.state = 'canceled';
      }
    });
  }
  private sharedNavigation(url: string, actorId: string, mainFrame = true): void {
    if (!this.sharedTab) return;
    const origin = new URL(url).origin;
    if (actorId === 'host') {
      if (mainFrame && this.sharedOrigin !== origin) {
        this.sharedOrigin = origin;
        this.sharedFrameOrigins.clear();
      }
      this.sharedFrameOrigins.add(origin);
    } else if (
      mainFrame
        ? origin !== this.sharedOrigin
        : origin !== this.sharedOrigin && !this.sharedFrameOrigins.has(origin)
    )
      throw new Error('共享仅限当前站点，请让主持人打开其他站点');
  }
  /** Release held keys/buttons after a lease change, before the next operator is admitted. */
  resetHumanInput(): Promise<void> {
    this.latestMove = undefined;
    this.pendingWheel = undefined;
    this.suppressMouseUp = false;
    return this.serialize(async () => {
      const tab = this.activeTab();
      if (this.heldButtons.size) await tab.page.call('Input.cancelDragging').catch(() => {});
      for (const input of this.heldButtons.values())
        await tab.page.call('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: input.button,
          x: -1,
          y: -1,
          buttons: 0,
        });
      this.heldButtons.clear();
      for (const input of this.heldKeys.values())
        await tab.page.call('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: input.key,
          code: input.code,
          modifiers: 0,
        });
      this.heldKeys.clear();
      // Wheel dispatch can acknowledge before compositor scroll events reach the observer.
      await this.bridge(
        tab,
        this.mainFrame(tab),
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      ).catch(() => {});
      for (const frame of await this.collectFrames(tab)) {
        await this.bridge(tab, frame, 'globalThis.__workbenchPage.flushScroll()').catch(() => {});
        for (const edit of tab.edits.filter(
          (e) => e.transient && e.frameId === frame.id && e.documentId === frame.documentId,
        )) {
          await this.withActor(edit.actor || this.currentActor(), undefined, async () => {
            await this.setSource(tab, 'human', frame);
            await this.bridge(
              tab,
              frame,
              `globalThis.__workbenchPage.commitStyles(${JSON.stringify(edit.localId)})`,
            );
          }).catch(() =>
            this.appendStep({
              kind: 'control',
              description: '预览已中断，页面发生变化，请检查当前效果',
              source: 'human',
              actor: edit.actor,
              url: evidenceUrl(tab.info.url),
              tabId: tab.info.id,
            }),
          );
          edit.transient = false;
        }
      }
      await this.setSource(tab, 'human');
    }, true);
  }
  recordCollaboration(actor: BrowserActor, description: string): void {
    const tab = this.tabs.get(this.activeTabId);
    if (tab)
      this.appendStep({
        kind: 'control',
        description,
        actor,
        source: 'human',
        url: evidenceUrl(tab.info.url),
        tabId: tab.info.id,
      });
  }
  getRecording(): Recording | undefined {
    return this.recording && structuredClone(this.recording);
  }

  constructor(private options: BrowserOptions) {}

  listTabs(): BrowserTab[] {
    return [...this.tabs.values()].map((tab) => ({ ...tab.info }));
  }
  getState(): BrowserState {
    const tab = this.tabs.get(this.activeTabId);
    return structuredClone({
      ...this.state,
      viewport: {
        width: this.width,
        height: this.height,
        epoch: this.surfaceEpoch,
        tabId: this.activeTabId,
      },
      ...(tab?.info ?? {}),
      tabs: this.listTabs(),
      activeTabId: tab?.info.id,
      previewEdits:
        tab?.edits.flatMap((edit) => {
          const frame = tab.frames.get(edit.frameId);
          return edit.localRef && edit.changes && frame?.documentId === edit.documentId
            ? [
                {
                  actor: edit.actor,
                  editId: edit.id,
                  tabId: tab.info.id,
                  frameId: edit.frameId,
                  documentId: edit.documentId,
                  nodeId: edit.localRef,
                  changes: edit.changes,
                },
              ]
            : [];
        }) ?? [],
    });
  }
  private update(patch: Partial<BrowserState> = {}): void {
    this.state = { ...this.state, ...patch };
    if (this.state.elementControls?.ref !== this.state.selectedElement?.ref)
      this.state.elementControls = undefined;
    this.options.onState(this.getState());
  }
  private updateTab(tab: TabSession, patch: Partial<BrowserTab>): void {
    if (this.tabs.get(tab.info.id) !== tab) return;
    Object.assign(tab.info, patch);
    this.update();
  }
  private log(tab: TabSession | undefined, kind: string, text: unknown): void {
    if (!tab) return;
    tab.diagnostics.push({ time: Date.now(), kind, text: redactBrowserText(text) });
    if (tab.diagnostics.length > 150) tab.diagnostics.shift();
  }
  private serialize<T>(action: () => Promise<T>, control = false): Promise<T> {
    // An intervening command is an ordering boundary for accumulated wheel input.
    this.pendingWheel = undefined;
    if (!control && this.queueDepth >= 128)
      return Promise.reject(new Error('操作过快，请等待当前输入完成'));
    const context = this.actorContext.getStore();
    this.queueDepth++;
    const result = this.queue
      .then(() =>
        this.actorContext.run(context!, async () => {
          this.assertActor();
          return action();
        }),
      )
      .finally(() => {
        this.queueDepth--;
      });
    this.queue = result.catch(() => {});
    return result;
  }
  private boostFrames(): void {
    this.interactiveFrameUntil = Date.now() + 300;
    this.releaseFrames();
  }
  private releaseFrames(): void {
    for (const acknowledge of this.frameAcks) acknowledge();
    this.nextIdleFrameAckAt = 0;
  }
  private acknowledgeFrame(page: BrowserChannel, sessionId: number): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const acknowledge = () => {
      if (timer) clearTimeout(timer);
      this.frameAcks.delete(acknowledge);
      void page.call('Page.screencastFrameAck', { sessionId }).catch(() => {});
    };
    if (Date.now() < this.interactiveFrameUntil) acknowledge();
    else {
      // Bound idle work even when the capture pipeline has several frames in flight.
      this.nextIdleFrameAckAt = Math.max(Date.now(), this.nextIdleFrameAckAt) + PREVIEW_INTERVAL;
      this.frameAcks.add(acknowledge);
      timer = setTimeout(acknowledge, this.nextIdleFrameAckAt - Date.now());
    }
  }
  private receiveScreencastFrame(tab: TabSession, p: any): void {
    const page = tab.page;
    if (this.disposed || this.activeTabId !== tab.info.id) {
      void page.call('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
      return;
    }
    const capturedAt = p.metadata.timestamp ? Math.round(p.metadata.timestamp * 1000) : Date.now();
    if (this.resizingViewport || capturedAt < this.surfaceChangedAt) {
      this.acknowledgeFrame(page, p.sessionId);
      return;
    }
    // A scaled captureScreenshot can temporarily change screencast metadata.
    // Such frames neither describe our viewport nor supersede a valid fallback.
    if (p.metadata.deviceWidth !== this.width || p.metadata.deviceHeight !== this.height) {
      this.acknowledgeFrame(page, p.sessionId);
      if (!this.refreshingFrame) this.refreshUnpaintedSurface(tab);
      return;
    }
    this.publishedEpoch = this.surfaceEpoch;
    this.options.onFrame({
      sequence: ++this.frameSequence,
      epoch: this.surfaceEpoch,
      capturedAt,
      data: `data:image/jpeg;base64,${p.data}`,
      width: this.width,
      height: this.height,
      tabId: tab.info.id,
    });
    this.acknowledgeFrame(page, p.sessionId);
  }
  private activeTab(): TabSession {
    const tab = this.tabs.get(this.activeTabId);
    if (!tab || this.state.status !== 'ready') throw new Error('浏览器尚未就绪');
    return tab;
  }
  private async until<T>(
    check: () => Promise<T | undefined | false>,
    timeout = 10_000,
  ): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await check();
      if (value) return value as T;
      await wait(50);
    }
    throw new Error('等待浏览器响应超时');
  }

  /** Re-checks the installed browser without starting it; onboarding polls this after an install. */
  async detectInstallation(): Promise<string | undefined> {
    if (this.state.status === 'ready') return this.state.binaryPath;
    const disposed = this.disposed;
    // A stored path from another browser must not block the default installation.
    const binary =
      (this.options.binaryPath ? await discoverChrome(this.options.binaryPath) : undefined) ??
      (await discoverChrome());
    if (
      this.disposed === disposed &&
      !this.starting &&
      this.getState().status !== 'ready' &&
      this.state.binaryPath !== binary
    )
      this.update({ status: binary ? 'stopped' : 'missing', binaryPath: binary, error: undefined });
    return binary;
  }
  start(initialUrl?: string): Promise<void> {
    if (this.state.status === 'ready') return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.startInternal(initialUrl).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async startInternal(initialUrl?: string): Promise<void> {
    const initial = initialUrl === undefined ? undefined : normalizeBrowserUrl(initialUrl);
    this.disposed = false;
    const binary = await this.detectInstallation();
    if (!binary) {
      this.update({
        status: 'missing',
        error: '未找到 Chrome，请安装 Chrome 或指定其应用路径。',
      });
      throw new Error(this.state.error);
    }
    this.update({ status: 'starting', binaryPath: binary, error: undefined });
    // A dedicated profile: never the user's everyday Chrome data.
    const profile = join(this.options.storageDir, 'agent-browser-profile');
    await mkdir(profile, { recursive: true });
    // Downloads started before the CDP download behavior applies still land in the owned folder.
    const preferencesPath = join(profile, 'Default', 'Preferences');
    let preferences: Record<string, any> = {};
    try {
      preferences = JSON.parse(await readFile(preferencesPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(join(profile, 'Default'), { recursive: true });
    await mkdir(this.getDownloadDirectory(), { recursive: true, mode: 0o700 });
    preferences.download = {
      ...preferences.download,
      default_directory: this.getDownloadDirectory(),
      prompt_for_download: false,
    };
    const temporary = preferencesPath + '.' + randomUUID();
    await writeFile(temporary, JSON.stringify(preferences), { mode: 0o600 });
    await rename(temporary, preferencesPath);
    const child = spawn(
      binary,
      [
        '--headless=new',
        '--force-device-scale-factor=2',
        '--remote-debugging-port=0',
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-features=MediaRouter',
        '--disable-sync',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        'about:blank',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          LANG: process.env.LANG || 'en_US.UTF-8',
        },
      },
    );
    this.process = child;
    let failure: Error | undefined;
    let endpoint = '';
    child.stderr?.on('data', (data) => {
      const match = data
        .toString()
        .match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/);
      if (match) endpoint = match[1];
    });
    child.on('error', (error) => {
      failure = error;
    });
    child.on('exit', () => {
      if (!this.disposed && this.process === child)
        this.update({
          status: 'error',
          loading: false,
          error: '浏览器已退出，请重新启动。',
        });
    });
    try {
      this.endpoint = await this.until(async () => {
        if (failure) throw failure;
        if (child.exitCode !== null) throw new Error('浏览器启动失败');
        return endpoint || undefined;
      }, 20_000);
      this.browser = await CdpConnection.connect(this.endpoint);
      this.browser.on('Target.targetCreated', (p) => {
        void this.handleTarget(p.targetInfo);
      });
      this.browser.on('Target.targetInfoChanged', (p) => {
        void this.handleTarget(p.targetInfo);
      });
      this.browser.on('Target.targetDestroyed', (p) => {
        void this.removeTarget(p.targetId);
      });
      const { targetInfos } = await this.browser.call('Target.getTargets');
      const first = targetInfos.find((item: any) => item.type === 'page');
      if (!first) throw new Error('浏览器没有创建可用页面');
      const tab = await this.attachTab(first);
      await this.activateTab(tab, 'human', false);
      await this.browser.call('Target.setDiscoverTargets', { discover: true });
      this.browser.on('Browser.downloadWillBegin', (p) => {
        this.downloads.set(p.guid, {
          sequence: ++this.downloadSequence,
          name: String(p.suggestedFilename || 'download'),
          state: 'inProgress',
        });
        if (this.downloads.size > 200) this.downloads.delete(this.downloads.keys().next().value!);
      });
      this.browser.on('Browser.downloadProgress', (p) => this.finishDownload(p));
      await this.applyDownloadBehavior();
      if (initial !== undefined) {
        this.updateTab(tab, { url: initial, loading: true });
        const result = await tab.page.call('Page.navigate', { url: initial });
        if (result.errorText) throw new Error(result.errorText);
        await this.refreshTab(tab);
      }
      this.update({ status: 'ready', error: undefined });
    } catch (error) {
      const message = redactBrowserText(error instanceof Error ? error.message : error);
      await this.dispose();
      this.update({ status: 'error', loading: false, error: message });
      throw new Error(message);
    }
  }

  private async handleTarget(info: any): Promise<void> {
    if (this.disposed || info.type !== 'page') return;
    const existing = this.tabs.get(info.targetId);
    if (existing) {
      this.updateTab(existing, {
        title: info.title || existing.info.title,
        url: info.url || existing.info.url,
      });
      return;
    }
    try {
      if (this.sharedTab) {
        await this.browser?.call('Target.closeTarget', { targetId: info.targetId });
        return;
      }
      await this.attachTab(info);
    } catch (error) {
      this.log(
        this.tabs.get(this.activeTabId),
        'tab.error',
        error instanceof Error ? error.message : error,
      );
    }
  }
  private attachTab(info: any): Promise<TabSession> {
    const pending = this.attaching.get(info.targetId);
    if (pending) return pending;
    const existing = this.tabs.get(info.targetId);
    if (existing) return Promise.resolve(existing);
    const task = this.attachTabInternal(info).finally(() => this.attaching.delete(info.targetId));
    this.attaching.set(info.targetId, task);
    return task;
  }
  private async attachTabInternal(info: any): Promise<TabSession> {
    const host = new URL(this.endpoint).host;
    const target = await this.until(async () => {
      const all = (await (await fetch(`http://${host}/json/list`)).json()) as any[];
      return all.find((item) => item.id === info.targetId && item.webSocketDebuggerUrl);
    });
    const page = await CdpConnection.connect(target.webSocketDebuggerUrl);
    const tab: TabSession = {
      info: {
        id: info.targetId,
        title: info.title || '新标签页',
        url: info.url || 'about:blank',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
      page,
      mainFrameId: '',
      frames: new Map(),
      channels: new Set(),
      children: new Set(),
      pendingFrames: new Set(),
      activation: 0,
      source: 'human',
      diagnostics: [],
      requests: new Map(),
      loadingFrames: new Set(),
      edits: [],
    };
    this.tabs.set(tab.info.id, tab);
    try {
      await this.installChannel(tab, page, true);
      page.on('Page.screencastFrame', (p) => this.receiveScreencastFrame(tab, p));
      page.on('connection:closed', () => {
        if (!this.disposed && this.tabs.get(tab.info.id) === tab)
          void this.removeTarget(tab.info.id);
      });
      await page.call('Emulation.setDeviceMetricsOverride', {
        width: this.width,
        height: this.height,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await this.refreshTab(tab);
      this.update();
      return tab;
    } catch (error) {
      this.tabs.delete(tab.info.id);
      page.close();
      throw error;
    }
  }
  private registerFrame(
    tab: TabSession,
    frame: any,
    channel: BrowserChannel,
    parentId?: string,
  ): FrameContext {
    let entry = tab.frames.get(frame.id);
    if (!entry) {
      entry = {
        id: frame.id,
        parentId: frame.parentId || parentId,
        url: frame.url || '',
        channel,
        revision: 0,
      };
      tab.frames.set(frame.id, entry);
    } else {
      entry.url = frame.url || entry.url;
      if (frame.parentId || parentId) entry.parentId = frame.parentId || parentId;
      if (
        entry.channel !== channel &&
        (channel !== tab.page || !tab.children.has(entry.channel as BrowserFrameSession))
      ) {
        this.invalidateFrame(tab, entry);
        entry.channel = channel;
      }
    }
    return entry;
  }
  private invalidateFrame(tab: TabSession, frame: FrameContext): void {
    if (this.activeTabId === tab.info.id) this.invalidateSurface();
    frame.revision++;
    frame.contextId = undefined;
    frame.documentId = undefined;
    frame.source = undefined;
    frame.actorId = undefined;
    for (const [ref, scope] of this.refs)
      if (scope.tabId === tab.info.id && scope.frameId === frame.id) this.refs.delete(ref);
    tab.edits = tab.edits.filter((edit) => edit.frameId !== frame.id);
    if (this.activeTabId === tab.info.id && this.state.selectedElement?.frameId === frame.id)
      this.update({ selectedElement: undefined });
    else if (this.activeTabId === tab.info.id) this.update();
    if (this.activeTabId === tab.info.id) this.refreshUnpaintedSurface(tab);
  }
  private async installChannel(
    tab: TabSession,
    channel: BrowserChannel,
    root = false,
  ): Promise<void> {
    if (tab.channels.has(channel)) return;
    tab.channels.add(channel);
    const contexts = new Map<number, string>();
    const children = new Map<string, BrowserFrameSession>();
    channel.on('Runtime.executionContextCreated', (p) => {
      const c = p.context;
      if (c.name === WORLD && c.auxData?.frameId) {
        contexts.set(c.id, c.auxData.frameId);
        const f = tab.frames.get(c.auxData.frameId);
        if (f?.channel === channel) f.contextId = c.id;
      }
    });
    channel.on('Runtime.executionContextDestroyed', (p) => {
      const frame = tab.frames.get(contexts.get(p.executionContextId) || '');
      if (frame?.channel === channel && frame.contextId === p.executionContextId)
        frame.contextId = undefined;
      contexts.delete(p.executionContextId);
    });
    channel.on('Runtime.executionContextsCleared', () => {
      for (const frame of tab.frames.values())
        if (frame.channel === channel) frame.contextId = undefined;
      contexts.clear();
    });
    channel.on('Runtime.bindingCalled', (p) => {
      if (
        this.disposed ||
        this.tabs.get(tab.info.id) !== tab ||
        p.name !== '__workbenchEvent' ||
        typeof p.payload !== 'string' ||
        p.payload.length > 256_000
      )
        return;
      const frameId =
        contexts.get(p.executionContextId) ||
        [...tab.frames.values()].find(
          (f) => f.channel === channel && f.contextId === p.executionContextId,
        )?.id;
      const frame = frameId && tab.frames.get(frameId);
      if (!frame || frame.channel !== channel) return;
      try {
        const payload = JSON.parse(p.payload);
        if (payload.kind === 'hover-frame') {
          if (
            !this.state.inspecting ||
            this.activeTabId !== tab.info.id ||
            frame.documentId !== payload.docId
          )
            return;
          for (const other of tab.frames.values()) {
            if (other.id === frame.id || !other.contextId) continue;
            void other.channel
              .call('Runtime.evaluate', {
                expression: 'globalThis.__workbenchPage?.leave()',
                contextId: other.contextId,
              })
              .catch(() => {});
          }
          return;
        }
        this.recordEvent(tab, frame, payload);
      } catch {}
    });
    channel.on('Page.frameNavigated', (p) => {
      const frame = this.registerFrame(tab, p.frame, channel);
      this.invalidateFrame(tab, frame);
      if (root && !p.frame.parentId) {
        tab.mainFrameId = frame.id;
        tab.activation++;
        tab.chooser = undefined;
        tab.edits = [];
        this.clearTabRefs(tab);
        if (this.activeTabId === tab.info.id)
          this.update({ selectedElement: undefined, inspecting: false });
        this.updateTab(tab, { url: frame.url });
      }
      this.appendStep({
        kind: 'navigate',
        description: `打开 ${evidenceUrl(frame.url)}`,
        url: evidenceUrl(frame.url),
        source: tab.source,
        actor: this.actors.get(tab.actorId || 'host'),
        tabId: tab.info.id,
        frameId: frame.id,
      });
      if (root && !p.frame.parentId) void this.refreshTab(tab);
      else if (this.activeTabId === tab.info.id && this.state.inspecting)
        void this.prepareFrame(tab, frame).catch(() => {});
    });
    channel.on('Page.frameDetached', (p) => {
      tab.loadingFrames.delete(p.frameId);
      if (p.reason === 'swap') return;
      const frame = tab.frames.get(p.frameId);
      if (frame) {
        this.invalidateFrame(tab, frame);
        tab.frames.delete(frame.id);
      }
    });
    channel.on('Page.navigatedWithinDocument', (p) => {
      const frame = tab.frames.get(p.frameId);
      if (frame) frame.url = p.url;
      if (p.frameId === tab.mainFrameId) {
        this.updateTab(tab, { url: p.url });
        void this.refreshTab(tab);
      }
    });
    channel.on('Page.frameStartedLoading', (p) => {
      tab.loadingFrames.add(p.frameId);
      if (p.frameId === tab.mainFrameId) this.updateTab(tab, { loading: true });
    });
    channel.on('Page.frameStoppedLoading', (p) => {
      tab.loadingFrames.delete(p.frameId);
      if (p.frameId === tab.mainFrameId) {
        this.updateTab(tab, { loading: false });
        void this.refreshTab(tab);
      }
      if (this.activeTabId === tab.info.id) this.refreshUnpaintedSurface(tab);
    });
    channel.on('Runtime.consoleAPICalled', (p) =>
      this.log(
        tab,
        `console.${p.type}`,
        p.args.map((arg: any) => arg.value ?? arg.description ?? '').join(' '),
      ),
    );
    channel.on('Runtime.exceptionThrown', (p) =>
      this.log(
        tab,
        'exception',
        p.exceptionDetails.exception?.description || p.exceptionDetails.text,
      ),
    );
    channel.on('Network.requestWillBeSent', (p) => {
      if (!SETTLE_RESOURCES.has(p.type)) return;
      tab.requests.set(p.requestId, Date.now());
      if (tab.requests.size > 500) tab.requests.delete(tab.requests.keys().next().value!);
    });
    channel.on('Network.loadingFinished', (p) => tab.requests.delete(p.requestId));
    channel.on('Network.responseReceived', (p) => {
      if (root && p.type === 'Document' && p.frameId === tab.mainFrameId)
        tab.documentStatus = p.response.status;
      this.log(tab, 'network', `${p.response.status} ${evidenceUrl(p.response.url)}`);
    });
    channel.on('Network.loadingFailed', (p) => {
      tab.requests.delete(p.requestId);
      this.log(tab, 'network.error', p.errorText);
    });
    channel.on('Page.fileChooserOpened', (p) => {
      if (typeof p.backendNodeId !== 'number') return;
      // The chooser never opens natively; a web task may answer it with approved files.
      tab.chooser = {
        channel,
        backendNodeId: p.backendNodeId,
        multiple: p.mode === 'selectMultiple',
      };
      this.log(tab, 'filechooser', '页面请求选择文件');
    });
    channel.on('Page.javascriptDialogOpening', (p) => {
      if (this.nativeAgentActive && this.agentAllowed) {
        this.pendingDialogs.set(tab.info.id, {
          channel,
          type: String(p.type || 'alert'),
          message: redactBrowserText(p.message, 500),
          ...(p.type === 'prompt'
            ? { defaultPrompt: redactBrowserText(p.defaultPrompt, 500) }
            : {}),
        });
        this.log(tab, 'dialog', '页面弹窗等待网页任务处理');
        return;
      }
      this.log(tab, 'dialog', '页面弹窗已关闭；请在页面控件中完成交互。');
      void channel.call('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    });
    channel.on('Page.javascriptDialogClosed', () => this.pendingDialogs.delete(tab.info.id));
    channel.on('Fetch.requestPaused', (p) => {
      let allowed = p.request.url === 'about:blank';
      try {
        normalizeBrowserUrl(p.request.url);
        if (this.sharedTab === tab.info.id)
          this.sharedNavigation(
            p.request.url,
            tab.actorId || 'host',
            p.frameId === tab.mainFrameId,
          );
        allowed = true;
      } catch {}
      void channel
        .call(
          allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          allowed
            ? { requestId: p.requestId }
            : { requestId: p.requestId, errorReason: 'BlockedByClient' },
        )
        .catch(() => {});
      if (!allowed) this.log(tab, 'navigation.blocked', '阻止了非 HTTP(S) 页面导航');
    });
    channel.on('Target.receivedMessageFromTarget', (p) =>
      children.get(p.sessionId)?.receive(p.message),
    );
    channel.on('Target.detachedFromTarget', (p) => {
      const child = children.get(p.sessionId);
      if (!child) return;
      child.close();
      children.delete(p.sessionId);
      tab.children.delete(child);
      tab.channels.delete(child);
      for (const frame of tab.frames.values())
        if (frame.channel === child) {
          this.invalidateFrame(tab, frame);
          tab.frames.delete(frame.id);
        }
    });
    channel.on('Target.attachedToTarget', (p) => {
      if (p.targetInfo.type !== 'iframe') {
        void channel.call('Target.detachFromTarget', { sessionId: p.sessionId }).catch(() => {});
        return;
      }
      const child = new BrowserFrameSession(channel, p.sessionId);
      children.set(p.sessionId, child);
      tab.children.add(child);
      const setup = this.installChannel(tab, child)
        .catch((error) =>
          this.log(tab, 'frame.error', error instanceof Error ? error.message : error),
        )
        .finally(() => tab.pendingFrames.delete(setup));
      tab.pendingFrames.add(setup);
    });
    await channel.call('Page.enable');
    // The browser is headless: an unanswered native chooser could never be completed.
    await channel.call('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
    await channel.call('DOM.enable');
    const tree = await channel.call('Page.getFrameTree');
    const walk = (node: any, parentId?: string) => {
      this.registerFrame(tab, node.frame, channel, parentId);
      for (const child of node.childFrames || []) walk(child, node.frame.id);
    };
    walk(tree.frameTree);
    if (root) tab.mainFrameId = tree.frameTree.frame.id;
    await channel.call('Runtime.enable');
    await channel.call('Network.enable');
    await channel.call('Runtime.addBinding', {
      name: '__workbenchEvent',
      executionContextName: WORLD,
    });
    await channel.call('Page.addScriptToEvaluateOnNewDocument', {
      source: browserPageSource,
      worldName: WORLD,
    });
    await channel.call('Fetch.enable', {
      patterns: [{ resourceType: 'Document', requestStage: 'Request' }],
    });
    await channel.call('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: false,
      filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
    });
    for (const frame of tab.frames.values())
      if (frame.channel === channel) await this.prepareFrame(tab, frame).catch(() => {});
  }
  private async collectFrames(tab: TabSession): Promise<FrameContext[]> {
    if (tab.pendingFrames.size) await Promise.allSettled([...tab.pendingFrames]);
    const tree = await tab.page.call('Page.getFrameTree');
    const present = new Set<string>();
    const walk = (node: any, parentId?: string) => {
      present.add(node.frame.id);
      this.registerFrame(tab, node.frame, tab.page, parentId);
      for (const child of node.childFrames || []) walk(child, node.frame.id);
    };
    walk(tree.frameTree);
    tab.mainFrameId = tree.frameTree.frame.id;
    // OOPIF children may be reported only by their own target's frame tree.
    return [...tab.frames.values()].filter(
      (frame) => present.has(frame.id) || frame.channel !== tab.page,
    );
  }
  private async prepareFrame(tab: TabSession, frame: FrameContext): Promise<PreparedContext> {
    if (this.disposed || this.tabs.get(tab.info.id) !== tab) throw new Error('页面已关闭');
    for (let attempt = 0; attempt < 3; attempt++) {
      const channel = frame.channel;
      let revision = frame.revision;
      const assertOwner = () => {
        if (tab.frames.get(frame.id) !== frame) throw new Error('元素所在 iframe 已移除');
        if (frame.channel !== channel || frame.revision !== revision)
          throw new Error('Frame context changed during preparation');
      };
      try {
        assertOwner();
        // A world survives many bridge calls; its document identity still needs validation.
        const contextId =
          frame.contextId ??
          ((
            await channel.call('Page.createIsolatedWorld', {
              frameId: frame.id,
              worldName: WORLD,
            })
          ).executionContextId as number);
        assertOwner();
        const ready = await channel.call('Runtime.evaluate', {
          expression:
            '({ready:typeof globalThis.__workbenchPage === "object" && typeof globalThis.__workbenchEvent === "function",documentId:globalThis.__workbenchPage?.docId})',
          contextId,
          returnByValue: true,
        });
        assertOwner();
        if (ready.exceptionDetails) throw new Error(ready.exceptionDetails.text);
        let documentId = ready.result.value?.documentId;
        if (!ready.result.value?.ready) {
          await channel.call('Runtime.addBinding', {
            name: '__workbenchEvent',
            executionContextId: contextId,
          });
          assertOwner();
          const installed = await channel.call('Runtime.evaluate', {
            expression: `${browserPageSource}\nglobalThis.__workbenchPage.docId`,
            contextId,
            returnByValue: true,
          });
          assertOwner();
          if (installed.exceptionDetails)
            throw new Error(
              installed.exceptionDetails.exception?.description || installed.exceptionDetails.text,
            );
          documentId = installed.result.value;
        }
        if (typeof documentId !== 'string' || !documentId) throw new Error('页面框架身份无效');
        const newDocument = frame.documentId !== documentId;
        if (frame.documentId && frame.documentId !== documentId) {
          this.invalidateFrame(tab, frame);
          revision = frame.revision;
        }
        frame.documentId = documentId;
        frame.contextId = contextId;
        if (newDocument) {
          const actor = this.actors.get(tab.actorId || 'host') || this.currentActor();
          await channel.call('Runtime.evaluate', {
            expression: `globalThis.__workbenchPage.setInspect(${this.activeTabId === tab.info.id && this.state.inspecting});globalThis.__workbenchPage.setActor(${JSON.stringify(actor.id)})`,
            contextId,
          });
          frame.actorId = actor.id;
        }
        assertOwner();
        return { contextId, channel, revision };
      } catch (error) {
        if (frame.channel === channel && frame.revision === revision) frame.contextId = undefined;
        const message = error instanceof Error ? error.message : String(error);
        if (
          attempt === 2 ||
          !/Cannot find (?:context|execution context)|Execution context was destroyed|No frame with given id|No frame for given id|Frame context changed during preparation/i.test(
            message,
          )
        )
          throw error;
        await wait(25);
      }
    }
    throw new Error('无法连接页面框架');
  }
  private assertPreparedContext(
    tab: TabSession,
    frame: FrameContext,
    prepared: PreparedContext,
  ): void {
    if (
      tab.frames.get(frame.id) !== frame ||
      frame.channel !== prepared.channel ||
      frame.revision !== prepared.revision ||
      frame.contextId !== prepared.contextId
    )
      throw new Error('页面框架已改变，请重新获取元素。');
  }
  private async bridge<T = any>(
    tab: TabSession,
    frame: FrameContext,
    expression: string,
    guard?: () => void,
  ): Promise<T> {
    const prepared = await this.prepareFrame(tab, frame);
    guard?.();
    this.assertActor();
    this.assertPreparedContext(tab, frame, prepared);
    const result = await prepared.channel.call('Runtime.evaluate', {
      expression,
      contextId: prepared.contextId,
      returnByValue: true,
      awaitPromise: true,
    });
    this.assertPreparedContext(tab, frame, prepared);
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text,
      );
    return result.result.value as T;
  }
  private mainFrame(tab: TabSession): FrameContext {
    const frame = tab.frames.get(tab.mainFrameId);
    if (!frame) throw new Error('页面框架尚未就绪');
    return frame;
  }
  private async refreshTab(tab: TabSession): Promise<void> {
    try {
      const result = await tab.page.call('Runtime.evaluate', {
        expression: '({title:document.title,url:location.href})',
        returnByValue: true,
      });
      const history = await tab.page.call('Page.getNavigationHistory');
      if (result.result.value)
        this.updateTab(tab, {
          title: result.result.value.title,
          url: result.result.value.url,
          canGoBack: history.currentIndex > 0,
          canGoForward: history.currentIndex < history.entries.length - 1,
        });
    } catch {}
  }
  private async startScreencast(tab: TabSession): Promise<void> {
    await tab.page.call('Page.startScreencast', {
      format: 'jpeg',
      quality: 88,
      maxWidth: this.captureSize.width,
      maxHeight: this.captureSize.height,
      everyNthFrame: 1,
      maxFramesInFlight: 3,
      sendLastFrame: true,
    });
  }
  private clearTabRefs(tab: TabSession): void {
    for (const [ref, scope] of this.refs) if (scope.tabId === tab.info.id) this.refs.delete(ref);
  }
  private async clearOutline(tab: TabSession): Promise<void> {
    for (const frame of tab.frames.values())
      await this.bridge(tab, frame, 'globalThis.__workbenchPage.clearOverlays()').catch(() => {});
  }
  private async activateTab(
    tab: TabSession,
    source: 'human' | 'agent',
    record = true,
  ): Promise<void> {
    if (this.sharedTab && this.sharedTab !== tab.info.id)
      throw new Error('请先停止共享再切换标签页');
    if (this.activeTabId === tab.info.id) return;
    this.invalidateSurface();
    const previous = this.tabs.get(this.activeTabId);
    this.releaseFrames();
    if (previous) {
      await previous.page.call('Page.stopScreencast').catch(() => {});
      await previous.page
        .call('Emulation.setFocusEmulationEnabled', { enabled: false })
        .catch(() => {});
      await this.clearOutline(previous);
      previous.activation++;
      this.clearTabRefs(previous);
    }
    this.activeTabId = tab.info.id;
    tab.activation++;
    tab.source = source;
    this.clearTabRefs(tab);
    this.suppressMouseUp = false;
    this.update({ selectedElement: undefined, inspecting: false });
    this.options.onFrame({ data: '', width: this.width, height: this.height, tabId: tab.info.id });
    await tab.page.call('Emulation.setDeviceMetricsOverride', {
      width: this.width,
      height: this.height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await tab.page.call('Page.bringToFront');
    // A web task can leave another tab in front; the embedded active page must keep rendering.
    await tab.page.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.startScreencast(tab);
    await this.refreshTab(tab);
    if (record)
      this.appendStep({
        kind: 'navigate',
        description: `切换页面：${tab.info.title || evidenceUrl(tab.info.url)}`,
        url: evidenceUrl(tab.info.url),
        source,
        tabId: tab.info.id,
        frameId: tab.mainFrameId,
      });
  }
  allowAgentControl(): void {
    if (this.sharedTab) throw new Error('共享期间由参与者操作页面，请先停止共享再启动 Agent');
    this.agentAllowed = true;
    this.agentNeedsObservation = false;
  }
  async setNativeAgentActive(value: boolean): Promise<void> {
    this.nativeAgentActive = value;
    if (!value) {
      const dialogs = [...this.pendingDialogs.values()];
      this.pendingDialogs.clear();
      for (const tab of this.tabs.values()) tab.chooser = undefined;
      await Promise.allSettled(
        dialogs.map((dialog) =>
          dialog.channel.call('Page.handleJavaScriptDialog', { accept: false }),
        ),
      );
    }
  }
  getNativeConnection(): { endpoint: string; binaryPath: string } {
    if (this.state.status !== 'ready' || !this.endpoint || !this.state.binaryPath)
      throw new Error('浏览器尚未连接');
    return { endpoint: this.endpoint, binaryPath: this.state.binaryPath };
  }
  getDownloadDirectory(): string {
    return resolve(this.options.storageDir, 'downloads');
  }
  /** The web task owns the action; Athena owns the visible tab and user-control lease. */
  performNative<T>(
    targetId: string | undefined,
    operation: () => Promise<T>,
    readonly = false,
  ): Promise<T> {
    const generation = this.leaseGeneration;
    return this.serialize(async () => {
      const guard = () => {
        if (!readonly && (!this.agentAllowed || generation !== this.leaseGeneration))
          throw new Error('用户已接管浏览器，操作已停止');
      };
      guard();
      if (!targetId && !readonly) await this.setSource(this.activeTab(), 'agent');
      if (targetId) {
        if (this.attaching.has(targetId)) await this.attaching.get(targetId);
        const tab = this.tabs.get(targetId);
        if (!tab) throw new Error('目标页已关闭，请重新获取页面');
        if (!readonly) await this.activateTab(tab, 'agent');
        if (!readonly) await this.setSource(tab, 'agent');
      }
      guard();
      try {
        const result = await operation();
        guard();
        return result;
      } finally {
        // The web executor brings the page it works on to the front inside the browser.
        if (targetId !== this.activeTabId)
          await this.tabs
            .get(this.activeTabId)
            ?.page.call('Page.bringToFront')
            .catch(() => {});
      }
    });
  }
  followNativeTarget(targetId: string): Promise<void> {
    return this.performNative(targetId, async () => {});
  }
  // The helpers below serve native web tools. They run inside performNative, which holds the queue.
  private nativeTab(targetId: string): TabSession {
    const tab = this.tabs.get(targetId);
    if (!tab) throw new Error('目标页已关闭，请重新获取页面');
    return tab;
  }
  nativeTabs(): Array<{ targetId: string; title: string; url: string; active: boolean }> {
    return [...this.tabs.values()].map((tab) => ({
      targetId: tab.info.id,
      title: tab.info.title,
      url: tab.info.url,
      active: tab.info.id === this.activeTabId,
    }));
  }
  async nativeNewTab(): Promise<string> {
    return (await this.createTab('about:blank', 'agent')).id;
  }
  nativeCloseTab(targetId: string): Promise<void> {
    return this.closeTabInternal(targetId, 'agent');
  }
  /** Shows the page a multi-page script is about to change. */
  async nativeActivate(targetId: string): Promise<void> {
    const tab = this.nativeTab(targetId);
    await this.activateTab(tab, 'agent');
    await this.setSource(tab, 'agent');
  }
  private tabBusy(tab: TabSession): boolean {
    if (tab.loadingFrames.size) return true;
    // Streams and long polls never finish; only fresh requests hold a settle.
    const recent = Date.now() - 2000;
    for (const started of tab.requests.values()) if (started > recent) return true;
    return false;
  }
  private framesQuiet(
    tab: TabSession,
    idle: number,
    timeout: number,
  ): Promise<'quiet' | 'noisy' | 'retry'> {
    const check = (async () => {
      const results = await Promise.all(
        (await this.collectFrames(tab)).map((frame) =>
          this.bridge<boolean>(
            tab,
            frame,
            `globalThis.__workbenchPage.quiet(${idle},${timeout})`,
          ).catch(() => undefined),
        ),
      );
      if (results.includes(undefined)) return 'retry' as const;
      return results.every(Boolean) ? ('quiet' as const) : ('noisy' as const);
    })().catch(() => 'retry' as const);
    // A renderer blocked by a dialog never answers.
    return Promise.race([check, wait(timeout + 300).then(() => 'retry' as const)]);
  }
  /**
   * Shows what a page script of the agent changes in view as cursor choreography: 'watch' keeps
   * the view as it looks before the script runs, 'replay' uncovers what changed once it has
   * returned and resolves when that show is over, so the next capture does not cut it short.
   * A replay without a show only uncovers the page. Page scripts run in the main frame.
   */
  async nativeScriptEdits(targetId: string, phase: 'watch' | 'replay', show = true): Promise<void> {
    const tab = this.tabs.get(targetId);
    // A page that was covered is uncovered whoever has it by now.
    if (!tab || this.pendingDialogs.has(targetId)) return;
    if (phase === 'watch' && tab.source !== 'agent') return;
    const call = (async () => {
      const frame = (await this.collectFrames(tab)).find((item) => item.id === tab.mainFrameId);
      if (frame)
        await this.bridge(tab, frame, `globalThis.__workbenchPage.${phase}Script(${show})`);
    })().catch(() => undefined);
    // A renderer blocked by a dialog never answers.
    await Promise.race([call, wait(phase === 'replay' && show ? 16000 : 500)]);
  }
  /**
   * A compact outline of what the page shows, for the agent's context at the start of a turn.
   * Undefined when the page does not answer in time; the turn then starts without it.
   */
  async nativeOutline(targetId: string, limit = 6000): Promise<string | undefined> {
    const tab = this.tabs.get(targetId);
    if (!tab || this.pendingDialogs.has(targetId)) return undefined;
    const call = (async () => {
      const frame = (await this.collectFrames(tab)).find((item) => item.id === tab.mainFrameId);
      if (!frame || !/^https?:/.test(frame.url || tab.info.url)) return undefined;
      const text = await this.bridge<string>(
        tab,
        frame,
        `globalThis.__workbenchPage.digest(${limit})`,
      );
      return typeof text === 'string' && text ? redactBrowserText(text, limit + 200) : undefined;
    })().catch(() => undefined);
    // A renderer blocked by a dialog never answers.
    return Promise.race([call, wait(800).then(() => undefined)]);
  }
  /** Waits until loading, fresh requests and DOM changes stop. Resolves false when the page stays busy. */
  async nativeSettle(targetId: string, timeout = 3000): Promise<boolean> {
    const deadline = Date.now() + timeout;
    // The action's first request or navigation needs a moment to start.
    await wait(30);
    while (Date.now() < deadline) {
      const tab = this.tabs.get(targetId);
      if (!tab || this.pendingDialogs.has(targetId)) return true;
      if (this.tabBusy(tab)) {
        await wait(25);
        continue;
      }
      const state = await this.framesQuiet(
        tab,
        80,
        Math.max(100, Math.min(600, deadline - Date.now())),
      );
      if (this.pendingDialogs.has(targetId)) return true;
      if (state === 'retry') {
        await wait(25);
        continue;
      }
      if (this.tabBusy(tab)) continue;
      // A page that animates its DOM forever is as settled as it will get.
      return state === 'quiet';
    }
    return false;
  }
  async nativeNavigate(
    targetId: string,
    action: 'url' | 'back' | 'forward' | 'reload',
    url?: string,
  ): Promise<{ moved: boolean; download?: boolean; status?: number; settled?: boolean }> {
    const tab = this.nativeTab(targetId);
    const activation = tab.activation;
    const mark = this.downloadSequence;
    tab.documentStatus = undefined;
    if (action === 'url') {
      const result = await tab.page.call(
        'Page.navigate',
        { url: normalizeBrowserUrl(url ?? '') },
        30_000,
      );
      if (result.isDownload || (result.errorText && this.downloadSequence > mark))
        return { moved: false, download: true };
      if (result.errorText) throw new Error(`页面无法打开：${result.errorText}`);
    } else if (action === 'reload') await tab.page.call('Page.reload');
    else {
      const history = await tab.page.call('Page.getNavigationHistory');
      const entry = history.entries[history.currentIndex + (action === 'back' ? -1 : 1)];
      if (!entry) return { moved: false };
      await tab.page.call('Page.navigateToHistoryEntry', { entryId: entry.id });
    }
    // History moves and reloads return before the new document commits.
    const committed = Date.now() + 1500;
    while (
      action !== 'url' &&
      tab.activation === activation &&
      !tab.loadingFrames.size &&
      Date.now() < committed
    )
      await wait(20);
    const settled = await this.nativeSettle(targetId, 15_000);
    await this.refreshTab(tab);
    return { moved: true, status: tab.documentStatus, settled };
  }
  async nativeRead(
    targetId: string,
    options: {
      format?: 'markdown' | 'text' | 'links';
      selector?: string;
      viewportOnly?: boolean;
      includeLinks?: boolean;
      includeImages?: boolean;
    },
  ): Promise<{ text: string; truncated: boolean }> {
    const tab = this.nativeTab(targetId);
    const frames = await this.collectFrames(tab);
    const parts: string[] = [];
    let matched = false;
    let truncated = false;
    for (const frame of [
      ...frames.filter((frame) => frame.id === tab.mainFrameId),
      ...frames.filter((frame) => frame.id !== tab.mainFrameId),
    ]) {
      let result: { matched: boolean; text: string; truncated: boolean };
      try {
        result = await this.bridge(
          tab,
          frame,
          `globalThis.__workbenchPage.read(${JSON.stringify(options)})`,
        );
      } catch (error) {
        if (frame.id === tab.mainFrameId) throw error;
        continue;
      }
      if (!result.matched) continue;
      matched = true;
      truncated ||= result.truncated;
      if (result.text)
        parts.push(
          frame.id === tab.mainFrameId
            ? result.text
            : `[iframe ${evidenceUrl(frame.url)}]\n${result.text}`,
        );
    }
    if (options.selector && !matched) throw new Error('没有元素匹配该选择器');
    return { text: parts.join('\n\n'), truncated };
  }
  nativeConsole(targetId: string): string[] {
    return this.nativeTab(targetId)
      .diagnostics.filter(
        (entry) => entry.kind.startsWith('console.') || entry.kind === 'exception',
      )
      .map((entry) => `[${entry.kind.replace(/^console\./, '')}] ${entry.text}`);
  }
  nativePage(targetId: string): { title: string; url: string; width: number; height: number } {
    const tab = this.nativeTab(targetId);
    return { title: tab.info.title, url: tab.info.url, width: this.width, height: this.height };
  }
  /** Captures with sensitive fields covered. Output pixels are CSS pixels unless `scale` is device. */
  async nativeScreenshot(
    targetId: string,
    options: {
      format?: 'jpeg' | 'png' | 'webp';
      quality?: number;
      fullPage?: boolean;
      scale?: 'css' | 'device';
      size?: { width?: number; height?: number };
    } = {},
  ): Promise<{ data: string; mimeType: string; width: number; height: number }> {
    const tab = this.nativeTab(targetId);
    const format = options.format ?? 'jpeg';
    if (tab.info.id !== this.activeTabId)
      // A background page may still carry the viewport it was created with.
      await tab.page.call('Emulation.setDeviceMetricsOverride', {
        width: this.width,
        height: this.height,
        deviceScaleFactor: 2,
        mobile: false,
      });
    const metrics = await tab.page.call('Page.getLayoutMetrics');
    const view = metrics.cssVisualViewport;
    const area = options.fullPage
      ? {
          x: 0,
          y: 0,
          width: Math.ceil(metrics.cssContentSize.width),
          // Chrome cannot rasterize arbitrarily tall surfaces.
          height: Math.min(8192, Math.ceil(metrics.cssContentSize.height)),
        }
      : { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight };
    let factor = options.scale === 'device' ? 2 : 1;
    if (options.size)
      factor = Math.min(
        2,
        (options.size.width ?? Infinity) / area.width,
        (options.size.height ?? Infinity) / area.height,
      );
    const result = await this.withMask(tab, false, () =>
      tab.page.call(
        'Page.captureScreenshot',
        {
          format,
          ...(format === 'png' ? {} : { quality: options.quality ?? 80 }),
          captureBeyondViewport: Boolean(options.fullPage),
          clip: { ...area, scale: factor / 2 },
        },
        30_000,
      ),
    );
    return {
      data: result.data,
      mimeType: `image/${format}`,
      width: Math.round(area.width * factor),
      height: Math.round(area.height * factor),
    };
  }
  /** Runs a capture made by the web task while sensitive fields are covered. */
  nativeMasked<T>(targetId: string, capture: () => Promise<T>): Promise<T> {
    return this.withMask(this.nativeTab(targetId), false, capture);
  }
  private saveFile(
    name: string,
    data: Buffer,
  ): Promise<{ path: string; name: string; size: number }> {
    const directory = this.getDownloadDirectory();
    const saved = this.downloadRenames.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = await uniqueDownloadPath(directory, name);
      await writeFile(target, data, { mode: 0o600, flag: 'wx' });
      return { path: target, name: basename(target), size: data.byteLength };
    });
    this.downloadRenames = saved.then(
      () => {},
      () => {},
    );
    return saved;
  }
  async nativePdf(
    targetId: string,
    options: { landscape?: boolean; printBackground?: boolean; preferCSSPageSize?: boolean } = {},
  ): Promise<{ path: string; name: string; size: number }> {
    const tab = this.nativeTab(targetId);
    const result = await tab.page.call(
      'Page.printToPDF',
      {
        landscape: Boolean(options.landscape),
        printBackground: Boolean(options.printBackground),
        preferCSSPageSize: Boolean(options.preferCSSPageSize),
      },
      60_000,
    );
    return this.saveFile(`${tab.info.title || 'page'}.pdf`, Buffer.from(result.data, 'base64'));
  }
  /** Evaluates in the page's own world. A dialog opened by the script ends the wait, not the script. */
  async nativeEvaluate(
    targetId: string,
    expression: string,
    timeout = 30_000,
  ): Promise<{ value?: unknown; error?: string; dialog?: boolean }> {
    const tab = this.nativeTab(targetId);
    let done = false;
    const evaluation = tab.page
      .call(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, userGesture: true },
        timeout + 2000,
      )
      .then(
        (result) =>
          result.exceptionDetails
            ? {
                error: redactBrowserText(
                  result.exceptionDetails.exception?.description || result.exceptionDetails.text,
                ),
              }
            : { value: result.result.value as unknown },
        (error) => ({ error: redactBrowserText(error instanceof Error ? error.message : error) }),
      )
      .finally(() => {
        done = true;
      });
    const watch = (async () => {
      const deadline = Date.now() + timeout;
      while (!done && Date.now() < deadline) {
        if (this.pendingDialogs.has(targetId)) return { dialog: true };
        await wait(25);
      }
      if (done) return evaluation;
      await tab.page.call('Runtime.terminateExecution').catch(() => {});
      return { error: `脚本在 ${timeout} ms 内没有完成` };
    })();
    return Promise.race([evaluation, watch]);
  }
  nativeDialog(
    targetId: string,
  ): { type: string; message: string; defaultPrompt?: string } | undefined {
    const dialog = this.pendingDialogs.get(targetId);
    return dialog
      ? {
          type: dialog.type,
          message: dialog.message,
          ...(dialog.defaultPrompt !== undefined ? { defaultPrompt: dialog.defaultPrompt } : {}),
        }
      : undefined;
  }
  async nativeDialogRespond(targetId: string, accept: boolean, promptText?: string): Promise<void> {
    const dialog = this.pendingDialogs.get(targetId);
    if (!dialog) throw new Error('页面当前没有等待处理的弹窗');
    await dialog.channel.call('Page.handleJavaScriptDialog', {
      accept,
      ...(accept && promptText !== undefined ? { promptText } : {}),
    });
    this.pendingDialogs.delete(targetId);
  }
  nativeChooser(targetId: string): { multiple: boolean } | undefined {
    const chooser = this.tabs.get(targetId)?.chooser;
    return chooser ? { multiple: chooser.multiple } : undefined;
  }
  /** Answers the file chooser the page opened; an empty list clears the input. */
  async nativeChooserFiles(targetId: string, files: string[]): Promise<void> {
    const tab = this.nativeTab(targetId);
    const chooser = tab.chooser;
    if (!chooser) throw new Error('页面当前没有等待中的文件选择');
    if (files.length > 1 && !chooser.multiple) throw new Error('该文件选择只接受一个文件');
    if (files.length)
      await chooser.channel.call('DOM.setFileInputFiles', {
        files,
        backendNodeId: chooser.backendNodeId,
      });
    else {
      const node = await chooser.channel.call('DOM.resolveNode', {
        backendNodeId: chooser.backendNodeId,
      });
      await chooser.channel.call('Runtime.callFunctionOn', {
        objectId: node.object.objectId,
        functionDeclaration:
          "function(){this.value='';this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));}",
      });
    }
    tab.chooser = undefined;
  }
  nativeDownloadMark(): number {
    return this.downloadSequence;
  }
  /** Resolves with the first download that started after `mark` once it is on disk. */
  async nativeAwaitDownload(
    mark: number,
    timeout = 60_000,
  ): Promise<{ path: string; name: string; size: number }> {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const entries = [...this.downloads.values()].filter((entry) => entry.sequence > mark);
      const done = entries.find((entry) => entry.state === 'completed' && entry.path);
      if (done) return { path: done.path!, name: basename(done.path!), size: done.size ?? 0 };
      if (entries.length && entries.every((entry) => entry.state === 'canceled'))
        throw new Error('下载已取消或失败');
      if (!entries.length && Date.now() - started > 10_000) throw new Error('点击后没有开始下载');
      await wait(50);
    }
    throw new Error('下载在 60 秒内没有完成');
  }
  revokeAgentControl(): void {
    this.leaseGeneration++;
    this.agentAllowed = false;
    this.agentNeedsObservation = false;
    const feedback = this.workingFeedback;
    this.workingFeedback = undefined;
    if (feedback) void this.serialize(() => this.clearWorkingFeedback(feedback)).catch(() => {});
  }
  private humanTakeover(source: string): void {
    this.revokeAgentControl();
    this.agentNeedsObservation = true;
    this.log(this.tabs.get(this.activeTabId), 'control', `Human takeover: ${source}`);
    this.options.onHumanTakeover();
  }
  newTab(url?: string): Promise<BrowserTab> {
    if (this.sharedTab) return Promise.reject(new Error('请先停止共享再新建标签页'));
    const initial = url === undefined ? 'about:blank' : normalizeBrowserUrl(url);
    this.humanTakeover('new-tab');
    return this.serialize(() => this.createTab(initial, 'human'));
  }
  private async createTab(
    url: string,
    source: 'human' | 'agent',
    guard?: () => void,
  ): Promise<BrowserTab> {
    if (!this.browser || this.state.status !== 'ready') throw new Error('浏览器尚未就绪');
    guard?.();
    const result = await this.browser.call('Target.createTarget', {
      url: 'about:blank',
      newWindow: false,
    });
    const tab = await this.attachTab({
      targetId: result.targetId,
      type: 'page',
      url: 'about:blank',
      title: '新标签页',
    });
    guard?.();
    await this.activateTab(tab, source);
    if (url !== 'about:blank') await this.navigateInternal(tab, url, source);
    return { ...tab.info };
  }
  switchTab(id: string): Promise<void> {
    if (!this.tabs.has(id)) return Promise.reject(new Error('标签页不存在'));
    this.humanTakeover('switch-tab');
    return this.serialize(async () => {
      const tab = this.attaching.has(id) ? await this.attaching.get(id) : this.tabs.get(id);
      if (!tab) throw new Error('标签页已关闭');
      if (id === this.activeTabId) return;
      await this.activateTab(tab, 'human');
    });
  }
  closeTab(id: string): Promise<void> {
    if (this.sharedTab) return Promise.reject(new Error('请先停止共享再关闭标签页'));
    if (!this.tabs.has(id)) return Promise.reject(new Error('标签页不存在'));
    this.humanTakeover('close-tab');
    return this.serialize(() => this.closeTabInternal(id, 'human'));
  }
  private async closeTabInternal(id: string, source: 'human' | 'agent'): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error('标签页已关闭');
    if (this.tabs.size === 1) await this.createTab('about:blank', source);
    else if (this.activeTabId === id)
      await this.activateTab(
        [...this.tabs.values()].find((other) => other !== tab)!,
        source,
      );
    this.tabs.delete(id);
    this.clearTabRefs(tab);
    for (const child of tab.children) child.close();
    tab.page.close();
    await this.browser!.call('Target.closeTarget', { targetId: id });
    this.update();
  }
  private async removeTarget(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const wasActive = this.activeTabId === id;
    this.tabs.delete(id);
    this.clearTabRefs(tab);
    for (const child of tab.children) child.close();
    tab.page.close();
    if (this.disposed) return;
    if (wasActive) {
      this.activeTabId = '';
      this.update({ selectedElement: undefined, inspecting: false });
      void this.serialize(async () => {
        const next = this.tabs.values().next().value as TabSession | undefined;
        if (next) await this.activateTab(next, 'agent');
        else if (this.state.status === 'ready') await this.createTab('about:blank', 'agent');
      }).catch((error) => this.update({ error: redactBrowserText(error) }));
    }
    this.update();
  }

  private requireActive(id: string): TabSession {
    const tab = this.activeTab();
    if (tab.info.id !== id) throw new Error('活动标签页已改变，请重新获取当前页面。');
    return tab;
  }
  private async setSource(
    tab: TabSession,
    source: 'human' | 'agent',
    only?: FrameContext,
  ): Promise<void> {
    tab.source = source;
    const actorId = source === 'agent' ? 'agent' : this.currentActor().id;
    tab.actorId = actorId;
    // A page blocked by a dialog answers nothing; its frames are marked by the next action.
    if (this.pendingDialogs.has(tab.info.id)) return;
    for (const frame of only ? [only] : await this.collectFrames(tab)) {
      if (frame.source === source && frame.actorId === actorId) continue;
      await this.bridge(
        tab,
        frame,
        `globalThis.__workbenchPage.setSource(${JSON.stringify(source)});globalThis.__workbenchPage.setActor(${JSON.stringify(actorId)})`,
      );
      frame.source = source;
      frame.actorId = actorId;
    }
  }
  navigate(url: string): Promise<void> {
    const target = normalizeBrowserUrl(url);
    const tab = this.activeTab();
    this.humanTakeover('navigate');
    return this.serialize(() =>
      this.navigateInternal(this.requireActive(tab.info.id), target, 'human'),
    );
  }
  private async navigateInternal(
    tab: TabSession,
    url: string,
    source: 'human' | 'agent',
  ): Promise<void> {
    this.assertActor();
    this.sharedNavigation(url, this.currentActor().id);
    tab.source = source;
    tab.actorId = source === 'agent' ? 'agent' : this.currentActor().id;
    tab.activation++;
    this.invalidateSurface();
    this.clearTabRefs(tab);
    tab.edits = [];
    if (this.activeTabId === tab.info.id)
      this.update({ inspecting: false, selectedElement: undefined });
    this.updateTab(tab, { loading: true });
    const result = await tab.page.call('Page.navigate', { url: normalizeBrowserUrl(url) });
    if (result.errorText) {
      this.updateTab(tab, { loading: false });
      throw new Error(result.errorText);
    }
  }
  back(): Promise<void> {
    return this.historyMove(-1);
  }
  forward(): Promise<void> {
    return this.historyMove(1);
  }
  private historyMove(direction: number): Promise<void> {
    const id = this.activeTab().info.id;
    this.humanTakeover(direction < 0 ? 'back' : 'forward');
    return this.serialize(async () => {
      const tab = this.requireActive(id);
      tab.source = 'human';
      tab.actorId = this.currentActor().id;
      const h = await tab.page.call('Page.getNavigationHistory');
      const entry = h.entries[h.currentIndex + direction];
      if (entry) {
        this.sharedNavigation(entry.url, this.currentActor().id);
        this.assertActor();
        tab.activation++;
        this.clearTabRefs(tab);
        await tab.page.call('Page.navigateToHistoryEntry', { entryId: entry.id });
      }
    });
  }
  reload(): Promise<void> {
    const id = this.activeTab().info.id;
    this.humanTakeover('reload');
    return this.serialize(async () => {
      const tab = this.requireActive(id);
      tab.activation++;
      tab.source = 'human';
      tab.actorId = this.currentActor().id;
      this.clearTabRefs(tab);
      await tab.page.call('Page.reload');
    });
  }
  resize(
    width: number,
    height: number,
    options: { fitToWidth?: boolean; tabId?: string; pixelRatio?: number } = {},
  ): Promise<BrowserViewport> {
    if (!Number.isFinite(width) || !Number.isFinite(height))
      return Promise.reject(new Error('Invalid browser viewport'));
    if (
      (options.fitToWidth !== undefined && typeof options.fitToWidth !== 'boolean') ||
      (options.tabId !== undefined && typeof options.tabId !== 'string') ||
      (options.pixelRatio !== undefined &&
        (!Number.isFinite(options.pixelRatio) || options.pixelRatio <= 0))
    )
      return Promise.reject(new Error('Invalid browser viewport options'));
    const w = Math.round(Math.min(1920, Math.max(320, width))),
      h = Math.round(Math.min(8192, Math.max(100, height)));
    // Capture for the host panel, not the wider CSS viewport produced by fit-to-width.
    const pixelRatio = options.pixelRatio ?? 2;
    const captureSize = {
      width: Math.max(1, Math.min(PREVIEW_MAX_EDGE, Math.ceil(width * pixelRatio))),
      height: Math.max(1, Math.min(PREVIEW_MAX_EDGE, Math.ceil(height * pixelRatio))),
    };
    const id = this.activeTabId || undefined;
    if (options.tabId !== undefined && options.tabId !== id)
      return Promise.reject(new Error('忽略了来自旧标签页的页面尺寸。'));
    if (this.state.status !== 'ready') {
      this.width = w;
      this.height = h;
      this.captureSize = captureSize;
      return Promise.resolve({ width: w, height: h, tabId: id, limited: false });
    }
    return this.serialize(async () => {
      const tab = this.requireActive(id!);
      const captureChanged =
        captureSize.width !== this.captureSize.width ||
        captureSize.height !== this.captureSize.height;
      if (!options.fitToWidth) this.fittedViewport = undefined;
      if (!captureChanged && !options.fitToWidth && w === this.width && h === this.height)
        return { width: w, height: h, tabId: id, limited: false };
      if (!captureChanged && options.fitToWidth && w === this.width && h === this.height) {
        // URL-only changes still recheck overflow, but a responsive page with
        // unchanged geometry needs neither a new epoch nor a capture restart.
        const metrics = await tab.page.call('Page.getLayoutMetrics');
        const contentWidth = metrics.cssContentSize?.width;
        const layoutWidth = metrics.cssLayoutViewport?.clientWidth;
        if (
          Number.isFinite(contentWidth) &&
          Number.isFinite(layoutWidth) &&
          contentWidth <= layoutWidth + 1
        ) {
          this.fittedViewport = {
            tabId: id!,
            activation: tab.activation,
            url: tab.info.url,
            paneWidth: w,
            width: w,
          };
          return { width: w, height: h, tabId: id, limited: false };
        }
      }
      const previous = { width: this.width, height: this.height };
      const setViewport = (viewWidth: number, viewHeight: number) =>
        tab.page.call('Emulation.setDeviceMetricsOverride', {
          width: viewWidth,
          height: viewHeight,
          deviceScaleFactor: 2,
          mobile: false,
        });
      this.resizingViewport = true;
      this.invalidateSurface();
      this.releaseFrames();
      try {
        await tab.page.call('Page.stopScreencast');
        const maxWidth = Math.max(w, Math.min(1920, Math.floor((8192 * w) / h)));
        const fitted = this.fittedViewport;
        const reuseWidth =
          options.fitToWidth &&
          fitted &&
          fitted?.tabId === id &&
          fitted.activation === tab.activation &&
          fitted.url === tab.info.url &&
          fitted.paneWidth === w;
        let viewWidth = reuseWidth ? Math.min(maxWidth, fitted.width) : w,
          viewHeight = Math.round((h * viewWidth) / w);
        await setViewport(viewWidth, viewHeight);
        if (options.fitToWidth) {
          // Height-only changes must not briefly switch responsive pages to a different layout.
          for (let attempt = 0; attempt < 2; attempt++) {
            const metrics = await tab.page.call('Page.getLayoutMetrics');
            const contentWidth = metrics.cssContentSize?.width;
            const layoutWidth = metrics.cssLayoutViewport?.clientWidth;
            if (!Number.isFinite(contentWidth) || !Number.isFinite(layoutWidth))
              throw new Error('无法读取页面布局尺寸');
            if (contentWidth <= layoutWidth + 1) break;
            const gutter = Math.max(0, viewWidth - layoutWidth);
            const nextWidth = Math.min(
              maxWidth,
              Math.max(viewWidth, Math.ceil(contentWidth + gutter)),
            );
            if (nextWidth === viewWidth) break;
            viewWidth = nextWidth;
            viewHeight = Math.round((h * viewWidth) / w);
            await setViewport(viewWidth, viewHeight);
          }
        }
        const metrics = options.fitToWidth
          ? await tab.page.call('Page.getLayoutMetrics')
          : undefined;
        if (
          metrics &&
          (!Number.isFinite(metrics.cssContentSize?.width) ||
            !Number.isFinite(metrics.cssLayoutViewport?.clientWidth))
        )
          throw new Error('无法读取页面布局尺寸');
        this.width = viewWidth;
        this.height = viewHeight;
        this.captureSize = captureSize;
        this.update();
        if (options.fitToWidth)
          this.fittedViewport = {
            tabId: id!,
            activation: tab.activation,
            url: tab.info.url,
            paneWidth: w,
            width: viewWidth,
          };
        return {
          width: viewWidth,
          height: viewHeight,
          tabId: id,
          limited: Boolean(
            metrics && metrics.cssContentSize.width > metrics.cssLayoutViewport.clientWidth + 1,
          ),
        };
      } catch (error) {
        await setViewport(previous.width, previous.height).catch(() => {});
        throw error;
      } finally {
        this.resizingViewport = false;
        await this.startScreencast(tab);
        // Static pages may only emit a transitional frame when capture restarts.
        // Keep a single fallback pending until an authoritative frame is published.
        this.refreshUnpaintedSurface(tab);
      }
    });
  }

  private async geometry(tab: TabSession, frame: FrameContext): Promise<FrameGeometry> {
    if (frame.id === tab.mainFrameId) return { x: 0, y: 0, scaleX: 1, scaleY: 1 };
    const parent = frame.parentId && tab.frames.get(frame.parentId);
    if (!parent) throw new Error('无法定位此 iframe 的父页面');
    const base = await this.geometry(tab, parent);
    const prepared = await this.prepareFrame(tab, parent);
    this.assertPreparedContext(tab, parent, prepared);
    const owner = await prepared.channel.call('DOM.getFrameOwner', { frameId: frame.id });
    this.assertPreparedContext(tab, parent, prepared);
    const node = await prepared.channel.call('DOM.resolveNode', {
      backendNodeId: owner.backendNodeId,
      executionContextId: prepared.contextId,
    });
    if (!node.object.objectId) throw new Error('无法定位 iframe 元素');
    try {
      this.assertPreparedContext(tab, parent, prepared);
      const result = await prepared.channel.call('Runtime.callFunctionOn', {
        objectId: node.object.objectId,
        functionDeclaration:
          'function(){const r=this.getBoundingClientRect();const t=getComputedStyle(this).transform;if(t!=="none"){const m=new DOMMatrix(t);if(!m.is2D||Math.abs(m.b)>0.0001||Math.abs(m.c)>0.0001)throw new Error("Rotated or 3D iframe coordinates are not supported");}const sx=r.width/this.offsetWidth,sy=r.height/this.offsetHeight;return{x:r.x+this.clientLeft*sx,y:r.y+this.clientTop*sy,scaleX:sx,scaleY:sy};}',
        returnByValue: true,
      });
      this.assertPreparedContext(tab, parent, prepared);
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description || result.exceptionDetails.text,
        );
      const box = result.result.value;
      if (!box || !Number.isFinite(box.scaleX) || !box.scaleX || !box.scaleY)
        throw new Error('iframe 当前不可见');
      return {
        x: base.x + box.x * base.scaleX,
        y: base.y + box.y * base.scaleY,
        scaleX: base.scaleX * box.scaleX,
        scaleY: base.scaleY * box.scaleY,
      };
    } finally {
      await prepared.channel
        .call('Runtime.releaseObject', { objectId: node.object.objectId })
        .catch(() => {});
    }
  }
  private async revealFrame(
    tab: TabSession,
    frame: FrameContext,
    guard?: () => void,
  ): Promise<void> {
    if (frame.id === tab.mainFrameId) return;
    const parent = frame.parentId && tab.frames.get(frame.parentId);
    if (!parent) throw new Error('无法定位此 iframe 的父页面');
    await this.revealFrame(tab, parent, guard);
    const owner = await parent.channel.call('DOM.getFrameOwner', { frameId: frame.id });
    guard?.();
    await parent.channel.call('DOM.scrollIntoViewIfNeeded', { backendNodeId: owner.backendNodeId });
  }
  private async inputPoint(
    tab: TabSession,
    frame: FrameContext,
    localRef: string,
    guard: () => void,
  ): Promise<{ x: number; y: number }> {
    await this.revealFrame(tab, frame, guard);
    const box = await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.bounds(${JSON.stringify(localRef)})`,
      guard,
    );
    if (box.disabled) throw new Error('Element is disabled');
    const offset = await this.geometry(tab, frame);
    const point = { x: offset.x + box.x * offset.scaleX, y: offset.y + box.y * offset.scaleY };
    const hit = await this.hitFrame(tab, point.x, point.y);
    if (frame.id !== tab.mainFrameId && hit.id !== frame.id)
      throw new Error('此 iframe 元素被父页面的其它元素遮挡');
    guard();
    return point;
  }
  private async hitFrame(tab: TabSession, x: number, y: number): Promise<FrameContext> {
    let frame = this.mainFrame(tab);
    for (let depth = 0; depth < 10; depth++) {
      const offset = await this.geometry(tab, frame);
      const local = { x: (x - offset.x) / offset.scaleX, y: (y - offset.y) / offset.scaleY };
      const prepared = await this.prepareFrame(tab, frame);
      this.assertPreparedContext(tab, frame, prepared);
      const hit = await prepared.channel.call('Runtime.evaluate', {
        expression: `(()=>{let el=document.elementFromPoint(${local.x},${local.y});while(el?.shadowRoot){const next=el.shadowRoot.elementFromPoint(${local.x},${local.y});if(!next||next===el)break;el=next;}return el;})()`,
        contextId: prepared.contextId,
      });
      this.assertPreparedContext(tab, frame, prepared);
      if (!hit.result.objectId) return frame;
      let childId: string | undefined;
      try {
        const described = await prepared.channel.call('DOM.describeNode', {
          objectId: hit.result.objectId,
        });
        this.assertPreparedContext(tab, frame, prepared);
        childId = described.node.frameId;
      } finally {
        await prepared.channel
          .call('Runtime.releaseObject', { objectId: hit.result.objectId })
          .catch(() => {});
      }
      const child = childId && tab.frames.get(childId);
      if (!child) return frame;
      const geometry = await this.geometry(tab, child);
      const viewport = await this.bridge(tab, child, '({width:innerWidth,height:innerHeight})');
      const cx = (x - geometry.x) / geometry.scaleX,
        cy = (y - geometry.y) / geometry.scaleY;
      if (cx < 0 || cy < 0 || cx >= viewport.width || cy >= viewport.height) return frame;
      frame = child;
    }
    throw new Error('iframe 嵌套过深，无法安全定位此坐标');
  }
  private expose(
    tab: TabSession,
    frame: FrameContext,
    element: any,
    geometry?: FrameGeometry,
  ): ElementRef {
    const documentId = frame.documentId || String(element.documentId || '');
    const ref = `${tab.info.id}/${tab.activation}/${frame.id}/${frame.revision}/${element.ref}`;
    this.refs.set(ref, {
      tabId: tab.info.id,
      activation: tab.activation,
      frameId: frame.id,
      revision: frame.revision,
      documentId,
      localRef: element.ref,
    });
    const bounds =
      element.bounds && geometry
        ? {
            x: geometry.x + element.bounds.x * geometry.scaleX,
            y: geometry.y + element.bounds.y * geometry.scaleY,
            width: element.bounds.width * geometry.scaleX,
            height: element.bounds.height * geometry.scaleY,
          }
        : element.bounds;
    return {
      ...element,
      ref,
      nodeId: element.ref,
      tabId: tab.info.id,
      frameId: frame.id,
      documentId,
      bounds,
    };
  }
  private async resolveRef(
    ref: string,
  ): Promise<{ tab: TabSession; frame: FrameContext; scope: ScopedElement }> {
    if (typeof ref !== 'string' || ref.length > 1500) throw new Error('元素引用无效');
    const scope = this.refs.get(ref),
      tab = this.activeTab();
    if (!scope || scope.tabId !== tab.info.id || scope.activation !== tab.activation)
      throw new Error('元素引用已失效或属于其他标签页，请重新获取 snapshot/query。');
    const frame = tab.frames.get(scope.frameId);
    if (!frame) throw new Error('元素所在 iframe 已移除');
    await this.prepareFrame(tab, frame);
    if (frame.revision !== scope.revision || frame.documentId !== scope.documentId)
      throw new Error('元素所在文档已改变，请重新获取引用。');
    return { tab, frame, scope };
  }
  private async atPoint(tab: TabSession, x: number, y: number): Promise<ElementRef | null> {
    await this.collectFrames(tab);
    const frame = await this.hitFrame(tab, x, y);
    const offset = await this.geometry(tab, frame);
    const element = await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.atPoint(${(x - offset.x) / offset.scaleX},${(y - offset.y) / offset.scaleY})`,
    );
    return element ? this.expose(tab, frame, element, offset) : null;
  }
  dispatchInput(input: BrowserInput): Promise<void> {
    if (!input || typeof input !== 'object')
      return Promise.reject(new Error('Invalid browser input'));
    this.assertActor();
    const actorId = this.currentActor().id;
    const guard = this.actorContext.getStore()?.guard;
    const epoch = this.surfaceEpoch;
    if (input.frameEpoch !== undefined && input.frameEpoch !== epoch)
      return Promise.reject(new Error('画面已过期，请等待新画面'));
    const id = this.activeTab().info.id;
    if (input.tabId !== undefined && input.tabId !== id)
      return Promise.reject(new Error('忽略了来自旧标签页的输入。'));
    if (input.type === 'resize') return this.resize(input.width, input.height).then(() => {});
    if (input.type === 'mouse') this.hoverEpoch++;
    if (input.type === 'mouse' && input.action === 'leave') {
      const tab = this.activeTab(),
        epoch = this.hoverEpoch,
        activation = tab.activation;
      this.latestMove = undefined;
      const cleared = this.clearHover(tab, epoch, activation);
      // Hover acknowledgements can wait on a resize; cleanup must never block page actions.
      if (this.pointerMove)
        void this.pointerMove
          .then(
            () => this.clearHover(tab, epoch, activation),
            () => this.clearHover(tab, epoch, activation),
          )
          .catch(() => {});
      return cleared;
    }
    if (
      input.type === 'mouse' &&
      input.button &&
      !['left', 'middle', 'right'].includes(input.button)
    )
      return Promise.reject(new Error('Invalid mouse button'));
    if (
      input.type === 'mouse' &&
      input.buttons !== undefined &&
      (!Number.isInteger(input.buttons) || input.buttons < 0 || input.buttons > 31)
    )
      return Promise.reject(new Error('Invalid mouse buttons'));
    if (input.type === 'mouse' && input.action === 'move' && !input.buttons) {
      if (
        ![input.x, input.y].every(Number.isFinite) ||
        input.x < 0 ||
        input.y < 0 ||
        input.x > this.width ||
        input.y > this.height
      )
        return Promise.reject(new Error('Pointer is outside the browser viewport'));
      if (
        input.modifiers !== undefined &&
        (!Number.isInteger(input.modifiers) || input.modifiers < 0 || input.modifiers > 15)
      )
        return Promise.reject(new Error('Invalid keyboard modifiers'));
      this.boostFrames();
      this.latestMove = { ...input, tabId: id };
      if (!this.pointerMove) {
        this.pointerMove = (async () => {
          while (this.latestMove) {
            const move = this.latestMove;
            this.latestMove = undefined;
            const tab = this.tabs.get(move.tabId!);
            if (!tab || this.activeTabId !== move.tabId) continue;
            this.assertActor();
            await tab.page.call('Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: move.x,
              y: move.y,
              button: move.buttons ? move.button || 'left' : 'none',
              buttons: move.buttons || 0,
              modifiers: move.modifiers || 0,
            });
          }
        })().finally(() => {
          this.pointerMove = undefined;
        });
      }
      return this.pointerMove;
    }
    if (
      (input.type === 'mouse' && input.action === 'down') ||
      input.type === 'text' ||
      input.type === 'wheel' ||
      (input.type === 'key' && input.action === 'down')
    )
      this.humanTakeover(
        input.type === 'mouse' ? 'mouse-down' : input.type === 'key' ? 'key-down' : input.type,
      );
    if (input.type === 'wheel') {
      if (![input.deltaX, input.deltaY].every(Number.isFinite))
        return Promise.reject(new Error('Invalid scroll input'));
      if (
        ![input.x, input.y].every(Number.isFinite) ||
        input.x < 0 ||
        input.y < 0 ||
        input.x > this.width ||
        input.y > this.height
      )
        return Promise.reject(new Error('Pointer is outside the browser viewport'));
      if (
        input.modifiers !== undefined &&
        (!Number.isInteger(input.modifiers) || input.modifiers < 0 || input.modifiers > 15)
      )
        return Promise.reject(new Error('Invalid keyboard modifiers'));
      input = {
        ...input,
        tabId: id,
        deltaX: Math.max(-5000, Math.min(5000, input.deltaX)),
        deltaY: Math.max(-5000, Math.min(5000, input.deltaY)),
      };
      const pending = this.pendingWheel;
      const previous = pending?.input;
      if (
        pending &&
        previous &&
        previous.tabId === id &&
        pending.actorId === actorId &&
        pending.guard === guard &&
        pending.epoch === epoch &&
        previous.x === input.x &&
        previous.y === input.y &&
        (previous.modifiers || 0) === (input.modifiers || 0) &&
        previous.deltaX * input.deltaX >= 0 &&
        previous.deltaY * input.deltaY >= 0 &&
        Math.abs(previous.deltaX + input.deltaX) <= 5000 &&
        Math.abs(previous.deltaY + input.deltaY) <= 5000
      ) {
        previous.deltaX += input.deltaX;
        previous.deltaY += input.deltaY;
        return pending.result;
      }
    }
    const result = this.serialize(async () => {
      if (this.pendingWheel?.input === input) this.pendingWheel = undefined;
      const tab = this.requireActive(id);
      if (epoch !== this.surfaceEpoch) throw new Error('页面已改变，请等待新画面');
      if (input.type === 'key' && input.key === 'Escape' && this.state.inspecting) {
        if (input.action === 'down') await this.setInspectInternal(tab, false);
        return;
      }
      if (input.type === 'mouse' && input.action === 'up' && this.suppressMouseUp) {
        this.suppressMouseUp = false;
        return;
      }
      if (input.type === 'mouse' || input.type === 'wheel')
        if (
          ![input.x, input.y].every(Number.isFinite) ||
          input.x < 0 ||
          input.y < 0 ||
          input.x > this.width ||
          input.y > this.height
        )
          throw new Error('Pointer is outside the browser viewport');
      if (
        'modifiers' in input &&
        input.modifiers !== undefined &&
        (!Number.isInteger(input.modifiers) || input.modifiers < 0 || input.modifiers > 15)
      )
        throw new Error('Invalid keyboard modifiers');
      this.boostFrames();
      // New documents start in human mode; only a control handoff needs a frame walk.
      if (
        tab.source !== 'human' ||
        [...tab.frames.values()].some(
          (frame) =>
            frame.source === 'agent' ||
            (actorId !== 'host'
              ? frame.actorId !== actorId
              : frame.actorId && frame.actorId !== actorId),
        )
      )
        await this.setSource(tab, 'human');
      this.assertActor();
      if (input.type === 'mouse') {
        if (
          !['move', 'down', 'up'].includes(input.action) ||
          (input.button && !['left', 'middle', 'right'].includes(input.button))
        )
          throw new Error('Invalid mouse input');
        if (this.state.inspecting && input.action === 'down') {
          const element = await this.atPoint(tab, input.x, input.y);
          this.suppressMouseUp = true;
          if (element) await this.selectElementInternal(element.ref, false);
          return;
        }
        await tab.page.call('Input.dispatchMouseEvent', {
          type: { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[
            input.action as 'move' | 'down' | 'up'
          ],
          x: input.x,
          y: input.y,
          button: input.button || 'left',
          ...(input.buttons !== undefined ? { buttons: input.buttons } : {}),
          clickCount: input.action === 'move' ? 0 : Math.min(3, Math.max(1, input.clickCount || 1)),
          modifiers: input.modifiers || 0,
        });
        if (input.action === 'down')
          this.heldButtons.set(input.button || 'left', {
            x: input.x,
            y: input.y,
            button: input.button || 'left',
          });
        if (input.action === 'up') this.heldButtons.delete(input.button || 'left');
      } else if (input.type === 'wheel') {
        if (![input.deltaX, input.deltaY].every(Number.isFinite))
          throw new Error('Invalid scroll input');
        await tab.page.call('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: input.x,
          y: input.y,
          deltaX: Math.max(-5000, Math.min(5000, input.deltaX)),
          deltaY: Math.max(-5000, Math.min(5000, input.deltaY)),
          modifiers: input.modifiers || 0,
        });
      } else if (input.type === 'text') {
        if (typeof input.text !== 'string' || input.text.length > 20_000)
          throw new Error('Text input is too long');
        await tab.page.call('Input.insertText', { text: input.text });
      } else if (input.type === 'key') {
        if (
          !['down', 'up'].includes(input.action) ||
          typeof input.key !== 'string' ||
          typeof input.code !== 'string' ||
          input.key.length > 100 ||
          input.code.length > 100 ||
          (input.text?.length || 0) > 100
        )
          throw new Error('Invalid key input');
        await tab.page.call('Input.dispatchKeyEvent', {
          type: input.action === 'up' ? 'keyUp' : input.text ? 'keyDown' : 'rawKeyDown',
          key: input.key,
          code: input.code,
          windowsVirtualKeyCode: input.keyCode,
          nativeVirtualKeyCode: input.keyCode,
          modifiers: input.modifiers || 0,
          text: input.action === 'down' ? input.text : undefined,
          ...(input.action === 'down' &&
          (input.modifiers || 0) & 6 &&
          input.key.toLowerCase() === 'a'
            ? { commands: ['selectAll'] }
            : {}),
        });
        if (input.action === 'down') this.heldKeys.set(input.code, input);
        else this.heldKeys.delete(input.code);
      } else throw new Error('Unsupported browser input');
    });
    if (input.type === 'wheel') {
      const pending = { input, result, actorId, guard, epoch };
      this.pendingWheel = pending;
      const clear = () => {
        if (this.pendingWheel === pending) this.pendingWheel = undefined;
      };
      void result.then(clear, clear);
    }
    return result;
  }
  private async clearHover(tab: TabSession, epoch: number, activation: number): Promise<void> {
    if (
      this.hoverEpoch !== epoch ||
      this.activeTabId !== tab.info.id ||
      tab.activation !== activation
    )
      return;
    await Promise.allSettled(
      [...tab.frames.values()]
        .filter((frame) => frame.contextId)
        .map((frame) =>
          frame.channel.call('Runtime.evaluate', {
            expression: 'globalThis.__workbenchPage?.leave()',
            contextId: frame.contextId,
          }),
        ),
    );
  }
  setInspect(enabled: boolean): Promise<void> {
    const id = this.activeTab().info.id;
    return this.serialize(() => this.setInspectInternal(this.requireActive(id), !!enabled));
  }
  private async setInspectInternal(tab: TabSession, enabled: boolean): Promise<void> {
    const frames = await this.collectFrames(tab);
    await Promise.all(
      frames.map((frame) =>
        this.bridge(tab, frame, `globalThis.__workbenchPage.setInspect(${enabled})`).catch(
          () => {},
        ),
      ),
    );
    this.update({ inspecting: enabled });
  }
  setElementFeedback(ref: string, phase: 'working' | null): Promise<void> {
    return this.serialize(async () => {
      if (phase === 'working') {
        const { tab, frame, scope } = await this.resolveRef(ref);
        if (this.workingFeedback && this.workingFeedback.ref !== ref)
          await this.clearWorkingFeedback(this.workingFeedback);
        this.workingFeedback = { ...scope, ref };
        await this.bridge(
          tab,
          frame,
          `globalThis.__workbenchPage.feedback(${JSON.stringify(scope.localRef)},'working')`,
        );
        return;
      }
      const scope = this.workingFeedback;
      if (!scope || scope.ref !== ref) return;
      this.workingFeedback = undefined;
      await this.clearWorkingFeedback(scope);
    });
  }
  private async clearWorkingFeedback(scope: ScopedElement): Promise<void> {
    const tab = this.tabs.get(scope.tabId),
      frame = tab?.frames.get(scope.frameId);
    if (!tab || !frame || frame.documentId !== scope.documentId) return;
    await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.feedback(${JSON.stringify(scope.localRef)},null)`,
    ).catch(() => {});
  }

  snapshot(): Promise<ToolResult> {
    const id = this.activeTab().info.id;
    return this.serialize(() => this.snapshotInternal(this.requireActive(id)));
  }
  private async snapshotInternal(tab: TabSession): Promise<ToolResult> {
    const frames = await this.collectFrames(tab),
      items: ElementRef[] = [],
      details: any[] = [],
      texts: string[] = [];
    for (const frame of frames) {
      try {
        const value = await this.bridge(tab, frame, 'globalThis.__workbenchPage.snapshot()');
        const geometry = await this.geometry(tab, frame);
        frame.documentId = value.documentId;
        items.push(...value.elements.map((item: any) => this.expose(tab, frame, item, geometry)));
        texts.push(value.text || '');
        details.push({
          frameId: frame.id,
          parentId: frame.parentId,
          url: evidenceUrl(frame.url),
          documentId: value.documentId,
        });
      } catch (error) {
        details.push({
          frameId: frame.id,
          url: evidenceUrl(frame.url),
          error: redactBrowserText(error instanceof Error ? error.message : error),
        });
      }
    }
    if (!details.some((frame) => frame.documentId)) throw new Error('当前页面框架尚未可读');
    return {
      text: JSON.stringify(
        {
          tabId: tab.info.id,
          url: evidenceUrl(tab.info.url),
          title: tab.info.title,
          documentId: this.mainFrame(tab).documentId,
          text: texts.join('\n\n').slice(0, 12_000),
          elements: items.slice(0, 240),
          frames: details,
        },
        null,
        2,
      ),
    };
  }
  screenshot(): Promise<ToolResult> {
    const id = this.activeTab().info.id;
    return this.serialize(() => this.screenshotInternal(this.requireActive(id)));
  }
  private async screenshotInternal(tab: TabSession): Promise<ToolResult> {
    const result = await this.withMask(tab, true, () =>
      tab.page.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
    );
    return {
      text: `网页截图（tab ${tab.info.id}）：${evidenceUrl(tab.info.url)}。可访问的敏感输入框已遮盖。`,
      image: result.data,
    };
  }
  /** Covers sensitive fields during a capture and discards it when the page changed meanwhile. */
  private async withMask<T>(
    tab: TabSession,
    visible: boolean,
    capture: () => Promise<T>,
  ): Promise<T> {
    const frames = await this.collectFrames(tab),
      masked: FrameContext[] = [];
    const activation = tab.activation;
    const scopes: Array<{
      id: string;
      channel: BrowserChannel;
      revision: number;
      documentId?: string;
    }> = [];
    const unchanged = async () => {
      const current = await this.collectFrames(tab);
      if (
        (visible && this.activeTabId !== tab.info.id) ||
        tab.activation !== activation ||
        current.length !== scopes.length
      )
        throw new Error('页面在截图期间发生变化，已丢弃截图，请重试。');
      for (const scope of scopes) {
        const frame = current.find((item) => item.id === scope.id);
        if (!frame || frame.channel !== scope.channel)
          throw new Error('页面框架在截图期间发生变化，已丢弃截图。');
        await this.prepareFrame(tab, frame);
        if (frame.revision !== scope.revision || frame.documentId !== scope.documentId)
          throw new Error('页面文档在截图期间发生变化，已丢弃截图，请重试。');
      }
    };
    try {
      for (const frame of frames) {
        await this.bridge(tab, frame, 'globalThis.__workbenchPage.mask(true)');
        masked.push(frame);
        scopes.push({
          id: frame.id,
          channel: frame.channel,
          revision: frame.revision,
          documentId: frame.documentId,
        });
      }
      await unchanged();
      const result = await capture();
      await unchanged();
      return result;
    } finally {
      for (const frame of masked)
        await this.bridge(tab, frame, 'globalThis.__workbenchPage.mask(false)').catch(() => {});
    }
  }
  queryElements(query: ElementQuery & { frameId?: string }): Promise<ElementQueryResult> {
    const id = this.activeTab().info.id;
    return this.serialize(() => this.queryInternal(this.requireActive(id), query));
  }
  private async queryInternal(
    tab: TabSession,
    query: ElementQuery & { frameId?: string },
  ): Promise<ElementQueryResult> {
    if (!query || typeof query !== 'object' || Array.isArray(query))
      throw new Error('查询条件无效');
    if (
      Object.keys(query).some(
        (key) => !['selector', 'text', 'role', 'exact', 'limit', 'frameId'].includes(key),
      )
    )
      throw new Error('查询含未知字段');
    for (const key of ['selector', 'text', 'role', 'frameId'] as const)
      if (query[key] !== undefined && (typeof query[key] !== 'string' || query[key]!.length > 1000))
        throw new Error('查询条件格式无效');
    if (![query.selector, query.text, query.role].some((value) => value?.trim()))
      throw new Error('请提供 selector、文字或 role');
    if (query.exact !== undefined && typeof query.exact !== 'boolean')
      throw new Error('exact 必须为布尔值');
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('查询数量必须在1到100之间');
    const all = await this.collectFrames(tab),
      frames = query.frameId ? all.filter((frame) => frame.id === query.frameId) : all;
    if (!frames.length) throw new Error('指定的 iframe 不存在');
    const { frameId: _, ...criteria } = query;
    const elements: ElementRef[] = [];
    const warnings: Array<{ frameId: string; message: string }> = [];
    let truncated = false;
    for (const frame of frames) {
      try {
        const result = await this.bridge(
          tab,
          frame,
          `globalThis.__workbenchPage.query(${JSON.stringify({ ...criteria, limit })})`,
        );
        truncated ||= result.truncated;
        if (!result.elements.length) continue;
        const geometry = await this.geometry(tab, frame);
        elements.push(
          ...result.elements.map((element: any) => this.expose(tab, frame, element, geometry)),
        );
      } catch (error) {
        if (query.frameId) throw error;
        warnings.push({
          frameId: frame.id,
          message: redactBrowserText(error instanceof Error ? error.message : error),
        });
      }
    }
    const result = {
      documentId: this.mainFrame(tab).documentId || '',
      elements: elements.slice(0, limit),
      truncated: truncated || elements.length > limit,
      ...(warnings.length ? { warnings } : {}),
    };
    return result;
  }
  getElementDetails(ref: string): Promise<ElementDetails> {
    return this.serialize(() => this.detailsInternal(ref));
  }
  private async detailsInternal(ref: string): Promise<ElementDetails> {
    const { tab, frame, scope } = await this.resolveRef(ref);
    const detail = await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.inspect(${JSON.stringify(scope.localRef)})`,
    );
    const element = await this.exposeDetails(tab, frame, detail);
    let objectId: string | undefined;
    try {
      const object = await frame.channel.call('Runtime.evaluate', {
        expression: `globalThis.__workbenchPage.node(${JSON.stringify(scope.localRef)})`,
        contextId: frame.contextId,
      });
      objectId = object.result?.objectId;
      if (objectId) {
        const [dom, ax] = await Promise.all([
          frame.channel.call('DOM.describeNode', { objectId }),
          frame.channel.call('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false }),
        ]);
        element.backendNodeId = dom.node?.backendNodeId;
        const node = ax.nodes?.find(
          (node: any) => node.backendDOMNodeId === element.backendNodeId && !node.ignored,
        );
        const role = node?.role?.value;
        if (role && !['generic', 'none', 'StaticText', 'InlineTextBox'].includes(role)) {
          element.role = role;
          element.semantics = {
            kind: role,
            source: 'accessibility',
            evidence: ['Browser accessibility role: ' + role],
          };
        } else if (
          element.semantics?.source !== 'html' &&
          element.semantics?.source !== 'aria' &&
          element.backendNodeId
        ) {
          // Event listeners are world-scoped; resolve the same DOM node in the page world.
          const main = await frame.channel.call('DOM.resolveNode', {
            backendNodeId: element.backendNodeId,
          });
          const mainId = main.object?.objectId;
          if (mainId)
            try {
              const listeners = await frame.channel.call('DOMDebugger.getEventListeners', {
                objectId: mainId,
              });
              if (listeners.listeners?.some((listener: any) => listener.type === 'click'))
                element.semantics = {
                  kind: 'button',
                  source: 'inferred',
                  evidence: [...(element.semantics?.evidence || []), 'click event listener'],
                };
            } finally {
              await frame.channel
                .call('Runtime.releaseObject', { objectId: mainId })
                .catch(() => {});
            }
        }
      }
    } catch {
      /* DOM evidence remains available on pages without AX support. */
    } finally {
      if (objectId) await frame.channel.call('Runtime.releaseObject', { objectId }).catch(() => {});
    }
    return element;
  }
  private async exposeDetails(
    tab: TabSession,
    frame: FrameContext,
    detail: any,
  ): Promise<ElementDetails> {
    const geometry = await this.geometry(tab, frame);
    return {
      ...detail,
      ...this.expose(tab, frame, detail, geometry),
      documentId: frame.documentId || detail.documentId,
      ancestors: (detail.ancestors || []).map((element: any) =>
        this.expose(tab, frame, element, geometry),
      ),
    };
  }
  selectElement(ref: string): Promise<ElementDetails> {
    const scope = this.refs.get(ref);
    if (!scope || scope.tabId !== this.activeTabId)
      return Promise.reject(new Error('元素引用已失效或属于其他标签页'));
    this.humanTakeover('inspect');
    return this.serialize(() => this.selectElementInternal(ref));
  }
  private async selectElementInternal(ref: string, reveal = true): Promise<ElementDetails> {
    const { tab, frame, scope } = await this.resolveRef(ref);
    await this.setSource(tab, 'human');
    if (reveal) {
      await this.revealFrame(tab, frame);
      await this.bridge(
        tab,
        frame,
        `globalThis.__workbenchPage.reveal(${JSON.stringify(scope.localRef)})`,
      );
    }
    await this.clearOutline(tab);
    await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.outline(${JSON.stringify(scope.localRef)})`,
    );
    const detail = await this.detailsInternal(ref);
    this.update({ selectedElement: detail, inspecting: false, elementControls: undefined });
    this.options.onSelected(detail, 'pick');
    return detail;
  }
  editElement(ref: string, changes: ElementEdit): Promise<ElementEditResult> {
    const scope = this.refs.get(ref);
    if (!scope || scope.tabId !== this.activeTabId)
      return Promise.reject(new Error('元素引用已失效或属于其他标签页'));
    this.humanTakeover('edit');
    return this.serialize(() => this.editInternal(ref, changes, 'human'));
  }
  previewStyles(
    ref: string,
    styles: Record<string, string>,
    editId?: string,
  ): Promise<{ editId: string }> {
    if (this.state.selectedElement?.ref !== ref)
      return Promise.reject(new Error('选区已变化，请重新选取'));
    this.humanTakeover('edit');
    return this.serialize(async () => {
      if (this.state.selectedElement?.ref !== ref) throw new Error('选区已变化，请重新选取');
      this.validateEdit({ styles });
      this.boostFrames();
      const { tab, frame, scope } = await this.resolveRef(ref);
      const previous = editId
        ? tab.edits.find((edit) => edit.id === editId && edit.localRef === scope.localRef)
        : undefined;
      if (editId && !previous) throw new Error('预览手势已失效');
      if (previous?.actor && previous.actor.id !== this.currentActor().id)
        throw new Error('只能继续自己的预览修改');
      if (!previous) await this.setSource(tab, 'human', frame);
      const result = await this.bridge(
        tab,
        frame,
        `globalThis.__workbenchPage.previewStyles(${JSON.stringify({ ref: scope.localRef, styles, editId: previous?.localId })})`,
      );
      const id = this.registerEdit(tab, frame, result.editId);
      const metadata = tab.edits.find((edit) => edit.id === id)!;
      metadata.localRef = scope.localRef;
      metadata.source = 'human';
      metadata.transient = true;
      metadata.changes = { styles: { ...metadata.changes?.styles, ...styles } };
      if (!previous) this.update();
      return { editId: id };
    });
  }
  commitStyles(ref: string, editId: string): Promise<ElementEditResult> {
    return this.serialize(async () => {
      if (this.state.selectedElement?.ref !== ref) throw new Error('选区已变化，请重新选取');
      const { tab, frame, scope } = await this.resolveRef(ref);
      const metadata = tab.edits.find(
        (edit) => edit.id === editId && edit.localRef === scope.localRef,
      );
      if (!metadata) throw new Error('预览手势已失效');
      if (metadata.actor && metadata.actor.id !== this.currentActor().id)
        throw new Error('只能提交自己的预览修改');
      const result = await this.bridge(
        tab,
        frame,
        `globalThis.__workbenchPage.commitStyles(${JSON.stringify(metadata.localId)})`,
      );
      metadata.transient = false;
      const element = await this.exposeDetails(tab, frame, result.element);
      element.semantics = this.state.selectedElement?.semantics || element.semantics;
      element.backendNodeId = this.state.selectedElement?.backendNodeId;
      this.update({ selectedElement: element });
      this.options.onSelected(element, 'edit');
      return { editId, element };
    });
  }
  private validateEdit(changes: ElementEdit): void {
    if (
      !changes ||
      typeof changes !== 'object' ||
      Array.isArray(changes) ||
      Object.keys(changes).some((key) => !['text', 'styles', 'animation', 'insert'].includes(key))
    )
      throw new Error('元素修改格式无效');
    if (changes.insert !== undefined) {
      if (Object.keys(changes).length !== 1)
        throw new Error('新增元素需独立提交，再用返回的引用继续修改');
      validateInsertion(changes.insert);
      return;
    }
    if (
      changes.text !== undefined &&
      (typeof changes.text !== 'string' || changes.text.length > 20_000)
    )
      throw new Error('文字内容过长或无效');
    if (changes.styles !== undefined) validateStyles(changes.styles, editableStyles, true);
    if (changes.animation !== undefined && changes.animation !== null)
      validateAnimation(changes.animation);
    if (
      changes.text === undefined &&
      !Object.keys(changes.styles || {}).length &&
      changes.animation === undefined
    )
      throw new Error('没有提供修改内容');
  }
  private registerEdit(
    tab: TabSession,
    frame: FrameContext,
    localId: string,
    actor = this.currentActor(),
  ): string {
    const id = `${tab.info.id}/${frame.id}/${frame.documentId}/${localId}`;
    if (!tab.edits.some((edit) => edit.id === id))
      tab.edits.push({ actor, id, frameId: frame.id, documentId: frame.documentId || '', localId });
    return id;
  }
  private async editInternal(
    ref: string,
    changes: ElementEdit,
    source: 'human' | 'agent',
    guard?: () => void,
  ): Promise<ElementEditResult> {
    this.validateEdit(changes);
    const { tab, frame, scope } = await this.resolveRef(ref);
    await this.setSource(tab, source, frame);
    const result = await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.edit(${JSON.stringify({ ref: scope.localRef, ...changes })})`,
      guard,
    );
    const editId = this.registerEdit(tab, frame, result.editId);
    const metadata = tab.edits.find((edit) => edit.id === editId)!;
    metadata.localRef = changes.insert ? result.element.ref : scope.localRef;
    metadata.source = source;
    metadata.changes = structuredClone(changes);
    await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.outline(${JSON.stringify(result.element.ref)})`,
    );
    const element = await this.exposeDetails(tab, frame, result.element);
    this.update({ selectedElement: element });
    this.options.onSelected(element, 'edit');
    return { editId, element };
  }
  /**
   * Restyles the whole page in one step: a stylesheet and text replacements by selector, kept as
   * one preview edit. A request the page refuses changes nothing and is answered, not thrown.
   */
  private async restyleInternal(
    tab: TabSession,
    changes: { css?: string; texts?: Array<{ selector: string; text: string }> },
    source: 'human' | 'agent',
    guard?: () => void,
  ): Promise<Record<string, unknown>> {
    const frame = (await this.collectFrames(tab)).find((item) => item.id === tab.mainFrameId);
    if (!frame) throw new Error('页面框架尚未就绪');
    await this.setSource(tab, source, frame);
    const result = await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.restyle(${JSON.stringify(changes)})`,
      guard,
    );
    if (!result.applied) return result;
    const { element, ...evidence } = result;
    const editId = this.registerEdit(tab, frame, result.editId);
    const metadata = tab.edits.find((edit) => edit.id === editId)!;
    metadata.localRef = element.ref;
    metadata.source = source;
    metadata.changes = {
      sheet: changes.css ?? '',
      ...(changes.texts?.length ? { texts: structuredClone(changes.texts) } : {}),
    };
    // The page as a whole changed: nothing is selected or outlined for it.
    this.update();
    return { ...evidence, editId };
  }
  /**
   * Everything the active page currently previews, by whom and on which element, for a record
   * of the changes. Gestures still in progress are left out.
   */
  pageChanges(): Promise<{ url: string; changes: PageChange[] }> {
    return this.serialize(async () => {
      const tab = this.tabs.get(this.activeTabId);
      if (!tab) return { url: this.state.url, changes: [] };
      const changes: PageChange[] = [];
      for (const edit of tab.edits) {
        const frame = tab.frames.get(edit.frameId);
        if (!frame || !edit.changes || !edit.localRef || edit.transient) continue;
        if (frame.documentId !== edit.documentId) continue;
        const page = edit.changes.sheet !== undefined;
        let element: PageChange['element'];
        if (!page)
          try {
            const detail = await this.bridge(
              tab,
              frame,
              `globalThis.__workbenchPage.inspect(${JSON.stringify(edit.localRef)})`,
            );
            element = {
              tag: String(detail.tag),
              name: String(detail.name || detail.tag).slice(0, 120),
              ...(detail.selector ? { selector: String(detail.selector).slice(0, 400) } : {}),
              ...(detail.textContent
                ? { text: String(detail.textContent).replace(/\s+/g, ' ').trim().slice(0, 200) }
                : {}),
            };
          } catch {
            // The page replaced the element; the change itself is still part of the record.
          }
        changes.push({
          editId: edit.id,
          by: edit.source === 'agent' ? 'agent' : 'user',
          ...(page ? { page: true } : {}),
          ...(element ? { element } : {}),
          changes: structuredClone(edit.changes),
        });
      }
      return { url: tab.info.url, changes };
    });
  }
  undoEdit(editId?: string): Promise<ElementEditResult> {
    const tab = this.activeTab();
    if (editId !== undefined && typeof editId !== 'string')
      return Promise.reject(new Error('修改ID无效'));
    this.humanTakeover('undo');
    return this.serialize(() =>
      this.undoInternal(this.requireActive(tab.info.id), editId, 'human'),
    );
  }
  private async undoInternal(
    tab: TabSession,
    id: string | undefined,
    source: 'human' | 'agent',
    guard?: () => void,
  ): Promise<ElementEditResult> {
    const actor = source === 'agent' ? undefined : this.currentActor();
    const edit = id
      ? tab.edits.find((item) => item.id === id)
      : tab.edits.findLast((item) => !actor || !item.actor || item.actor.id === actor.id);
    if (actor && edit?.actor && edit.actor.id !== actor.id) throw new Error('只能撤销自己的修改');
    if (
      edit &&
      tab.edits.some(
        (item) =>
          item !== edit &&
          item.localRef === edit.localRef &&
          item.actor?.id !== actor?.id &&
          tab.edits.indexOf(item) > tab.edits.indexOf(edit),
      )
    )
      throw new Error('其他参与者已修改此元素，无法撤销较早的修改');
    if (!edit) throw new Error('当前标签页没有可撤销的修改');
    const frame = tab.frames.get(edit.frameId);
    if (!frame) throw new Error('修改所在框架已移除');
    await this.prepareFrame(tab, frame);
    if (frame.documentId !== edit.documentId) throw new Error('修改所在文档已改变，无法撤销');
    await this.setSource(tab, source, frame);
    const result = await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.undo(${JSON.stringify(edit.localId)})`,
      guard,
    );
    tab.edits = tab.edits.filter((item) => item.id !== edit.id);
    if (result.page) {
      this.update();
      return {
        editId: edit.id,
        element: await this.exposeDetails(tab, frame, result.element),
        page: true,
      };
    }
    await this.bridge(
      tab,
      frame,
      `globalThis.__workbenchPage.outline(${JSON.stringify(result.element.ref)})`,
    );
    const element = await this.exposeDetails(tab, frame, result.element);
    this.update({ selectedElement: element });
    this.options.onSelected(element, 'edit');
    return { editId: edit.id, element };
  }

  startRecording(sharedSessionId?: string, part?: number): void {
    const tab = this.activeTab();
    if (this.recording) return;
    this.recording = {
      id: randomUUID(),
      sharedSessionId,
      part,
      title: `${sharedSessionId ? '共享 · ' : ''}${tab.info.title || '浏览器操作'}${part && part > 1 ? ` · ${part}` : ''}`,
      startedAt: Date.now(),
      steps: [],
    };
    this.update({ recording: true });
    this.appendStep({
      kind: 'navigate',
      description: `打开 ${evidenceUrl(tab.info.url)}`,
      url: evidenceUrl(tab.info.url),
      source: 'human',
      tabId: tab.info.id,
      frameId: tab.mainFrameId,
    });
  }
  stopRecording(): Promise<Recording> {
    if (this.endingRecording) return this.endingRecording;
    const current = this.recording;
    if (!current) return Promise.reject(new Error('当前没有录制'));
    this.endingRecording = this.withActor(this.actors.get('host')!, undefined, async () => {
      await this.pendingWheel?.result;
      const active = this.tabs.get(this.activeTabId);
      const root = active?.frames.get(active.mainFrameId);
      if (active && root?.contextId !== undefined)
        // Input acknowledgement can precede the document's scroll event.
        await this.bridge(
          active,
          root,
          'new Promise(resolve => requestAnimationFrame(() => resolve()))',
        );
      for (const tab of this.tabs.values()) {
        for (const frame of [...tab.frames.values()]) {
          if (frame.contextId === undefined) continue;
          try {
            await this.bridge(tab, frame, 'globalThis.__workbenchPage.flushScroll()');
          } catch (error) {
            if (this.tabs.get(tab.info.id) === tab && tab.frames.get(frame.id) === frame)
              throw error;
          }
        }
      }
      if (this.recording !== current) throw new Error('录制状态已变化，请重新检查记录');
      const recording = structuredClone({ ...current, endedAt: Date.now() });
      this.recording = undefined;
      this.update({ recording: false });
      return recording;
    }).finally(() => {
      this.endingRecording = undefined;
    });
    return this.endingRecording;
  }
  private recordEvent(tab: TabSession, frame: FrameContext, event: any): void {
    if (
      !this.recording ||
      !event ||
      !['click', 'fill', 'select', 'key', 'scroll', 'edit', 'undo'].includes(event.kind) ||
      !['human', 'agent'].includes(event.source)
    )
      return;
    if (typeof event.docId !== 'string') return;
    if (frame.documentId && frame.documentId !== event.docId) return;
    frame.documentId = event.docId;
    const target =
      event.target && typeof event.target.ref === 'string'
        ? this.expose(tab, frame, {
            ...event.target,
            name: redactBrowserText(event.target.name).slice(0, 180),
          })
        : undefined;
    const value =
      typeof event.value === 'string'
        ? ['edit', 'undo'].includes(event.kind)
          ? recordedEditValue(event.value)
          : redactBrowserText(event.value)
        : undefined;
    const verbs: Record<string, string> = {
      click: '点击',
      fill: '填写',
      select: '选择',
      key: '按键',
      scroll: '滚动',
      edit: '修改元素',
      undo: '撤销修改',
    };
    const editId =
      typeof event.editId === 'string'
        ? this.registerEdit(tab, frame, event.editId, this.actors.get(event.actorId))
        : undefined;
    if (event.kind === 'undo' && editId) tab.edits = tab.edits.filter((edit) => edit.id !== editId);
    this.appendStep({
      kind: event.kind,
      description: `${verbs[event.kind]}${target?.name ? `「${target.name}」` : ''}${value && ['key', 'scroll'].includes(event.kind) ? ` ${value}` : ''}`,
      url: evidenceUrl(frame.url || tab.info.url),
      source: event.source,
      actor:
        this.actors.get(event.actorId) ??
        (event.source === 'agent' ? { id: 'agent', name: 'Agent' } : undefined),
      target,
      value,
      tabId: tab.info.id,
      frameId: frame.id,
      editId,
    });
  }
  private appendStep(data: Omit<RecordedStep, 'id' | 'timestamp'>): void {
    if (!this.recording || this.recording.steps.length >= 2000) return;
    const step: RecordedStep = {
      actor: data.source === 'human' ? this.currentActor() : { id: 'agent', name: 'Agent' },
      ...data,
      id: randomUUID(),
      timestamp: Date.now(),
    };
    const last = this.recording.steps.at(-1);
    if (
      last &&
      ['fill', 'select', 'scroll'].includes(step.kind) &&
      last.kind === step.kind &&
      last.tabId === step.tabId &&
      last.frameId === step.frameId &&
      last.target?.ref === step.target?.ref &&
      last.source === step.source &&
      last.actor?.id === step.actor?.id &&
      step.timestamp - last.timestamp < 1500
    ) {
      step.id = last.id;
      this.recording.steps[this.recording.steps.length - 1] = step;
    } else this.recording.steps.push(step);
    this.options.onStep(structuredClone(step));
  }

  getTools(): BrowserTool[] {
    const tool = (
      name: string,
      description: string,
      properties: Record<string, unknown> = {},
      required: string[] = [],
      target = true,
    ): BrowserTool => ({
      name: `workbench_browser_${name}`,
      description,
      inputSchema: {
        type: 'object',
        properties: {
          ...(target
            ? {
                tabId: {
                  type: 'string',
                  description: '目标必须是当前活动标签页；其他页面先用 switch_tab。',
                },
              }
            : {}),
          ...properties,
        },
        required,
        additionalProperties: false,
      },
    });
    const ref = {
      type: 'string',
      description: '当前活动标签页 snapshot/query 返回的精确元素引用；切换或导航后必须重取。',
    };
    return [
      tool('tabs', '列出工作台中的真实浏览器标签页及活动页。', {}, [], false),
      tool(
        'new_tab',
        '新建并显示工作台内的标签页；不打开系统浏览器。',
        { url: { type: 'string' } },
        [],
        false,
      ),
      tool(
        'switch_tab',
        '切换可见标签页；旧元素引用失效，之后先获取 snapshot。',
        { tabId: { type: 'string' } },
        ['tabId'],
        false,
      ),
      tool('close_tab', '关闭指定标签页。', { tabId: { type: 'string' } }, ['tabId'], false),
      tool('snapshot', '读取当前标签页及可访问iframe的DOM文字、元素与frame标识。'),
      tool('screenshot', '获取当前可见标签页截图，遮盖可访问frame中的敏感输入框。'),
      tool('query', '按CSS selector、文字或role查找精确DOM节点（含开放Shadow DOM）。', {
        selector: { type: 'string' },
        text: { type: 'string' },
        role: { type: 'string' },
        exact: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        frameId: { type: 'string' },
      }),
      tool(
        'controls',
        '为当前选中元素提供 A2UI v0.9.1 调整面板。只创建控件，不改变网页；用户拖动后本地预览。组件格式 {id,component,property,min?,max?,step?}，类型与属性必须匹配：' +
          JSON.stringify(controlProperties),
        {
          ref,
          components: {
            type: 'array',
            minItems: 1,
            maxItems: 24,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                component: { type: 'string', enum: ['Slider', 'ColorPicker', 'ChoicePicker'] },
                property: { type: 'string', enum: Object.keys(controlProperties) },
                min: { type: 'number' },
                max: { type: 'number' },
                step: { type: 'number' },
              },
              required: ['id', 'component', 'property'],
              additionalProperties: false,
            },
          },
        },
        ['ref', 'components'],
      ),
      tool(
        'inspect',
        '读取精确元素属性、计算样式（含渐变、阴影、变换）、工具预览动画配置与实际播放状态、祖先和frame，不改变页面。',
        { ref },
        ['ref'],
      ),
      tool(
        'edit',
        '修改精确 DOM 的文字、样式、可撤销 WAAPI 动效；或单独用 insert 在 ref 内部/前后创建嵌套 HTML 元素。新建返回新元素 ref，可继续 inspect/edit；要点击或填写它时重新获取 snapshot。结构最多 80 节点/8 层，不接受 HTML 字符串、脚本、事件属性或敏感控件。新增输入控件不提交到原有表单。styles 禁止 URL、var/attr、代码和 !important；animation:null 只取消自己的动画。所有修改可撤销，仅影响当前页面预览，不代表源码已保存。',
        {
          ref,
          text: { type: 'string', maxLength: 20_000 },
          insert: {
            type: 'object',
            additionalProperties: false,
            required: ['node'],
            description:
              '与 text/styles/animation 互斥。styles 可放在 node 内；position 默认 append。',
            properties: {
              position: { type: 'string', enum: ['append', 'prepend', 'before', 'after'] },
              node: {
                type: 'object',
                additionalProperties: false,
                required: ['tag'],
                properties: {
                  tag: { type: 'string', enum: [...ELEMENT_INSERT_TAGS] },
                  text: { type: 'string', maxLength: 20_000 },
                  attributes: {
                    type: 'object',
                    maxProperties: 20,
                    propertyNames: { enum: [...ELEMENT_INSERT_ATTRIBUTES] },
                    additionalProperties: { type: 'string', maxLength: 4096 },
                  },
                  styles: {
                    type: 'object',
                    maxProperties: ELEMENT_PREVIEW_LIMITS.styleCount,
                    propertyNames: { enum: [...ELEMENT_STYLE_PROPERTIES] },
                    additionalProperties: {
                      type: 'string',
                      maxLength: ELEMENT_PREVIEW_LIMITS.styleValueLength,
                    },
                  },
                  children: {
                    type: 'array',
                    maxItems: 80,
                    items: { $ref: '#/properties/insert/properties/node' },
                  },
                },
              },
            },
          },
          styles: {
            type: 'object',
            maxProperties: ELEMENT_PREVIEW_LIMITS.styleCount,
            propertyNames: { enum: [...ELEMENT_STYLE_PROPERTIES] },
            additionalProperties: {
              type: 'string',
              maxLength: ELEMENT_PREVIEW_LIMITS.styleValueLength,
            },
            description:
              '支持linear/radial/conic-gradient及安全颜色、box-shadow/text-shadow、transform/filter。空值删除该行内属性。',
          },
          animation: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['keyframes', 'duration'],
                properties: {
                  keyframes: {
                    type: 'array',
                    minItems: ELEMENT_PREVIEW_LIMITS.keyframesMin,
                    maxItems: ELEMENT_PREVIEW_LIMITS.keyframesMax,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['styles'],
                      properties: {
                        offset: {
                          type: 'number',
                          minimum: 0,
                          maximum: 1,
                          description: '已指定的offset必须非递减。',
                        },
                        styles: {
                          type: 'object',
                          minProperties: 1,
                          maxProperties: ELEMENT_PREVIEW_LIMITS.styleCount,
                          propertyNames: { enum: [...ELEMENT_ANIMATION_PROPERTIES] },
                          additionalProperties: {
                            type: 'string',
                            minLength: 1,
                            maxLength: ELEMENT_PREVIEW_LIMITS.styleValueLength,
                          },
                        },
                      },
                    },
                  },
                  duration: {
                    type: 'number',
                    minimum: ELEMENT_PREVIEW_LIMITS.durationMin,
                    maximum: ELEMENT_PREVIEW_LIMITS.durationMax,
                    description: '一轮时长，单位毫秒。',
                  },
                  iterations: {
                    anyOf: [
                      { type: 'number', minimum: 1, maximum: ELEMENT_PREVIEW_LIMITS.iterationsMax },
                      { type: 'string', enum: ['infinite'] },
                    ],
                  },
                  easing: {
                    type: 'string',
                    maxLength: ELEMENT_PREVIEW_LIMITS.easingLength,
                    description:
                      'linear/ease/ease-in/ease-out/ease-in-out/step-start/step-end，或合法cubic-bezier()/steps()。',
                  },
                  direction: {
                    type: 'string',
                    enum: ['normal', 'reverse', 'alternate', 'alternate-reverse'],
                  },
                },
              },
            ],
          },
        },
        ['ref'],
      ),
      tool(
        'restyle',
        '一次调用完成页面级外观与文案预览：css 是作用于整个页面的样式表（可写任意选择器、@media、@keyframes，覆盖站点原有样式或行内样式时加 !important），texts 按选择器替换文字。立即生效、无需用户确认，返回 editId，可用 workbench_browser_undo 撤销；多次调用会叠加。返回值就是证据：rules 规则数、matched 命中的元素数、unmatched 未命中的选择器、unchanged 命中但取样元素的计算样式没有变化的选择器（被更高优先级覆盖、媒体条件未满足或原本如此）、dropped 没有任何有效声明的规则、texts 每项的命中与实际替换数量；applied 为 false 时页面未被改动，按 reason 修正后重试即可。不能引用外部资源（url() 仅限 data:image），不能新增元素（新增用 workbench_browser_edit 的 insert），不作用于 iframe 与 shadow DOM 内部。',
        {
          css: {
            type: 'string',
            maxLength: PAGE_SHEET_LIMIT,
            description: '完整的 CSS 样式表文本。',
          },
          texts: {
            type: 'array',
            maxItems: 60,
            description:
              '文字替换：selector 指向直接包含该文字的元素，命中的每个元素都会被替换；子元素（如图标）保持不变。',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['selector', 'text'],
              properties: {
                selector: { type: 'string', minLength: 1, maxLength: 1000 },
                text: { type: 'string', maxLength: 20000 },
              },
            },
          },
        },
      ),
      tool('undo', '撤销当前标签页的预览修改。', { editId: { type: 'string' } }),
      tool('navigate', '在当前标签页打开HTTP(S)地址。', { url: { type: 'string' } }, ['url']),
      tool('click', '点击当前snapshot/query中的精确元素。', { ref }, ['ref']),
      tool('fill', '填写当前元素引用对应的文本输入框。', { ref, value: { type: 'string' } }, [
        'ref',
        'value',
      ]),
      tool('select', '选择下拉框的option value。', { ref, value: { type: 'string' } }, [
        'ref',
        'value',
      ]),
      tool(
        'press',
        '发送Enter、Tab、Escape、Backspace或方向键。',
        {
          key: {
            type: 'string',
            enum: [
              'Enter',
              'Tab',
              'Escape',
              'Backspace',
              'ArrowUp',
              'ArrowDown',
              'ArrowLeft',
              'ArrowRight',
            ],
          },
        },
        ['key'],
      ),
      tool(
        'scroll',
        '滚动当前标签页。',
        { deltaY: { type: 'number', minimum: -1500, maximum: 1500 } },
        ['deltaY'],
      ),
      tool('diagnostics', '读取当前标签页console和网络摘要，不包含请求正文。'),
    ];
  }
  callTool(name: string, args: unknown): Promise<ToolResult> {
    const generation = this.leaseGeneration,
      capturedTab = this.activeTabId;
    return this.serialize(async () => {
      try {
        this.activeTab();
        if (!args || typeof args !== 'object' || Array.isArray(args))
          throw new Error('Tool arguments must be an object');
        const input = args as Record<string, unknown>,
          definition = this.getTools().find((tool) => tool.name === name);
        if (!definition) throw new Error('Unknown browser tool');
        const properties = definition.inputSchema.properties as Record<string, unknown>;
        if (Object.keys(input).some((key) => !(key in properties)))
          throw new Error('Unexpected browser tool argument');
        if (
          input.tabId !== undefined &&
          (typeof input.tabId !== 'string' || input.tabId.length > 200)
        )
          throw new Error('tabId is invalid');
        const assertLease = () => {
          if (!this.agentAllowed || generation !== this.leaseGeneration)
            throw new Error(
              '用户正在操作页面。请重新读取当前页面，再按新状态继续；不要重放未核对的动作。',
            );
        };
        const observed = async (operation: Promise<ToolResult>): Promise<ToolResult> => {
          const result = await operation;
          if (generation !== this.leaseGeneration)
            throw new Error('观察期间页面被用户操作，请重新读取当前页面。');
          if (this.agentNeedsObservation && !result.isError && !this.sharedTab)
            this.allowAgentControl();
          return result;
        };
        const json = (value: unknown): ToolResult => ({ text: JSON.stringify(value, null, 2) });
        if (name === 'workbench_browser_tabs')
          return json({ activeTabId: this.activeTabId, tabs: this.listTabs() });
        if (name === 'workbench_browser_new_tab') {
          assertLease();
          if (input.url !== undefined && typeof input.url !== 'string')
            throw new Error('url is invalid');
          return json(
            await this.createTab(
              input.url === undefined ? 'about:blank' : normalizeBrowserUrl(input.url),
              'agent',
              assertLease,
            ),
          );
        }
        if (name === 'workbench_browser_switch_tab') {
          assertLease();
          const target = typeof input.tabId === 'string' && this.tabs.get(input.tabId);
          if (!target) throw new Error('标签页不存在');
          await this.activateTab(target, 'agent');
          return json({ activeTabId: this.activeTabId, tabs: this.listTabs() });
        }
        if (name === 'workbench_browser_close_tab') {
          assertLease();
          if (typeof input.tabId !== 'string') throw new Error('tabId is required');
          await this.closeTabInternal(input.tabId, 'agent');
          return json({ activeTabId: this.activeTabId, tabs: this.listTabs() });
        }
        const tab = this.requireActive(typeof input.tabId === 'string' ? input.tabId : capturedTab);
        if (name === 'workbench_browser_snapshot')
          return await observed(this.snapshotInternal(tab));
        if (name === 'workbench_browser_screenshot') return await this.screenshotInternal(tab);
        if (name === 'workbench_browser_diagnostics') return json(tab.diagnostics);
        if (name === 'workbench_browser_query') {
          const { tabId: _, ...query } = input;
          return await observed(
            this.queryInternal(tab, query as ElementQuery & { frameId?: string }).then(json),
          );
        }
        if (name === 'workbench_browser_controls') {
          assertLease();
          if (typeof input.ref !== 'string' || this.state.selectedElement?.ref !== input.ref)
            throw new Error('面板只能用于当前选中元素');
          await this.resolveRef(input.ref);
          const controls = validateElementControls(input.components);
          this.update({ elementControls: { ref: input.ref, revision: randomUUID(), controls } });
          return json({
            created: true,
            protocol: 'A2UI v0.9.1',
            message: '调整面板已显示，用户操作控件后才会修改页面。',
          });
        }
        if (name === 'workbench_browser_inspect') {
          if (typeof input.ref !== 'string') throw new Error('ref is required');
          return await observed(this.detailsInternal(input.ref).then(json));
        }
        assertLease();
        if (name === 'workbench_browser_navigate') {
          if (typeof input.url !== 'string') throw new Error('url is required');
          await this.navigateInternal(tab, normalizeBrowserUrl(input.url), 'agent');
          return { text: '页面正在加载，继续前请重新获取 snapshot。' };
        }
        if (name === 'workbench_browser_edit') {
          if (typeof input.ref !== 'string') throw new Error('ref is required');
          return json(
            await this.editInternal(
              input.ref,
              {
                ...(input.text !== undefined ? { text: input.text as string } : {}),
                ...(input.styles !== undefined
                  ? { styles: input.styles as Record<string, string> }
                  : {}),
                ...(input.animation !== undefined
                  ? { animation: input.animation as ElementAnimation | null }
                  : {}),
                ...(input.insert !== undefined ? { insert: input.insert as ElementInsertion } : {}),
              },
              'agent',
              assertLease,
            ),
          );
        }
        if (name === 'workbench_browser_restyle') {
          if (input.css !== undefined && typeof input.css !== 'string')
            throw new Error('css is invalid');
          if (input.texts !== undefined && !Array.isArray(input.texts))
            throw new Error('texts is invalid');
          return json(
            await this.restyleInternal(
              tab,
              {
                ...(input.css !== undefined ? { css: input.css as string } : {}),
                ...(input.texts !== undefined
                  ? { texts: input.texts as Array<{ selector: string; text: string }> }
                  : {}),
              },
              'agent',
              assertLease,
            ),
          );
        }
        if (name === 'workbench_browser_undo') {
          if (input.editId !== undefined && typeof input.editId !== 'string')
            throw new Error('editId is invalid');
          const undone = await this.undoInternal(
            tab,
            input.editId as string | undefined,
            'agent',
            assertLease,
          );
          return json(undone.page ? { editId: undone.editId, page: true, undone: true } : undone);
        }
        if (
          [
            'workbench_browser_click',
            'workbench_browser_fill',
            'workbench_browser_select',
          ].includes(name)
        ) {
          if (typeof input.ref !== 'string') throw new Error('ref is required');
          const { frame, scope } = await this.resolveRef(input.ref);
          await this.setSource(tab, 'agent', frame);
          assertLease();
          const point = await this.inputPoint(tab, frame, scope.localRef, assertLease);
          if (name === 'workbench_browser_click') {
            await tab.page.call('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              button: 'left',
              clickCount: 1,
              ...point,
            });
            await tab.page.call('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              button: 'left',
              clickCount: 1,
              ...point,
            });
          } else {
            if (typeof input.value !== 'string' || input.value.length > 20_000)
              throw new Error('value must be a string of at most 20,000 characters');
            if (name === 'workbench_browser_fill') {
              await this.bridge(
                tab,
                frame,
                `globalThis.__workbenchPage.focus(${JSON.stringify(scope.localRef)})`,
                assertLease,
              );
              assertLease();
              await tab.page.call('Input.insertText', { text: input.value });
            } else
              await this.bridge(
                tab,
                frame,
                `globalThis.__workbenchPage.select(${JSON.stringify(scope.localRef)},${JSON.stringify(input.value)})`,
                assertLease,
              );
          }
        } else if (name === 'workbench_browser_press') {
          const keys: Record<string, number> = {
            Enter: 13,
            Tab: 9,
            Escape: 27,
            Backspace: 8,
            ArrowUp: 38,
            ArrowDown: 40,
            ArrowLeft: 37,
            ArrowRight: 39,
          };
          if (typeof input.key !== 'string' || !Object.hasOwn(keys, input.key))
            throw new Error('Unsupported key');
          await this.setSource(tab, 'agent');
          assertLease();
          await tab.page.call('Input.dispatchKeyEvent', {
            type: 'rawKeyDown',
            key: input.key,
            code: input.key,
            windowsVirtualKeyCode: keys[input.key],
          });
          await tab.page.call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: input.key,
            code: input.key,
            windowsVirtualKeyCode: keys[input.key],
          });
        } else if (name === 'workbench_browser_scroll') {
          if (
            typeof input.deltaY !== 'number' ||
            !Number.isFinite(input.deltaY) ||
            Math.abs(input.deltaY) > 1500
          )
            throw new Error('deltaY must be between -1500 and 1500');
          await this.setSource(tab, 'agent');
          assertLease();
          await tab.page.call('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: this.width / 2,
            y: this.height / 2,
            deltaX: 0,
            deltaY: input.deltaY,
          });
        }
        return { text: '操作已执行，请用 snapshot 或 screenshot 核对实际结果。' };
      } catch (error) {
        return {
          text: redactBrowserText(error instanceof Error ? error.message : error),
          isError: true,
        };
      }
    });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.frameRefreshTimer);
    this.revokeAgentControl();
    this.recording = undefined;
    this.releaseFrames();
    for (const tab of this.tabs.values()) {
      for (const child of tab.children) child.close();
      tab.page.close();
    }
    this.tabs.clear();
    this.refs.clear();
    this.pendingDialogs.clear();
    this.activeTabId = '';
    const child = this.process;
    this.process = undefined;
    const exited =
      child?.pid && child.exitCode === null && child.signalCode === null
        ? new Promise<void>((resolve) => child.once('exit', () => resolve()))
        : Promise.resolve();
    try {
      await this.browser?.call('Browser.close');
    } catch {}
    this.browser?.close();
    this.browser = undefined;
    // Let Chromium flush the owned profile before another instance can reuse it.
    if (child?.pid) {
      await Promise.race([exited, wait(2000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([exited, wait(500)]);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([exited, wait(500)]);
      }
      if (child.exitCode === null && child.signalCode === null)
        throw new Error('无法确认浏览器已停止，请先检查运行状态');
    }
    this.update({
      status: 'stopped',
      loading: false,
      recording: false,
      inspecting: false,
      selectedElement: undefined,
    });
  }
}
