import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  UsageStore,
  parseTokenCounts,
  readUsageBaseline,
  readExecutionModel,
} from '../src/main/usage';
import {
  groupUsage,
  groupVoice,
  filterUsage,
  filterVoice,
  summarizeUsage,
  summarizeVoice,
  unknownTokens,
  zeroTokens,
} from '../src/shared/usage';
import { API_PRICING_SOURCE } from '../src/shared/usage-pricing';

const counts = (n: number) => ({
  inputTokens: n,
  outputTokens: n / 10,
  cachedInputTokens: n / 2,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: n + n / 10,
});
async function setup(t: any) {
  const dir = await mkdtemp(path.join(tmpdir(), 'athena-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new UsageStore(dir);
  await store.load();
  return { store, dir };
}
const model = { model: 'actual-one', requested: 'actual-one', source: 'thread-response' as const };

test('native CLI model changes keep mixed-model usage unknown instead of pricing everything as the last model', async (t) => {
  const { store } = await setup(t);
  store.start('native', 'pi');
  store.bind('native', 'pi-session', 'pi-turn', { source: 'unconfirmed' }, zeroTokens());
  store.reroute('pi-session', 'pi-turn', { model: 'gpt-6-sol', source: 'cli-message' });
  assert.equal(store.snapshot().records[0].model, 'gpt-6-sol');
  store.reroute('pi-session', 'pi-turn', { model: 'gpt-6.1-sol', source: 'cli-message' });
  store.reroute('pi-session', 'pi-turn', { model: 'third-model', source: 'cli-message' });
  const record = store.snapshot().records[0];
  assert.equal(record.model, undefined);
  assert.equal(record.apiPricing, undefined);
  assert.deepEqual(record.models, ['gpt-6-sol', 'gpt-6.1-sol', 'third-model']);
  assert.equal(record.partial, true);
});

test('USD valuation persists its official rates and basis across restart and model confirmation', async (t) => {
  const { store, dir } = await setup(t);
  store.start('priced', 'codex');
  store.bind('priced', 't', 'a', { model: 'gpt-6-sol', source: 'thread-response' }, zeroTokens());
  store.update('t', 'a', counts(100), counts(100));
  store.reroute('t', 'a', { model: 'gpt-6.1-sol', source: 'turn-context' });
  store.finish('priced', 'completed');
  await store.save();
  const saved = JSON.parse(await readFile(path.join(dir, 'usage.json'), 'utf8'));
  const price = saved.records[0].apiPricing;
  assert.equal(price.sourceUrl, API_PRICING_SOURCE);
  assert.equal(price.verifiedAt, '2026-11-01');
  assert.equal(price.currency, 'USD');
  assert.equal(price.tier, 'standard');
  assert.equal(price.context, 'short');
  assert.equal(price.cacheWriteRetention, '30m');
  assert.equal(price.model, 'gpt-6.1-sol');
  assert.equal(price.rates.cachedInput, 0.1);
  const restored = new UsageStore(dir);
  await restored.load();
  assert.deepEqual(restored.snapshot().records[0].apiPricing, price);
  assert(Math.abs(summarizeUsage(restored.snapshot().records).cost.value! - 0.000205) < 1e-12);
  restored.reroute('t', 'a', {
    model: 'gpt-6-astra',
    previousModel: 'gpt-6.1-sol',
    source: 'rerouted',
  });
  assert.equal(restored.snapshot().records[0].apiPricing, undefined);
  assert.equal(summarizeUsage(restored.snapshot().records).cost.value, null);
});

test('historical tracked records without pricing receive a dated comparison basis on load', async (t) => {
  const { dir } = await setup(t);
  await writeFile(
    path.join(dir, 'usage.json'),
    JSON.stringify({
      since: 1,
      updatedAt: 1,
      records: [
        {
          id: 'old',
          agent: 'codex',
          startedAt: 1,
          status: 'completed',
          source: 'live',
          model: 'gpt-6.1-sol',
          tokens: counts(100),
          observed: true,
          partial: false,
          issues: [],
        },
      ],
    }),
  );
  const restored = new UsageStore(dir);
  await restored.load();
  assert.equal(restored.snapshot().records[0].apiPricing?.verifiedAt, '2026-11-01');
  assert.equal(restored.snapshot().records[0].startedAt, 1);
  assert(Math.abs(summarizeUsage(restored.snapshot().records).cost.value! - 0.000205) < 1e-12);
});

test('cumulative updates are replaced, never summed; duplicates and stale turns do not add usage', async (t) => {
  const { store } = await setup(t);
  store.start('a', 'codex');
  store.bind('a', 'thread', 'turn-a', model, zeroTokens());
  store.update('thread', 'turn-a', counts(100), counts(100));
  store.update('thread', 'turn-a', counts(300), counts(200));
  assert.equal(store.update('thread', 'turn-a', counts(300), counts(200)), false);
  assert.equal(store.update('other', 'turn-a', counts(9990), counts(9990)), false);
  assert.equal(store.snapshot().records[0].tokens.inputTokens, 300);
  store.finish('a', 'completed');
  store.start('b', 'codex');
  store.bind('b', 'thread', 'turn-b', { ...model, model: 'actual-two' }, counts(300));
  store.update('thread', 'turn-b', counts(400), counts(100));
  store.update('thread', 'turn-a', counts(300), counts(200));
  assert.equal(summarizeUsage(store.snapshot().records).amounts.inputTokens.value, 400);
  assert.deepEqual(
    groupUsage(store.snapshot().records, 'model').map((g) => [g.key, g.amounts.inputTokens.value]),
    [
      ['actual-one', 300],
      ['actual-two', 100],
    ],
  );
});

test('missing and invalid fields stay unknown; explicit zero remains zero', async (t) => {
  const { store } = await setup(t);
  const invalid = parseTokenCounts({
    inputTokens: 100,
    outputTokens: -1,
    cachedInputTokens: NaN,
    cacheWriteInputTokens: 0,
    totalTokens: 1.5,
  });
  assert.equal(invalid.outputTokens, null);
  assert.equal(invalid.totalTokens, null);
  assert.equal(invalid.cacheWriteInputTokens, 0);
  store.start('a', 'codex');
  store.bind('a', 't', 'a', model, zeroTokens());
  store.update('t', 'a', invalid, invalid);
  store.finish('a', 'completed');
  store.start('b', 'codex');
  store.finish('b', 'cancelled');
  const sum = summarizeUsage(store.snapshot().records);
  assert.equal(sum.amounts.inputTokens.value, 100);
  assert.equal(sum.amounts.inputTokens.missing, 1);
  assert.equal(sum.amounts.outputTokens.value, null);
  assert.equal(sum.amounts.cacheWriteInputTokens.value, 0);
  assert.equal(sum.missing, 1);
  assert.equal(sum.partial, 1);
  assert.equal(summarizeUsage([]).amounts.totalTokens.value, null);
});

test('unknown old history uses last sample as partial, not the entire historical cumulative total', async (t) => {
  const { store } = await setup(t);
  store.start('a', 'codex');
  store.bind('a', 't', 'a', model);
  store.update('t', 'a', counts(10000), counts(100));
  store.update('t', 'a', counts(10200), counts(200));
  assert.equal(store.snapshot().records[0].tokens.inputTokens, 300);
  assert.equal(store.snapshot().records[0].partial, true);
});

test('restart, cancellation, late final usage and model reroute retain consistent accounting', async (t) => {
  const { store, dir } = await setup(t);
  store.start('a', 'codex');
  store.bind('a', 't', 'a', model, zeroTokens());
  store.update('t', 'a', counts(100), counts(100));
  store.finish('a', 'cancelled');
  store.update('t', 'a', counts(200), counts(100));
  store.start('b', 'codex');
  store.bind('b', 't', 'b', model, counts(200));
  store.update('t', 'b', counts(300), counts(100));
  store.reroute('t', 'b', { model: 'fallback', previousModel: 'actual-one', source: 'rerouted' });
  await store.save();
  const restored = new UsageStore(dir);
  await restored.load();
  assert.equal(restored.snapshot().records[0].status, 'cancelled');
  assert.equal(restored.snapshot().records[1].status, 'interrupted');
  assert.equal(restored.snapshot().records[1].model, undefined);
  assert.deepEqual(restored.snapshot().records[1].models, ['actual-one', 'fallback']);
  assert.equal(restored.update('t', 'b', counts(300), counts(100)), false);
  assert.equal(summarizeUsage(restored.snapshot().records).amounts.inputTokens.value, 300);
  const json = JSON.parse(await readFile(path.join(dir, 'usage.json'), 'utf8'));
  assert.equal(json.records.length, 2);
});

test('decreasing totals never double count or erase known usage; resets are disclosed', async (t) => {
  const { store } = await setup(t);
  store.start('a', 'codex');
  store.bind('a', 't', 'a', model, counts(200));
  store.update('t', 'a', counts(300), counts(100));
  store.update('t', 'a', counts(100), counts(100));
  assert.equal(store.snapshot().records[0].tokens.inputTokens, 100);
  assert.equal(store.snapshot().records[0].partial, true);
});

test('only explicit trusted rollout identity supplies a baseline; no historical token guesses', async (t) => {
  const { dir, store } = await setup(t);
  const file = path.join(dir, 'owned.jsonl');
  await writeFile(
    file,
    [
      { type: 'session_meta', payload: { id: 'own' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 400, output_tokens: 20, total_tokens: 420 } },
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n{partial',
  );
  assert.equal((await readUsageBaseline(file, 'own'))?.inputTokens, 400);
  assert.equal(await readUsageBaseline(file, 'foreign'), undefined);
  assert.equal(await readUsageBaseline(path.join(dir, 'missing'), 'own'), undefined);
  await store.load([
    {
      id: 'c',
      title: 'old',
      updatedAt: 1,
      messages: [{ id: 'old', role: 'assistant', text: 'text', createdAt: 1 }],
    },
  ]);
  assert.deepEqual(store.snapshot().records[0].tokens, unknownTokens());
});

test('date/model/assistant filtering respects local calendar boundaries and unknown identities', async (t) => {
  const { store } = await setup(t);
  store.start('now', 'codex');
  store.start('older', 'codex');
  store.start('unknown', 'codex');
  const records = store.snapshot().records;
  const now = new Date(2026, 10, 1, 12).getTime();
  records[0].startedAt = now;
  records[0].model = 'model-a';
  records[1].startedAt = new Date(2026, 9, 25, 23, 59).getTime();
  records[1].model = 'model-b';
  records[2].startedAt = new Date(2026, 9, 26).getTime();
  records[2].agent = 'unknown';
  assert.deepEqual(
    filterUsage(records, { days: 7 }, now).map((r) => r.id),
    ['now', 'unknown'],
  );
  assert.deepEqual(
    filterUsage(records, { days: 30, model: 'model-b', agent: 'codex' }, now).map((r) => r.id),
    ['older'],
  );
  assert.deepEqual(
    filterUsage(records, { model: 'unknown' }, now).map((r) => r.id),
    ['unknown'],
  );
  assert.equal(filterUsage(records, {}, now).length, 3);
});

test('turn model confirmation requires both owned thread and exact turn; missing baseline fields remain partial', async (t) => {
  const { dir, store } = await setup(t);
  const file = path.join(dir, 'context.jsonl');
  await writeFile(
    file,
    [
      { type: 'session_meta', payload: { id: 'owned' } },
      { type: 'turn_context', payload: { turn_id: 'before', model: 'old-model', effort: 'high' } },
      {
        type: 'turn_context',
        payload: { turn_id: 'current', model: 'actual-model', effort: 'low' },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
  assert.equal(await readExecutionModel(file, 'foreign', 'current'), undefined);
  assert.equal(await readExecutionModel(file, 'owned', 'missing'), undefined);
  assert.deepEqual(await readExecutionModel(file, 'owned', 'current'), {
    model: 'actual-model',
    effort: 'low',
    source: 'turn-context',
  });
  store.start('a', 'codex');
  store.bind('a', 'owned', 'current', model, { ...zeroTokens(), cachedInputTokens: null });
  store.update('owned', 'current', counts(100), counts(100));
  assert.equal(store.snapshot().records[0].tokens.cachedInputTokens, 50);
  assert.equal(store.snapshot().records[0].partial, true);
  store.update('owned', 'current', { ...counts(200), outputTokens: null }, counts(100));
  assert.equal(
    store.snapshot().records[0].tokens.outputTokens,
    10,
    'retain the actual known subtotal',
  );
  assert.equal(store.snapshot().records[0].partial, true);
});

test('Live voice calls are kept by the time the service reported, and an unfinished call stays a lower bound', async (t) => {
  const { store, dir } = await setup(t);
  store.voiceStart('call_a', 'gpt-live-1');
  store.voiceStart('call_a', 'gpt-live-1');
  assert.equal(store.voiceFinish('call_a', 42.5, true), true);
  assert.equal(store.voiceFinish('call_a', 99, true), false, 'a call ends once');
  store.voiceStart('call_b', 'gpt-live-1');
  // Ended from elsewhere, with only the last progress figure.
  assert.equal(store.voiceFinish(undefined, 10), true);
  store.voiceStart('call_c', 'gpt-live-1');
  assert.equal(store.voiceFinish('call_c', Number.NaN, true), true);
  store.voiceStart('call_d', 'gpt-live-1');
  await store.save();

  const calls = store.snapshot().voice!;
  assert.deepEqual(
    calls.map((call) => [call.id, call.seconds, call.final, call.status]),
    [
      ['call_a', 42.5, true, 'completed'],
      ['call_b', 10, false, 'interrupted'],
      ['call_c', undefined, false, 'interrupted'],
      ['call_d', undefined, false, 'running'],
    ],
  );
  const summary = summarizeVoice(calls);
  assert.equal(summary.calls, 4);
  assert.deepEqual(summary.seconds, { value: 52.5, known: 2, missing: 2 });
  assert.equal(summary.partial, 1);
  assert.equal(groupVoice(calls).length, 1);
  assert.equal(filterVoice([{ ...calls[0], startedAt: Date.now() - 40 * 86_400_000 }], 30).length, 0);
  assert.equal(summarizeVoice([]).seconds.value, null, 'no calls is unknown, never zero seconds');

  // A call still open when the app stopped is not left running, and token records are untouched.
  const reopened = new UsageStore(dir);
  await reopened.load();
  assert.equal(reopened.snapshot().voice!.at(-1)!.status, 'interrupted');
  const saved = JSON.parse(await readFile(path.join(dir, 'usage.json'), 'utf8'));
  saved.voice.push({ id: 7, startedAt: 'never' });
  await writeFile(path.join(dir, 'usage.json'), JSON.stringify(saved));
  const damaged = new UsageStore(dir);
  await damaged.load();
  assert.equal(damaged.snapshot().voice!.length, 4, 'a malformed call is dropped, the rest stay');
});
