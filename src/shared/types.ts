import type { ElementControlSurface } from './element-controls';
import type { PageHint } from './page-hints';
import type { WorkspaceSkill } from './skills';
import type { TaskSelection } from './access';
import type { RecordingWorkflow } from './recording-workflow';
export type AgentId = 'codex' | 'claude' | 'opencode' | 'gemini' | 'pi' | 'cursor' | 'kimi';
export interface AgentInfo {
  id: AgentId;
  name: string;
  available: boolean;
  supported: boolean;
  path?: string;
  version?: string;
  detail?: string;
}
export type CodexUpdateStatus =
  | { status: 'unknown' }
  | {
      status: 'available' | 'current';
      installedVersion: string;
      latestVersion: string;
      releaseUrl: string;
    };
export interface ElementRef {
  ref: string;
  tabId?: string;
  frameId?: string;
  documentId?: string;
  nodeId?: string;
  tag: string;
  role?: string;
  semantics?: {
    kind: string;
    source: 'accessibility' | 'html' | 'aria' | 'inferred' | 'unknown';
    evidence: string[];
  };
  backendNodeId?: number;
  name: string;
  selector?: string;
  text?: string;
  editableText?: boolean;
  editReason?: string;
  value?: string;
  shadowPath?: string[];
  bounds?: { x: number; y: number; width: number; height: number };
}

export const ELEMENT_STYLE_PROPERTIES = [
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration',
  'white-space',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-width',
  'border-style',
  'border-radius',
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'display',
  'box-sizing',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'z-index',
  'overflow',
  'overflow-x',
  'overflow-y',
  'object-fit',
  'object-position',
  'aspect-ratio',
  'opacity',
  'gap',
  'row-gap',
  'column-gap',
  'flex-direction',
  'flex-wrap',
  'flex',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'order',
  'justify-content',
  'align-items',
  'align-content',
  'align-self',
  'justify-items',
  'justify-self',
  'place-items',
  'grid-template-columns',
  'grid-template-rows',
  'grid-auto-columns',
  'grid-auto-rows',
  'grid-auto-flow',
  'grid-column',
  'grid-row',
  'text-overflow',
  'text-transform',
  'overflow-wrap',
  'word-break',
  'background',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'box-shadow',
  'text-shadow',
  'transform',
  'transform-origin',
  'filter',
] as const;
export const ELEMENT_ANIMATION_PROPERTIES = [
  'transform',
  'opacity',
  'box-shadow',
  'filter',
  'color',
  'background-color',
] as const;
export const ELEMENT_BACKGROUND_FUNCTIONS = [
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
  'calc',
  'min',
  'max',
  'clamp',
] as const;
export const ELEMENT_PREVIEW_LIMITS = {
  styleCount: 30,
  styleValueLength: 500,
  keyframesMin: 2,
  keyframesMax: 12,
  durationMin: 100,
  durationMax: 60_000,
  iterationsMax: 100,
  easingLength: 200,
  stepsMax: 1000,
} as const;
export const ELEMENT_UNSAFE_CSS_PATTERN = String.raw`(?:url|image-set|-webkit-image-set|var|attr|paint|expression)\s*\(|javascript\s*:|!\s*important|\/\*|\*\/|@|[;{}<>\\]`;

