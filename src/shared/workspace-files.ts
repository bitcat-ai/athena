export const MAX_WORKSPACE_FILES = 12;

export function workspaceFilePaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_FILES)
    throw new Error(`每条消息最多引用 ${MAX_WORKSPACE_FILES} 个工作区文件`);
  const paths = new Set<string>();
  for (const item of value) {
    if (
      typeof item !== 'string' ||
      !item ||
      item.length > 2048 ||
      /[\x00-\x1f]/.test(item) ||
      item.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('工作区文件路径无效');
    paths.add(item);
  }
  return [...paths];
}
