export type SkillAvailability = 'usable' | 'unavailable';
export type SkillSource = 'workspace' | 'global';

export type SkillDiagnosticCode =
  | 'missing-root'
  | 'missing-entry'
  | 'invalid-metadata'
  | 'unsafe-path'
  | 'oversized-entry'
  | 'unreadable-entry';

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  message: string;
}

export interface SkillUsage {
  name: string;
  source: SkillSource;
  packagePath?: string;
  contentHash?: string;
  injectionStatus: 'injected' | 'degraded' | 'failed';
  capabilityDegradation?: string;
}

export interface WorkspaceSkill {
  name: string;
  description?: string;
  source: SkillSource;
  packagePath: string;
  entryPath: string;
  contentHash?: string;
  availability: SkillAvailability;
  diagnostics: SkillDiagnostic[];
}

export interface SkillSourceStatus {
  source: SkillSource;
  rootPath: string;
  diagnostics: SkillDiagnostic[];
}

export interface SkillDiscovery {
  skills: WorkspaceSkill[];
  workspace: SkillSourceStatus;
  global: SkillSourceStatus;
}
