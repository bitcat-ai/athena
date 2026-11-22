import type { BrowserActor, BrowserFrame, BrowserState, RecordedStep, Recording } from './types';

export function shareInvitation(link: string, certificate = '') {
  const url = URL.canParse(link.trim()) ? new URL(link.trim()) : undefined;
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search
  )
    throw new Error('请输入主持人复制的完整 HTTPS 邀请链接');
  const params = new URLSearchParams(url.hash.slice(1));
  const invite = params.get('invite') ?? '';
  if (params.getAll('invite').length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(invite))
    throw new Error('邀请链接缺少有效的邀请码');
  const fingerprint = (params.get('fingerprint') ?? certificate)
    .trim()
    .replace(/:/g, '')
    .toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(fingerprint)) throw new Error('请填写主持人提供的 SHA-256 证书指纹');
  url.hash = new URLSearchParams({ invite }).toString();
  return { url: url.href, origin: url.origin, hostname: url.hostname, fingerprint };
}

export interface ShareParticipant extends BrowserActor {
  role: 'host' | 'viewer' | 'editor';
  status: 'pending' | 'connected' | 'disconnected';
  requestedControl?: boolean;
}
export interface ShareState {
  active: boolean;
  sessionId?: string;
  tabId?: string;
  title?: string;
  address?: string;
  fingerprint?: string;
  invite?: { url: string; expiresAt: number };
  participants: ShareParticipant[];
  controllerId: string;
  generation: number;
  changingControl?: boolean;
  error?: string;
}
export type ShareServerMessage =
  | { type: 'welcome'; participantId: string; resume: string }
  | { type: 'state'; state: ShareState; browser?: BrowserState; steps?: RecordedStep[] }
  | { type: 'frame'; frame: BrowserFrame }
  | { type: 'step'; step: RecordedStep }
  | { type: 'result'; id: number; value?: unknown; error?: string }
  | { type: 'ended'; recording?: Recording }
  | { type: 'error'; error: string };

// Deliberately narrower than workbench:invoke. Never add general host or Agent tools here.
export const SHARED_PAGE_ACTIONS = new Set([
  'browser:input',
  'browser:navigate',
  'browser:back',
  'browser:forward',
  'browser:reload',
  'browser:inspect',
  'browser:query',
  'browser:element',
  'browser:element-details',
  'browser:edit',
  'browser:preview-styles',
  'browser:commit-styles',
  'browser:undo',
]);
