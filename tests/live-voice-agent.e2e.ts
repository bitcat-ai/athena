/** Opt-in one real local Codex turn; voice signaling uses an isolated fixture and no microphone. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import type { AppSnapshot, Conversation } from '../src/shared/types';

if (process.env.ATHENA_TEST_LIVE_VOICE_AGENT !== '1')
  throw new Error('Set ATHENA_TEST_LIVE_VOICE_AGENT=1 to run one real Codex model turn');
const directory = await mkdtemp(path.join(tmpdir(), 'athena-live-voice-agent-'));
await seedLegacyWorkspace(directory);
const marker = '语音联调 ' + randomUUID().slice(0, 8);
let app: ElectronApplication | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  app = await electron.launch({
    args: ['tests/electron-background.cjs', '--use-mock-keychain'],
    env: { ...process.env, WORKBENCH_DEV_SERVER_URL: '', WORKBENCH_USER_DATA_DIR: directory },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.workbench));
  const invoke = <T>(action: string, payload?: unknown) =>
    page.evaluate(({ action, payload }) => window.workbench.invoke<T>(action, payload), {
      action,
      payload,
    });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), directory);
  await app.evaluate(({ net }) => {
    const original = net.fetch.bind(net);
    net.fetch = (input, init) => {
      if (String(input) === 'https://api.openai.com/v1/live/sessions')
        return Promise.resolve(
          Response.json({
            session: { id: 'voice_agent_fixture' },
            transport: { type: 'webrtc', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' },
          }),
        );
      if (String(input) === 'https://api.openai.com/v1/live/sessions/voice_agent_fixture/hangup')
        return Promise.resolve(new Response(null, { status: 200 }));
      return original(input, init);
    };
  });
  const snapshot = () => invoke<AppSnapshot>('app:snapshot');
  await expect
    .poll(async () => (await snapshot()).browser.status, { timeout: 25000 })
    .toBe('ready');
  const state = await snapshot();
  const conversation = state.conversations[0] ?? (await invoke<Conversation>('conversation:new'));
  const query = () => invoke<{ elements: { text: string }[] }>('browser:query', { selector: 'h1' });
  assert((await query()).elements.length, 'the local welcome page must contain a heading');
  await invoke('voice:configure', { key: 'sk-local-signaling-fixture-not-a-real-key' });
  await invoke('voice:connect', {
    requestId: 'voice_real_agent',
    conversationId: conversation.id,
    sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
  });
  const text =
    '请把当前网页上 h1 标题的文字改成「' + marker + '」。改完请重新读取这个标题，告诉我实际文字。';
  const result = await Promise.race([
    invoke<{ text: string }>('voice:delegate', {
      requestId: 'voice_real_agent',
      delegationId: 'edit_title',
      offsetMs: 1000,
      transcripts: [{ role: 'user', text, startMs: 0, endMs: 1000 }],
    }).then((reply) => reply.text),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Timed out waiting for the real Codex turn')),
        140000,
      );
    }),
  ]);
  assert.equal((await query()).elements[0]?.text, marker);
  assert(result.includes(marker), 'Agent result must include independently verified title');
  const current = (await snapshot()).conversations.find((c) => c.id === conversation.id)!;
  assert.equal(current.messages.at(-1)?.status, 'done');
  await invoke('voice:disconnect', { requestId: 'voice_real_agent' });
  const evidence = {
    localAgent: 'codex',
    voiceSignaling: 'isolated fixture',
    microphone: false,
    title: marker,
    resultVerified: true,
    tools: current.messages.at(-1)?.tools?.map((t) => t.name),
  };
  await mkdir('test-results/live-voice', { recursive: true });
  await writeFile('test-results/live-voice/agent-result.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  clearTimeout(timer);
  await app
    ?.firstWindow()
    .then((page) => page.evaluate(() => window.workbench.invoke('voice:disconnect', {})))
    .catch(() => {});
  await app?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 4 });
}
