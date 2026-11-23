import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import {
  tokenFields,
  unknownTokens,
  type TokenCounts,
  type UsageRecord,
  type UsageSnapshot,
  type ExecutionModel,
} from '../shared/usage';
import type { AgentId, Conversation } from '../shared/types';
import { apiPricingFor } from '../shared/usage-pricing';

export function parseTokenCounts(value: unknown, snakeCase = false): TokenCounts {
  const result = unknownTokens();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const key of tokenFields) {
    const name = snakeCase ? key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase()) : key;
    const number = (value as Record<string, unknown>)[name];
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0)
      result[key] = number;
  }
  return result;
}

/** Read only the rollout returned for this owned thread; never scan other CLI histories. */
export async function readUsageBaseline(
  file: string | undefined,
  threadId: string,
): Promise<TokenCounts | undefined> {
  if (!file || !path.isAbsolute(file)) return;
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let identity: string | undefined;
  let latest: TokenCounts | undefined;
  try {
    for await (const line of lines) {
      if (line.length > 8_000_000) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type === 'session_meta') identity = row.payload?.id;
      if (
        row.type === 'event_msg' &&
        row.payload?.type === 'token_count' &&
        row.payload.info?.total_token_usage
      )
        latest = parseTokenCounts(row.payload.info.total_token_usage, true);
    }
    return identity === threadId ? latest : undefined;
  } catch {
    return;
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function readExecutionModel(
  file: string | undefined,
  threadId: string,
  turnId: string,
): Promise<ExecutionModel | undefined> {
  if (!file || !path.isAbsolute(file)) return;
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let identity: string | undefined;
  try {
    for await (const line of lines) {
      if (line.length > 8_000_000) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type === 'session_meta') identity = row.payload?.id;
      if (
        identity === threadId &&
        row.type === 'turn_context' &&
        row.payload?.turn_id === turnId &&
        typeof row.payload.model === 'string'
      )
        return {
          model: row.payload.model,
          effort: typeof row.payload.effort === 'string' ? row.payload.effort : undefined,
          source: 'turn-context',
        };
    }
  } catch {
    return;
  } finally {
    lines.close();
    input.destroy();
  }
}

export class UsageStore {
  private data: UsageSnapshot = { records: [], since: Date.now(), updatedAt: Date.now() };
  private writes = Promise.resolve();
  constructor(private directory: string) {}

