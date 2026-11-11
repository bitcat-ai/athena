/** Real Electron IPC + installed CLI catalogs. No prompts, turns, tool approvals or model inference. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import type { AppSnapshot } from '../src/shared/types';
import type { ModelOption } from '../src/shared/usage';

const root = process.cwd();
await mkdir(path.join(root, '.runtime'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.runtime/cli-models-ui-'));
const profile = path.join(directory, 'profile'),
  workspace = path.join(directory, 'workspace');
const output = path.resolve('test-results/cli-models-ui');
for (const dir of [profile, workspace, output]) await mkdir(dir, { recursive: true });
const cliIds = ['claude', 'cursor', 'gemini', 'opencode'] as const;
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: { workspace, agent: 'claude' },
    recordings: [],
    onboarding: {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      workspaceConfirmed: workspace,
      browserDeferred: true,
    },
    conversations: cliIds.map((agent, index) => ({
      id: `catalog-${agent}`,
      title: `Catalog ${agent}`,
      agent,
      workspace,
      updatedAt: 10 - index,
      messages: [],
    })),
  }),
);
const env: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
env.WORKBENCH_USER_DATA_DIR = profile;
delete env.WORKBENCH_DEV_SERVER_URL;
// Optional private installation used only by this isolated test; it is not installed globally.
if (process.env.WORKBENCH_TEST_GEMINI_BIN)
  env.PATH = `${process.env.WORKBENCH_TEST_GEMINI_BIN}${path.delimiter}${env.PATH || ''}`;
let app: ElectronApplication | undefined;
const evidence: Array<{ cli: string; version?: string; models: number; selected: string }> = [];
const deadline = setTimeout(() => void app?.close(), 90000);
try {
  app = await electron.launch({
    args: ['tests/electron-background.cjs'],
    cwd: root,
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await expect(page.locator('#composer-agent-name')).toBeAttached({ timeout: 30000 });
  assert.ok(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((w) => !w.isVisible() && !w.isFocused()),
    ),
  );
  const invoke = <T>(action: string, payload?: unknown) =>
    page.evaluate(({ action, payload }) => window.workbench.invoke<T>(action, payload), {
      action,
      payload,
    });
  for (const cli of cliIds) {
    const before = await invoke<AppSnapshot>('app:snapshot');
    const info = before.agents.find((agent) => agent.id === cli);
    assert.ok(info?.available && info.supported, `${cli} must be installed for this native test`);
    await page
      .locator('.conversation-list')
      .getByRole('button', { name: new RegExp(`^Catalog ${cli}`) })
      .click();
    await page.locator('.sidebar-settings').click();
    const card = page.locator('.agent-connection-card');
    await expect(card.getByRole('heading', { level: 4 })).toHaveText(info.name);
    const models = await invoke<ModelOption[]>('models:list', {
      conversationId: `catalog-${cli}`,
      agent: cli,
    });
    assert.ok(models.length > 0, `${cli} must return its own catalog`);
    const model = models.find((item) => item.model === 'sonnet') || models[0];
    await card.getByRole('button', { name: '选择模型', exact: true }).click();
    const list = page.getByRole('listbox', { name: '模型', exact: true });
    await expect(list.getByRole('option')).toHaveCount(models.length);
    await list.getByRole('option', { name: model.name, exact: true }).first().click();
    await expect
      .poll(
        async () =>
          (await invoke<AppSnapshot>('app:snapshot')).conversations.find(
            (c) => c.id === `catalog-${cli}`,
          )?.modelSelection?.model,
      )
      .toBe(model.model);
    if (cli === 'claude') {
      assert.ok(model.efforts.length > 0);
      const slider = page.getByRole('slider', { name: '推理强度', exact: true });
      await slider.focus();
      await slider.press('End');
      await expect
        .poll(
          async () =>
            (await invoke<AppSnapshot>('app:snapshot')).conversations.find(
              (c) => c.id === `catalog-${cli}`,
            )?.modelSelection?.effort,
        )
        .toBe(model.efforts.at(-1)!.id);
    }
    for (const option of models.filter((item) =>
      models.some((other) => other.model !== item.model && other.name === item.name),
    ))
      await expect(
        list.getByText(option.model, { exact: true }),
      ).toHaveCount(1);
    const footer = await page.locator('.model-control-status').boundingBox();
    const viewport = await page.evaluate(() => ({ height: innerHeight, width: innerWidth }));
    assert.ok(
      footer && footer.y >= 0 && footer.y + footer.height <= viewport.height,
      `${cli} model controls overflow the viewport`,
    );
    await page.screenshot({ path: path.join(output, `${cli}-catalog.png`) });
    await page.getByRole('button', { name: '关闭模型选择', exact: true }).click();
    const after = await invoke<AppSnapshot>('app:snapshot');
    assert.equal(after.settings.agent, 'claude');
    assert.equal(after.settings.modelSelections, undefined);
    assert.ok(after.conversations.every((c) => c.messages.length === 0));
    evidence.push({ cli, version: info.version, models: models.length, selected: model.model });
  }
  await app.close();
  app = undefined;
  const saved = JSON.parse(await readFile(path.join(profile, 'workspace.json'), 'utf8'));
  for (const item of evidence)
    assert.equal(
      saved.conversations.find((c: any) => c.id === `catalog-${item.cli}`).modelSelection.model,
      item.selected,
    );
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      { passed: true, mode: 'hidden-electron-real-cli-catalogs', modelPrompts: 0, evidence },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, modelPrompts: 0, evidence, output }));
} finally {
  clearTimeout(deadline);
  await app?.close().catch(() => {});
}
