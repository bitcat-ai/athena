/** Explicit real CLI test. Uses the existing login and an isolated workspace. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { CodexSession, detectAgents } from '../src/main/agents';
import { UsageStore } from '../src/main/usage';
import { summarizeUsage, type ModelSelection } from '../src/shared/usage';
import type { AgentEvent } from '../src/shared/types';

const directory = await mkdtemp(path.resolve('.runtime/model-usage-'));
const output = path.resolve('test-results/agent-experience/live');
await mkdir(output, { recursive: true });
const info = (await detectAgents()).find((agent) => agent.id === 'codex');
assert.ok(info?.path);
let ledger = new UsageStore(directory);
await ledger.load();
let activeId = '';
const events: AgentEvent[] = [];
const executionContexts: unknown[] = [];
const onEvent = (event: AgentEvent) => {
  if (['usage', 'run-started', 'model', 'complete', 'error'].includes(event.type))
    events.push(event);
  if (event.type === 'run-started')
    ledger.bind(activeId, event.threadId, event.turnId, event.model, event.baseline);
  if (event.type === 'usage') ledger.update(event.threadId, event.turnId, event.total, event.last);
  if (event.type === 'model') ledger.reroute(event.threadId, event.turnId, event.model);
};
let session = new CodexSession({
  workspace: directory,
  executablePath: info.path,
  tools: [],
  onEvent,
  callTool: async () => ({ text: 'No tools needed', isError: true }),
});
const selections: ModelSelection[] = [];
const verifyContext = async () => {
  const file = (session as unknown as { rolloutPath: string }).rolloutPath;
  assert.ok(file);
  const context = (await readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line);
        return row.type === 'turn_context' ? [row.payload] : [];
      } catch {
        return [];
      }
    })
    .at(-1);
  assert.ok(context);
  const expected = selections.at(-1)!;
  assert.equal(context.model, expected.model);
  executionContexts.push({ turnId: context.turn_id, model: context.model, effort: context.effort });
};
try {
  const models = await session.listModels();
  assert.ok(models.length > 1);
  assert.equal(session.sessionId, undefined, 'catalog must not create an empty conversation');
  const first = models.find((m) => m.isDefault) ?? models[0];
  const second =
    models.find((m) => /luna/.test(m.model) && m.model !== first.model) ??
    models.find((m) => m.model !== first.model)!;
  for (const [index, model] of [first, second].entries()) {
    activeId = 'turn-' + index;
    const selection = {
      model: model.model,
      effort: model.efforts.find((e) => e.id === 'low')?.id ?? model.defaultEffort,
    };
    selections.push(selection);
    ledger.start(activeId, 'codex', model.model);
    await session.send(
      index ? '只回答：切换确认。不调用工具。' : '只回答：连接确认。不调用工具。',
      undefined,
      undefined,
      selection,
    );
    ledger.finish(activeId, 'completed');
    await ledger.save();
    await verifyContext();
    const record = ledger.snapshot().records.at(-1)!;
    assert.equal(record.model, selection.model);
    assert.ok(record.observed && record.tokens.inputTokens! > 0 && record.tokens.outputTokens! > 0);
  }
  const before = ledger.snapshot();
  const sessionId = session.sessionId!;
  const fingerprint = session.toolsFingerprint;
  session.close();
  ledger = new UsageStore(directory);
  await ledger.load();
  assert.deepEqual(summarizeUsage(ledger.snapshot().records), summarizeUsage(before.records));
  session = new CodexSession({
    workspace: directory,
    executablePath: info.path,
    sessionId,
    sessionToolsFingerprint: fingerprint,
    tools: [],
    onEvent,
    callTool: async () => ({ text: 'No tools needed', isError: true }),
  });
  activeId = 'resumed';
  ledger.start(activeId, 'codex', second.model);
  await session.send('只回答：恢复确认。不调用工具。', undefined, undefined, selections.at(-1));
  ledger.finish(activeId, 'completed');
  await ledger.save();
  await verifyContext();
  const final = ledger.snapshot();
  const record = final.records.at(-1)!;
  assert.ok(record.observed && record.baseline!.inputTokens! > 0);
  assert.ok(record.tokens.inputTokens! < record.lastTotal!.inputTokens!);
  assert.equal(record.model, second.model);
  const totalsBeforeDuplicate = summarizeUsage(final.records);
  for (const event of events.filter((e) => e.type === 'usage'))
    ledger.update(event.threadId, event.turnId, event.total, event.last);
  assert.deepEqual(
    summarizeUsage(ledger.snapshot().records).amounts,
    totalsBeforeDuplicate.amounts,
  );
  await writeFile(
    path.join(output, 'evidence.json'),
    JSON.stringify(
      {
        passed: true,
        cliVersion: info.version,
        selections,
        executionContexts,
        records: final.records,
        summary: summarizeUsage(final.records),
        events,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      models: selections.map((s) => s.model),
      records: final.records.map((r) => ({ model: r.model, tokens: r.tokens, partial: r.partial })),
    }),
  );
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify({ error: String(error), events, records: ledger.snapshot().records }, null, 2),
  );
  throw error;
} finally {
  session.close();
  await rm(directory, { recursive: true, force: true });
}
