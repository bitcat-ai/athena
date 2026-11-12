import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { SharingRuntime } from '../src/main/sharing';
import type { BrowserFrame } from '../src/shared/types';

async function fixture(t: any) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'athena-share-test-'));
  const calls: any[] = [];
  let actor: any, recording: any;
  const browser: any = {
    epoch: 1,
    getState: () => ({
      status: 'ready',
      engine: 'agent-browser',
      activeTabId: 'shared',
      title: 'Shared',
      url: 'https://example.test/',
      tabs: [
        { id: 'shared', title: 'Shared', url: 'https://example.test/' },
        { id: 'private', title: 'Private', url: 'https://private.test/' },
      ],
      recording: !!recording,
      binaryPath: '/private/binary',
      loading: false,
      inspecting: false,
      canGoBack: false,
      canGoForward: false,
    }),
    async setSharedTab() {},
    getSurfaceEpoch: () => browser.epoch,
    getSurfaceViewport: () => ({ width: 800, height: 600, tabId: 'shared', loading: false }),
    withActor(a: any, guard: any, run: any) {
      actor = a;
      guard?.();
      return run();
    },
    startRecording() {
      recording = { id: 'record', title: 'Shared', startedAt: Date.now(), steps: [] };
    },
    getRecording: () => recording,
    stopRecording() {
      const r = { ...recording, endedAt: Date.now() };
      recording = undefined;
      return r;
    },
    resetHumanInput: async () => {},
    recordCollaboration() {},
    dispatchInput: async (input: any) => {
      calls.push({ actor: { ...actor }, input });
    },
  };
  const saved: any[] = [];
  const runtime = new SharingRuntime({
    browser,
    storageDir: directory,
    assetsDir: path.resolve('dist/renderer'),
    onState() {},
    saveRecording(r) {
      saved.push(r);
    },
  });
  const start = await runtime.start({ address: '127.0.0.1', name: 'Alice' });
  const origin = start.address!;
  const invite = new URLSearchParams(new URL(start.invite!.url).hash.slice(1)).get('invite');
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const s of sockets) s.terminate();
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const connect = async (payload: any = { name: 'Bob', invite }, requestedOrigin = origin) => {
    const ws = new WebSocket(origin.replace('https:', 'wss:') + '/connect', {
      rejectUnauthorized: false,
      origin: requestedOrigin,
    });
    sockets.push(ws);
    const messages: any[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    if (payload) ws.send(JSON.stringify({ type: 'join', ...payload }));
    const until = async (predicate: (m: any) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const m = messages.find(predicate);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('Expected sharing protocol message');
    };
    let id = 0;
    const command = async (action: string, body: any = {}, patch: any = {}) => {
      const n = ++id;
      ws.send(
        JSON.stringify({
          type: 'command',
          id: n,
          action,
          payload: body,
          generation: runtime.getState().generation,
          frame: { sequence: 1, epoch: 1 },
          ...patch,
        }),
      );
      return until((m) => m.type === 'result' && m.id === n);
    };
    return { ws, messages, until, command };
  };
  const frame = (sequence = 1, epoch = 1): BrowserFrame => ({
    tabId: 'shared',
    data: 'data:image/jpeg;base64,eA==',
    width: 800,
    height: 600,
    sequence,
    epoch,
    capturedAt: Date.now(),
  });
  return { runtime, browser, start, origin, invite, connect, calls, saved, frame };
}

test('an invitation creates a pending identity and exposes no page before host approval', async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  const welcome = await c.until((m) => m.type === 'welcome');
  f.runtime.onFrame(f.frame());
  await c.until((m) => m.type === 'state');
  assert(
    c.messages
      .filter((m) => m.type === 'state')
      .every((m) => !m.browser && !m.steps && !m.state.invite && !m.state.fingerprint),
  );
  assert(!c.messages.some((m) => m.type === 'frame'));
  assert.match(
    (await c.command('browser:input', { type: 'text', text: 'blocked' })).error,
    /等待主持人/,
  );
  await f.runtime.approve(welcome.participantId, 'viewer');
  const state = await c.until((m) => m.type === 'state' && m.browser);
  assert.deepEqual(
    state.browser.tabs.map((t: any) => t.id),
    ['shared'],
  );
  assert.equal(state.browser.binaryPath, undefined);
  const image = await c.until((m) => m.type === 'frame');
  c.ws.send(
    JSON.stringify({ type: 'ack', sequence: image.frame.sequence, epoch: image.frame.epoch }),
  );
  assert.match(
    (await c.command('browser:input', { type: 'text', text: 'blocked' })).error,
    /操作权限/,
  );
  assert.equal(f.calls.length, 0);
});

