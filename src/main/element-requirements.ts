import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserTool, ElementDetails, ElementRef, ToolResult } from '../shared/types';
import type { SandboxArtifact } from './local-sandbox';

export const elementRequirementTool: BrowserTool = {
  name: 'workbench_prd_save',
  description:
    '在用户选中元素的改造任务中，将已实际显示的可撤销页面预览、用户原始要求、功能范围和验收条件保存为 PRD 文件。必须先通过 workbench_browser_edit 修改所选元素或在旁边插入元素，并观察结果；保存后才能进入沙箱源码实现。PRD 不代表功能已实现。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      requirements: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
      acceptance: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
      sources: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    },
    required: ['title', 'requirements', 'acceptance'],
    additionalProperties: false,
  },
};
export interface ElementRequirement {
  conversationId: string;
  turnId: string;
  userRequest: string;
  url: string;
  selected: ElementRef;
  preview?: {
    editId: string;
    at: number;
    changes: Record<string, unknown>;
    element: ElementDetails;
  };
  saved?: SandboxArtifact;
}

export function continueElementRequirement(
  previous: ElementRequirement | undefined,
  context: { conversationId: string; turnId: string; userRequest: string; url: string },
  selected?: ElementRef,
): ElementRequirement | undefined {
  if (
    selected &&
    (!previous || ![previous.selected.ref, previous.preview?.element.ref].includes(selected.ref))
  )
    return { ...context, selected: structuredClone(selected) };
  if (!previous) return;
  return {
    ...previous,
    turnId: context.turnId,
    userRequest: previous.userRequest + '\n\n用户补充：' + context.userRequest,
  };
}

export function recordRequirementPreview(
  requirement: ElementRequirement,
  args: Record<string, unknown>,
  result: ToolResult,
) {
  if (
    result.isError ||
    (args.ref !== requirement.selected.ref && args.ref !== requirement.preview?.element.ref)
  )
    return;
  let value;
  try {
    value = JSON.parse(result.text);
  } catch {
    return;
  }
  if (typeof value.editId !== 'string' || !value.element?.ref || !value.element?.documentId) return;
  requirement.preview = {
    editId: value.editId,
    at: Date.now(),
    changes: structuredClone(args),
    element: value.element,
  };
  requirement.saved = undefined;
}

export function assertRequirementRecorded(requirement?: ElementRequirement) {
  if (requirement?.preview && !requirement.saved)
    throw new Error(
      '页面预览已生成。请先调用 workbench_prd_save 保存本次需求和验收条件，再开始源码实现。',
    );
}

export async function saveElementRequirement(
  directory: string,
  requirement: ElementRequirement | undefined,
  args: Record<string, unknown>,
  inspect: (ref: string) => Promise<ElementDetails>,
  signal: AbortSignal,
): Promise<SandboxArtifact> {
  if (!requirement?.preview) throw new Error('尚无所选元素的成功页面预览，请先修改并观察页面。');
  const bounded = (value: unknown, max: number) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max)
      throw new Error('PRD 文本无效');
    return value.trim();
  };
  const list = (value: unknown, max: number, required = true) => {
    if (!Array.isArray(value) || value.length > max || (required && !value.length))
      throw new Error('PRD 条目无效');
    return value.map((item) => bounded(item, 2000));
  };
  const title = bounded(args.title, 120),
    requirements = list(args.requirements, 20),
    acceptance = list(args.acceptance, 20),
    sources = list(args.sources ?? [], 10, false);
  const preview = requirement.preview;
  signal.throwIfAborted();
  const current = await inspect(preview.element.ref);
  if (
    current.documentId !== preview.element.documentId ||
    current.nodeId !== preview.element.nodeId ||
    current.textContent !== preview.element.textContent
  )
    throw new Error('页面预览已变化，请重新观察并更新预览后记录需求。');
  signal.throwIfAborted();
  const lines = (items: string[]) => items.map((item, i) => `${i + 1}. ${item}`).join('\n');
  const record = {
    conversationId: requirement.conversationId,
    turnId: requirement.turnId,
    website: requirement.url,
    selected: {
      ref: requirement.selected.ref,
      name: requirement.selected.name,
      selector: requirement.selected.selector,
      documentId: requirement.selected.documentId,
      tabId: requirement.selected.tabId,
      frameId: requirement.selected.frameId,
    },
    preview: {
      ...preview,
      element: {
        ref: current.ref,
        nodeId: current.nodeId,
        documentId: current.documentId,
        selector: current.selector,
        textContent: current.textContent,
        attributes: current.attributes,
        computed: current.computed,
        bounds: current.bounds,
      },
    },
    recordedAt: new Date().toISOString(),
  };
  const content = `# ${title}\n\n状态：需求已记录，等待源码实现与验收。\n\n## 用户原始要求\n\n${requirement.userRequest}\n\n## 功能范围\n\n${lines(requirements)}\n\n## 验收条件\n\n${lines(acceptance)}\n\n## 参考资料\n\n${sources.length ? lines(sources) : '未提供外部资料。'}\n\n## 页面预览证据\n\n预览已在页面显示且可撤销；预览按钮尚不证明后端功能可用。页面刷新可能撤销预览，源码实现需单独验证。\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\`\n`;
  const folder = path.join(
    directory,
    createHash('sha256').update(requirement.conversationId).digest('hex').slice(0, 16),
  );
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const filename = path.join(folder, `PRD-${randomUUID()}.md`);
  await writeFile(filename, content, { flag: 'wx', mode: 0o600, signal });
  signal.throwIfAborted();
  const artifact = {
    path: filename,
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
  };
  requirement.saved = artifact;
  return artifact;
}
