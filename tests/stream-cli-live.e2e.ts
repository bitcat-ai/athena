// Opt-in real model calls. No file changes, shell commands or external messages are requested.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentSession } from '../src/main/agent-factory';
import type { AgentSession } from '../src/main/agent-session';
import { executableAgents } from '../src/shared/agents';
import type { AgentEvent, AgentId } from '../src/shared/types';

const cli = process.env.WORKBENCH_LIVE_CLI;
const executablePath = process.env.WORKBENCH_CLI_PATH;
if (
  !cli ||
  !(executableAgents as readonly string[]).includes(cli) ||
  !executablePath ||
  !path.isAbsolute(executablePath)
)
  throw new Error(
    'Authorize a real model test with WORKBENCH_LIVE_CLI=codex|claude|gemini|pi|cursor|opencode and WORKBENCH_CLI_PATH.',
  );
const workspace = await mkdtemp(path.join(os.tmpdir(), `athena-${cli}-live-`));
const marker = `athena-${randomUUID()}`;
const events: AgentEvent[] = [];
let session: AgentSession;
let stopOnDelta = false;
const make = (sessionId?: string) =>
  createAgentSession(cli as AgentId, {
    workspace,
    executablePath,
    sessionId,
    sessionDirectory: path.join(workspace, 'sessions'),
    permissionsExtensionPath: path.resolve('resources/cli/pi-permissions.mjs'),
    tools: [],
    callTool: async () => ({ isError: true, text: 'Browser tools unavailable' }),
    onEvent(event) {
      events.push(event);
      if (event.type === 'approval') {
        session.resolveApproval(
          event.request.id,
          /^(cursor|gemini)-workspace:/.test(event.request.id) &&
            event.request.detail.startsWith(`${workspace}\n`),
        );
      }
      if (event.type === 'delta' && stopOnDelta) {
        stopOnDelta = false;
        void session.interrupt();
      }
    },
  });
const deadline = setTimeout(() => session?.close(), 150000);
try {
  session = make();
  await session.send(
    `Remember this marker for this conversation: ${marker}. Reply with only the exact marker. Do not use any tools or read any files.`,
  );
  assert.ok(
    events
      .filter((e) => e.type === 'delta')
      .map((e) => e.text)
      .join('')
      .includes(marker),
  );
  const id = session.sessionId;
  assert.ok(id, 'Native session ID was not returned');
  session.close();
  session = make(id);
  const before = events.length;
  await session.send('Reply with only the exact marker from the previous turn. Do not use tools.');
  assert.ok(
    events
      .slice(before)
      .filter((e) => e.type === 'delta')
      .map((e) => e.text)
      .join('')
      .includes(marker),
    'Native resume did not recall the original marker',
  );
  stopOnDelta = true;
  await assert.rejects(
    session.send(
      'Without using any tools, count from 1 to 2000, writing each integer on its own line. Do not stop early.',
    ),
    /停止/,
  );
  assert.equal(stopOnDelta, false);
  console.log(
    JSON.stringify({
      cli,
      checks: ['real response', 'streaming', 'native resume', 'interrupt'],
      modelEvidence: events.some((e) => e.type === 'model'),
      usageEvidence: events.some((e) => e.type === 'usage'),
    }),
  );
} finally {
  clearTimeout(deadline);
  session!?.close();
  await rm(workspace, { recursive: true, force: true });
}
