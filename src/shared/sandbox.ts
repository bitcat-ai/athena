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
/** Where a sandbox runs: a container on this Mac, or a workspace on a Coder deployment. */
export type SandboxProvider = 'docker' | 'coder';
export interface CoderTemplateView {
  id: string;
  name: string;
}
export interface SandboxInstanceView {
  id: string;
  name: string;
  provider: SandboxProvider;
  /** The local environment; `default` for a Coder sandbox, whose template decides it. */
  runtime: SandboxTarget;
  /** Name of the Coder template the sandbox was created from. */
  template?: string;
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
/** The Coder deployment sandboxes can be created on, as the settings page shows it. */
export interface SandboxCoderState {
  /** An address and a token are stored. */
  connected: boolean;
  /** The deployment answered the last time it was asked. */
  available: boolean;
  origin?: string;
  username?: string;
  /** The address is plain HTTP, so the token and the traffic are not encrypted. */
  insecure?: boolean;
  message?: string;
  templates: CoderTemplateView[];
}
/** What a sandbox's environment is called in lists and in the agent's prompt. */
export const sandboxEnvironment = (
  instance: Pick<SandboxInstanceView, 'provider' | 'runtime' | 'template'>,
): string =>
  instance.provider === 'coder'
    ? `Coder · ${instance.template ?? '工作区'}`
    : SANDBOX_RUNTIMES[instance.runtime];
export interface SandboxInstancesState {
  docker: { available: boolean; message?: string };
  coder: SandboxCoderState;
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
