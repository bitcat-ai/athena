// Shared with the existing sandbox picture-in-picture presentation.
export type SandboxTarget = 'default' | 'frontend' | 'backend';
export interface LocalSandboxView {
  conversationId: string;
  target: SandboxTarget;
  connection: 'connecting' | 'ready' | 'reconnecting' | 'failed' | 'closed';
  name?: string;
  command?: { id: string; command: string; status: string; exitCode?: number };
  service?: { status: string; url?: string };
  lines: Array<{ kind: 'command' | 'stdout' | 'stderr' | 'status'; text: string }>;
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
  target: SandboxTarget;
  previewAvailable?: boolean;
}