test('guest commands are page-scoped, lease-checked and attributed by server identity', async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  const welcome = await c.until((m) => m.type === 'welcome');
  await f.runtime.approve(welcome.participantId, 'editor');
  await f.runtime.changeControl(welcome.participantId);
  f.runtime.onFrame(f.frame());
  await c.until((m) => m.type === 'frame');
  c.ws.send(JSON.stringify({ type: 'ack', sequence: 1, epoch: 1 }));
  for (const action of [
    'app:snapshot',
    'conversation:send',
    'browser:tabs',
    'browser:snapshot',
    'browser:new-tab',
    'browser:diagnostics',
    'feishu:configure',
    'shell:openExternal',
  ])
    assert.match((await c.command(action)).error, /权限内/);
  assert.match(
    (await c.command('browser:input', { type: 'resize', width: 900, height: 600 })).error,
    /主持人/,
  );
  const result = await c.command('browser:input', {
    type: 'text',
    text: 'hello',
    actor: { id: 'host', name: 'Alice' },
  });
  assert.equal(result.error, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].actor.id, welcome.participantId);
  assert.equal(f.calls[0].actor.name, 'Bob');
  const old = f.runtime.getState().generation;
  await f.runtime.changeControl('host');
  await f.runtime.changeControl(welcome.participantId);
  assert.match(
    (await c.command('browser:input', { type: 'text', text: 'old' }, { generation: old })).error,
    /控制权/,
  );
  assert.equal(f.calls.length, 1);
});

test('each slow guest holds at most one frame in flight and only the newest pending frame', async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  const w = await c.until((m) => m.type === 'welcome');
  await f.runtime.approve(w.participantId, 'editor');
  await f.runtime.changeControl(w.participantId);
  for (let i = 1; i <= 100; i++) f.runtime.onFrame(f.frame(i));
  await c.until((m) => m.type === 'frame');
  assert.equal(c.messages.filter((m) => m.type === 'frame').length, 1);
  c.ws.send(JSON.stringify({ type: 'ack', sequence: 999, epoch: 1 }));
  assert.match((await c.command('browser:input', { type: 'text', text: 'no ack' })).error, /过期/);
  c.ws.send(JSON.stringify({ type: 'ack', sequence: 1, epoch: 1 }));
  const latest = await c.until((m) => m.type === 'frame' && m.frame.sequence === 100);
  assert.equal(latest.frame.sequence, 100);
  assert.equal(c.messages.filter((m) => m.type === 'frame').length, 2);
  c.ws.send(JSON.stringify({ type: 'ack', sequence: 100, epoch: 1 }));
  f.browser.epoch = 2;
  assert.match(
    (
      await c.command(
        'browser:input',
        { type: 'text', text: 'stale' },
        { frame: { sequence: 100, epoch: 1 } },
      )
    ).error,
    /过期/,
  );
  assert.equal(f.calls.length, 0);
});

test('expiry, revocation and removals invalidate their actual capabilities', async (t) => {
  const f = await fixture(t);
  (f.runtime as any).inviteExpires = Date.now() - 1;
  const expired = await f.connect();
  assert.match((await expired.until((m) => m.type === 'error')).error, /过期/);
  f.runtime.renewInvite();
  const old = await f.connect();
  assert.match((await old.until((m) => m.type === 'error')).error, /撤销/);
  const newInvite = new URLSearchParams(
    new URL(f.runtime.getState().invite!.url).hash.slice(1),
  ).get('invite');
  const c = await f.connect({ invite: newInvite, name: 'Bob' });
  const w = await c.until((m) => m.type === 'welcome');
  await f.runtime.approve(w.participantId, 'editor');
  await f.runtime.changeControl(w.participantId);
  f.runtime.remove(w.participantId);
  assert.equal(f.runtime.getState().controllerId, 'host');
  f.runtime.revokeInvite();
  const resume = await f.connect({ resume: w.resume, name: 'Bob', invite: newInvite });
  assert.match((await resume.until((m) => m.type === 'error')).error, /过期|撤销/);
});

