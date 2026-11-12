/** Actual Electron + Docker transport + offscreen page frames; no model or fake UI state. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { LocalSandbox } from '../src/main/local-sandbox';
import type { AppSnapshot } from '../src/shared/types';

const root = process.cwd(),
  directory = await mkdtemp(path.join(root, '.runtime/pip-local-'));
const profile = path.join(directory, 'profile'),
  workspace = path.join(directory, 'workspace');
await mkdir(profile);
await mkdir(workspace);
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: { workspace, agent: 'claude' },
    conversations: [
      {
        id: 'pip-check',
        title: '沙箱连接检查',
        agent: 'claude',
        workspace,
        messages: [],
        updatedAt: Date.now(),
      },
    ],
    recordings: [],
    onboarding: {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      workspaceConfirmed: workspace,
      browserDeferred: true,
    },
  }),
);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  WORKBENCH_USER_DATA_DIR: profile,
};
delete env.WORKBENCH_DEV_SERVER_URL;
const app = await electron.launch({
  args: [path.join(root, 'tests/electron-background.cjs')],
  cwd: root,
  env: Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  ),
});
const controller = new AbortController(),
  context = { conversationId: 'pip-check', turnId: 'ui-check', signal: controller.signal };
const peer = new LocalSandbox(
  path.join(profile, 'sandboxes/frontend'),
  path.join(root, 'packages/athena-sandbox/athena-sandbox.mjs'),
  () => {},
  {
    image: 'athena-sandbox-node:1',
    dockerfile: path.join(root, 'resources/sandbox/node.Dockerfile'),
  },
);
const output = path.join(root, 'test-results/sandbox-pip-ui');
await mkdir(output, { recursive: true });
try {
  const page = await app.firstWindow();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate('window.__name = fn => fn');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 960));
  const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
  await page.getByRole('button', { name: '独立沙箱', exact: true }).click();
  const pip = page.getByRole('region', { name: '前端沙箱预览' });
  const backend = page.getByRole('region', { name: '后端沙箱预览' });
  await expect(backend).toBeVisible();
  const initialFront = (await pip.boundingBox())!;
  const initialBack = (await backend.boundingBox())!;
  assert.equal(initialFront.x - initialBack.x, 28);
  assert.equal(initialBack.y - initialFront.y, 14);
  await page.screenshot({ path: path.join(output, 'default-cascade.png') });
  await pip.locator('.sandbox-pip-bar').click({ position: { x: 70, y: 5 } });
  await expect(pip).toContainText('未连接');
  await pip.getByRole('button', { name: '连接沙箱', exact: true }).click();
  await expect
    .poll(
      async () => (await snapshot()).sandboxViews?.find((v) => v.target === 'frontend')?.connection,
      { timeout: 30000 },
    )
    .toBe('ready');
  const command = await peer.run(
    context,
    "printf 'PIP-LIVE-OUTPUT\\n'; sleep 2; printf 'PIP-COMPLETE\\n'",
    0,
  );
  await expect(pip.getByRole('log')).toContainText('PIP-LIVE-OUTPUT');
  await expect(pip.getByRole('status')).toContainText('正在执行');
  await peer.result(context, command.command.id, 5);
  await expect(pip.getByRole('log')).toContainText('PIP-COMPLETE');
  await page.screenshot({ path: path.join(output, 'command-output.png') });
  await peer.run(context, 'exit 7');
  await expect(pip.getByRole('status')).toContainText('需要检查');
  await peer.write(context, [
    {
      path: 'server.cjs',
      content:
        "require('http').createServer((q,s)=>{s.setHeader('content-type','text/html;charset=utf-8');s.end('<title>真实沙箱预览</title><h1>Real sandbox page</h1><p>Live response from the container.</p>')}).listen(Number(process.env.PORT),'0.0.0.0')",
    },
  ]);
  const preview = await peer.service(context, 'node server.cjs');
  await expect(pip.getByRole('img')).toHaveAttribute('src', /^data:image\/jpeg/, {
    timeout: 20000,
  });
  await expect(pip.getByRole('img')).toHaveAttribute('alt', /真实沙箱预览/);
  await expect(pip.getByRole('status')).toContainText('已连接');
  await page.screenshot({ path: path.join(output, 'live-preview.png') });
  const before = await pip.boundingBox(),
    bar = (await pip.locator('.sandbox-pip-bar').boundingBox())!;
  const reminder = page.getByRole('button', { name: '收起提醒', exact: true });
  if (await reminder.isVisible()) await reminder.click();
  await page.mouse.move(bar.x + 70, bar.y + 5);
  await page.mouse.down();
  await page.mouse.move(bar.x - 100, bar.y + 105, { steps: 10 });
  await page.mouse.up();
  const after = await pip.boundingBox();
  assert.ok(before && after && Math.abs(before.x - after.x) > 100);
  await expect(backend).toBeVisible();
  await backend.locator('.sandbox-pip-bar').click({ position: { x: 70, y: 5 } });
  await backend.getByRole('button', { name: '连接沙箱', exact: true }).click();
  await expect
    .poll(
      async () => (await snapshot()).sandboxViews?.find((v) => v.target === 'backend')?.connection,
      { timeout: 30000 },
    )
    .toBe('ready');
  const views = (await snapshot()).sandboxViews!;
  assert.notEqual(
    views.find((v) => v.target === 'frontend')?.name,
    views.find((v) => v.target === 'backend')?.name,
  );
  await expect(pip.getByRole('log')).toHaveCount(0);
  await expect(backend.getByRole('log')).not.toContainText('PIP-LIVE-OUTPUT');
  await expect(pip.getByRole('img')).toBeVisible();
  const backendBefore = await backend.boundingBox();
  await backend.locator('.sandbox-pip-bar').focus();
  await page.keyboard.press('Shift+ArrowLeft');
  const backendAfter = await backend.boundingBox();
  assert.equal(backendBefore!.x - backendAfter!.x, 24);
  assert.deepEqual(await pip.boundingBox(), after);
  await page.screenshot({ path: path.join(output, 'two-independent-windows.png') });
  await expect(pip.getByRole('img')).toBeVisible({ timeout: 15000 });
  await pip.locator('.sandbox-pip-bar').click({ position: { x: 70, y: 20 } });
  await pip.getByRole('button', { name: '打开预览 ↗', exact: true }).click();
  await expect.poll(async () => (await snapshot()).browser.url).toBe(preview.url + '/');
  await pip.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(pip).toHaveCount(0);
  await expect(backend).toBeVisible();
  await page.getByRole('button', { name: '独立沙箱', exact: true }).click();
  await expect(pip).toBeVisible();
  assert.equal((await snapshot()).sandboxPips?.length, 2);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 700));
  await expect
    .poll(async () => {
      const boxes = await page.locator('.sandbox-pip').evaluateAll((nodes) =>
        nodes.map((node) => {
          const r = node.getBoundingClientRect();
          return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
        }),
      );
      return boxes.every(Boolean);
    })
    .toBe(true);
  await page.screenshot({ path: path.join(output, 'two-windows-narrow.png') });
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        passed: true,
        mode: 'real Electron + Docker, no model',
        directory,
        checks: [
          'manual connect',
          'live command output and status',
          'real service thumbnail',
          'dragging',
          'two visible independent windows, isolated logs and keyboard movement',
          'open browser preview',
          'close and reopen',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: real sandbox PiP connection, logs, preview, independent windows and keyboard movement',
  );
} finally {
  controller.abort();
  await app.close();
  await peer.dispose();
}
