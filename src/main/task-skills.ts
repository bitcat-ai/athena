import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserTool, ToolResult } from '../shared/types';

const skills = [
  {
    name: 'business-context',
    title: '业务领域核对',
    description: '根据当前网页、业务对象和知识库资料核对业务领域，再通过 MCP 查找对应仓库。',
  },
  {
    name: 'customer-material-review',
    title: '客户材料核对',
    description: '在客户运营页面筛选客户、逐项核对资料完整性，整理缺件与可交付材料。',
  },
];

export const taskSkillTools: BrowserTool[] = [
  {
    name: 'workbench_skill_list',
    description:
      '列出 Athena 内置业务 Skill 的名称和适用范围。核对业务网页时先选择相关 Skill，再用 workbench_skill_read 读取流程。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'workbench_skill_read',
    description:
      '按名称读取真实 SKILL.md。依照与当前任务相关的流程操作，并向用户说明采用的 Skill；读取 Skill 不代表已核对页面。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: skills.map((skill) => skill.name) } },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

/** Only packaged, read-only workflows; this does not execute scripts or scan personal skills. */
export async function readTaskSkill(
  directory: string,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolResult> {
  signal.throwIfAborted();
  if (tool === 'workbench_skill_list')
    return { text: JSON.stringify({ source: 'Athena', skills }) };
  const skill = skills.find((item) => item.name === args.name);
  if (tool !== 'workbench_skill_read' || !skill) throw new Error('没有找到该业务 Skill');
  const filename = path.join(directory, skill.name, 'SKILL.md');
  const content = await readFile(filename, { encoding: 'utf8', signal });
  if (Buffer.byteLength(content) > 12 * 1024) throw new Error('业务 Skill 内容超出限制');
  return {
    text: JSON.stringify({
      ...skill,
      source: 'Athena',
      entry: `resources/skills/${skill.name}/SKILL.md`,
      sha256: createHash('sha256').update(content).digest('hex'),
      content,
    }),
  };
}
