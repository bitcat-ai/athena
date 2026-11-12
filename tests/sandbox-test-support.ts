import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxClient, type SandboxClientOptions } from '../src/main/sandbox-client';
import { WorkspaceChannel } from '../src/main/workspace-channel';

export const mockPath = fileURLToPath(new URL('../scripts/mock-sandboxd.mjs', import.meta.url));

export interface MockDaemon {
  directory: string;
  env: NodeJS.ProcessEnv;
  /** Ends the current connection; daemon state survives for the next one. */
  drop(): Promise<void>;
  cleanup(): Promise<void>;
}

export async function mockDaemon(env: Record<string, string> = {}): Promise<MockDaemon> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'athena-sandbox-test-'));
  const dropFile = path.join(directory, 'drop');
  return {
    directory,
    env: {
      ...process.env,
      MOCK_SANDBOXD_STATE: path.join(directory, 'state.json'),
      MOCK_SANDBOXD_DROP_FILE: dropFile,
      MOCK_SANDBOXD_STEP_MS: '2',
      ...env,
    },
    drop: () => writeFile(dropFile, ''),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export const fastClient = {
  backoffMs: [20],
  maxAttempts: 5,
  requestTimeoutMs: 3000,
} satisfies Partial<SandboxClientOptions>;

export function mockClient(daemon: MockDaemon, options: Partial<SandboxClientOptions> = {}) {
  return new SandboxClient({
    host: 'mock',
    clientVersion: 'test',
    command: process.execPath,
    args: [mockPath],
    env: daemon.env,
    ...fastClient,
    ...options,
  });
}

export function mockChannel(daemon: MockDaemon, clientOptions: Partial<SandboxClientOptions> = {}) {
  return new WorkspaceChannel({
    ssh: 'coder.mock',
    clientVersion: 'test',
    transport: { command: process.execPath, args: [mockPath], env: daemon.env },
    clientOptions: { ...fastClient, ...clientOptions },
  });
}

export async function until<T>(read: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