test('reconnection restores identity without restoring control or replaying input', async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  const w = await c.until((m) => m.type === 'welcome');
  await f.runtime.approve(w.participantId, 'editor');
  await f.runtime.changeControl(w.participantId);
  c.ws.terminate();
  for (let i = 0; i < 100 && f.runtime.getState().controllerId !== 'host'; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.runtime.getState().controllerId, 'host');
  const resumed = await f.connect({ resume: w.resume, name: 'Impersonator' });
  const next = await resumed.until((m) => m.type === 'welcome');
  assert.equal(next.participantId, w.participantId);
  assert.equal(
    f.runtime.getState().participants.find((p) => p.id === w.participantId)?.name,
    'Bob',
  );
  assert.equal(f.runtime.getState().controllerId, 'host');
  assert.equal(f.calls.length, 0);
});

test('untrusted origins and host impersonation are rejected', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.connect(undefined, 'https://evil.example'));
  const c = await f.connect({ invite: f.invite, name: 'Alice' });
  assert.match((await c.until((m) => m.type === 'error')).error, /姓名/);
});

test('stopping a pending start leaves no listener or active share', async (t) => {
  const f = await fixture(t);
  await f.runtime.stop();
  const starting = f.runtime.start({ address: '127.0.0.1', name: 'Alice' });
  await assert.rejects(f.runtime.start({ address: '127.0.0.1', name: 'Second' }), /启动|结束/);
  const rejected = assert.rejects(starting, /取消/);
  await f.runtime.stop();
  await rejected;
  assert.equal(f.runtime.active, false);
  assert.equal((f.runtime as any).server, undefined);
});

test('write failures cannot keep a stopped share network listener alive', async (t) => {
  const f = await fixture(t);
  (f.runtime as any).options.saveRecording = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(f.runtime.stop(), /共享已停止/);
  assert.equal(f.runtime.active, false);
  assert.equal((f.runtime as any).server, undefined);
});

test('late command replies from a dead socket cannot resolve commands on its replacement', async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  const w = await c.until((m) => m.type === 'welcome');
  await f.runtime.approve(w.participantId, 'editor');
  await f.runtime.changeControl(w.participantId);
  f.runtime.onFrame(f.frame());
  await c.until((m) => m.type === 'frame');
  c.ws.send(JSON.stringify({ type: 'ack', sequence: 1, epoch: 1 }));
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  f.browser.dispatchInput = () =>
    new Promise<void>((r) => {
      release = r;
      entered();
    });
  c.ws.send(
    JSON.stringify({
      type: 'command',
      id: 1,
      action: 'browser:input',
      payload: { type: 'text', text: 'x' },
      generation: f.runtime.getState().generation,
      frame: { sequence: 1, epoch: 1 },
    }),
  );
  await started;
  c.ws.terminate();
  for (let i = 0; i < 100 && f.runtime.getState().controllerId !== 'host'; i++)
    await new Promise((r) => setTimeout(r, 5));
  const resumed = await f.connect({ resume: w.resume, name: 'Bob' });
  await resumed.until((m) => m.type === 'welcome');
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert(!resumed.messages.some((m) => m.type === 'result'));
});

test('long sessions rotate recordings before the browser step cap', async (t) => {
  const f = await fixture(t);
  const step = {
    id: 'last',
    kind: 'click' as const,
    description: 'Click',
    timestamp: Date.now(),
    url: 'https://example.test/',
    tabId: 'shared',
    source: 'human' as const,
    actor: { id: 'host', name: 'Alice' },
  };
  const current = f.browser.getRecording();
  current.steps = Array.from({ length: 1800 }, (_, i) => ({ ...step, id: String(i) }));
  f.runtime.onStep(step);
  const deadline = Date.now() + 2000;
  while ((f.runtime as any).rotating) {
    assert(Date.now() < deadline);
    await new Promise((r) => setTimeout(r, 5));
  }
  assert(f.saved.some((r) => r.endedAt && r.steps.length === 1800));
  assert.equal(f.browser.getRecording().steps.length, 0);
  assert.equal((f.runtime as any).part, 2);
});

test('a pending participant never receives saved page content when sharing stops', async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  await c.until((m) => m.type === 'welcome');
  const pending = c.messages.find((m) => m.type === 'state');
  assert.equal(pending.state.title, undefined);
  assert.equal(pending.state.tabId, undefined);
  await f.runtime.stop();
  const ended = await c.until((m) => m.type === 'ended');
  assert.equal(ended.recording, undefined);
});