export interface ElementAnimation {
  keyframes: Array<{ offset?: number; styles: Record<string, string> }>;
  duration: number;
  iterations?: number | 'infinite';
  easing?: string;
  direction?: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
}
export interface ElementDetails extends ElementRef {
  documentId: string;
  layout?: {
    parentDisplay: string;
    parentDirection?: string;
    parentColumns?: string;
    childCount: number;
    previous?: ElementRef;
    next?: ElementRef;
  };
  textContent: string;
  editableText: boolean;
  editReason?: string;
  attributes: Record<string, string>;
  computed: Record<string, string>;
  ancestors: ElementRef[];
  shadowPath: string[];
  animation?: ElementAnimation | null;
  animationState?: 'running' | 'paused' | 'finished' | 'idle' | 'reduced-motion';
}
export interface ElementQuery {
  selector?: string;
  text?: string;
  role?: string;
  exact?: boolean;
  limit?: number;
}
export interface ElementQueryResult {
  documentId: string;
  elements: ElementRef[];
  truncated: boolean;
}
export interface ElementEdit {
  text?: string;
  styles?: Record<string, string>;
  animation?: ElementAnimation | null;
  insert?: ElementInsertion;
  /** A page-level preview: a stylesheet for the whole document rather than one element. */
  sheet?: string;
  /** Text replacements by selector that belong to a page-level preview. */
  texts?: Array<{ selector: string; text: string }>;
}
export const ELEMENT_INSERT_TAGS = [
  'div',
  'span',
  'p',
  'section',
  'article',
  'header',
  'footer',
  'nav',
  'main',
  'aside',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'a',
  'button',
  'img',
  'strong',
  'em',
  'small',
  'label',
  'input',
  'textarea',
  'select',
  'option',
  'details',
  'summary',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'br',
  'hr',
] as const;
export const ELEMENT_INSERT_ATTRIBUTES = [
  'id',
  'class',
  'role',
  'aria-label',
  'aria-describedby',
  'aria-hidden',
  'title',
  'alt',
  'href',
  'src',
  'type',
  'placeholder',
  'value',
  'disabled',
  'readonly',
  'checked',
  'selected',
  'open',
  'for',
  'colspan',
  'rowspan',
] as const;
export interface ElementNode {
  tag: (typeof ELEMENT_INSERT_TAGS)[number];
  text?: string;
  attributes?: Record<string, string>;
  styles?: Record<string, string>;
  children?: ElementNode[];
}
export interface ElementInsertion {
  position?: 'append' | 'prepend' | 'before' | 'after';
  node: ElementNode;
}
export interface ElementEditResult {
  editId: string;
  element: ElementDetails;
  /** The edit belongs to the whole page; element is the document root and is not selected. */
  page?: boolean;
}
export interface ElementPreview {
  actor?: BrowserActor;
  editId: string;
  tabId: string;
  frameId: string;
  documentId: string;
  nodeId: string;
  changes: ElementEdit;
}
/** One preview the page currently shows, as it goes into a record of the changes. */
export interface PageChange {
  editId: string;
  by: 'user' | 'agent';
  /** A page-level restyle rather than a change of one element. */
  page?: boolean;
  /** The element as it is now; absent when the page has since replaced it. */
  element?: { tag: string; name: string; selector?: string; text?: string };
  changes: ElementEdit;
}
export interface BrowserActor {
  id: string;
  name: string;
}
export interface RecordedStep {
  actor?: BrowserActor;
  id: string;
  kind:
    | 'navigate'
    | 'click'
    | 'fill'
    | 'select'
    | 'key'
    | 'scroll'
    | 'edit'
    | 'undo'
    | 'control'
    | 'download'
    | 'feedback';
  description: string;
  timestamp: number;
  url: string;
  source: 'human' | 'agent' | 'page';
  target?: Partial<ElementRef>;
  value?: string;
  tabId?: string;
  frameId?: string;
  editId?: string;
  /** Visible row heading at the time of the action. */
  scopeText?: string;
  /** Committed state from a non-sensitive native checkbox/radio input event. */
  checked?: boolean;
  feedback?: { role: 'alert' | 'status'; text: string };
  outcome?: {
    kind: 'download';
    status: 'started' | 'completed' | 'canceled' | 'unknown';
    origin: 'link' | 'page';
  };
}
export interface Recording {
  practice?: {
    target: string;
    status: 'guiding' | 'stopped' | 'finished';
    progress: { note: string; status: 'pending' | 'current' | 'done' | 'skipped' }[];
    verification: 'unknown' | 'passed' | 'failed';
    detail: string;
  };
  sharedSessionId?: string;
  part?: number;
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  steps: RecordedStep[];
  truncated?: boolean;
  summary?: string;
  workflow?: RecordingWorkflow;
}
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** What Athena can do with this page, worked out when the page was read on load. */
  hints?: PageHint[];
}
export interface BrowserState {
  viewport?: BrowserViewport & { epoch: number };
  status: 'missing' | 'starting' | 'ready' | 'error' | 'stopped';
  engine: 'agent-browser';
  tabs: BrowserTab[];
  activeTabId?: string;
  binaryPath?: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  recording: boolean;
  inspecting: boolean;
  selectedElement?: ElementRef;
  previewEdits?: ElementPreview[];
  /** The preview edits of the active page in order, for moving back and forth through them. */
  timeline?: EditTimeline;
  elementControls?: ElementControlSurface;
  error?: string;
}
export const EDIT_TIMELINE_KINDS = ['text', 'style', 'animation', 'insert', 'restyle', 'layout'] as const;
export interface EditTimelineEntry {
  id: string;
  kind: (typeof EDIT_TIMELINE_KINDS)[number];
  /** What the edited element is called on the page; empty for a change to the whole page. */
  name: string;
  by: 'human' | 'agent';
  at: number;
}
export interface EditTimeline {
  /** How many of the entries the page currently shows, counted from the oldest. */
  position: number;
  entries: EditTimelineEntry[];
  /** Why the page could not move all the way to the requested position. */
  blocked?: string;
}
/** Page data arrives as text from the page's own script: keep only what the shape allows. */
export function readEditTimeline(value: unknown): EditTimeline | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { position, entries, blocked } = value as Record<string, unknown>;
  if (!Array.isArray(entries) || entries.length > 500) return undefined;
  const list: EditTimelineEntry[] = [];
  for (const item of entries) {
    if (!item || typeof item !== 'object') return undefined;
    const { id, kind, name, by, at } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id.length > 200) return undefined;
    if (!EDIT_TIMELINE_KINDS.includes(kind as EditTimelineEntry['kind'])) return undefined;
    list.push({
      id,
      kind: kind as EditTimelineEntry['kind'],
      name: typeof name === 'string' ? name.slice(0, 60) : '',
      by: by === 'agent' ? 'agent' : 'human',
      at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
    });
  }
  if (!Number.isSafeInteger(position) || (position as number) < 0 || (position as number) > list.length)
    return undefined;
  return {
    position: position as number,
    entries: list,
    ...(typeof blocked === 'string' && blocked ? { blocked: blocked.slice(0, 200) } : {}),
  };
}
export interface WebExecutorState {
  status: 'stopped' | 'starting' | 'ready' | 'error';
  version?: string;
  error?: string;
}
export interface WebSessionSummary {
  sessionId: string;
  name?: string;
  label?: string;
  site?: string;
  taskSummary?: string;
  startedAt: number;
  durationMs?: number;
  dispatchCount: number;
  status: string;
  errorCount?: number;
}
export interface WebSessionDetail {
  session: WebSessionSummary;
  dispatches: Array<{
    dispatchId: number;
    createdAt: number;
    toolName: string;
    pageId?: number;
    targetId?: string;
    title?: string;
    argsJson?: string;
    resultMeta?: string;
    durationMs?: number;
    parentDispatchId?: string;
  }>;
}
export interface BrowserFrame {
  sequence?: number;
  epoch?: number;
  capturedAt?: number;
  data: string;
  width: number;
  height: number;
  tabId?: string;
}
export interface BrowserViewport {
  width: number;
  height: number;
  tabId?: string;
  limited?: boolean;
}
export type BrowserInput = (
  | {
      type: 'mouse';
      action: 'move' | 'down' | 'up' | 'leave';
      x: number;
      y: number;
      button?: 'left' | 'middle' | 'right';
      buttons?: number;
      clickCount?: number;
      modifiers?: number;
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | {
      type: 'key';
      action: 'down' | 'up';
      key: string;
      code: string;
      keyCode?: number;
      modifiers?: number;
      text?: string;
    }
  | { type: 'text'; text: string }
  | { type: 'resize'; width: number; height: number }
) & { tabId?: string; frameEpoch?: number };
export interface BrowserTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ToolResult {
  text: string;
  execution?: 'not_executed' | 'completed' | 'unknown';
  image?: string;
  images?: string[];
  isError?: boolean;
}
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  status: 'running' | 'done' | 'error';
  output?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  exitCode?: number;
}
export interface AgentPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
  /** When the host first saw this step leave pending; orders it among the turn's actions. */
  startedAt?: number;
}
/** Public execution facts, never private model reasoning or estimated progress. */
export interface WebExecutionEvent {
  id: string;
  taskId: string;
  at: number;
  kind:
    | 'started'
    | 'plan'
    | 'operation'
    | 'control'
    | 'observation'
    | 'checkpoint'
    | 'recovery'
    | 'human-help'
    | 'artifact'
    | 'cancelled'
    | 'finished';
  status: 'running' | 'succeeded' | 'failed' | 'blocked';
  operationId?: string;
  control?: { scope: 'viewport' | 'interaction'; reason: string };
  tool?: string;
  page?: number;
  durationMs?: number;
  observationId?: string;
  outcome?: 'verified' | 'not_applied' | 'unknown';
  summary?: string;
  evidence?: string;
  artifact?: { path: string; bytes: number; sha256: string; mimeType?: string };
  plan?: AgentPlanStep[];
}
export interface ApprovalRequest {
  id: string;
  title: string;
  detail: string;
  kind: 'command' | 'file' | 'other';
  action?: 'browser-script' | 'browser-upload' | 'browser-help' | 'browser-guide';
  /** The command or file the approval is about, shown once the request has been handled. */
  target?: string;
  /** The steps of a guide the user is being walked through on the page, and how far they are. */
  guide?: { steps: Array<{ note: string; status: 'pending' | 'current' | 'done' | 'skipped' }> };
}
export interface UserInputRequest {
  id: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isSecret: boolean;
    isOther?: boolean;
    options?: Array<{ label: string; description: string }>;
  }>;
}
export type PendingAgentRequest =
  | { conversationId: string; messageId: string; kind: 'approval'; request: ApprovalRequest }
  | { conversationId: string; messageId: string; kind: 'input'; request: UserInputRequest };
