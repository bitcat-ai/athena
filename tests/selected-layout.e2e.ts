/** The real desktop send path on the demo page, even when the model never produces a first token. */
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import type { AppSnapshot, ElementQueryResult } from '../src/shared/types';

const dir = await mkdtemp(path.join(tmpdir(), 'athena-selected-layout-'));
const profile = path.join(dir, 'profile'),
  bin = path.join(dir, 'bin'),
  log = path.join(dir, 'turns');
await seedLegacyWorkspace(profile);
await mkdir(bin);
await writeFile(log, '');
await writeFile(
  path.join(bin, 'codex'),
  `#!${process.execPath}
const fs=require('node:fs');const send=x=>console.log(JSON.stringify(x));
if(process.argv.includes('--version')){console.log('codex-cli 0.171.0');process.exit(0);}
require('node:readline').createInterface({input:process.stdin}).on('line',s=>{
 const r=JSON.parse(s);if(r.id===undefined)return;
 let result={};if(r.method==='initialize')result={userAgent:'fixture'};
 if(r.method==='skills/list'||r.method==='model/list')result={data:[]};
 if(r.method==='thread/start'||r.method==='thread/resume')result={thread:{id:'selected-fixture'}};
 if(r.method==='turn/start'){const text=r.params.input.find(i=>i.type==='text')?.text || '';fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({selected:text.includes('selected_element_snapshot'),localHistory:text.includes('<recent_local_previews>'),fullPage:text.includes('<web_page_outline>')})+'\\n');result={turn:{id:'held-turn',status:'inProgress'}};}
 send({id:r.id,result});
 if(r.method==='turn/interrupt')send({method:'turn/completed',params:{threadId:'selected-fixture',turn:{id:'held-turn',status:'interrupted'}}});
});`,
  { mode: 0o700 },
);
const app = await electron.launch({
  ...(process.env.ATHENA_LAYOUT_APP ? {executablePath:process.env.ATHENA_LAYOUT_APP} : {}),
  args: process.env.ATHENA_LAYOUT_APP ? [] : [path.resolve('tests/electron-background.cjs')],
  cwd: process.cwd(),
  env: {
    ...process.env,
    PATH: bin + ':' + process.env.PATH,
    WORKBENCH_USER_DATA_DIR: profile,
    WORKBENCH_DEV_SERVER_URL: '',
  },
});
try {
  const renderer = await app.firstWindow();
  const invoke = <T>(action: string, payload?: unknown) =>
    renderer.evaluate(({ action, payload }) => window.workbench.invoke<T>(action, payload), {
      action,
      payload,
    });
  const query = async (selector: string) =>
    (await invoke<ElementQueryResult>('browser:query', { selector })).elements[0];
  await expect
    .poll(async () => (await invoke<AppSnapshot>('app:snapshot')).browser.status, {
      timeout: 30000,
    })
    .toBe('ready');
  const heading = await query('#headline');
  const before = (await query('.intro')).bounds!;
  const started = performance.now();
  const sent = await invoke<{ conversationId: string }>('conversation:send', {
    text: '[ele1] 它和副标题，改为左右布局',
    mentions: [{ token: '[ele1]', ref: heading.ref }],
  });
  const sideBySide = async () => {
    const h = (await query('#headline')).bounds!,
      p = (await query('.intro')).bounds!;
    return (
      h.x + h.width <= p.x + 1 && Math.min(h.y + h.height, p.y + p.height) > Math.max(h.y, p.y)
    );
  };
  await expect.poll(sideBySide, { timeout: 3000, intervals: [10, 20, 50] }).toBe(true);
  const visibleMs = Math.round(performance.now() - started);
  const snapshot = () => invoke<AppSnapshot>('app:snapshot');
  const reply = async () =>
    (await snapshot()).conversations.find((c) => c.id === sent.conversationId)?.messages.at(-1);
  await expect.poll(async () => (await reply())?.status).toBe('done');
  assert.match((await reply())!.text, /左右/);
  const { browser } = await snapshot();
  const preview = browser.previewEdits?.at(-1);
  assert.ok(preview?.editId);
  assert.equal(await readFile(log, 'utf8'), '');
  await invoke('browser:undo', { editId: preview.editId });
  assert.equal(await sideBySide(), false);
  assert.equal((await query('.intro')).bounds!.x, before.x);
  await renderer.getByRole('button', { name: '展开浏览器', exact: true }).click();
  const field = renderer.getByRole('textbox', { name: '发送给 Agent 的任务', exact: true });
  await invoke('browser:element', { ref: (await query('#headline')).ref });
  await expect(renderer.locator('.composer .element-token')).toHaveCount(1);
  await field.focus();
  await field.press('End');
  await renderer.keyboard.insertText(' 它和副标题，改为左右布局');
  const clicked = performance.now();
  await renderer.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect.poll(sideBySide, { timeout: 3000, intervals: [10, 20, 50] }).toBe(true);
  await expect(
    renderer
      .getByText('已在当前网页将标题和副标题改为左右布局，可撤销本次预览。', { exact: true })
      .last(),
  ).toBeVisible();
  const viaComposerMs = Math.round(performance.now() - clicked);
  assert.equal(await readFile(log, 'utf8'), '');
  const input = await query('#title');
  const trialEdits = (await snapshot()).browser.previewEdits!.length;
  await invoke('conversation:send', {
    id: sent.conversationId,
    text: '[ele1] 它和副标题，改为左右布局',
    mentions: [{ token: '[ele1]', ref: input.ref }],
  });
  await expect.poll(async () => !!(await readFile(log, 'utf8')).trim()).toBe(true);
  assert.deepEqual(JSON.parse((await readFile(log, 'utf8')).trim()), {
    selected: true,
    localHistory: true,
    fullPage: false,
  });
  assert.equal(
    (await snapshot()).browser.previewEdits!.length,
    trialEdits,
    'ambiguous pair must not alter the page',
  );
  await invoke('conversation:stop');
  const report = {
    visibleMs,
    viaComposerMs,
    modelTurnsForMatchingLayout: 0,
    undoVerified: true,
    ambiguousFallbackVerified: true,
  };
  await mkdir('test-results/selected-layout', { recursive: true });
  await writeFile(
    'test-results/selected-layout/verification.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 4 });
}
