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
  generatedImageDirectory?: string;
  validateGeneratedImage?: (bytes: Buffer) => boolean;
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
  /** A single bounded page insertion, isolated from files and general-purpose tools. */
  previewOnly?: boolean;
  /** Analyze a supplied recording without accessing the user's working environment. */
  evidenceOnly?: boolean;
}

export const previewInstructions =
  'Immediately call workbench_browser_edit once with the exact body ref provided. Insert one styled hero section (prepend), at most 8 nodes and 2000 JSON characters: brand name, headline, short copy and a button. Only the first viewport; leave all lower sections to the main assistant. Use real product copy matching the request, never placeholders, development notes or invented business results. Use compact inline styles; inherit typography from the root. No preamble, scripts, URLs, files, commands, Skills or other tools. After the tool succeeds reply only "首屏已呈现".';

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
  // Related elements have scoped refs; duplicating the selected tab/frame/document for each adds no grounding.
  const related = ({ ref, tag, role, selector, name, bounds, shadowPath }: ElementRef) => ({
    ref,
    tag,
    role,
    selector,
    name: name && name !== tag ? name.trim().slice(0, 100) : undefined,
    bounds,
    shadowPath: shadowPath?.length ? shadowPath : undefined,
  });
  const snapshot = JSON.stringify({
    ...current,
    ancestors: current.ancestors.map(related),
    layout: current.layout && {
      ...current.layout,
      previous: current.layout.previous && related(current.layout.previous),
      next: current.layout.next && related(current.layout.next),
    },
  }).replace(/</g, '\\u003c');
  if (snapshot.length > 60_000) throw new Error('所选元素的上下文过长，请选择更具体的元素');
  return snapshot;
}
