import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { CodexSession, useMacResponsesProxy } from '../src/main/agents';

test('default OpenAI conversations follow Mac network settings without displacing a configured route', () => {
  assert.equal(useMacResponsesProxy({}, {}, 'darwin'), true);
  assert.equal(
    useMacResponsesProxy(
      { model_provider: 'openai', chatgpt_base_url: 'https://chatgpt.com/backend-api/' },
      { no_proxy: 'localhost,127.0.0.1,::1' },
      'darwin',
    ),
    true,
  );
  for (const env of [
    { HTTPS_PROXY: 'http://proxy' },
    { all_proxy: 'socks5://proxy' },
    { NO_PROXY: 'localhost,.openai.com' },
    { no_proxy: '*' },
    { OPENAI_BASE_URL: 'http://localhost' },
  ]) {
    assert.equal(useMacResponsesProxy({}, env, 'darwin'), false);
  }
  for (const config of [
    { model_provider: 'custom' },
    { openai_base_url: 'http://localhost/v1' },
    { chatgpt_base_url: 'https://private.example' },
    { features: { respect_system_proxy: false } },
    { features: { respect_system_proxy: true } },
    { features: { system_proxy_fallback: false } },
  ]) {
    assert.equal(useMacResponsesProxy(config, {}, 'darwin'), false);
  }
  assert.equal(useMacResponsesProxy(undefined, {}, 'darwin'), false);
  assert.equal(useMacResponsesProxy({}, {}, 'linux'), false);
});

/** A real CLI, a recording-free, loopback-only provider and a proxy that never forwards off-machine. */
test(
  'installed Codex uses the configured proxy for a remote fixture name and bypasses it for a local provider',
  { skip: process.env.ATHENA_TEST_CODEX_NETWORK !== '1', timeout: 30000 },
  async () => {
    const executable = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
    const root = await mkdtemp(path.join(tmpdir(), 'athena-proxy-check-'));
    const sockets = new Set<Socket>();
    const track = (socket: Socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    };
    const origin = createServer((_req, res) => res.writeHead(404).end());
    const webSockets = new WebSocketServer({ noServer: true });
    let samples = 0,
      tunnels = 0;
    origin.on('connection', track);
    origin.on('upgrade', (request, socket, head) =>
      webSockets.handleUpgrade(request, socket, head, (ws) => {
        ws.on('message', (raw) => {
          const request = JSON.parse(raw.toString());
          if (request.type !== 'response.create') return;
          const event = (type: string, body: object) => ws.send(JSON.stringify({ type, ...body }));
          event('response.created', {
            response: { id: 'response', status: 'in_progress', output: [] },
          });
          if (request.generate !== false) {
            samples++;
            event('response.output_item.done', {
              output_index: 0,
              item: {
                id: 'message',
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'transport-ok' }],
              },
            });
          }
          event('response.completed', {
            response: {
              id: 'response',
              status: 'completed',
              output: [],
              usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
            },
          });
        });
      }),
    );
    const listen = (server: ReturnType<typeof createServer>) =>
      new Promise<number>((r) =>
        server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)),
      );
    const port = await listen(origin);
    const proxy = createServer((_req, res) => res.writeHead(404).end());
    proxy.on('connection', track);
    proxy.on('connect', (req, socket, head) => {
      if (req.url !== `athena-transport.invalid:${port}`) return socket.destroy();
      tunnels++;
      const target = connect(port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) target.write(head);
        socket.pipe(target);
        target.pipe(socket);
      });
      track(target);
    });
    const proxyUrl = 'http://127.0.0.1:' + (await listen(proxy));
    const saved = { ...process.env };
    try {
      for (const k of [
        'OPENAI_API_KEY',
        'CODEX_API_KEY',
        'CODEX_ACCESS_TOKEN',
        'OPENAI_BASE_URL',
        'ALL_PROXY',
        'all_proxy',
      ])
        delete process.env[k];
      Object.assign(process.env, {
        HTTPS_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        NO_PROXY: '127.0.0.1,localhost,::1',
        no_proxy: '127.0.0.1,localhost,::1',
      });
      for (const host of ['athena-transport.invalid', '127.0.0.1']) {
        const home = path.join(root, host),
          workspace = path.join(home, 'workspace');
        await mkdir(workspace, { recursive: true });
        process.env.CODEX_HOME = home;
        await writeFile(
          path.join(home, 'config.toml'),
          `model="gpt-5.4"
model_provider="local-fixture"
chatgpt_base_url="http://127.0.0.1:${port}"
cli_auth_credentials_store="file"
[model_providers.local-fixture]
name="Local fixture"
base_url="http://${host}:${port}/v1"
wire_api="responses"
supports_websockets=true
`,
        );
        let reply = '';
        const session = new CodexSession({
          executablePath: executable,
          workspace,
          tools: [],
          callTool: async () => ({ isError: true, text: 'unexpected tool' }),
          onEvent: (e) => {
            if (e.type === 'delta') reply += e.text;
          },
        });
        const deadline = setTimeout(() => session.close(), 8000);
        const priorSamples = samples,
          priorTunnels = tunnels;
        try {
          await session.send('Reply transport-ok.');
          assert.equal(reply, 'transport-ok');
          assert.equal(samples - priorSamples, 1);
          assert.equal(tunnels - priorTunnels, host === '127.0.0.1' ? 0 : 1);
        } finally {
          clearTimeout(deadline);
          session.close();
        }
      }
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      for (const socket of sockets) socket.destroy();
      webSockets.close();
      origin.close();
      proxy.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);
