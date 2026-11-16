// Shared with the existing sandbox picture-in-picture presentation.
export type SandboxTarget = 'default' | 'frontend' | 'backend';
export const SANDBOX_RUNTIMES: Record<SandboxTarget, string> = {
  frontend: 'Node 前端',
  backend: 'Java 后端',
  default: '基础 Node',
};
export interface LocalSandboxView {
  conversationId: string;
  target: SandboxTarget;
  /** Set for an instance the user created; its view follows the conversation that last used it. */
  instance?: string;
  connection: 'connecting' | 'ready' | 'reconnecting' | 'failed' | 'closed';
  name?: string;
  command?: { id: string; command: string; status: string; exitCode?: number };
  service?: { status: string; url?: string };
  lines: Array<{ kind: 'command' | 'stdout' | 'stderr' | 'status'; text: string }>;
}
/** What a conversation calls one of its sandboxes: the instance, or else the built-in target. */
export const sandboxKey = (view: Pick<LocalSandboxView, 'instance' | 'target'>): string =>
  view.instance ?? view.target;

/** How long sandboxes are kept. Applied by the host on a timer, never decided by a model. */
export interface SandboxPolicy {
  /** A running sandbox nobody used for this long is stopped; its files stay. */
  idleStopMinutes: number;
  /** A sandbox nobody used for this long is removed with its files, unless kept. */
  retainDays: number;
  maxRunning: number;
}
export const SANDBOX_POLICY_CHOICES = {
  idleStopMinutes: [15, 30, 60, 120],
  retainDays: [3, 7, 14, 30],
  maxRunning: [2, 4, 6, 8],
} as const;
export interface SandboxInstanceView {
  id: string;
  name: string;
  runtime: SandboxTarget;
  /** `legacy`: left by a conversation that no longer exists; it can only be removed. */
  origin: 'user' | 'agent' | 'legacy';
  conversationId?: string;
  createdAt: number;
  lastUsedAt: number;
  keep: boolean;
  status: 'starting' | 'running' | 'stopped' | 'failed';
  /** A command or a start is in progress. */
  busy: boolean;
  message?: string;
  previewUrl?: string;
  /** When the host stops it, respectively removes it, if nothing uses it before then. */
  stopsAt?: number;
  removesAt?: number;
}
export interface SandboxInstancesState {
  docker: { available: boolean; message?: string };
  policy: SandboxPolicy;
  instances: SandboxInstanceView[];
}
export interface SandboxPreviewState {
  workspaceId: string;
  slug: string;
  name: string;
  status: 'loading' | 'live' | 'error';
  frame?: string;
  width?: number;
  height?: number;
  title?: string;
  message?: string;
  at: number;
}
export interface SandboxPipState {
  conversationId: string;
  name?: string;
  status: { text: string; tone: 'ok' | 'busy' | 'off' | 'error' };
  running: boolean;
  frame?: string;
  frameTitle?: string;
  lines: LocalSandboxView['lines'];
  /** See `sandboxKey`. */
  target: string;
  runtime?: SandboxTarget;
  previewAvailable?: boolean;
}
