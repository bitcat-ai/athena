import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { LocalSandboxUpdate } from '../src/main/local-sandbox';
import { SandboxPool, type SandboxBackend, type SandboxPoolCoder } from '../src/main/sandbox-pool';
import type { SandboxInstanceView, SandboxTarget } from '../src/shared/sandbox';

const MINUTE = 60_000,
  DAY = 24 * 60 * MINUTE;
const signal = new AbortController().signal;
const context = (conversationId: string) => ({ conversationId, turnId: 'turn', signal });

/** Docker and the disk, reduced to what the pool asks of them. */
async function world(conversations: string[] = []) {
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-pool-'));
  const containers = new Map<string, string>();
  const directories = new Set<string>();
  const released: string[] = [];
  const removed: string[] = [];
  const state = {
    now: 1000 * DAY,
    down: false,
    held: new Set<string>(),
    /** Runs while Docker is busy stopping or removing a container. */
    releasing: undefined as ((container: string) => void | Promise<void>) | undefined,
  };
  const name = (target: SandboxTarget, id: string) =>
    `athena-${target}-${createHash('sha256').update(id).digest('hex').slice(0, 10)}`;
  const backend = (
    target: SandboxTarget,
    onUpdate: (update: LocalSandboxUpdate) => void,
  ): SandboxBackend => {
    const open = async ({ conversationId }: { conversationId: string }) => {
      if (state.down) throw new Error('Cannot connect to the Docker daemon');
      const container = name(target, conversationId);
      containers.set(container, 'running');
      directories.add(container);
      onUpdate({ conversationId, type: 'connection', status: 'ready', name: container });
      return container;
    };
    return {
      prefix: `athena-${target}-`,
      containerName: (id) => name(target, id),
      open,
      async containers() {
        if (state.down) throw new Error('Cannot connect to the Docker daemon');
        return new Map(containers);
      },
      workspaces: async () =>
        [...directories].filter((item) => item.startsWith(`athena-${target}-`)),
      async release(container, remove) {
        if (state.down) throw new Error('Cannot connect to the Docker daemon');
        released.push(`${remove ? 'remove' : 'stop'} ${container}`);
        await state.releasing?.(container);
        if (remove) {
          containers.delete(container);
          directories.delete(container);
        } else if (containers.has(container)) containers.set(container, 'exited');
      },
      async call(tool, _args, context) {
        if (tool !== 'athena_sandbox_status') await open(context);
        return { text: JSON.stringify({ tool, container: name(target, context.conversationId) }) };
      },
      cancelTurn: async () => {},
      dispose: async () => {},
    };
  };
  /** A Coder deployment: its workspaces, and whether it is connected and answers. */
  const coder = {
    connected: true,
    down: false,
    workspaces: new Map<string, string>(),
    templates: [{ id: 'tpl-node', name: 'Node 工作区' }],
    forgotten: 0,
    name: (id: string) =>
      `athena-coder-${createHash('sha256').update(id).digest('hex').slice(0, 10)}`,
  };
  const reach = () => {
    if (coder.down) throw new Error('无法连接 Coder（https://coder.example）：fetch failed');
  };
  const coderBackend: SandboxPoolCoder['backend'] = (onUpdate, template) => {
    const open = async ({ conversationId }: { conversationId: string }) => {
      reach();
      if (!template(conversationId)) throw new Error('这个沙箱没有记录 Coder 模板');
      coder.workspaces.set(coder.name(conversationId), 'running');
      onUpdate({
        conversationId,
        type: 'connection',
        status: 'ready',
        name: coder.name(conversationId),
      });
      return coder.name(conversationId);
    };
    return {
      prefix: 'athena-coder-',
      containerName: coder.name,
      open,
      async containers() {
        reach();
        return new Map(coder.workspaces);
      },
      workspaces: async () => [],
      async release(workspace, remove) {
        reach();
        released.push(`${remove ? 'remove' : 'stop'} ${workspace}`);
        await state.releasing?.(workspace);
        if (remove) coder.workspaces.delete(workspace);
        else if (coder.workspaces.has(workspace)) coder.workspaces.set(workspace, 'stopped');
      },
      async call(tool, _args, context) {
        if (tool !== 'athena_sandbox_status') await open(context);
        return { text: JSON.stringify({ tool, container: coder.name(context.conversationId) }) };
      },
      cancelTurn: async () => {},
      dispose: async () => {},
      async forget() {
        coder.forgotten++;
        for (const [workspace, status] of coder.workspaces)
          if (status === 'running') coder.workspaces.set(workspace, 'stopped');
      },
    };
  };
  const pool = () =>
    new SandboxPool(directory, '/nowhere/athena-sandbox.mjs', () => {}, undefined, {
      backend,
      coder: {
        backend: coderBackend,
        connection: () =>
          coder.connected
            ? {
                connected: true,
                origin: 'https://coder.example',
                username: 'tester',
                insecure: false,
              }
            : { connected: false },
        async templates() {
          reach();
          return coder.templates;
        },
      },
      now: () => state.now,
      conversations: () => conversations,
      held: (instance) => state.held.has(instance.id),
      onRemoved: (_conversation, key) => removed.push(key),
    });
  return { directory, containers, directories, released, removed, state, name, coder, pool };
}
const byName = (instances: SandboxInstanceView[], name: string) =>
  instances.find((instance) => instance.name === name)!;
