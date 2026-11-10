import path from 'node:path';
import type { AgentId } from './types';
import type { ProviderIdentity, ProviderSkill, ProviderSkillCapability, ProviderSkillDiscovery, SkillDiagnostic } from './skills';

export interface ProviderSkillInput {
  name?: unknown;
  description?: unknown;
  shortDescription?: unknown;
  path?: unknown;
  contentHash?: unknown;
  userInvocable?: unknown;
}

export interface ProviderDiscoveryInput {
  provider?: unknown;
  capability?: unknown;
  skills?: unknown;
  error?: unknown;
}

export interface ProviderPathPolicy {
  approvedRoot: string;
  /** Trusted CLI discovery can return global entries; Athena never reads these files. */
  providerManagedPaths?: boolean;
}

function diagnostic(code: SkillDiagnostic['code'], message: string): SkillDiagnostic {
  return { code, message };
}

function providerIdentity(value: unknown): ProviderIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !candidate.id.trim() || typeof candidate.name !== 'string' || !candidate.name.trim()) return undefined;
  return { id: candidate.id.trim(), name: candidate.name.trim() };
}

function contained(candidate: string, root: string): boolean {
  const child = path.resolve(candidate);
  const parent = path.resolve(root);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

export function unavailableProviderSkillDiscovery(agent: Pick<ProviderIdentity, 'id' | 'name'>, message: string): ProviderSkillDiscovery {
  return { status: 'unavailable', source: 'provider', provider: agent, skills: [], diagnostics: [diagnostic('capability-degraded', message)] };
}

export function providerSkillDiscoveryForAgent(agent: { id: AgentId; name: string; authentication?: string }): ProviderSkillDiscovery | undefined {
  if (agent.authentication !== 'missing') return undefined;
  return unavailableProviderSkillDiscovery(agent, `请先在终端登录 ${agent.name}，再刷新连接`);
}

export function normalizeProviderSkillDiscovery(input: ProviderDiscoveryInput, policy: ProviderPathPolicy = { approvedRoot: process.cwd() }): ProviderSkillDiscovery {
  const provider = providerIdentity(input.provider) ?? { id: 'unknown', name: 'Unknown provider' };
  const diagnostics: SkillDiagnostic[] = [];
  const capability = input.capability as ProviderSkillCapability;
  if (!['supported', 'unsupported', 'unavailable'].includes(capability)) {
    return { status: 'malformed', source: 'provider', provider, skills: [], diagnostics: [diagnostic('invalid-metadata', 'Provider discovery capability is malformed.')] };
  }
  if (capability !== 'supported') return { status: capability, source: 'provider', provider, skills: [], diagnostics };
  if (!Array.isArray(input.skills)) return { status: 'malformed', source: 'provider', provider, skills: [], diagnostics: [diagnostic('invalid-metadata', 'Provider skills must be an array.')] };
  const skills: ProviderSkill[] = [];
  const names = new Set<string>();
  for (const item of input.skills as ProviderSkillInput[]) {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim()) {
      diagnostics.push(diagnostic('invalid-metadata', 'Provider Skill name is malformed.'));
      continue;
    }
    if (item.userInvocable !== true || names.has(item.name.trim())) continue;
    const providerPath = typeof item.path === 'string' && item.path.trim() ? item.path.trim() : undefined;
    if (providerPath && (policy.providerManagedPaths ? !path.isAbsolute(providerPath) : !contained(providerPath, policy.approvedRoot))) {
      diagnostics.push(diagnostic('unsafe-path', 'Provider Skill path is outside the approved boundary.'));
      continue;
    }
    names.add(item.name.trim());
    skills.push({ name: item.name.trim(), description: typeof item.description === 'string' && item.description.trim() ? item.description.trim() : '未提供描述', shortDescription: typeof item.shortDescription === 'string' && item.shortDescription.trim() ? item.shortDescription.trim() : undefined, providerPath, contentHash: typeof item.contentHash === 'string' && item.contentHash.trim() ? item.contentHash.trim() : undefined, userInvocable: true, source: 'provider', provider });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { status: skills.length ? 'ready' : (diagnostics.length && skills.length === 0 ? 'malformed' : 'empty'), source: 'provider', provider, skills, diagnostics };
}
