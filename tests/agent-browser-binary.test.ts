import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AGENT_BROWSER_VERSION,
  ensureAgentBrowserBinary,
  type AgentBrowserDownload,
} from '../src/main/agent-browser-server';

const name = `agent-browser-darwin-${process.arch}`;
const local = path.resolve('.runtime/agent-browser', AGENT_BROWSER_VERSION, name);
const supported = process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch);
const serve =
  (bytes: Uint8Array, status = 200, seen: string[] = []): AgentBrowserDownload =>
  async (url) => {
    seen.push(url);
    return {
      ok: status === 200,
      status,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  };

/** Runs away from the repository so the developer copy under .runtime is not picked up. */
async function isolated(run: (cache: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'athena-ab-binary-')));
  const previous = process.cwd();
  const override = process.env.ATHENA_AGENT_BROWSER_PATH;
  delete process.env.ATHENA_AGENT_BROWSER_PATH;
  process.chdir(directory);
  try {
    await run(path.join(directory, 'cache'));
  } finally {
    process.chdir(previous);
    if (override !== undefined) process.env.ATHENA_AGENT_BROWSER_PATH = override;
    await rm(directory, { recursive: true, force: true });
  }
}

test('a download that is refused or altered is never installed', { skip: !supported }, async () => {
  await isolated(async (cache) => {
    const seen: string[] = [];
    await assert.rejects(
      ensureAgentBrowserBinary(cache, undefined, serve(Buffer.from('not the release'), 200, seen)),
      /下载校验失败/,
    );
    assert.deepEqual(seen, [
      `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${name}`,
    ]);
    await assert.rejects(
      ensureAgentBrowserBinary(cache, undefined, serve(new Uint8Array(), 503)),
      /下载失败（503）/,
    );
    await assert.rejects(
      ensureAgentBrowserBinary(cache, undefined, async () => {
        throw new Error('offline');
      }),
      /offline/,
    );
    const abort = new AbortController();
    await assert.rejects(
      ensureAgentBrowserBinary(cache, abort.signal, async (_url, options) => {
        abort.abort();
        options.signal.throwIfAborted();
        throw new Error('the signal was not passed on');
      }),
      /abort/i,
    );
    assert.deepEqual(await readdir(cache), [AGENT_BROWSER_VERSION], 'no staging directory stays');
    assert.deepEqual(await readdir(path.join(cache, AGENT_BROWSER_VERSION)), []);
  });
});

test('an explicit path is used as given and must be executable', { skip: !supported }, async () => {
  await isolated(async (cache) => {
    const file = path.join(path.dirname(cache), 'custom-agent-browser');
    await writeFile(file, '#!/bin/sh\n', { mode: 0o644 });
    process.env.ATHENA_AGENT_BROWSER_PATH = file;
    try {
      const refuse: AgentBrowserDownload = async () => {
        throw new Error('must not download');
      };
      await assert.rejects(ensureAgentBrowserBinary(cache, undefined, refuse), /EACCES/);
      await chmod(file, 0o755);
      assert.equal(await ensureAgentBrowserBinary(cache, undefined, refuse), file);
    } finally {
      delete process.env.ATHENA_AGENT_BROWSER_PATH;
    }
  });
});

test(
  'the official release is installed once, reused, and replaced when its bytes change',
  {
    // Needs the real release bytes; `npm run setup:agent-browser` fetches them.
    skip:
      !supported ||
      !(await stat(local).then(
        () => true,
        () => false,
      )),
  },
  async () => {
    const release = await readFile(local);
    await isolated(async (cache) => {
      const seen: string[] = [];
      const installed = await ensureAgentBrowserBinary(cache, undefined, serve(release, 200, seen));
      assert.equal(installed, path.join(cache, AGENT_BROWSER_VERSION, name));
      assert.equal((await stat(installed)).mode & 0o777, 0o755);
      assert.equal((await stat(path.dirname(installed))).mode & 0o777, 0o700);
      assert((await readFile(installed)).equals(release));
      assert.deepEqual(await readdir(cache), [AGENT_BROWSER_VERSION]);
      assert.equal(
        await ensureAgentBrowserBinary(cache, undefined, serve(Buffer.from('x'), 200, seen)),
        installed,
      );
      assert.equal(seen.length, 1, 'a verified copy is not downloaded again');
      await writeFile(installed, 'tampered');
      await assert.rejects(
        ensureAgentBrowserBinary(cache, undefined, serve(Buffer.from('x'), 200, seen)),
        /下载校验失败/,
      );
      assert.equal(await ensureAgentBrowserBinary(cache, undefined, serve(release)), installed);
      assert((await readFile(installed)).equals(release));
    });
  },
);
