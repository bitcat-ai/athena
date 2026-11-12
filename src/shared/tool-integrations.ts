import type { ToolCall } from './types';

export interface ToolIntegration {
  kind: 'skill' | 'mcp';
  name: string;
  action: string;
  description?: string;
  facts: Array<{ label: string; value: string }>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const text = (value: unknown, limit = 300) =>
  typeof value === 'string' ? value.slice(0, limit) : '';

/** Presentation comes from the actual call and returned fields, never the assistant's prose. */
export function toolIntegration(tool: ToolCall): ToolIntegration | undefined {
  const input = object(tool.input);
  let result: Record<string, unknown> = {};
  if (tool.status === 'done' && tool.output) {
    try {
      result = object(JSON.parse(tool.output));
    } catch {
      /* raw result remains in the timeline */
    }
  }
  if (tool.name === 'workbench_skill_read')
    return {
      kind: 'skill',
      name: text(result.title) || text(input.name) || '业务 Skill',
      action: '读取流程',
      description: text(result.description) || undefined,
      facts: result.entry ? [{ label: '来源', value: text(result.entry) }] : [],
    };
  const actions: Record<string, string> = {
    workbench_repository_resolve: '查找业务仓库',
    workbench_repository_publish: '提交测试分支',
    workbench_repository_checkout: '拉取复测代码',
  };
  if (!actions[tool.name]) return;
  const facts: ToolIntegration['facts'] = [];
  const add = (label: string, value: unknown) => {
    if (text(value)) facts.push({ label, value: text(value) });
  };
  add('应用', result.application);
  add('业务模块', result.module);
  add('代码仓库', result.repository);
  for (const [key, label] of [
    ['frontend', '前端目录'],
    ['backend', '后端目录'],
  ])
    add(label, object(object(result.components)[key]).root);
  add('基线提交', text(result.baseCommit).slice(0, 8));
  add('提交', text(result.commit).slice(0, 8));
  add('测试分支', result.targetBranch ?? result.branch);
  return { kind: 'mcp', name: '仓库映射', action: actions[tool.name], facts };
}
