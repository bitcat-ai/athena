export type AccessMode = 'read-only' | 'supervised' | 'full';
export type ConfigurationKind = 'skills' | 'mcp' | 'agents' | 'workspace';

export const ACCESS_OPERATIONS: Record<AccessMode, readonly string[]> = {
  'read-only': ['state.read', 'configuration.read', 'thread.read'],
  supervised: ['state.read', 'configuration.read', 'thread.read', 'thread.start', 'thread.send', 'thread.stop'],
  full: ['state.read', 'configuration.read', 'configuration.write', 'thread.read', 'thread.start', 'thread.send', 'thread.stop'],
};

export function canAccess(mode: AccessMode, operation: string): boolean {
  return ACCESS_OPERATIONS[mode].includes(operation);
}

export interface TaskSelection { skills: string[]; mcp: string[]; }
export function normalizeTaskSelection(value: Partial<TaskSelection>): TaskSelection {
  const skills = [...new Set(value.skills ?? [])];
  if (skills.length > 3) throw new Error('最多选择三个 Skill');
  return { skills, mcp: [...new Set(value.mcp ?? [])] };
}
