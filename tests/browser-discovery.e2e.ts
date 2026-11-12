/** Real Electron timer/focus → filesystem discovery → UI; fixture app, no browser launch or model calls. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import type { AppSnapshot } from '../src/shared/types';

const root = process.cwd();
const directory = await mkdtemp(path.join(tmpdir(), 'athena-detect-ui-'));
const profile = path.join(directory, 'profile');
const workspace = path.join(directory, 'workspace');
const application = path.join(profile, 'runtime/Google Chrome.app');
const binary = path.join(application, 'Contents/MacOS/Google Chrome');
const launched = path.join(directory, 'unexpected-launch');
await mkdir(profile);
await mkdir(workspace);
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: { agent: 'codex', workspace, browserPath: path.join(directory, 'moved.app') },
    conversations: [],
    recordings: [],
    onboarding: {
      version: 1,
      status: 'in-progress',
      stage: 'browser',
      required: true,
    },
  }),
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  WORKBENCH_USER_DATA_DIR: profile,
  WORKBENCH_BROWSER_PATH: path.join(directory, 'moved.app'),
  ATHENA_CHROME_PATH: path.join(directory, 'not-installed.app'),
};
delete env.WORKBENCH_DEV_SERVER_URL;
const app = await electron.launch({
  args: [path.join(root, 'tests/browser-discovery-host.cjs')],
  cwd: directory,
  env: Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
});
try {
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate('window.__name = fn => fn');
  const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
  await expect.poll(async () => (await snapshot()).onboarding?.stage).toBe('browser');
  const before = await snapshot();
  assert.notEqual(before.browser.binaryPath, binary);

  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, `#!/bin/sh\ntouch '${launched}'\nexit 91\n`, { mode: 0o700 });
  await writeFile(
    path.join(application, 'Contents/Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.google.Chrome</string><key>CFBundleExecutable</key><string>Google Chrome</string></dict></plist>',
  );
  await writeFile(path.join(profile, 'indexed-browser.txt'), application);
  await expect
    .poll(async () => (await snapshot()).browser.binaryPath, { timeout: 20_000 })
    .toBe(binary);
  await expect.poll(async () => (await snapshot()).onboarding?.browser.path).toBe(binary);
  await expect(page.getByRole('button', { name: '重新检查', exact: true })).toBeVisible();
  const after = await snapshot();
  assert.equal(after.browser.binaryPath, binary);
  assert.equal(after.web?.status, 'stopped');
  assert.notEqual(after.onboarding?.browser.status, 'ready');
  assert.equal(after.onboarding?.plan, undefined);
  const relocated = path.join(profile, 'Not indexed.app');
  await rename(application, relocated);
  await writeFile(path.join(profile, 'registered-browser.txt'), relocated);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'));
  await expect
    .poll(async () => (await snapshot()).browser.binaryPath)
    .toBe(path.join(relocated, 'Contents/MacOS/Google Chrome'));
  assert.equal(
    await access(launched).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  const output = path.join(root, 'test-results/browser-discovery');
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'installed.png'), animations: 'disabled' });
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        checks: [
          'external installation detected by the background timer without refocusing',
          'stale configured path recovered',
          'externally indexed installation discovered',
          'registered renamed installation discovered without Spotlight',
          'installation discovered without skipping incomplete setup',
          'no browser launch',
        ],
        browser: after.browser.status,
        web: after.web?.status,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: external installation detected on focus; UI updated; browser and agent-browser remain stopped.',
  );
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
