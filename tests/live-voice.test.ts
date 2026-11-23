import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { LiveVoice } from '../src/main/live-voice';
import { voiceContext, type VoiceTranscript } from '../src/shared/live-voice';

const key = 'sk-isolated-test-not-a-real-key';
const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const input: VoiceTranscript[] = [
  { role: 'assistant', text: '好的。', startMs: 120, endMs: 160 },
  { role: 'user', text: '检查', startMs: 0, endMs: 100 },
  { role: 'user', text: ' 项目。', startMs: 100, endMs: 300 },
];

async function world(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-live-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'voice', 'credentials.json');
  const requests: { url: string; init: RequestInit }[] = [];
  const tasks: {
    id: string;
    text: string;
    context: string;
    signal: AbortSignal;
    pointer?: { x: number; y: number; tabId?: string };
    relay?: string[];
  }[] = [];
  let failEncryption = false;
  let request: (url: string) => Promise<Response> = async (url) =>
    url.endsWith('/hangup')
      ? new Response(null, { status: 200 })
      : Response.json({
          session: { id: 'live_fixture' },
          transport: { type: 'webrtc', sdp: offer },
        });
  let run: () => Promise<string> = async () => '已核对项目，测试通过。';
  const options = {
    file,
    encrypt: async (value: string) => {
      if (failEncryption) throw new Error('locked');
      return Buffer.from(value).toString('base64');
    },
    decrypt: async (value: string) => Buffer.from(value, 'base64').toString(),
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return request(url);
    },
    runTask: async (
      id: string,
      text: string,
      context: string,
      signal: AbortSignal,
      pointer?: { x: number; y: number; tabId?: string },
      relay?: string[],
    ) => {
      tasks.push({ id, text, context, signal, pointer, relay });
      return run();
    },
  };
  const voice = new LiveVoice(options);
  await voice.load();
  return {
    voice,
    options,
    file,
    requests,
    tasks,
    setRequest: (value: typeof request) => {
      request = value;
    },
    setRun: (value: typeof run) => {
      run = value;
    },
    lock: () => {
      failEncryption = true;
    },
    connect: async () => {
      await voice.configure(key);
      return voice.connect('request_a', 'conversation_a', offer);
    },
  };
}

test('voice credentials are saved encrypted with owner-only access and never returned', async (t) => {
  const w = await world(t);
  assert.deepEqual(w.voice.config(), { configured: false, active: false });
  await assert.rejects(w.voice.configure('invalid'), /有效/);
  await w.voice.configure(key);
  assert.ok(!(await readFile(w.file, 'utf8')).includes(key));
  assert.equal((await stat(w.file)).mode & 0o777, 0o600);
  const restored = new LiveVoice(w.options);
  await restored.load();
  assert.deepEqual(restored.config(), { configured: true, active: false });
  assert.equal(w.requests.length, 0, 'saving a key does not initiate a billable session');
  w.lock();
  const saved = await readFile(w.file, 'utf8');
  await assert.rejects(w.voice.configure('sk-another-isolated-test-key'), /locked/);
  assert.equal(await readFile(w.file, 'utf8'), saved);
  await restored.forget();
  assert.deepEqual(restored.config(), { configured: false, active: false });
  await assert.rejects(stat(w.file), { code: 'ENOENT' });
});

