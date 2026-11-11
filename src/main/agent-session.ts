import type {
  AgentEvent,
  BrowserTool,
  ElementDetails,
  ElementRef,
  ToolResult,
} from '../shared/types';
import type { ModelOption, ModelSelection } from '../shared/usage';
import type { ImageAttachment } from '../shared/images';
import type { ProviderSkill, ProviderSkillDiscovery } from '../shared/skills';

/** Host boundary: adapters own their wire protocol, never the host's authorization. */
export interface AgentSessionOptions {
  workspace: string;
  executablePath: string;
  sessionId?: string;
  sessionDirectory?: string;
  permissionsExtensionPath?: string;
  sessionToolsFingerprint?: string;
  historyForToolUpgrade?: string;
  tools: BrowserTool[];
  inspectSelectedElement?: (ref: string) => Promise<ElementDetails>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  onEvent: (event: AgentEvent) => void;
  onClose?: (reason: string) => void;
}

export interface AgentSession {
  readonly sessionId: string | undefined;
  readonly toolsFingerprint: string | undefined;
  readonly replacedSessionId: string | undefined;
  readonly isReady: boolean;
  readonly isClosed: boolean;
  matchesConfiguration(workspace: string, executablePath: string, tools: BrowserTool[]): boolean;
  prepare(selection?: ModelSelection): Promise<void>;
  listModels(): Promise<ModelOption[]>;
  discoverProviderSkills(): Promise<ProviderSkillDiscovery>;
  send(
    text: string,
    context?: string,
    selectedElement?: ElementRef,
    selection?: ModelSelection,
    skills?: ProviderSkill[],
    images?: ImageAttachment[],
  ): Promise<void>;
  interrupt(): Promise<void>;
  resolveApproval(id: string, approved: boolean): void;
  resolveUserInput(id: string, answers: Record<string, string[]>): void;
  close(): void;
}

export async function selectedElementContext(
  selected: ElementRef | undefined,
  inspect: AgentSessionOptions['inspectSelectedElement'],
): Promise<string | undefined> {
  if (!selected) return;
  const initial = { ...selected };
  if (typeof initial.ref !== 'string' || !initial.ref || initial.ref.length > 2048 || !inspect)
    throw new Error('无法读取所选元素，请重新选择后重试');
  const current = await inspect(initial.ref);
  for (const key of ['ref', 'tabId', 'frameId', 'documentId', 'nodeId'] as const)
    if (initial[key] !== undefined && current[key] !== initial[key])
      throw new Error('所选元素已改变，请重新选择后重试');
  const snapshot = JSON.stringify(current).replace(/</g, '\\u003c');
  if (snapshot.length > 60_000) throw new Error('所选元素的上下文过长，请选择更具体的元素');
  return snapshot;
}
