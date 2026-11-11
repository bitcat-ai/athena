/** Installed OpenCode + a loopback model fixture: native approvals, file IO, resume and stop; no remote inference. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OpenCodeSession } from '../src/main/opencode-session';
import type { AgentEvent } from '../src/shared/types';
import { testImage } from './image-fixture';

const executable = process.env.WORKBENCH_TEST_OPENCODE_PATH;
if (!executable || !path.isAbsolute(executable))
  throw Error('Set WORKBENCH_TEST_OPENCODE_PATH to an installed OpenCode 1.x executable.');
const directory = await mkdtemp(path.join(os.tmpdir(), 'athena-opencode-native-'));
const workspace = path.join(directory, 'workspace');
await mkdir(workspace);
const file = path.join(workspace, 'evidence.txt'),
  marker = randomUUID();
await writeFile(file, marker);
const output = path.resolve('test-results/opencode-native');
await mkdir(output, { recursive: true });
const events: AgentEvent[] = [],
  requests: any[] = [],
  approvals: Array<{ title: string; keys: string[]; approved: boolean }> = [];
let phase: 'read' | 'write' | 'resume' | 'stop' | 'browser' | 'image' | 'denied' = 'read',
  session: OpenCodeSession | undefined;
const hostCalls: Array<{ name: string; value: unknown }> = [];
let resolveStarted: () => void = () => {};
const started = new Promise<void>((resolve) => {
  resolveStarted = resolve;
});
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || '{}');
  requests.push({
    phase,
    model: body.model,
    tools: (body.tools || []).map((t: any) => t.function?.name),
    hasMarker: JSON.stringify(body.messages).includes(marker),
  });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (delta: any, finish_reason: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  const answer = (text: string) => {
    send({ role: 'assistant', content: text });
    send({}, 'stop');
    res.end('data: [DONE]\n\n');
  };
  if (!body.tools?.length) {
    answer('Local catalog check');
    return;
  }
  if (phase === 'stop') {
    send({ role: 'assistant', content: 'running' });
    resolveStarted();
    return;
  }
  if (phase === 'image') {
    answer(JSON.stringify(body.messages).includes(testImage.data) ? 'IMAGE_OK' : 'IMAGE_MISSING');
    return;
  }
  if (phase === 'denied' && !requests.at(-1).tools.includes('read')) {
    answer('DENIED_OK');
    return;
  }
  const toolName = phase === 'browser' ? 'athena_neo_probe' : phase === 'read' ? 'read' : 'write';
  const hasResult = body.messages?.some((m: any) => m.role === 'tool');
  if (phase === 'resume') {
    answer(requests.at(-1).hasMarker ? 'RESUME_OK' : 'RESUME_MISSING');
    return;
  }
  if (hasResult) {
    answer(phase === 'browser' ? 'BROWSER_OK' : phase === 'read' ? 'READ_OK' : 'WRITE_OK');
    return;
  }
  if (!requests.at(-1).tools.includes(toolName)) {
    answer('TOOL_MISSING');
    return;
  }
  const args =
    phase === 'browser'
      ? { value: marker }
      : phase === 'read'
        ? { filePath: file }
        : { filePath: file, content: `${marker}\nupdated` };
  send({
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id: `call-${phase}`,
        type: 'function',
        function: { name: toolName, arguments: JSON.stringify(args) },
      },
    ],
  });
  send({}, 'tool_calls');
  res.end('data: [DONE]\n\n');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
process.env.XDG_CONFIG_HOME = path.join(directory, 'config');
process.env.XDG_DATA_HOME = path.join(directory, 'data');
process.env.XDG_CACHE_HOME = path.join(directory, 'cache');
process.env.OPENCODE_CONFIG_DIR = path.join(directory, 'config', 'opencode');
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  enabled_providers: ['athena-fixture'],
  model: 'athena-fixture/fixture-model',
  small_model: 'athena-fixture/fixture-model',
  autoupdate: false,
  share: 'disabled',
  provider: {
    'athena-fixture': {
      npm: '@ai-sdk/openai-compatible',
      name: 'Local fixture',
      options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-only' },
      models: {
        'fixture-model': {
          name: 'Fixture model',
          limit: { context: 32000, output: 2048 },
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      },
    },
  },
});
const make = (sessionId?: string) =>
  new OpenCodeSession({
    workspace,
    executablePath: executable,
    sessionId,
    tools: [
      {
        name: 'neo_probe',
        description: 'Return a local verification value',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ],
    callTool: async (name, args) => {
      hostCalls.push({ name, value: args.value });
      assert.equal(name, 'neo_probe');
      assert.equal(args.value, marker);
      return { text: marker };
    },
    onEvent(event) {
      events.push(event);
      if (event.type === 'approval') {
        const data = JSON.parse(event.request.detail);
        const target = data.filePath ?? data.filepath ?? data.path;
        const approved =
          phase !== 'denied' &&
          target === file &&
          !Object.keys(data).some((key) => /command/i.test(key));
        approvals.push({ title: event.request.title, keys: Object.keys(data), approved });
        session!.resolveApproval(event.request.id, approved);
      }
    },
  });
const timer = setTimeout(() => session?.close(), 90000);
try {
  session = make();
  const models = await session.listModels();
  assert.ok(models.some((m) => m.model === 'athena-fixture/fixture-model'));
  await session.send('Read the requested evidence file.', undefined, undefined, {
    model: 'athena-fixture/fixture-model',
  });
  assert.ok(events.some((e) => e.type === 'complete' && e.text?.includes('READ_OK')));
  assert.ok(approvals.some((a) => a.approved));
  assert.ok(
    requests.some((r) => r.phase === 'read' && r.hasMarker),
    'Native file content must reach the local provider',
  );
  const id = session.sessionId;
  assert.ok(id);
  session.close();
  session = make(id);
  phase = 'resume';
  await session.send('Recall the evidence from this native session.');
  assert.ok(events.some((e) => e.type === 'complete' && e.text?.includes('RESUME_OK')));
  assert.equal(session.sessionId, id);
  session.close();
  session = make();
  phase = 'write';
  await session.send('Update the requested evidence file.', undefined, undefined, {
    model: 'athena-fixture/fixture-model',
  });
  assert.equal(await readFile(file, 'utf8'), `${marker}\nupdated`);
  session.close();
  session = make();
  phase = 'browser';
  await session.send('Check the host browser tool.', undefined, undefined, {
    model: 'athena-fixture/fixture-model',
  });
  assert.deepEqual(hostCalls, [{ name: 'neo_probe', value: marker }]);
  assert.equal(
    events.some((e) => e.type === 'tool' && e.call.name === 'athena_neo_probe'),
    false,
  );
  assert.ok(events.some((e) => e.type === 'complete' && e.text?.includes('BROWSER_OK')));
  phase = 'image';
  await session.send('Check this attachment.', undefined, undefined, undefined, [testImage]);
  assert.ok(events.some((e) => e.type === 'complete' && e.text?.includes('IMAGE_OK')));
  phase = 'stop';
  const pending = assert.rejects(session.send('Keep responding.'), /停止/);
  await started;
  await session.interrupt();
  await pending;
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!);
  config.permission = { read: 'deny' };
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  phase = 'denied';
  session = make();
  const priorApprovals = approvals.length;
  await session.send('Check that the native read restriction is preserved.', undefined, undefined, {
    model: 'athena-fixture/fixture-model',
  });
  assert.ok(events.some((e) => e.type === 'complete' && e.text?.includes('DENIED_OK')));
  assert.equal(approvals.length, priorApprovals);
  assert.ok(approvals.every((a) => a.approved));
  assert.ok(requests.every((r) => r.model === 'fixture-model'));
  const evidence = {
    passed: true,
    source: 'installed-opencode-loopback-model',
    remoteModelCalls: 0,
    approvals,
    requests: requests.length,
    checks: [
      'native model catalog',
      'explicit model passed to native provider',
      'native read and write approvals',
      'native session resume',
      'interrupt',
      'private host MCP roundtrip',
      'native image content reaches the provider',
      'native deny rules remain denied',
    ],
  };
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      {
        error: error instanceof Error ? error.message : 'unknown',
        approvals,
        requests,
        events: events.filter(
          (e) => e.type === 'error' || e.type === 'complete' || e.type === 'tool',
        ),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  clearTimeout(timer);
  session?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