test('stopping during asynchronous recording rotation never starts a new segment', async (t) => {
  const f = await fixture(t);
  const step = {
    id: 'last',
    kind: 'click' as const,
    description: 'Click',
    timestamp: Date.now(),
    url: 'https://example.test/',
    tabId: 'shared',
    source: 'human' as const,
    actor: { id: 'host', name: 'Alice' },
  };
  f.browser.getRecording().steps = Array.from({ length: 1800 }, (_, i) => ({
    ...step,
    id: String(i),
  }));
  const original = f.browser.stopRecording.bind(f.browser);
  let release!: () => void;
  const pending = new Promise((resolve) => (release = () => resolve(original())));
  f.browser.stopRecording = () => pending;
  f.runtime.onStep(step);
  await new Promise<void>((r) => queueMicrotask(r));
  assert((f.runtime as any).rotating);
  const stopping = f.runtime.stop();
  release();
  const stoppedRecording = await stopping;
  assert(stoppedRecording?.endedAt);
  const deadline = Date.now() + 2000;
  while ((f.runtime as any).rotating) {
    assert(Date.now() < deadline);
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(f.browser.getRecording(), undefined);
  assert.equal((f.runtime as any).part, 1);
  assert.equal(f.runtime.getState().active, false);
});

test('a recorder flush failure still closes sharing and preserves the partial recording', async (t) => {
  const f = await fixture(t),
    c = await f.connect();
  await c.until((m) => m.type === 'welcome');
  f.browser.stopRecording = async () => {
    throw new Error('frame unavailable');
  };
  await assert.rejects(f.runtime.stop(), /共享已停止/);
  assert.equal(f.runtime.getState().active, false);
  assert(f.saved.some((record) => record.id === 'record'));
  await c.until((m) => m.type === 'ended');
});

test('failed native handoff closes sharing instead of leaving an unusable control lease', async (t) => {
  const f = await fixture(t),
    c = await f.connect(),
    w = await c.until((m) => m.type === 'welcome');
  await f.runtime.approve(w.participantId, 'editor');
  f.browser.resetHumanInput = async () => {
    throw new Error('page lost');
  };
  await assert.rejects(f.runtime.changeControl(w.participantId), /交接失败.*共享已停止/);
  assert.equal(f.runtime.active, false);
  assert.equal((f.runtime as any).server, undefined);
});

test('input permission checks do not clone the full preview history on every wheel packet', async (t) => {
  const f = await fixture(t),
    c = await f.connect(),
    w = await c.until((m) => m.type === 'welcome');
  await f.runtime.approve(w.participantId, 'editor');
  await f.runtime.changeControl(w.participantId);
  f.runtime.onFrame(f.frame());
  await c.until((m) => m.type === 'frame');
  c.ws.send(JSON.stringify({ type: 'ack', sequence: 1, epoch: 1 }));
  const fullState = f.browser.getState;
  f.browser.getState = () => {
    throw new Error('full state read on the input path');
  };
  try {
    const result = await c.command('browser:input', {
      type: 'wheel',
      x: 50,
      y: 60,
      deltaX: 0,
      deltaY: 10,
    });
    assert.equal(result.error, undefined);
    assert.equal(f.calls.length, 1);
  } finally {
    f.browser.getState = fullState;
  }
});

test('resuming during the old socket close handshake still revokes control and queued input', async (t) => {
  const f = await fixture(t),
    c = await f.connect(),
    w = await c.until((m) => m.type === 'welcome');
  await f.runtime.approve(w.participantId, 'editor');
  await f.runtime.changeControl(w.participantId);
  const oldGeneration = f.runtime.getState().generation;
  const oldServerSocket = (f.runtime as any).peers.get(w.participantId).socket;
  oldServerSocket._readyState = WebSocket.CLOSING;
  const resumed = await f.connect({ resume: w.resume, name: 'Bob' });
  await resumed.until((m) => m.type === 'welcome');
  assert.equal(f.runtime.getState().controllerId, 'host');
  assert(f.runtime.getState().generation > oldGeneration);
  assert.match(
    (await resumed.command('browser:input', { type: 'text', text: 'stale' })).error,
    /权限|控制权/,
  );
  oldServerSocket.terminate();
});
