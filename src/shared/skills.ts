export type SkillAvailability = 'usable' | 'unavailable';
export type SkillSource = 'workspace' | 'global' | 'provider';

export type ProviderSkillCapability = 'supported' | 'unsupported' | 'unavailable';
export type ProviderSkillDiscoveryStatus = 'ready' | 'empty' | 'unsupported' | 'unavailable' | 'malformed';

export interface ProviderIdentity {
  id: string;
  name: string;
}

export interface ProviderSkill {
  name: string;
  description: string;
  shortDescription?: string;
  providerPath?: string;
  contentHash?: string;
  userInvocable: boolean;
  source: 'provider';
  provider: ProviderIdentity;
}

export interface ProviderSkillDiscovery {
  status: ProviderSkillDiscoveryStatus;
  source: 'provider';
  provider: ProviderIdentity;
  skills: ProviderSkill[];
  diagnostics: SkillDiagnostic[];
}

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
  provider?: ProviderIdentity;
  providerPath?: string;
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