test('the host creates a Live session with client delegation and protects the fixed endpoint', async (t) => {
  const w = await world(t);
  assert.throws(() => w.voice.connect('request_a', 'conversation_a', offer), /保存/);
  const result = await w.connect();
  assert.deepEqual(result, { sessionId: 'live_fixture', sdp: offer });
  const request = w.requests[0];
  assert.equal(request.url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(new Headers(request.init.headers).get('Authorization'), `Bearer ${key}`);
  const body = JSON.parse(String(request.init.body));
  assert.equal(body.session.model, 'gpt-live-1');
  assert.deepEqual(body.session.delegation, { type: 'client' });
  assert.equal(body.session.store, false);
  assert.deepEqual(body.transport, { type: 'webrtc', sdp: offer });
  assert.ok(!JSON.stringify(result).includes(key));
  assert.throws(() => w.voice.connect('request_b', 'conversation_a', offer), /已有/);
  await assert.rejects(w.voice.configure(key), /结束/);
  await assert.rejects(w.voice.forget(), /结束/);
  await w.voice.disconnect('different_request');
  assert.equal(w.requests.length, 1);
  await w.voice.disconnect('request_a');
  assert.equal(w.requests[1].url, 'https://api.openai.com/v1/live/sessions/live_fixture/hangup');
  assert.equal(w.voice.config().active, false);
  assert.throws(() => w.voice.connect('request_a', 'conversation_a', offer + 'm=video'), /无效/);
});

test('OpenAI authentication failures are actionable without echoing a key or retrying', async (t) => {
  const w = await world(t);
  w.setRequest(async () => new Response(`invalid key ${key}`, { status: 401 }));
  await assert.rejects(
    w.connect(),
    (error: Error) => error.message.includes('401') && !error.message.includes(key),
  );
  assert.equal(w.requests.length, 1);
  assert.equal(w.voice.config().active, false);
});

test('cancelling an in-flight connection hangs up its eventual session exactly once', async (t) => {
  const w = await world(t);
  let release!: (value: Response) => void;
  w.setRequest(async (url) =>
    url.endsWith('/hangup')
      ? new Response()
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  const connecting = w.connect();
  const rejected = assert.rejects(connecting, /取消/);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const stopped = w.voice.disconnect('request_a');
  release(Response.json({ session: { id: 'live_fixture' }, transport: { sdp: offer } }));
  await Promise.all([rejected, stopped]);
  assert.equal(w.requests.filter((r) => r.url.endsWith('/hangup')).length, 1);
  assert.equal(w.voice.config().active, false);
});

test('unknown hangup outcome blocks a new call until the user retries ending it', async (t) => {
  const w = await world(t);
  await w.connect();
  w.setRequest(async () => {
    throw new Error(`network ${key}`);
  });
  await assert.rejects(w.voice.disconnect('request_a'), /未确认远端通话结束/);
  assert.equal(w.voice.config().active, true);
  assert.throws(() => w.voice.connect('request_b', 'conversation_a', offer), /已有/);
  w.setRequest(async () => new Response(null, { status: 404 }));
  await w.voice.disconnect('request_a');
  assert.equal(w.voice.config().active, false);
});

test('delegation preserves timed overlapping context, executes once and excludes old requests', async (t) => {
  const w = await world(t);
  await w.connect();
  const first = w.voice.delegate('request_a', 'delegation_1', input, 300);
  assert.equal(w.voice.delegate('request_a', 'delegation_1', input, 300), first);
  assert.equal(await first, '已核对项目，测试通过。');
  assert.equal(w.tasks.length, 1);
  assert.equal(w.tasks[0].id, 'conversation_a');
  assert.equal(w.tasks[0].text, '检查 项目。');
  assert.match(w.tasks[0].context, /用户（本次新增）：检查/);
  assert.ok(w.tasks[0].context.indexOf('检查') < w.tasks[0].context.indexOf('好的'));
  assert.match(await w.voice.delegate('request_a', 'delegation_2', input, 300), /未执行/);
  assert.equal(w.tasks.length, 1);
  const next = [
    ...input,
    { role: 'user' as const, text: '继续检查构建。', startMs: 350, endMs: 500 },
  ];
  await w.voice.delegate('request_a', 'delegation_3', next, 500);
  assert.equal(w.tasks[1].text, '继续检查构建。');
  assert.match(w.tasks[1].context, /之前，已处理/);
  assert.throws(
    () => w.voice.delegate('request_a', 'bad', [{ ...input[0], endMs: -1 }], 0),
    /格式无效/,
  );
  assert.throws(() => w.voice.delegate('request_a', '../../escape', next, 0), /标识无效/);
  await w.voice.disconnect('request_a', true);
  assert.equal(w.requests.length, 1, 'confirmed session.closed needs no redundant hangup');
});

test('hanging up aborts the task in hand and the correction that was taking over from it', async (t) => {
  const w = await world(t);
  await w.connect();
  let finish!: () => void;
  w.setRun(
    () =>
      new Promise((resolve) => {
        finish = () => resolve('stopped');
      }),
  );
  const pending = w.voice.delegate('request_a', 'delegation_1', input, 300);
  await new Promise((resolve) => setImmediate(resolve));
  const correction = [
    ...input,
    { role: 'user' as const, text: '改为检查测试', startMs: 350, endMs: 500 },
  ];
  const corrected = w.voice.delegate('request_a', 'delegation_2', correction, 500);
  void corrected.catch(() => {});
  assert.equal(w.tasks[0].signal.aborted, true, 'a correction stops the work in hand');
  await w.voice.disconnect('request_a');
  finish();
  assert.match(await pending, /取代/);
  await assert.rejects(corrected, /已结束/);
  assert.equal(w.tasks.length, 1, 'nothing new starts after the call has ended');
  assert.throws(() => w.voice.delegate('request_a', 'delegation_3', correction, 500), /已结束/);
});

test('a failed task cannot be replayed by a duplicate delegation', async (t) => {
  const w = await world(t);
  await w.connect();
  w.setRun(async () => {
    throw new Error('partial action outcome unknown');
  });
  const first = w.voice.delegate('request_a', 'delegation_1', input, 300);
  await assert.rejects(first, /unknown/);
  assert.equal(w.voice.delegate('request_a', 'delegation_1', input, 300), first);
  assert.match(await w.voice.delegate('request_a', 'delegation_2', input, 300), /未执行/);
  assert.equal(w.tasks.length, 1);
  await w.voice.disconnect();
});

test('context keeps repeated words and both voices in order, and separates what is new', () => {
  assert.equal(
    voiceContext(
      [
        { role: 'assistant', text: 'Sure', startMs: 150, endMs: 200 },
        { role: 'user', text: 'I I', startMs: 10, endMs: 130 },
        { role: 'user', text: ' need help', startMs: 120, endMs: 250 },
      ],
      140,
    ),
    '用户（之前，已处理）：I I\n用户（本次新增）：need help\n语音助手（本次新增）：Sure',
  );
});

/** A task that runs until it is released or its signal aborts, as a real turn does when stopped. */
function held(w: Awaited<ReturnType<typeof world>>) {
  const runs: Array<{ release(value: string): void; signal: AbortSignal }> = [];
  w.setRun(
    () =>
      new Promise<string>((resolve, reject) => {
        const signal = w.tasks.at(-1)!.signal;
        runs.push({ release: resolve, signal });
        signal.addEventListener('abort', () => reject(new Error('任务已停止')), { once: true });
      }),
  );
  return runs;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const say = (text: string, startMs: number): VoiceTranscript => ({
  role: 'user',
  text,
  startMs,
  endMs: startMs + 100,
});

test('a changed request stops the work in hand and carries on from it, without a word about the old one', async (t) => {
  const w = await world(t);
  await w.connect();
  const runs = held(w);
  const first = w.voice.delegate('request_a', 'first', [say('把按钮改成橙色', 0)], 200);
  await tick();
  const words = [say('把按钮改成橙色', 0), say('不对，改成蓝色', 400)];
  const second = w.voice.delegate('request_a', 'second', words, 600);
  assert.equal(runs[0].signal.aborted, true, 'the work in hand is stopped');
  assert.equal(await first, await first);
  assert.match(await first, /取代/);
  assert.equal(w.voice.silent('first'), true);
  assert.equal(w.voice.silent('second'), false);
  await tick();
  assert.equal(w.tasks.length, 2, 'the new request starts once the old one has stopped');
  assert.equal(w.tasks[1].text, '不对，改成蓝色');
  assert.deepEqual(w.tasks[1].relay, ['把按钮改成橙色']);
  // A third change takes over from the second and still knows what the first wanted.
  const third = w.voice.delegate(
    'request_a',
    'third',
    [...words, say('算了还是绿色吧，字也加粗', 900)],
    1100,
  );
  assert.match(await second, /取代/);
  await tick();
  assert.deepEqual(w.tasks[2].relay, ['把按钮改成橙色', '不对，改成蓝色']);
  runs[2].release('按钮现在是绿色，文字已加粗。');
  assert.equal(await third, '按钮现在是绿色，文字已加粗。');
  await w.voice.disconnect();
});

test('something more is done after the work in hand, which is left alone', async (t) => {
  const w = await world(t);
  await w.connect();
  const runs = held(w);
  const first = w.voice.delegate('request_a', 'first', [say('把按钮改成橙色', 0)], 200);
  await tick();
  const words = [say('把按钮改成橙色', 0), say('再把标题加粗', 400)];
  const second = w.voice.delegate('request_a', 'second', words, 600);
  await tick();
  assert.equal(runs[0].signal.aborted, false);
  assert.equal(w.tasks.length, 1, 'the addition waits its turn');
  // A question about the page is also answered afterwards.
  const third = w.voice.delegate(
    'request_a',
    'third',
    [...words, say('标题现在是什么颜色', 800)],
    1000,
  );
  runs[0].release('按钮已改成橙色。');
  assert.equal(await first, '按钮已改成橙色。');
  await tick();
  assert.equal(w.tasks[1].text, '再把标题加粗');
  assert.equal(w.tasks[1].relay, undefined);
  runs[1].release('标题已加粗。');
  assert.equal(await second, '标题已加粗。');
  await tick();
  assert.equal(w.tasks[2].text, '标题现在是什么颜色');
  runs[2].release('黑色。');
  assert.equal(await third, '黑色。');
  assert.equal(w.voice.silent('first'), false);
  await w.voice.disconnect();
});

test('asking how it is going does not disturb the work, and saying stop ends it with nothing new', async (t) => {
  const w = await world(t);
  await w.connect();
  const runs = held(w);
  const first = w.voice.delegate('request_a', 'first', [say('把页面改成复古风格', 0)], 200);
  await tick();
  const asked = [say('把页面改成复古风格', 0), say('好了吗', 400)];
  const status = await w.voice.delegate('request_a', 'status', asked, 600);
  assert.match(status, /还在处理「把页面改成复古风格」/);
  assert.equal(runs[0].signal.aborted, false);
  assert.equal(w.tasks.length, 1);
  // "好的" while it works is not a new request, and a spoken yes is not an approval.
  const nodded = await w.voice.delegate(
    'request_a',
    'nod',
    [...asked, say('同意，执行', 700)],
    790,
  );
  assert.match(nodded, /没有打断/);
  assert.match(nodded, /界面/);
  assert.equal(runs[0].signal.aborted, false);
  assert.equal(w.tasks.length, 1);
  const stop = w.voice.delegate('request_a', 'stop', [...asked, say('算了，停下吧', 800)], 1000);
  assert.equal(runs[0].signal.aborted, true);
  assert.match(await stop, /已按用户的要求停下「把页面改成复古风格」/);
  assert.match(await first, /取代/);
  assert.equal(w.voice.silent('first'), true);
  assert.equal(w.tasks.length, 1, 'stopping starts nothing');
  // With nothing in hand, the next request is an ordinary one.
  w.setRun(async () => 'done');
  await w.voice.delegate('request_a', 'next', [...asked, say('算了，停下吧', 800), say('打开百度', 1200)], 1400);
  assert.equal(w.tasks[1].relay, undefined);
  await w.voice.disconnect();
});

test('ending the call stops whatever is running or waiting', async (t) => {
  const w = await world(t);
  await w.connect();
  const runs = held(w);
  const first = w.voice.delegate('request_a', 'first', [say('整理这张表格', 0)], 200);
  await tick();
  const second = w.voice.delegate(
    'request_a',
    'second',
    [say('整理这张表格', 0), say('然后总结一下', 400)],
    600,
  );
  void second.catch(() => {});
  await w.voice.disconnect('request_a');
  assert.equal(runs[0].signal.aborted, true);
  await assert.rejects(first, /已停止/);
  await assert.rejects(second, /已结束/);
  assert.equal(w.tasks.length, 1);
});

test('what the pointer rests on travels with a spoken request, and a malformed point is dropped', async (t) => {
  const w = await world(t);
  await w.connect();
  const said = (text: string, startMs: number) => [
    { role: 'user' as const, text, startMs, endMs: startMs + 200 },
  ];
  await w.voice.delegate('request_a', 'point_1', said('把这个改大一点', 0), 300, {
    x: 120.5,
    y: 80,
    tabId: 'tab_1',
    extra: 'ignored',
  });
  assert.deepEqual(w.tasks.at(-1)?.pointer, { x: 120.5, y: 80, tabId: 'tab_1' });
  await w.voice.delegate('request_a', 'point_2', said('再说一件事', 400), 700, { x: -4, y: 80 });
  assert.equal(w.tasks.at(-1)?.pointer, undefined);
  await w.voice.delegate('request_a', 'point_3', said('没有指着什么', 800), 1100);
  assert.equal(w.tasks.at(-1)?.pointer, undefined);
});

test('syllables become sentences, so a request reads as it was spoken', () => {
  const said = (role: 'user' | 'assistant', words: string[], from: number) =>
    words.map((text, index) => ({
      role,
      text,
      startMs: from + index * 200,
      endMs: from + index * 200 + 200,
    }));
  assert.equal(
    voiceContext(
      [
        ...said('user', ['把', '按钮', '改成', '橙色'], 0),
        ...said('assistant', ['好', '了', '。'], 2000),
        ...said('user', ['旁边', '那个', '输入框', '你看到了吗'], 5000),
      ],
      3000,
    ),
    '用户（之前，已处理）：把按钮改成橙色\n语音助手（之前，已处理）：好了。\n用户（本次新增）：旁边那个输入框你看到了吗',
  );
});

test('a first-run trial talks without a conversation and carries nothing out', async (t) => {
  const w = await world(t);
  await w.voice.configure(key);
  await w.voice.connect('request_t', '', offer, true);
  const body = JSON.parse(String(w.requests[0].init.body));
  assert.match(body.session.instructions, /首次引导/);
  // The same wire format as a real call; the host is what keeps a trial from doing anything.
  assert.deepEqual(body.session.delegation, { type: 'client' });
  assert.match(await w.voice.delegate('request_t', 'delegation_t', input, 300), /没有执行任何任务/);
  assert.equal(w.tasks.length, 0);
  await w.voice.disconnect('request_t');
  assert.equal(w.voice.config().active, false);
});
