import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserRuntime } from '../src/main/browser';
import { CdpConnection } from '../src/main/browser-cdp';
import { until } from './web-fixture';

const binary = process.env.ATHENA_TEST_CHROME;
const options = { skip: !binary || process.platform !== 'darwin', timeout: 40_000 };
const createRuntime = (storageDir: string) =>
  new BrowserRuntime({
    storageDir,
    binaryPath: binary,
    onState() {},
    onFrame() {},
    onStep() {},
    onSelected() {},
    onHumanTakeover() {},
  });

async function pages(endpoint: string): Promise<string[]> {
  const response = await fetch(`http://${new URL(endpoint).host}/json/list`);
  assert.equal(response.status, 200);
  const targets: Array<{ type: string; id: string }> = await response.json();
  return targets
    .filter((target) => target.type === 'page')
    .map((target) => target.id)
    .sort();
}

// A broken implementation can leave the fixture browser without a runtime to dispose it.
async function closeFixtureChrome(endpoint?: string) {
  if (!endpoint) return;
  const browser = await CdpConnection.connect(endpoint).catch(() => undefined);
  if (!browser) return;
  await browser.call('Browser.close').catch(() => {});
  browser.close();
  await until(
    () =>
      pages(endpoint).then(
        () => false,
        () => true,
      ),
    'fixture browser exit',
  );
}

function exited(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return true;
  }
}

for (const legacy of [false, true]) {
  test(
    `a ${legacy ? 'legacy' : 'current'} orphaned Chrome keeps both unsaved tabs on reconnect`,
    options,
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'athena-orphan-'));
      const lock = path.join(directory, 'agent-browser-profile/SingletonLock');
      const host = fork(
        new URL('./browser-start-recovery-host.ts', import.meta.url),
        [directory, legacy ? 'first' : 'last'],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        },
      );
      const runtime = createRuntime(directory);
      let endpoint: string | undefined;
      try {
        const [message] = await once(host, 'message', { signal: AbortSignal.timeout(15_000) });
        const original = message as {
          endpoint: string;
          activeTabId: string;
          drafts: Array<{ id: string; value: string }>;
        };
        endpoint = original.endpoint;
        const owner = await readlink(lock);
        const originalTabs = original.drafts.map((draft) => draft.id).sort();
        assert.deepEqual(await pages(endpoint), originalTabs);
        if (legacy) {
          // Simulate an older host with no Athena lease at its configured path.
          await rm(path.join(directory, 'browser-owner.lock'), { force: true });
          await assert.rejects(runtime.start(), /正在使用|占用/);
          assert.equal(runtime.getState().status, 'error');
          assert.deepEqual(
            await pages(endpoint),
            originalTabs,
            'starting must not deliver a new tab to the live owner',
          );
        }
        const hostExited = once(host, 'exit');
        host.kill('SIGKILL');
        await hostExited;
        if (legacy) {
          await rm(path.join(directory, 'browser-owner.lock'), { force: true });
          await rm(path.join(directory, 'agent-browser-profile/DevToolsActivePort'));
        }

        // Production supplies an initial page to start(). Recovering it must preserve the existing documents.
        await runtime.start('http://127.0.0.1:1/would-replace-the-draft');
        assert.equal(runtime.getState().status, 'ready');
        assert.equal(runtime.getNativeConnection().endpoint, endpoint);
        assert.equal(await readlink(lock), owner);
        await until(
          () => runtime.getState().tabs.length === originalTabs.length,
          'both restored tabs',
        );
        assert.deepEqual(
          runtime
            .getState()
            .tabs.map((t) => t.id)
            .sort(),
          originalTabs,
        );
        assert.equal(
          runtime.getState().activeTabId,
          original.activeTabId,
          'the previously active tab should remain in front',
        );
        assert.equal(runtime.getState().selectedElement, undefined);
        assert.equal(
          (
            await runtime.nativeEvaluate(
              original.activeTabId,
              'window.oldAthenaSelection.isConnected',
            )
          ).value,
          false,
          'the previous host’s selection should disappear with its inspector',
        );
        for (const { id, value } of original.drafts) {
          await runtime.switchTab(id);
          assert.deepEqual(
            await runtime.nativeEvaluate(id, "document.querySelector('input').value"),
            { value },
          );
        }
        assert.match((await runtime.screenshot()).image ?? '', /^iVBORw0KGgo/);

        runtime.startRecording();
        const bounds = (await runtime.queryElements({ selector: 'input' })).elements[0].bounds!;
        const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        await runtime.dispatchInput({ type: 'mouse', action: 'down', ...point });
        await runtime.dispatchInput({ type: 'mouse', action: 'up', ...point });
        const recording = await runtime.stopRecording();
        const clicks = recording.steps.filter((step) => step.kind === 'click');
        assert.equal(clicks.length, 1);
        assert.equal(clicks[0].source, 'human');
        assert.equal(clicks[0].target?.tag, 'input');

        const contender = createRuntime(directory);
        try {
          await assert.rejects(contender.start(), /正在使用|占用/);
          assert.equal(contender.getState().status, 'error');
          assert.deepEqual(await pages(endpoint), originalTabs);
          assert.equal(
            (
              await runtime.nativeEvaluate(
                original.drafts[1].id,
                "document.querySelector('input').value",
              )
            ).value,
            original.drafts[1].value,
          );
          await runtime.dispose();
          const chromePid = Number(/-(\d+)$/.exec(owner)![1]);
          await until(() => exited(chromePid), 'the adopted Chrome process to exit');
          await assert.rejects(pages(endpoint));
          assert.equal(runtime.getState().status, 'stopped');
          await contender.start();
          assert.equal(contender.getState().status, 'ready');
          assert.notEqual(contender.getNativeConnection().endpoint, endpoint);
        } finally {
          await contender.dispose();
        }
      } finally {
        if (host.exitCode === null && host.signalCode === null) {
          const exited = once(host, 'exit');
          host.kill('SIGKILL');
          await exited;
        }
        await runtime.dispose().catch(() => {});
        await closeFixtureChrome(endpoint);
        await rm(directory, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  );
}

test(
  'a running Athena can retry a failed handshake to the Chrome it launched',
  options,
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'athena-browser-retry-'));
    const runtime = createRuntime(directory);
    let endpoint: string | undefined;
    try {
      await runtime.start();
      endpoint = runtime.getNativeConnection().endpoint;
      const tab = runtime.getState().activeTabId!;
      assert.equal(
        (await runtime.nativeEvaluate(tab, "window.unsavedDraft = 'Before disconnect'")).value,
        'Before disconnect',
      );

      (runtime as unknown as { browser: CdpConnection }).browser.close();
      await until(
        () => runtime.getState().status === 'error',
        'the lost connection to reach the host',
      );
      const connect = CdpConnection.connect.bind(CdpConnection);
      const firstRetry = t.mock.method(CdpConnection, 'connect', async (url: string) => {
        if (url === endpoint) throw new Error('temporary handshake failure');
        return connect(url);
      });
      try {
        await assert.rejects(runtime.start(), /temporary handshake failure/);
      } finally {
        firstRetry.mock.restore();
      }
      assert.deepEqual(await pages(endpoint), [tab]);
      await runtime.start();
      assert.equal(runtime.getState().status, 'ready');
      assert.equal(runtime.getNativeConnection().endpoint, endpoint);
      assert.deepEqual(await runtime.nativeEvaluate(tab, 'window.unsavedDraft'), {
        value: 'Before disconnect',
      });
    } finally {
      await runtime.dispose().catch(() => {});
      await closeFixtureChrome(endpoint);
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);
