import type {
  AgentEvent,
  BrowserTool,
  ElementDetails,
  ElementRef,
  ToolResult,
} from '../shared/types';
import type { ModelOption, ModelSelection } from '../shared/usage';
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
  ): Promise<void>;
  interrupt(): Promise<void>;
  resolveApproval(id: string, approved: boolean): void;
  resolveUserInput(id: string, answers: Record<string, string[]>): void;
  close(): void;
}
