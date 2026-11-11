import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nodeShebang } from './node-script';
import { StreamCliSession } from '../src/main/stream-cli-session';

async function fixture(cli: 'claude' | 'cursor' | 'gemini', response: unknown, mode = 'normal') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'athena-models-'));
  const executablePath = path.join(directory, 'cli.cjs');
  await writeFile(
    executablePath,
    `${nodeShebang()}
const fs = require('node:fs');
const cli=${JSON.stringify(cli)}, mode=${JSON.stringify(mode)}, response=${JSON.stringify(response)};
fs.writeFileSync(__dirname+'/started', String(process.pid));
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',data=>input+=data);
process.stdin.on('end',()=>{
  const args=process.argv.slice(2);
  fs.writeFileSync(__dirname+'/request.json', JSON.stringify({args,input}));
  if(mode==='hang'){setInterval(()=>{},1000);return;}
  if(mode==='fail'){process.stderr.write('sk-private-provider-secret');process.exit(1);}
  if(cli==='cursor'){process.stdout.write(response);return;}
  if(cli==='gemini'){process.stdout.write(JSON.stringify(response));return;}
  const request=JSON.parse(input);
  if(request.type!=='control_request'||request.request.subtype!=='initialize')process.exit(2);
  process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models:response,account:{secret:'sk-private-provider-secret'}}}}));
});`,
    { mode: 0o700 },
  );
  const session = new StreamCliSession({
    cli,
    workspace: directory,
    executablePath,
    tools: [],
    callTool: async () => {
      throw new Error('Discovery cannot call tools');
    },
    onEvent() {},
  });
  return {
    directory,
    session,
    async cleanup() {
      session.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Claude discovers native model identifiers and supported efforts without a user prompt', async () => {
  const f = await fixture('claude', [
    { value: 'default', displayName: 'Default', description: 'CLI default' },
    {
      value: 'sonnet[1m]',
      displayName: 'Sonnet',
      description: 'Long context',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
    },
    { value: 'haiku', displayName: 'Haiku' },
  ]);
  try {
    const models = await f.session.listModels();
    assert.deepEqual(
      models.map((m) => m.model),
      ['default', 'sonnet[1m]', 'haiku'],
    );
    assert.deepEqual(
      models[1].efforts.map((e) => e.id),
      ['low', 'high'],
    );
    assert.deepEqual(models[2].efforts, []);
    assert.equal(models[0].isDefault, true);
    assert.equal(JSON.stringify(models).includes('sk-private'), false);
    const { args, input } = JSON.parse(
      await readFile(path.join(f.directory, 'request.json'), 'utf8'),
    );
    assert.ok(args.includes('--no-session-persistence'));
    assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.equal(JSON.parse(input).type, 'control_request');
    assert.equal(f.session.sessionId, undefined);
  } finally {
    await f.cleanup();
  }
});

test('Cursor uses its account model catalog and preserves native model variants', async () => {
  const f = await fixture(
    'cursor',
    '\u001b[32mAvailable models\u001b[0m\n\nauto - Auto (default)\nmodel-high-fast - Model High Fast\n\nTip: use --model <id>\n',
  );
  try {
    assert.deepEqual(
      (await f.session.listModels()).map(({ model, name, isDefault, efforts }) => ({
        model,
        name,
        isDefault,
        efforts,
      })),
      [
        { model: 'auto', name: 'Auto', isDefault: true, efforts: [] },
        { model: 'model-high-fast', name: 'Model High Fast', isDefault: false, efforts: [] },
      ],
    );
    const request = JSON.parse(await readFile(path.join(f.directory, 'request.json'), 'utf8'));
    assert.deepEqual(request.args, ['--list-models']);
    assert.equal(request.input, '');
  } finally {
    await f.cleanup();
  }
});

test('Gemini reads structured native model identifiers without fabricating effort or a default', async () => {
  const f = await fixture('gemini', [
    { modelId: 'auto', name: 'Auto', description: 'CLI routing' },
    { modelId: 'gemini-native', name: 'Native model', description: '' },
  ]);
  try {
    const models = await f.session.listModels();
    assert.deepEqual(
      models.map((model) => model.model),
      ['auto', 'gemini-native'],
    );
    assert.ok(models.every((model) => model.efforts.length === 0 && !model.isDefault));
    const request = JSON.parse(await readFile(path.join(f.directory, 'request.json'), 'utf8'));
    assert.deepEqual(request.args, ['--list-models', '--output-format', 'json']);
    assert.equal(request.input, '');
  } finally {
    await f.cleanup();
  }
});

for (const [cli, response] of [
  ['claude', {}],
  ['cursor', 'Login required\n'],
  ['gemini', { error: 'login required' }],
] as const)
  test(`${cli}: malformed catalog is an error, not an empty success`, async () => {
    const f = await fixture(cli, response);
    try {
      await assert.rejects(f.session.listModels(), /模型目录/);
    } finally {
      await f.cleanup();
    }
  });

test('Discovery errors never surface provider diagnostics', async () => {
  const f = await fixture('cursor', '', 'fail');
  try {
    await assert.rejects(
      f.session.listModels(),
      (error) =>
        error instanceof Error &&
        /CLI 信息/.test(error.message) &&
        !error.message.includes('sk-private'),
    );
  } finally {
    await f.cleanup();
  }
});

test('Closing the adapter cancels model discovery and kills its process', async () => {
  const f = await fixture('claude', [], 'hang');
  let timer: NodeJS.Timeout;
  let watcher: ReturnType<typeof watch> | undefined;
  const started = new Promise<number>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('CLI fixture did not start')), 20000);
    const observe = async () => {
      const pid = Number(await readFile(path.join(f.directory, 'started'), 'utf8').catch(() => ''));
      if (pid) {
        clearTimeout(timer);
        resolve(pid);
      }
    };
    watcher = watch(f.directory, () => void observe());
  });
  try {
    const pending = assert.rejects(f.session.listModels(), /关闭|取消/);
    const pid = await started;
    f.session.close();
    await pending;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    clearTimeout(timer!);
    watcher?.close();
    await f.cleanup();
  }
});
