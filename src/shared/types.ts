import type { ElementControlSurface } from './element-controls';
export type AgentId = 'codex' | 'claude' | 'opencode' | 'gemini' | 'pi' | 'cursor';
export interface AgentInfo {
  id: AgentId;
  name: string;
  available: boolean;
  supported: boolean;
  path?: string;
  version?: string;
  authentication?: 'ready' | 'missing' | 'unknown';
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
  value?: string;
  shadowPath?: string[];
  bounds?: { x: number; y: number; width: number; height: number };
}

export const ELEMENT_STYLE_PROPERTIES = [
  'color',
  'background-color',
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
  'opacity',
  'gap',
  'row-gap',
  'column-gap',
  'flex-direction',
  'justify-content',
  'align-items',
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
}
export interface ElementEditResult {
  editId: string;
  element: ElementDetails;
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
export interface BrowserActor {
  id: string;
  name: string;
}
export interface RecordedStep {
  actor?: BrowserActor;
  id: string;
  kind: 'navigate' | 'click' | 'fill' | 'select' | 'key' | 'scroll' | 'edit' | 'undo' | 'control';
  description: string;
  timestamp: number;
  url: string;
  source: 'human' | 'agent';
  target?: Partial<ElementRef>;
  value?: string;
  tabId?: string;
  frameId?: string;
  editId?: string;
}
export interface Recording {
  sharedSessionId?: string;
  part?: number;
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  steps: RecordedStep[];
  summary?: string;
}
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}
export interface BrowserState {
  viewport?: BrowserViewport & { epoch: number };
  status: 'missing' | 'starting' | 'ready' | 'error' | 'stopped';
  engine: 'browseros';
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
  elementControls?: ElementControlSurface;
  error?: string;
}
export interface NativeNeoState {
  status: 'stopped' | 'starting' | 'ready' | 'error';
  version?: string;
  error?: string;
}
export interface NeoSessionSummary {
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
export interface NeoSessionDetail {
  session: NeoSessionSummary;
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
    | 'observation'
    | 'checkpoint'
    | 'recovery'
    | 'human-help'
    | 'artifact'
    | 'cancelled'
    | 'finished';
  status: 'running' | 'succeeded' | 'failed' | 'blocked';
  operationId?: string;
  tool?: string;
  page?: number;
  durationMs?: number;
  observationId?: string;
  outcome?: 'verified' | 'not_applied' | 'unknown';
  summary?: string;
  evidence?: string;
  artifact?: { path: string; bytes: number; sha256: string };
  plan?: AgentPlanStep[];
}
export interface ApprovalRequest {
  id: string;
  title: string;
  detail: string;
  kind: 'command' | 'file' | 'other';
  action?: 'browser-script' | 'browser-upload' | 'browser-help';
  /** The command or file the approval is about, shown once the request has been handled. */
  target?: string;
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
  | { type: 'tool'; call: ToolCall }
  | { type: 'plan'; steps: AgentPlanStep[]; at: number }
  | { type: 'web-execution'; event: WebExecutionEvent }
  | {
      type: 'status';
      status: 'starting' | 'thinking' | 'working' | 'waiting' | 'idle';
      label?: string;
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
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  status?: 'streaming' | 'done' | 'error';
  source?: 'desktop' | 'feishu';
  tools?: ToolCall[];
  context?: string;
  mentions?: ElementMention[];
  neoSessionId?: string;
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
  remoteChatId?: string;
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
}
export interface Settings {
  workspace: string;
  /** Personal conversations use an app-owned directory, without selecting a project. */
  workspaceMode?: 'project' | 'personal';
  browserPath?: string;
  agent: AgentId;
  modelSelection?: import('./usage').ModelSelection;
  modelSelections?: Partial<Record<AgentId, import('./usage').ModelSelection>>;
}
export interface CodexConnectionState {
  status: 'idle' | 'starting' | 'ready' | 'error';
  conversationId?: string;
  message?: string;
}
export interface AppSnapshot {
  onboarding?: import('./onboarding').OnboardingState;
  localUser?: { name: string };
  settings: Settings;
  agents: AgentInfo[];
  codexConnection?: CodexConnectionState;
  browser: BrowserState;
  neo?: NativeNeoState;
  feishu: FeishuState;
  conversations: Conversation[];
  recordings: Recording[];
  browserFrame?: BrowserFrame;
  pendingRequests?: PendingAgentRequest[];
  share?: import('./share').ShareState;
}
export type AppEvent =
  | { type: 'onboarding:state'; state: import('./onboarding').OnboardingState }
  | { type: 'codex:state'; state: CodexConnectionState }
  | { type: 'usage:updated' }
  | { type: 'share:state'; state: import('./share').ShareState }
  | { type: 'browser:state'; state: BrowserState }
  | { type: 'neo:state'; state: NativeNeoState }
  | { type: 'browser:frame'; frame: BrowserFrame }
  | { type: 'browser:step'; step: RecordedStep }
  | { type: 'browser:selected'; element: ElementRef; reason?: 'pick' | 'edit' }
  | { type: 'recording:saved'; recording: Recording }
  | { type: 'agent:event'; conversationId: string; messageId: string; event: AgentEvent }
  | { type: 'feishu:state'; state: FeishuState }
  | { type: 'conversation:updated'; conversation: Conversation }
  | { type: 'notice'; message: string; level: 'info' | 'error' };
export interface WorkbenchBridge {
  invoke<T = unknown>(action: string, payload?: unknown): Promise<T>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
declare global {
  interface Window {
    workbench: WorkbenchBridge;
  }
}