/** Creating returns at once; the start it kicks off finishes a few ticks later. */
async function create(
  pool: SandboxPool,
  name: string,
  runtime: SandboxTarget = 'frontend',
  template?: string,
) {
  await pool.create(name, runtime, template);
  await wait(5);
  return byName((await pool.instances()).instances, name);
}

test('a user creates several named sandboxes and they survive a restart', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    const web = await create(pool, '支付页重构');
    const api = await create(pool, 'order-api', 'backend');
    assert.equal(web.status, 'running');
    assert.equal(web.origin, 'user');
    assert.equal(api.runtime, 'backend');
    assert.equal(w.containers.size, 2);
    await assert.rejects(pool.create('支付页重构', 'frontend'), /已有名为/);
    await assert.rejects(pool.create('ORDER-API', 'frontend'), /已有名为/);
    await assert.rejects(pool.create('  ', 'frontend'), /名称/);
    await assert.rejects(pool.create('../x', 'frontend'), /名称/);
    await assert.rejects(pool.create('ok', 'gpu'), /环境/);
    await pool.keep(api.id, true);
    await pool.setPolicy({ retainDays: 14 });
    await pool.dispose();

    const saved = JSON.parse(await readFile(path.join(w.directory, 'instances.json'), 'utf8'));
    assert.equal(saved.version, 1);
    const reopened = w.pool();
    await reopened.load();
    await reopened.reconcile();
    const state = await reopened.instances();
    assert.deepEqual(state.instances.map((instance) => instance.name).sort(), [
      'order-api',
      '支付页重构',
    ]);
    assert.equal(byName(state.instances, 'order-api').keep, true);
    assert.equal(state.policy.retainDays, 14);
    await reopened.dispose();
  } finally {
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('an agent reaches a user sandbox by name and its own by target', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    const web = await create(pool, 'Checkout');
    const named = await pool.call(
      'athena_sandbox_exec',
      { sandbox: 'checkout', command: 'pwd' },
      context('conversation-1'),
    );
    assert.equal(JSON.parse(named.text).container, w.name('frontend', web.id));
    assert.deepEqual(
      pool.state('conversation-1').map((view) => view.instance),
      [web.id],
    );
    // Another conversation takes the same instance over; no second container appears.
    await pool.call(
      'athena_sandbox_exec',
      { sandbox: web.id, command: 'pwd' },
      context('conversation-2'),
    );
    assert.equal(pool.state('conversation-1').length, 0);
    assert.equal(pool.state('conversation-2').length, 1);
    assert.equal(w.containers.size, 1);

    const own = await pool.call(
      'athena_sandbox_exec',
      { target: 'backend', command: 'pwd' },
      context('conversation-1'),
    );
    assert.equal(JSON.parse(own.text).container, w.name('backend', 'conversation-1'));
    const { instances } = await pool.instances();
    assert.deepEqual(instances.map((instance) => [instance.origin, instance.id]).sort(), [
      ['agent', 'conversation-1:backend'],
      ['user', web.id],
    ]);
    await assert.rejects(
      pool.call('athena_sandbox_exec', { sandbox: 'nope', command: 'pwd' }, context('c')),
      /可用实例：Checkout/,
    );
    await assert.rejects(
      pool.call('athena_sandbox_exec', { target: 'gpu', command: 'pwd' }, context('c')),
      /未知的沙箱目标/,
    );
    // Asking for the status neither starts nor registers anything, and lists what the user made.
    const status = JSON.parse(
      (await pool.call('athena_sandbox_status', { target: 'default' }, context('c'))).text,
    );
    assert.deepEqual(status.instances, [
      { name: 'Checkout', provider: 'docker', runtime: 'frontend', status: 'running' },
    ]);
    assert.equal((await pool.instances()).instances.length, 2);
    assert.match(pool.prompt(), /「Checkout」（Node 前端，运行中）/);
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('idle sandboxes stop with their files kept, unused ones are removed with them', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    const web = await create(pool, 'web');
    const keep = await create(pool, 'keep');
    await pool.keep(keep.id, true);
    await pool.call('athena_sandbox_exec', { command: 'pwd' }, context('conversation-1'));

    w.state.now += 29 * MINUTE;
    await pool.sweep();
    assert.equal(w.released.length, 0);

    w.state.now += 2 * MINUTE;
    await pool.sweep();
    assert.equal(w.released.filter((entry) => entry.startsWith('stop ')).length, 3);
    assert.equal(w.directories.size, 3);
    assert.ok(
      (await pool.instances()).instances.every((instance) => instance.status === 'stopped'),
    );

    // Using a stopped sandbox starts it again and restarts its clock.
    await pool.call(
      'athena_sandbox_exec',
      { sandbox: 'web', command: 'pwd' },
      context('conversation-1'),
    );
    assert.equal(byName((await pool.instances()).instances, 'web').status, 'running');

    w.state.now += 7 * DAY - MINUTE;
    await pool.sweep();
    assert.deepEqual((await pool.instances()).instances.map((instance) => instance.name).sort(), [
      'keep',
      'web',
    ]);
    assert.deepEqual(w.removed, ['default']);

    w.state.now += 2 * MINUTE;
    await pool.sweep();
    assert.deepEqual(
      (await pool.instances()).instances.map((instance) => instance.name),
      ['keep'],
    );
    assert.deepEqual(w.removed, ['default', web.id]);
    assert.deepEqual([...w.directories], [w.name('frontend', keep.id)]);
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('the running limit stops the least recently used sandbox, never one in use', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    await pool.setPolicy({ maxRunning: 2 });
    const a = await create(pool, 'a');
    w.state.now += 2 * MINUTE;
    const b = await create(pool, 'b');
    w.state.now += 2 * MINUTE;
    const c = await create(pool, 'c');
    const status = async () =>
      Object.fromEntries(
        (await pool.instances()).instances.map((instance) => [instance.name, instance.status]),
      );
    assert.deepEqual(await status(), { a: 'stopped', b: 'running', c: 'running' });
    assert.deepEqual(w.released, [`stop ${w.name('frontend', a.id)}`]);

    w.state.now += 2 * MINUTE;
    w.state.held.add(b.id).add(c.id);
    await assert.rejects(pool.start(a.id), /已达上限（2 个）/);
    await assert.rejects(
      pool.call('athena_sandbox_exec', { command: 'pwd' }, context('conversation-1')),
      /已达上限/,
    );
    assert.equal(byName((await pool.instances()).instances, 'a').status, 'failed');

    // A sandbox stopped outside Athena frees its place as soon as Docker is asked.
    w.containers.set(w.name('frontend', b.id), 'exited');
    await pool.start(a.id);
    assert.deepEqual(await status(), { a: 'running', b: 'stopped', c: 'running' });
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('two sandboxes starting at the same moment do not share the last free place', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    await pool.setPolicy({ maxRunning: 2 });
    const a = await create(pool, 'a');
    w.state.held.add(a.id);
    const results = await Promise.allSettled(
      ['conversation-1', 'conversation-2'].map((id) =>
        pool.call('athena_sandbox_exec', { command: 'pwd' }, context(id)),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.status),
      ['fulfilled', 'rejected'],
    );
    assert.match(String((results[1] as PromiseRejectedResult).reason), /已达上限/);
    assert.equal([...w.containers.values()].filter((status) => status === 'running').length, 2);
    assert.deepEqual((await pool.instances()).instances.map((instance) => instance.id).sort(), [
      'conversation-1:default',
      a.id,
    ]);

    // With an idle one to stop, both start and only that one gives way.
    w.state.held.clear();
    w.state.now += 2 * MINUTE;
    await pool.setPolicy({ maxRunning: 4 });
    await create(pool, 'b');
    await create(pool, 'c');
    w.state.now += 2 * MINUTE;
    w.released.length = 0;
    await Promise.all(
      ['conversation-3', 'conversation-4'].map((id) =>
        pool.call('athena_sandbox_exec', { command: 'pwd' }, context(id)),
      ),
    );
    assert.equal([...w.containers.values()].filter((status) => status === 'running').length, 4);
    assert.equal(w.released.length, 2);
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('a sandbox that comes into use during a recycling pass is left alone', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    const a = await create(pool, 'a');
    const b = await create(pool, 'b');
    w.state.now += 8 * DAY;
    // While Docker removes the first, the preview of the second is opened in a tab.
    w.state.releasing = () => void w.state.held.add(b.id);
    await pool.sweep();
    assert.deepEqual(w.released, [`remove ${w.name('frontend', a.id)}`]);
    assert.deepEqual(
      (await pool.instances()).instances.map((instance) => [instance.name, instance.status]),
      [['b', 'running']],
    );
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('a call that arrives while its sandbox is being removed waits for the removal', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    const web = await create(pool, 'web');
    await pool.call('athena_sandbox_exec', { command: 'pwd' }, context('conversation-1'));
    w.state.releasing = () => wait(20);
    const exec = (args: Record<string, unknown>) =>
      pool.call('athena_sandbox_exec', { ...args, command: 'pwd' }, context('conversation-1'));

    // The user's instance is gone afterwards, so the call says so instead of reviving it.
    const removed = pool.remove(web.id);
    await assert.rejects(exec({ sandbox: 'web' }), /用户还没有创建沙箱实例/);
    await removed;
    assert.equal(w.containers.has(w.name('frontend', web.id)), false);
    assert.equal(w.directories.has(w.name('frontend', web.id)), false);

    // The conversation's own sandbox is made again, complete, after the old one is gone.
    const own = w.name('default', 'conversation-1');
    const recycled = pool.remove('conversation-1:default');
    await exec({});
    await recycled;
    assert.equal(w.containers.get(own), 'running');
    assert.deepEqual(
      (await pool.instances()).instances.map((instance) => [instance.id, instance.status]),
      [['conversation-1:default', 'running']],
    );
    // A stop in progress is waited for as well; the next call starts the sandbox again.
    const stopped = pool.stop('conversation-1:default');
    await exec({});
    await stopped;
    assert.equal(w.containers.get(own), 'running');
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('sandboxes left by earlier versions are listed, then expire like any other', async () => {
  const w = await world(['conversation-1']);
  const known = w.name('frontend', 'conversation-1');
  const orphan = w.name('default', 'deleted-conversation');
  const foreign = 'athena-0123456789abcdef-0123456789';
  w.containers.set(known, 'exited').set(orphan, 'running').set(foreign, 'exited');
  w.directories.add(known).add(orphan).add(w.name('backend', 'only-files'));
  const pool = w.pool();
  try {
    await pool.load();
    await pool.reconcile();
    const { instances } = await pool.instances();
    assert.deepEqual(
      instances.map((instance) => [instance.id, instance.origin, instance.status]).sort(),
      [
        ['conversation-1:frontend', 'agent', 'stopped'],
        [`legacy:${w.name('backend', 'only-files')}`, 'legacy', 'stopped'],
        [`legacy:${orphan}`, 'legacy', 'running'],
      ].sort(),
    );
    assert.deepEqual(w.released, []);
    await assert.rejects(pool.start(`legacy:${orphan}`), /只能删除/);

    w.state.now += 8 * DAY;
    await pool.sweep();
    assert.equal((await pool.instances()).instances.length, 0);
    // Another profile's sandbox is not this pool's to touch.
    assert.deepEqual([...w.containers.keys()], [foreign]);
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('deleting a conversation removes the sandboxes its agent opened, not the user’s', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    await create(pool, 'mine');
    await pool.call(
      'athena_sandbox_exec',
      { sandbox: 'mine', command: 'pwd' },
      context('conversation-1'),
    );
    await pool.call('athena_sandbox_exec', { command: 'pwd' }, context('conversation-1'));
    await pool.call(
      'athena_sandbox_exec',
      { target: 'frontend', command: 'pwd' },
      context('conversation-1'),
    );
    await pool.call('athena_sandbox_exec', { command: 'pwd' }, context('conversation-2'));
    await pool.forgetConversation('conversation-1');
    assert.deepEqual(
      (await pool.instances()).instances.map((instance) => instance.id).sort(),
      ['conversation-2:default', byName((await pool.instances()).instances, 'mine').id].sort(),
    );
    assert.equal(w.containers.size, 2);
    assert.equal(pool.state('conversation-1').length, 0);
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('nothing is recycled or forgotten while Docker does not answer', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    const web = await create(pool, 'web');
    await pool.call('athena_sandbox_exec', { command: 'pwd' }, context('conversation-1'));
    w.state.down = true;
    w.state.now += 30 * DAY;
    await pool.sweep();
    const state = await pool.instances(true);
    assert.equal(state.docker.available, false);
    assert.match(state.docker.message ?? '', /Docker 没有运行/);
    assert.equal(state.instances.length, 2);
    await assert.rejects(pool.remove(web.id), /Docker/);
    await pool.forgetConversation('conversation-1');
    // Still listed, as a sandbox without a conversation, so that it is removed once Docker is back.
    assert.deepEqual((await pool.instances()).instances.map((instance) => instance.origin).sort(), [
      'legacy',
      'user',
    ]);
    w.state.down = false;
    await pool.sweep();
    assert.equal((await pool.instances()).instances.length, 0);
    assert.equal(w.containers.size, 0);
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('a user creates sandboxes on Coder beside local ones, and they share the running limit', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    await pool.load();
    await pool.reconcile();
    const state = await pool.instances();
    assert.deepEqual(state.coder, {
      available: true,
      templates: w.coder.templates,
      connected: true,
      origin: 'https://coder.example',
      username: 'tester',
      insecure: false,
    });

    const remote = await create(pool, '远程联调', 'default', 'tpl-node');
    assert.deepEqual(
      [remote.provider, remote.template, remote.status, remote.origin],
      ['coder', 'Node 工作区', 'running', 'user'],
    );
    assert.deepEqual([...w.coder.workspaces], [[w.coder.name(remote.id), 'running']]);
    assert.equal(w.containers.size, 0);
    await assert.rejects(pool.create('other', 'default', 'tpl-gone'), /找不到这个 Coder 模板/);
    await assert.rejects(pool.create('远程联调', 'frontend'), /已有名为/);

    // The agent reaches it by name like any other instance, and is told what kind it is.
    const named = await pool.call(
      'athena_sandbox_exec',
      { sandbox: '远程联调', command: 'pwd' },
      context('conversation-1'),
    );
    assert.equal(JSON.parse(named.text).container, w.coder.name(remote.id));
    const status = JSON.parse(
      (await pool.call('athena_sandbox_status', {}, context('conversation-1'))).text,
    );
    assert.deepEqual(status.instances, [
      { name: '远程联调', provider: 'coder', runtime: 'Node 工作区', status: 'running' },
    ]);
    assert.match(pool.prompt(), /「远程联调」（Coder · Node 工作区，运行中）/);
    assert.match(pool.prompt(), /没有 \/workspace/);
    // An agent's own sandbox, opened without a name, stays a local container.
    await pool.call('athena_sandbox_exec', { command: 'pwd' }, context('conversation-1'));
    assert.deepEqual([...w.containers.keys()], [w.name('default', 'conversation-1')]);

    // One limit for both kinds: the least recently used gives way, wherever it runs.
    await pool.setPolicy({ maxRunning: 2 });
    w.state.now += 2 * MINUTE;
    await pool.call('athena_sandbox_exec', { command: 'pwd' }, context('conversation-1'));
    w.state.now += 2 * MINUTE;
    const local = await create(pool, 'local');
    assert.equal(local.status, 'running');
    assert.deepEqual(w.released, [`stop ${w.coder.name(remote.id)}`]);
    assert.equal(byName((await pool.instances()).instances, '远程联调').status, 'stopped');
    await pool.dispose();

    const reopened = w.pool();
    await reopened.load();
    await reopened.reconcile();
    const again = byName((await reopened.instances()).instances, '远程联调');
    assert.deepEqual(
      [again.provider, again.template, again.id],
      ['coder', 'Node 工作区', remote.id],
    );
    // Started again from its record: the template it was made from is still known.
    await reopened.setPolicy({ maxRunning: 4 });
    await reopened.start(remote.id);
    assert.equal(w.coder.workspaces.get(w.coder.name(remote.id)), 'running');
    await reopened.dispose();
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('Coder sandboxes are recycled like local ones, but never while Coder does not answer', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    const remote = await create(pool, 'remote', 'default', 'tpl-node');
    const kept = await create(pool, 'kept', 'default', 'tpl-node');
    await pool.keep(kept.id, true);
    await create(pool, 'web');

    w.state.now += 31 * MINUTE;
    await pool.sweep();
    assert.deepEqual(
      w.released.sort(),
      [
        `stop ${w.coder.name(kept.id)}`,
        `stop ${w.coder.name(remote.id)}`,
        `stop ${w.name('frontend', byName((await pool.instances()).instances, 'web').id)}`,
      ].sort(),
    );
    assert.deepEqual([...w.coder.workspaces.values()], ['stopped', 'stopped']);

    // Coder is away for a month: the local sandbox goes, the Coder ones wait untouched.
    w.released.length = 0;
    w.coder.down = true;
    w.state.now += 30 * DAY;
    await pool.sweep();
    let state = await pool.instances(true);
    assert.equal(state.coder.available, false);
    assert.match(state.coder.message ?? '', /无法连接 Coder/);
    assert.deepEqual(state.coder.templates, w.coder.templates);
    assert.deepEqual(state.instances.map((instance) => instance.name).sort(), ['kept', 'remote']);
    assert.equal(w.released.filter((entry) => entry.includes('athena-coder-')).length, 0);
    await assert.rejects(pool.remove(remote.id), /无法连接 Coder/);
    await assert.rejects(pool.create('new', 'default', 'tpl-node'), /无法连接 Coder/);

    w.coder.down = false;
    await pool.sweep();
    state = await pool.instances();
    assert.deepEqual(
      state.instances.map((instance) => instance.name),
      ['kept'],
    );
    assert.deepEqual([...w.coder.workspaces.keys()], [w.coder.name(kept.id)]);
    assert.ok(w.removed.includes(remote.id));
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('recycling that fails is tried again later, not every minute', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    const remote = await create(pool, 'remote', 'default', 'tpl-node');
    w.state.releasing = () => {
      throw new Error('Coder 工作区停止失败（failed），请在 Coder 中查看构建日志');
    };
    w.state.now += 31 * MINUTE;
    await pool.sweep();
    w.state.now += MINUTE;
    await pool.sweep();
    w.state.now += MINUTE;
    await pool.sweep();
    assert.equal(w.released.length, 1);
    // The user can still stop it by hand, and sees why it fails.
    await assert.rejects(pool.stop(remote.id), /请在 Coder 中查看构建日志/);
    assert.equal(w.released.length, 2);

    w.state.releasing = undefined;
    w.state.now += 10 * MINUTE;
    await pool.sweep();
    assert.equal(w.released.length, 3);
    assert.equal(byName((await pool.instances()).instances, 'remote').status, 'stopped');
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test('disconnecting Coder takes its sandboxes off the list and leaves the workspaces there', async () => {
  const w = await world();
  const pool = w.pool();
  try {
    const remote = await create(pool, 'remote', 'default', 'tpl-node');
    const local = await create(pool, 'local');
    await pool.forgetCoder();
    w.coder.connected = false;
    const state = await pool.instances(true);
    assert.deepEqual(
      state.instances.map((instance) => instance.name),
      ['local'],
    );
    assert.deepEqual(state.coder, { available: false, templates: [], connected: false });
    // Still on Coder, asked to stop; deleting it is up to the user there.
    assert.equal(w.coder.forgotten, 1);
    assert.deepEqual([...w.coder.workspaces], [[w.coder.name(remote.id), 'stopped']]);
    assert.deepEqual(w.released, []);
    assert.deepEqual(w.removed, [remote.id]);
    assert.equal(w.containers.get(w.name('frontend', local.id)), 'running');
    await assert.rejects(pool.create('again', 'default', 'tpl-node'), /尚未连接 Coder/);
    const saved = JSON.parse(await readFile(path.join(w.directory, 'instances.json'), 'utf8'));
    assert.deepEqual(
      saved.instances.map((record: { name: string }) => record.name),
      ['local'],
    );

    // Connected again, the workspace this profile left behind shows up, to be deleted or to expire.
    w.coder.connected = true;
    await pool.reconcile();
    const found = (await pool.instances()).instances.find((item) => item.provider === 'coder')!;
    assert.deepEqual(
      [found.id, found.origin, found.name, found.status],
      [`legacy:${w.coder.name(remote.id)}`, 'legacy', '未登记的 Coder 沙箱', 'stopped'],
    );
    await assert.rejects(pool.start(found.id), /只能删除/);
    w.state.now += 8 * DAY;
    await pool.sweep();
    assert.equal(w.coder.workspaces.size, 0);
  } finally {
    await pool.dispose();
    await rm(w.directory, { recursive: true, force: true });
  }
});

test(
  'real Docker keeps two user sandboxes apart, stops the idle one and removes the unused one',
  { skip: process.env.ATHENA_TEST_DOCKER !== '1', timeout: 180_000 },
  async () => {
    const docker = promisify(execFile);
    const directory = await mkdtemp(path.join(tmpdir(), 'athena-pool-docker-'));
    let now = Date.now();
    const pool = new SandboxPool(
      directory,
      path.resolve('packages/athena-sandbox/athena-sandbox.mjs'),
      () => {},
      undefined,
      { now: () => now },
    );
    const inspect = async (container: string) =>
      (
        await docker('docker', ['inspect', '--format', '{{.State.Status}}', container]).catch(
          () => ({ stdout: 'missing' }),
        )
      ).stdout.trim();
    const run = async (sandbox: string, command: string) =>
      JSON.parse(
        (await pool.call('athena_sandbox_exec', { sandbox, command }, context('conversation-1')))
          .text,
      );
    let names: string[] = [];
    try {
      await pool.load();
      await pool.create('one', 'default');
      await pool.create('two', 'default');
      await pool.call(
        'athena_sandbox_write',
        { sandbox: 'one', files: [{ path: 'note.txt', content: 'ONLY_IN_ONE' }] },
        context('conversation-1'),
      );
      assert.match((await run('one', 'cat note.txt')).output, /ONLY_IN_ONE/);
      assert.notEqual((await run('two', 'cat note.txt')).command.exitCode, 0);
      const { instances } = await pool.instances(true);
      assert.deepEqual(
        instances.map((instance) => instance.status),
        ['running', 'running'],
      );
      names = (await readdir(directory)).filter((entry) => entry.startsWith('athena-'));
      assert.equal(names.length, 2);
      const one = byName(instances, 'one'),
        two = byName(instances, 'two');
      await pool.keep(one.id, true);

      // Idle: both stop, and the files of the first are still there when it is used again.
      now += 31 * MINUTE;
      await pool.sweep();
      for (const name of names) assert.equal(await inspect(name), 'exited');
      assert.match((await run('one', 'cat note.txt')).output, /ONLY_IN_ONE/);
      assert.equal(byName((await pool.instances(true)).instances, 'one').status, 'running');

      // Unused past the retention period: the one not kept goes, container and files.
      now += 8 * DAY;
      await pool.sweep();
      const left = (await pool.instances(true)).instances;
      assert.deepEqual(
        left.map((instance) => [instance.name, instance.status]),
        [['one', 'stopped']],
      );
      assert.deepEqual(
        (await readdir(directory)).filter((entry) => entry.startsWith('athena-')).length,
        1,
      );
      assert.equal((await Promise.all(names.map(inspect))).sort().join(), 'exited,missing');
      assert.equal(left[0].id, one.id);
      assert.notEqual(two.id, one.id);

      await pool.remove(one.id);
      assert.equal((await Promise.all(names.map(inspect))).join(), 'missing,missing');
    } finally {
      await pool.dispose();
      for (const name of names) await docker('docker', ['rm', '--force', name]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);
