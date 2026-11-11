import type {
  ProviderDiscoveryInput,
  ProviderPathPolicy,
  ProviderSkillInput,
} from '../shared/provider-skills';
import { normalizeProviderSkillDiscovery } from '../shared/provider-skills';
import type { ProviderIdentity, ProviderSkillDiscovery } from '../shared/skills';

export type ProviderDiscoveryResponse = ProviderDiscoveryInput;
export type ProviderDiscoveryTransport = () => Promise<ProviderDiscoveryResponse>;

/**
 * Adapter seam for provider-owned discovery. The transport is deliberately
 * injected so protocol fixtures can exercise normalization without a model,
 * login, network, or filesystem scan.
 */
export interface ProviderSkillDiscoveryAdapter {
  readonly provider: ProviderIdentity;
  discover(): Promise<ProviderSkillDiscovery>;
}

export function createProviderSkillDiscoveryAdapter(
  provider: ProviderIdentity,
  transport: ProviderDiscoveryTransport,
  policy: ProviderPathPolicy = { approvedRoot: process.cwd() },
): ProviderSkillDiscoveryAdapter {
  return {
    provider,
    async discover() {
      try {
        const payload = await transport();
        return normalizeProviderSkillDiscovery(
          { ...payload, provider },
          policy,
        );
      } catch {
        return {
          status: 'unavailable',
          source: 'provider',
          provider,
          skills: [],
          diagnostics: [{ code: 'capability-degraded', message: 'Provider Skill discovery is unavailable.' }],
        };
      }
    },
  };
}

export function unsupportedProviderSkillDiscovery(provider: ProviderIdentity): ProviderSkillDiscoveryAdapter {
  return createProviderSkillDiscoveryAdapter(provider, async () => ({ capability: 'unsupported' }));
}

export type { ProviderSkillInput };
