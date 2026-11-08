export type SkillAvailability = 'usable' | 'unavailable';

export type SkillDiagnosticCode =
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
  source: 'workspace';
  contentHash?: string;
  injectionStatus: 'injected' | 'degraded' | 'failed';
  capabilityDegradation?: string;
}

export interface WorkspaceSkill {
  name: string;
  description?: string;
  source: 'workspace';
  packagePath: string;
  entryPath: string;
  contentHash?: string;
  availability: SkillAvailability;
  diagnostics: SkillDiagnostic[];
}