export type AgentEvent =
  | {
      type: 'run-started';
      threadId: string;
      turnId: string;
      model: import('./usage').ExecutionModel;
      baseline?: import('./usage').TokenCounts;
    }
  | {
      type: 'usage';
      threadId: string;
      turnId: string;
      total: import('./usage').TokenCounts;
      last: import('./usage').TokenCounts;
    }
  | { type: 'model'; threadId: string; turnId: string; model: import('./usage').ExecutionModel }
  | { type: 'delta'; text: string }
  | { type: 'tool-preparing'; name: string }
  | { type: 'tool'; call: ToolCall }
  | { type: 'plan'; steps: AgentPlanStep[]; at: number }
  | { type: 'web-execution'; event: WebExecutionEvent }
  | {
      type: 'status';
      status: 'starting' | 'thinking' | 'working' | 'waiting' | 'idle';
      label?: string;
      delivery?: import('./phase').CodexDelivery;
      /** Set by the host; `status` and `label` stay for consumers that predate phases. */
      phase?: import('./phase').TurnPhase;
    }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'user-input'; request: UserInputRequest }
  | { type: 'request-resolved'; id: string; resolved?: import('./phase').ResolvedRequest }
  | { type: 'complete'; text?: string; sessionId?: string; phase?: import('./phase').TurnPhase }
  | { type: 'error'; message: string; phase?: import('./phase').TurnPhase };
