export const composerCommands = [
  { name: 'new', label: '新对话', description: '开始新对话，保留当前对话与草稿', icon: 'new' },
  {
    name: 'model',
    label: '选择模型',
    description: '打开模型选择，或输入 /model 模型名称',
    icon: 'model',
  },
  {
    name: 'agent',
    label: '选择 Agent',
    description: '切换新对话的 CLI，或输入 /agent codex',
    icon: 'agent',
  },
  {
    name: 'skills',
    label: '本机 Skills',
    description: '查找并选择当前任务使用的 Skill',
    icon: 'skills',
  },
  { name: 'mcp', label: 'MCP 服务', description: '查看、连接或断开本机 MCP', icon: 'mcp' },
  {
    name: 'settings',
    label: '设置',
    description: '打开设置，可指定 agent、browser、skills、mcp、sandbox、feishu、learning',
    icon: 'settings',
  },
  { name: 'usage', label: '查看用量', description: '查看本机任务的用量与估算费用', icon: 'usage' },
  {
    name: 'browser',
    label: '浏览器',
    description: '显示浏览器，/browser hide 可收起',
    icon: 'browser',
  },
  { name: 'stop', label: '停止任务', description: '停止当前执行，保留已产生的结果', icon: 'stop' },
  {
    name: 'help',
    label: '命令帮助',
    description: '查看内置命令、Skill 引用与快捷键',
    icon: 'help',
  },
] as const;

export type ComposerCommand = (typeof composerCommands)[number];
export function slashCommands(query: string, atStart: boolean) {
  if (!atStart || !/^[\p{L}\p{N}_-]*$/u.test(query)) return [];
  const prefix = query.toLowerCase();
  return composerCommands.filter(
    (item) => item.name.startsWith(prefix) || item.label.includes(query),
  );
}
export function parseComposerCommand(text: string) {
  const match = /^\/([a-z]+)(?:[ \t]+([^\n]*))?[ \t]*$/.exec(text.trim());
  const command = match && composerCommands.find((item) => item.name === match[1]);
  return command ? { command, argument: match![2]?.trim() ?? '' } : undefined;
}