  async load(conversations: Conversation[] = []) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readFile(path.join(this.directory, 'usage.json'), 'utf8'));
      if (
        !data ||
        !Array.isArray(data.records) ||
        !Number.isFinite(data.since) ||
        data.records.some(
          (r: any) =>
            !r ||
            typeof r.id !== 'string' ||
            !Number.isFinite(r.startedAt) ||
            !r.tokens ||
            !Array.isArray(r.issues),
        )
      )
        throw new Error('用量记录格式不正确；原文件已保留');
      this.data = data;
      // Calls are kept only if they are well formed; a damaged entry never blocks the token records.
      this.data.voice = (Array.isArray(data.voice) ? data.voice : []).filter(
        (call: any) =>
          call &&
          typeof call.id === 'string' &&
          Number.isFinite(call.startedAt) &&
          typeof call.model === 'string' &&
          (call.seconds === undefined || (Number.isFinite(call.seconds) && call.seconds >= 0)),
      );
      for (const call of this.data.voice!)
        if (call.status === 'running') {
          call.status = 'interrupted';
          call.final = false;
        }
      for (const record of this.data.records) {
        record.tokens = parseTokenCounts(record.tokens);
        if (record.baseline) record.baseline = parseTokenCounts(record.baseline);
        if (record.lastTotal) record.lastTotal = parseTokenCounts(record.lastTotal);
        if (!record.apiPricing && !record.models?.length)
          record.apiPricing = apiPricingFor(record.model);
        if (record.status === 'running') {
          record.status = 'interrupted';
          record.partial = true;
          this.issue(record, '应用中断，结束用量未确认');
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const known = new Set(this.data.records.map((record) => record.id));
    for (const conversation of conversations)
      for (const message of conversation.messages) {
        if (message.role !== 'assistant' || message.localPreview || known.has(message.id)) continue;
        this.data.records.push({
          id: message.id,
          agent: 'unknown',
          startedAt: message.createdAt,
          status: 'untracked',
          source: 'legacy',
          tokens: unknownTokens(),
          observed: false,
          partial: true,
          issues: ['此任务没有已采集的用量记录'],
        });
        known.add(message.id);
      }
    await this.save();
  }

  snapshot(): UsageSnapshot {
    return structuredClone(this.data);
  }
  /** A Live call the service has accepted: it is billed from here on. */
  voiceStart(id: string, model: string) {
    const calls = (this.data.voice ??= []);
    if (calls.some((call) => call.id === id)) return;
    calls.push({ id, model, startedAt: Date.now(), final: false, status: 'running' });
  }
  /**
   * `seconds` is what the service last reported for the call, `final` whether that was its
   * closing figure. Without an id, whichever call is still open is the one that ended.
   */
  voiceFinish(id: string | undefined, seconds?: number, final = false): boolean {
    const call = this.data.voice?.find((item) =>
      id === undefined ? item.status === 'running' : item.id === id,
    );
    if (!call || call.status !== 'running') return false;
    call.endedAt = Date.now();
    if (seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400)
      call.seconds = seconds;
    call.final = final && call.seconds !== undefined;
    call.status = call.final ? 'completed' : 'interrupted';
    return true;
  }
  start(id: string, agent: AgentId, requestedModel?: string) {
    if (this.data.records.some((record) => record.id === id)) return;
    this.data.records.push({
      id,
      agent,
      requestedModel,
      startedAt: Date.now(),
      status: 'running',
      source: 'live',
      tokens: unknownTokens(),
      observed: false,
      partial: true,
      issues: [],
    });
  }
  bind(
    id: string,
    threadId: string,
    turnId: string,
    model: ExecutionModel,
    baseline?: TokenCounts,
  ) {
    const record = this.data.records.find((r) => r.id === id);
    if (!record || record.turnId) return;
    Object.assign(record, {
      threadId,
      turnId,
      requestedModel: model.requested,
      model: model.model,
      effort: model.effort,
      baseline: baseline ? parseTokenCounts(baseline) : undefined,
      apiPricing: apiPricingFor(model.model),
    });
    if (!baseline) this.issue(record, '开始前累计用量未知，仅计已观察部分');
  }
  private issue(record: UsageRecord, text: string) {
    if (!record.issues.includes(text)) record.issues.push(text);
  }
  update(threadId: string, turnId: string, total: TokenCounts, last: TokenCounts): boolean {
    const record = this.data.records.find((r) => r.threadId === threadId && r.turnId === turnId);
    if (!record) return false;
    total = parseTokenCounts(total);
    last = parseTokenCounts(last);
    if (record.lastTotal && JSON.stringify(total) === JSON.stringify(record.lastTotal))
      return false;
    if (
      record.lastTotal &&
      total.totalTokens !== null &&
      record.lastTotal.totalTokens !== null &&
      total.totalTokens < record.lastTotal.totalTokens
    ) {
      this.issue(record, '累计用量回退，保留已确认记录');
      record.partial = true;
      return true;
    }
    if (!record.baseline) {
      record.baseline = unknownTokens();
      for (const key of tokenFields)
        if (total[key] !== null && last[key] !== null && total[key]! >= last[key]!)
          record.baseline[key] = total[key]! - last[key]!;
    }
    for (const key of tokenFields) {
      if (
        !record.lastTotal &&
        record.baseline[key] === null &&
        total[key] !== null &&
        last[key] !== null &&
        total[key]! >= last[key]!
      ) {
        record.baseline[key] = total[key]! - last[key]!;
        this.issue(record, '部分字段缺少起始累计值，仅计已观察部分');
      }
      const base = record.baseline[key];
      const value = total[key];
      if (base !== null && value !== null && value >= base) {
        const next = value - base;
        if (record.tokens[key] !== null && next < record.tokens[key]!) {
          this.issue(record, '部分累计字段回退，记录不完整');
          continue;
        }
        record.tokens[key] = next;
      } else {
        if (record.tokens[key] !== null) this.issue(record, '部分字段暂不可得，保留已采集值');
        if (base !== null && value !== null && value < base)
          this.issue(record, '累计用量重置，无法可靠拆分');
      }
    }
    record.lastTotal = total;
    record.observed = tokenFields.some((key) => record.tokens[key] !== null);
    record.partial =
      record.issues.length > 0 || tokenFields.some((key) => record.tokens[key] === null);
    return true;
  }
  reroute(threadId: string, turnId: string, model: ExecutionModel) {
    const record = this.data.records.find((r) => r.threadId === threadId && r.turnId === turnId);
    if (!record) return;
    const nativeSwitch =
      model.source === 'cli-message' &&
      (Boolean(record.models?.length) ||
        Boolean(record.model && model.model && record.model !== model.model));
    if (model.source !== 'rerouted' && !nativeSwitch) {
      if (!record.models?.length) {
        record.model = model.model;
        record.effort = model.effort;
        if (record.apiPricing?.model !== model.model)
          record.apiPricing = apiPricingFor(model.model);
      }
      return;
    }
    record.models = [
      ...new Set(
        [...(record.models ?? []), record.model, model.previousModel, model.model].filter(
          (v): v is string => !!v,
        ),
      ),
    ];
    record.model = undefined;
    record.apiPricing = undefined;
    this.issue(record, '本轮发生模型切换，用量无法按模型拆分');
    record.partial = true;
  }
  finish(id: string, status: UsageRecord['status']) {
    const record = this.data.records.find((r) => r.id === id);
    if (!record) return;
    record.status = status;
    record.endedAt = Date.now();
    if (!record.observed) this.issue(record, 'CLI 未返回本轮用量');
    if (status !== 'completed' && record.observed) {
      record.partial = true;
      this.issue(record, '任务未正常结束，仅计已返回用量');
    }
  }
  save() {
    this.data.updatedAt = Date.now();
    const json = JSON.stringify(this.data, null, 2);
    const file = path.join(this.directory, 'usage.json');
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await writeFile(`${file}.tmp`, json, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      });
    return this.writes;
  }
}