/** A page element the user embedded in a message as an inline token such as [ele1]. */
export interface ElementMention {
  token: string;
  ref: string;
  tag: string;
  name: string;
  role?: string;
  /** Preview edit made in the inspector that the user wants carried into source. */
  edit?: ElementEdit;
}
export interface ChatMessage {
  /** This turn was handled by a local reversible layout action and did not invoke a model. */
  localPreview?: true;
  files?: string[];
  id: string;
  role: 'user' | 'assistant';
  text: string;
  displayText?: string;
  createdAt: number;
  status?: 'streaming' | 'done' | 'error';
  source?: 'desktop' | 'feishu';
  tools?: ToolCall[];
  context?: string;
  mentions?: ElementMention[];
  // shortcut: images live in workspace.json; use separate blobs when large image histories are needed.
  images?: import('./images').ImageAttachment[];
  webSessionId?: string;
  plan?: AgentPlanStep[];
  execution?: WebExecutionEvent[];
  model?: import('./usage').ExecutionModel;
  failure?: string;
  /** Last phase of the turn; the only source for status display. */
  phase?: import('./phase').TurnPhase;
  endedAt?: number;
  /** Requests the user already handled during this turn. */
  requests?: import('./phase').ResolvedRequest[];
}
export interface Conversation {
  id: string;
  /** Subsequent questions in this conversation are limited to this recording. */
  recordingId?: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
  /** Missing on legacy conversations means Codex, never the current default. */
  agent?: AgentId;
  modelSelection?: import('./usage').ModelSelection;
  agentSessionId?: string;
  agentToolsFingerprint?: string;
  previousAgentSessionIds?: string[];
  workspace?: string;
  selectedSkills?: string[];
  skillUsage?: import('./skills').SkillUsage[];
  remoteChatId?: string;
  /** Explicit task capabilities; absent on legacy conversations. */
  selection?: TaskSelection;
  /** MCP capabilities selected independently from Skills. */
  mcpSelection?: string[];
  /** 归档时间。缺省表示未归档；归档只是从主列表收起，记录本身保留。 */
  archivedAt?: number;
}
/** 归档的对话保留全部记录，但不出现在主列表，也不再准备连接或接收新任务。 */
export function isArchived(conversation: Pick<Conversation, 'archivedAt'>): boolean {
  return conversation.archivedAt !== undefined;
}
export interface FeishuState {
  status: 'restoring' | 'disconnected' | 'configuring' | 'connecting' | 'connected' | 'error';
  hasSavedCredentials?: boolean;
  restoreFailed?: boolean;
  appId?: string;
  botName?: string;
  paired: boolean;
  pairingCode?: string;
  setupUrl?: string;
  setupQr?: string;
  error?: string;
  lastMessageAt?: number;
}
export interface FeishuMessage {
  id: string;
  text: string;
  senderId: string;
  chatId: string;
  timestamp: number;
  /** Written in a group chat with the bot mentioned; the reply goes to that group. */
  group?: boolean;
}
export interface Settings {
  workspace: string;
  /** Personal conversations use an app-owned directory, without selecting a project. */
  workspaceMode?: 'project' | 'personal';
  browserPath?: string;
  knowledgeRoot?: string;
  agent: AgentId;
  modelSelection?: import('./usage').ModelSelection;
  modelSelections?: Partial<Record<AgentId, import('./usage').ModelSelection>>;
  /** References only; connection secrets remain in their original CLI configuration. */
  localMcpEnabled?: string[];
  localMcpReview?: string[];
  pagePreview?: boolean;
}
export interface CodexConnectionState {
  status: 'idle' | 'starting' | 'ready' | 'error';
  conversationId?: string;
  message?: string;
}
export interface AppSnapshot {
  sandboxViews?: import('./sandbox').LocalSandboxView[];
  sandboxPip?: import('./sandbox').SandboxPipState;
  sandboxPips?: import('./sandbox').SandboxPipState[];
  onboarding?: import('./onboarding').OnboardingState;
  localUser?: { name: string };
  settings: Settings;
  agents: AgentInfo[];
  skills?: WorkspaceSkill[];
  providerSkills?: import('./skills').ProviderSkill[];
  providerSkillDiscovery?: import('./skills').ProviderSkillDiscovery;
  localMcp?: import('./local-mcp').LocalMcpState;
  codexConnection?: CodexConnectionState;
  browser: BrowserState;
  web?: WebExecutorState;
  feishu: FeishuState;
  conversations: Conversation[];
  recordings: Recording[];
  browserFrame?: BrowserFrame;
  pendingRequests?: PendingAgentRequest[];
  pendingExternalConnections?: Array<{
    id: string;
    agent: { id: string; name: string };
    requestedMode: import('./access').AccessMode;
    status: string;
    mode?: import('./access').AccessMode;
  }>;
  share?: import('./share').ShareState;
  learning?: import('./learning').LearningState;
  queue?: import('./queue').MessageQueueState;
}
export type AppEvent =
  | { type: 'local-mcp:state'; state: import('./local-mcp').LocalMcpState }
  | { type: 'sandbox:state'; state: import('./sandbox').LocalSandboxView }
  | { type: 'sandbox:instances'; state: import('./sandbox').SandboxInstancesState }
  | {
      type: 'sandbox:pip';
      state?: import('./sandbox').SandboxPipState;
      states?: import('./sandbox').SandboxPipState[];
    }
  | { type: 'onboarding:state'; state: import('./onboarding').OnboardingState }
  | { type: 'codex:state'; state: CodexConnectionState }
  | { type: 'usage:updated' }
  | { type: 'share:state'; state: import('./share').ShareState }
  | { type: 'learning:state'; state: import('./learning').LearningState }
  | { type: 'queue:state'; state: import('./queue').MessageQueueState }
  | { type: 'browser:state'; state: BrowserState }
  | { type: 'web:state'; state: WebExecutorState }
  | { type: 'browser:frame'; frame: BrowserFrame }
  | { type: 'browser:step'; step: RecordedStep }
  | { type: 'browser:selected'; element: ElementRef; reason?: 'pick' | 'edit' }
  | { type: 'recording:saved'; recording: Recording }
  | { type: 'agent:event'; conversationId: string; messageId: string; event: AgentEvent }
  | { type: 'feishu:state'; state: FeishuState }
  | { type: 'conversation:updated'; conversation: Conversation }
  | { type: 'notice'; message: string; level: 'info' | 'error' }
  | { type: 'mcp:connections'; connections: AppSnapshot['pendingExternalConnections'] };
export interface WorkbenchBridge {
  droppedWorkspaceFiles(workspace: string, files: File[]): Promise<string[]>;
  invoke<T = unknown>(action: string, payload?: unknown): Promise<T>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
declare global {
  interface Window {
    workbench: WorkbenchBridge;
  }
}
