/** Use the installed Codex app-server; the local Responses fixture makes no provider calls. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { CodexSession } from '../src/main/agents';
import type { AgentEvent } from '../src/shared/types';
import { testImage } from './image-fixture';

const live = process.argv.includes('--live');
const root = await mkdtemp(path.join(tmpdir(), 'athena-codex-image-'));
const executable = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
const png = testImage.data;
const requests: string[][] = [];
let generations = 0;
const server = createServer(async (req, res) => {
  if (req.url?.endsWith('/images/generations')) {
    generations++;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        created: 1,
        background: 'opaque',
        data: [{ b64_json: png, generation_id: 'gen-local-fixture' }],
      }),
    );
    return;
  }
  if (!req.url?.endsWith('/responses')) {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const body = (
    req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes
  ).toString('utf8');
  requests.push(
    (JSON.parse(body).tools ?? []).map((t: { type: string; name?: string }) => t.name ?? t.type),
  );
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type: string, data: object) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('response.created', { response: { id: 'resp_local', status: 'in_progress', output: [] } });
  if (requests.length === 1)
    event('response.output_item.done', {
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: 'ig-1',
        namespace: 'image_gen',
        name: 'imagegen',
        arguments: JSON.stringify({ prompt: 'a blue dot' }),
      },
    });
  else
    event('response.output_item.done', {
      output_index: 0,
      item: {
        id: 'msg',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: '图片已生成' }],
      },
    });
  event('response.completed', {
    response: {
      id: 'resp_local',
      status: 'completed',
      output: [],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  });
  res.end();
});
const home = path.join(root, 'codex-home'),
  workspace = path.join(root, 'workspace');
await mkdir(workspace);
delete process.env.OPENAI_API_KEY;
delete process.env.CODEX_API_KEY;
if (!live) {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await mkdir(home);
  process.env.CODEX_HOME = home;
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'fixture',
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'local-fixture',
        chatgpt_plan_type: 'plus',
      },
    }),
  ).toString('base64url');
  const token = 'eyJhbGciOiJub25lIn0.' + payload + '.fixture';
  await writeFile(
    path.join(home, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: token,
        access_token: token,
        refresh_token: 'unused',
        account_id: 'local-fixture',
      },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(home, 'config.toml'),
    `model = "gpt-5.4"
model_provider = "local"
chatgpt_base_url = "${origin}"
cli_auth_credentials_store = "file"
[model_providers.local]
name = "OpenAI"
base_url = "${origin}/api/codex"
wire_api = "responses"
supports_websockets = false
requires_openai_auth = true
`,
  );
}
const events: AgentEvent[] = [];
const generatedImageDirectory = live
  ? path.resolve('test-results/codex-native-image')
  : path.join(root, 'images');
const session = new CodexSession({
  workspace,
  executablePath: executable,
  tools: [],
  generatedImageDirectory,
  onEvent: (e) => {
    events.push(e);
    if (e.type === 'approval') session.resolveApproval(e.request.id, false);
  },
  callTool: async () => ({ isError: true, text: 'No external tools in the image check' }),
});
const timeout = setTimeout(
  () => {
    session.close();
  },
  live ? 240_000 : 45_000,
);
try {
  await session.send(
    '使用当前 Codex 内置图片生成工具生成一张白底蓝色圆形的 PNG 小图。直接生图，无需使用 shell 或 API 脚本。',
  );
  const artifact = events.flatMap((e) =>
    e.type === 'web-execution' && e.event.artifact ? [e.event.artifact] : [],
  )[0];
  assert.ok(
    artifact,
    'No native image artifact: ' +
      JSON.stringify(
        events.filter((e) => e.type === 'tool').map((e) => e.call.name + ':' + e.call.status),
      ),
  );
  const bytes = await readFile(artifact.path);
  assert(bytes.length === artifact.bytes && bytes.length > 24);
  if (!live) {
    assert.equal(bytes.toString('base64'), png);
    assert.equal(generations, 1);
  }
  console.log(
    JSON.stringify({
      runtime: execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(),
      provider: live ? 'signed-in Codex' : 'local Responses and Images fixtures',
      apiKeyProvided: false,
      imageRequests: live ? undefined : generations,
      artifact: live ? artifact.path : path.basename(artifact.path),
      bytes: artifact.bytes,
    }),
  );
} finally {
  clearTimeout(timeout);
  session.close();
  server.close();
  await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 });
}
