import type { AgentId } from './types';
import { summarizeUsageCost, type ApiPricing, type UsageCostSummary } from './usage-pricing';

export const tokenFields = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'reasoningOutputTokens',
  'totalTokens',
] as const;
export type TokenField = (typeof tokenFields)[number];
export type TokenCounts = Record<TokenField, number | null>;
export const unknownTokens = (): TokenCounts =>
  Object.fromEntries(tokenFields.map((key) => [key, null])) as TokenCounts;
export const zeroTokens = (): TokenCounts =>
  Object.fromEntries(tokenFields.map((key) => [key, 0])) as TokenCounts;

export interface ModelOption {
  id: string;
  model: string;
  name: string;
  description: string;
  isDefault: boolean;
  efforts: Array<{ id: string; description: string }>;
  defaultEffort?: string;
}
export interface ModelSelection {
  model: string;
  effort?: string;
}
export interface ExecutionModel {
  requested?: string;
  model?: string;
  effort?: string;
  source: 'thread-response' | 'turn-context' | 'cli-message' | 'rerouted' | 'unconfirmed';
  previousModel?: string;
}
export interface UsageRecord {
  id: string;
  agent: AgentId | 'unknown';
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'untracked';
  source: 'live' | 'legacy';
  threadId?: string;
  turnId?: string;
  requestedModel?: string;
  model?: string;
  effort?: string;
  models?: string[];
  tokens: TokenCounts;
  baseline?: TokenCounts;
  lastTotal?: TokenCounts;
  observed: boolean;
  partial: boolean;
  issues: string[];
  apiPricing?: ApiPricing;
}
/** One Live voice call. Voice is billed by the second, apart from the Agent's tokens. */
export interface VoiceUsageRecord {
  id: string;
  startedAt: number;
  endedAt?: number;
  model: string;
  /** Billed seconds as the service last reported them; absent when it reported none. */
  seconds?: number;
  /** The service closed the call with a final figure; otherwise `seconds` is a lower bound. */
  final: boolean;
  status: 'running' | 'completed' | 'interrupted';
}
export interface UsageSnapshot {
  records: UsageRecord[];
  /** Absent in files written before voice calls were recorded. */
  voice?: VoiceUsageRecord[];
  since: number;
  updatedAt: number;
}
export interface UsageAmount {
  value: number | null;
  known: number;
  missing: number;
}
export interface UsageSummary {
  records: number;
  missing: number;
  partial: number;
  amounts: Record<TokenField, UsageAmount>;
  cost: UsageCostSummary;
}
export function summarizeUsage(records: UsageRecord[]): UsageSummary {
  const amounts = Object.fromEntries(
    tokenFields.map((field) => {
      const known = records.filter((record) => record.tokens[field] !== null);
      return [
        field,
        {
          value: known.length
            ? known.reduce((sum, record) => sum + record.tokens[field]!, 0)
            : null,
          known: known.length,
          missing: records.length - known.length,
        },
      ];
    }),
  ) as UsageSummary['amounts'];
  return {
    records: records.length,
    missing: records.filter((r) => !r.observed).length,
    partial: records.filter((r) => r.observed && (r.partial || r.status === 'running')).length,
    amounts,
    cost: summarizeUsageCost(records),
  };
}
export interface VoiceUsageSummary {
  calls: number;
  /** Seconds across the calls that reported any; `missing` counts those that reported none. */
  seconds: UsageAmount;
  /** Calls whose figure is a lower bound, or that are still going. */
  partial: number;
  latest?: number;
}
export function filterVoice(records: VoiceUsageRecord[], days?: number, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (days) start.setDate(start.getDate() - (days - 1));
  return records.filter(
    (record) => !days || (record.startedAt >= start.getTime() && record.startedAt <= now),
  );
}
export function summarizeVoice(records: VoiceUsageRecord[]): VoiceUsageSummary {
  const known = records.filter((record) => record.seconds !== undefined);
  return {
    calls: records.length,
    seconds: {
      value: known.length ? known.reduce((sum, record) => sum + record.seconds!, 0) : null,
      known: known.length,
      missing: records.length - known.length,
    },
    partial: known.filter((record) => !record.final).length,
    latest: records.length ? Math.max(...records.map((record) => record.startedAt)) : undefined,
  };
}
/** Voice calls by local day, oldest first. */
export function groupVoice(records: VoiceUsageRecord[]) {
  const groups = new Map<string, VoiceUsageRecord[]>();
  for (const record of records) {
    const key = usageDate(record.startedAt);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups]
    .map(([key, values]) => ({ key, ...summarizeVoice(values) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
export function usageDate(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function filterUsage(
  records: UsageRecord[],
  options: { days?: number; model?: string; agent?: string },
  now = Date.now(),
) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (options.days) start.setDate(start.getDate() - (options.days - 1));
  return records.filter(
    (record) =>
      (!options.days || (record.startedAt >= start.getTime() && record.startedAt <= now)) &&
      (!options.agent || record.agent === options.agent) &&
      (!options.model || (record.model ?? 'unknown') === options.model),
  );
}
export function groupUsage(records: UsageRecord[], by: 'model' | 'agent' | 'date') {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key =
      by === 'date'
        ? usageDate(record.startedAt)
        : by === 'model'
          ? (record.model ?? (record.models?.length ? '混合模型（未拆分）' : '模型未知'))
          : record.agent === 'unknown'
            ? '助手未知'
            : record.agent;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups]
    .map(([key, values]) => ({ key, ...summarizeUsage(values) }))
    .sort((a, b) =>
      by === 'date'
        ? a.key.localeCompare(b.key)
        : (b.cost.value ?? -1) - (a.cost.value ?? -1) ||
          (b.amounts.totalTokens.value ?? -1) - (a.amounts.totalTokens.value ?? -1),
    );
}
