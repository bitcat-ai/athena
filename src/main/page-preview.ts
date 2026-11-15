import { createAgentSession } from './agent-factory';
import type { AgentSession, AgentSessionOptions } from './agent-session';
import type { AgentEvent, AgentId, BrowserTool, ToolResult } from '../shared/types';
import type { ModelOption, ModelSelection } from '../shared/usage';

export const previewResultTool: BrowserTool = {
  name: 'workbench_preview_result',
  description:
    '等待本轮快速页面初稿并读取真实插入结果、ref 和 editId。初稿生成时可以规划其他工作；首次修改页面前读取此结果并在现有内容上继续，避免重复创建。初稿不是完整交付或源码。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export function wantsPagePreview(text: string): boolean {
  return (
    !/https?:\/\/|源码|仓库|写文件|部署|发布|不要|不必|别|只用|仅使用|先.{0,8}(?:分析|解释|讨论)|source code|repository|deploy|do not|don't|only use/i.test(
      text,
    ) &&
    /(?:创建|构建|生成|绘制|渲染|设计|做|搭建|build|create|draw|render|design).{0,80}(?:页面|网页|落地页|website|web\s?page|landing\s?page|\bui\b)/is.test(
      text,
    )
  );
}

export function fastPreviewModel(models: ModelOption[]): ModelSelection | undefined {
  // shortcut: only the measured native Sonnet route is enabled; benchmark new routes before adding them.
  const model = models.find((model) => model.model === 'sonnet');
  return (
    model && {
      model: model.model,
      ...(model.efforts.some((effort) => effort.id === 'low') ? { effort: 'low' } : {}),
    }
  );
}

export interface PreviewResult {
  agent: 'claude';
  status: 'rendered' | 'unavailable' | 'cancelled';
  requestedModel: string;
  actualModel?: string;
  startedAt: number;
  firstVisibleAt?: number;
  preparingAt?: number;
  result?: ToolResult;
  message?: string;
}

/** One writer owns the first insertion; callers await done before accessing that page. */
export class PagePreview {
  readonly done: Promise<PreviewResult>;
  settled = false;
  private session: Pick<AgentSession, 'send' | 'close' | 'resolveApproval' | 'resolveUserInput'>;
  private result: PreviewResult;
  constructor(options: {
    executablePath: string;
    workspace: string;
    selection: ModelSelection;
    request: string;
    ref: string;
    tabId: string;
    tool: BrowserTool;
    signal: AbortSignal;
    call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
    onEvent: (event: AgentEvent) => void;
    createSession?: (
      agent: AgentId,
      options: AgentSessionOptions,
    ) => Pick<AgentSession, 'send' | 'close' | 'resolveApproval' | 'resolveUserInput'>;
    timeoutMs?: number;
  }) {
    this.result = {
      agent: 'claude',
      status: 'unavailable',
      requestedModel: options.selection.model,
      startedAt: Date.now(),
    };
    let attempts = 0;
    const properties = options.tool.inputSchema.properties as Record<string, unknown>;
    const tool = {
      ...options.tool,
      description:
        '在已观测的 body 中插入可撤销的首屏预览。只传 ref 与 insert；用嵌套 node 和简短内联 styles，不使用 HTML 字符串。',
      inputSchema: {
        ...options.tool.inputSchema,
        properties: { ref: { type: 'string', const: options.ref }, insert: properties?.insert },
        required: ['ref', 'insert'],
      },
    };
    this.session = (options.createSession ?? createAgentSession)('claude', {
      workspace: options.workspace,
      executablePath: options.executablePath,
      tools: [tool],
      previewOnly: true,
      callTool: async (name, args) => {
        options.signal.throwIfAborted();
        if (
          this.settled ||
          this.result.result ||
          name !== 'workbench_browser_edit' ||
          ++attempts > 3
        )
          return { text: '初稿只允许一次成功插入。', isError: true };
        if (
          args.ref !== options.ref ||
          !args.insert ||
          args.text !== undefined ||
          args.styles !== undefined ||
          args.animation !== undefined
        )
          return { text: '仅允许在提供的 body ref 内插入首屏。', isError: true };
        const insertion = args.insert as { position?: string; node?: { children?: unknown[] } };
        let nodes = 0;
        const count = (node: any) => {
          nodes++;
          if (Array.isArray(node?.children)) node.children.forEach(count);
        };
        count(insertion.node);
        if (
          !insertion.node ||
          (insertion.position && insertion.position !== 'prepend') ||
          nodes > 8 ||
          JSON.stringify(args).length > 2000
        )
          return {
            text: '首屏限 8 个节点、2000 字符，使用 prepend；只做品牌、标题、短介绍和按钮，后续内容由主助手补充。',
            isError: true,
          };
        const result = await options.call(name, {
          ...args,
          tabId: options.tabId,
          insert: { ...insertion, position: 'prepend' },
        });
        options.signal.throwIfAborted();
        if (!result.isError) {
          this.result.status = 'rendered';
          this.result.result = result;
          this.result.firstVisibleAt = Date.now();
        }
        return result;
      },
      onEvent: (event) => {
        if (event.type === 'tool-preparing') this.result.preparingAt ??= Date.now();
        if (event.type === 'model') this.result.actualModel = event.model.model;
        if (event.type === 'run-started' && event.model.source !== 'unconfirmed')
          this.result.actualModel = event.model.model;
        if (event.type === 'approval') this.session.resolveApproval(event.request.id, false);
        else if (event.type === 'user-input') this.session.resolveUserInput(event.request.id, {});
        options.onEvent(event);
      },
    });
    const stop = () => this.session.close();
    options.signal.addEventListener('abort', stop, { once: true });
    const timeout = setTimeout(stop, options.timeoutMs ?? 25000);
    const session = this.session;
    const result = this.result;
    this.done = (async () => {
      try {
        options.signal.throwIfAborted();
        await session.send(
          options.request,
          `Create the first viewport now in this observed empty page. Exact body ref: ${options.ref}; tabId: ${options.tabId}. First call must insert the actual designed content, not a placeholder.`,
          undefined,
          options.selection,
        );
      } catch (error) {
        if (options.signal.aborted) result.status = 'cancelled';
        else if (!result.result) result.message = '快速初稿未生成，主助手继续处理';
      } finally {
        clearTimeout(timeout);
        options.signal.removeEventListener('abort', stop);
        session.close();
        this.settled = true;
      }
      return result;
    })();
  }
}
