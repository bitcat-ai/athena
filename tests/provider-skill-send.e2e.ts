/** Actual renderer/preload/host IPC with a scripted Pi CLI; build first, no model calls. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type ElectronApplication } from '@playwright/test';
import { Store } from '../src/main/store';
import type { AppSnapshot } from '../src/shared/types';

const root = process.cwd();
const profile = await realpath(await mkdtemp(path.join(tmpdir(), 'athena-provider-send-')));
const workspace = path.join(profile, 'workspace');
const bin = path.join(profile, 'bin');
const log = path.join(profile, 'calls');
const skillPath = path.join(workspace, '.pi', 'skills', 'review', 'SKILL.md');
const localSkillPath = path.join(workspace, '.agents', 'skills', 'athena-fixture-notes', 'SKILL.md');
const body = '---\nname: review\ndescription: Provider review\n---\nPrivate provider instructions';
let application: ElectronApplication | undefined;
try {
  await mkdir(bin);
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, body);
  await mkdir(path.dirname(localSkillPath), { recursive: true });
  await writeFile(
    localSkillPath,
    '---\nname: athena-fixture-notes\ndescription: Workspace notes\n---\nPrivate workspace instructions',
  );
  await writeFile(log, '');
  // Block discovery of other real CLIs even if the host has them installed.
  for (const name of ['codex', 'claude', 'gemini', 'cursor-agent', 'agent', 'opencode']) {
    await writeFile(path.join(bin, name), '#!/bin/sh\nprintf "fixture unavailable\\n"\n', {
      mode: 0o700,
    });
  }
  const cli = path.join(bin, 'pi');
  await writeFile(
    cli,
    `#!${process.execPath}\n` +
      String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args.includes('--version')) {console.log('pi 0.70.0');process.exit(0)}
if(args.includes('--help')) {console.log('--mode rpc --no-skills --no-prompt-templates --no-extensions --no-mcp');process.exit(0)}
const profile = process.env.WORKBENCH_USER_DATA_DIR;
const sid = args[args.indexOf('--session-id')+1];
const out = r => console.log(JSON.stringify(r));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line);
 fs.appendFileSync(profile+'/calls', JSON.stringify(r)+'\n');
 const reply = data => out({type:'response',id:r.id,command:r.type,success:true,data});
 if(r.type==='get_state') {
  out({type:'extension_ui_request',id:'gate',method:'notify',message:'athena-permissions-v1'});
  return reply({sessionId:sid,isStreaming:false,pendingMessageCount:0,model:{id:'model',provider:'fixture'}});
 }
 if(r.type==='get_available_models')return reply({models:[{id:'model',provider:'fixture'}]});
 if(r.type==='get_commands')return reply({commands:[{name:'skill:review',description:'Review',source:'skill',sourceInfo:{path:process.cwd()+'/.pi/skills/review/SKILL.md'}}]});
 if(r.type==='prompt') {
  reply({disposition:'started'});
  out({type:'agent_start'});
  out({type:'message_end',message:{role:'assistant',model:'model',provider:'fixture',stopReason:'stop',content:[{type:'text',text:'done'}]}});
  return out({type:'agent_settled',aborted:false});
 }
 reply({});
});
`,
    { mode: 0o700 },
  );
  // Use the production serializer instead of guessing the persisted format.
  const store = new Store(profile);
  await store.load();
  store.data.settings = { agent: 'pi', workspace };
  store.data.onboarding = {
    version: 1,
    status: 'complete',
    stage: 'ready',
    required: false,
    browserDeferred: true,
    workspaceConfirmed: workspace,
  };
  store.data.conversations = [
    { id: 'pi-task', agent: 'pi', title: 'Pi task', updatedAt: 1, workspace, messages: [] },
  ];
  await store.save();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    WORKBENCH_USER_DATA_DIR: profile,
  };
  delete env.WORKBENCH_DEV_SERVER_URL;
  application = await electron.launch({
    args: ['.'],
    cwd: root,
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  const page = await application.firstWindow({ timeout: 30000 });
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
  });
  const invoke = <T>(name: string, payload?: unknown) =>
    page.evaluate(({ name, payload }) => window.workbench.invoke<T>(name, payload), {
      name,
      payload,
    });
  const snapshot = () => invoke<AppSnapshot>('app:snapshot');
  const conversation = async () =>
    (await snapshot()).conversations.find((item) => item.id === 'pi-task')!;
  // codexConnection is a legacy shared field, not proof of Pi discovery/readiness.
  await expect
    .poll(async () => (await snapshot()).providerSkillDiscovery?.status, { timeout: 30000 })
    .toBe('ready');
  const initial = await snapshot();
  assert.equal(initial.settings.workspace, workspace);
  assert.equal(initial.agents.find((item) => item.id === 'pi')?.path, cli);
  assert.equal(initial.providerSkillDiscovery?.provider.id, 'pi');
  assert.deepEqual(
    initial.providerSkills?.map((item) => item.name),
    ['review'],
  );
  const metadata = {
    name: 'review',
    providerId: 'pi',
    providerPath: path.join(workspace, '.pi', 'skills', 'review', 'SKILL.md'),
  };
  assert.equal(initial.providerSkills?.[0].providerPath, metadata.providerPath);
  assert.equal(initial.providerSkills?.[0].contentHash, undefined);
  const calls = async (): Promise<Array<{ type: string; message?: string }>> =>
    (await readFile(log, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const prompts = async () => (await calls()).filter((item) => item.type === 'prompt');
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的任务', exact: true });
  await expect(page.locator('#composer-agent-name')).toHaveText('Pi');
  const option = page.getByRole('menuitem', { name: /review/ });
  // A slash inside a URL or a path is not a Skill reference.
  for (const text of ['https://example.com/re', '/tmp/file']) {
    await composer.fill(text);
    await expect(composer).toHaveText(text);
    await expect(option).toHaveCount(0);
  }
  await composer.fill('/');
  await expect(option).toBeVisible();
  await composer.press('Escape');
  await expect(option).toHaveCount(0);
  await composer.fill('Check /rev');
  await expect(option).toBeVisible();
  await composer.press('Enter');
  await expect(composer.locator('.composer-skill-reference')).toHaveText('/review');
  await expect(option).toHaveCount(0);
  assert.equal((await prompts()).length, 0, 'choosing a Skill must not send the task');
  await composer.fill('/');
  await composer.press('Enter');
  await expect(composer.locator('.composer-skill-reference')).toHaveText('/review');
  await page.keyboard.insertText('Inspect changes');
  await composer.press('Enter');
  await expect.poll(async () => (await prompts()).length).toBe(1);
  await expect.poll(async () => (await conversation()).messages.at(-1)?.status).toBe('done');
  await expect(composer).toHaveText('');
  assert.equal((await prompts())[0].message, '/skill:review\n\nInspect changes');
  const completed = await conversation();
  await expect(page.locator('.user-message-text').first()).toHaveText('/review Inspect changes');
  assert.equal(completed.messages[0].text, 'Inspect changes');
  assert.equal(completed.skillUsage?.[0].provider?.id, 'pi');
  assert.equal(completed.skillUsage?.[0].injectionStatus, 'degraded');
  assert.match(completed.skillUsage?.[0].capabilityDegradation ?? '', /CLI/);

  await page.evaluate(() => {
    const notices: string[] = [];
    Object.assign(window, { providerFixtureNotices: notices });
    window.workbench.onEvent((event) => {
      if (event.type === 'notice' && event.level === 'error') notices.push(event.message);
    });
  });
  const notices = () =>
    page.evaluate(
      () => (window as unknown as { providerFixtureNotices: string[] }).providerFixtureNotices,
    );
  const draft = 'Keep this unsent draft';
  await composer.fill(draft);
  for (const [stale, error] of [
    [{ ...metadata, providerId: 'codex' }, /provider 已改变/],
    [{ ...metadata, providerPath: metadata.providerPath + '.moved' }, /路径已改变/],
  ] as const) {
    const before = (await notices()).length;
    // startTurn ACKs immediately; stale checks fail asynchronously via notice, not IPC rejection.
    const result = await invoke<{ conversationId: string }>('conversation:send', {
      id: 'pi-task',
      text: 'Rejected task',
      selectedSkills: ['review'],
      selectedSkillMetadata: [stale],
    });
    assert.deepEqual(result, { conversationId: 'pi-task' });
    await expect.poll(async () => (await notices()).length).toBe(before + 1);
    assert.match((await notices()).at(-1)!, error);
    assert.equal((await prompts()).length, 1);
    assert.deepEqual(
      await conversation(),
      completed,
      'rejected metadata must not append messages or overwrite skill usage',
    );
    // This direct IPC check preserves an unrelated draft; it does not prove UI-submit failure retention.
    await expect(composer).toContainText(draft);
  }

  // A workspace Skill is picked in the toolbar. It is sent by name, without provider metadata.
  assert.ok((await snapshot()).skills?.some((item) => item.name === 'athena-fixture-notes'));
  await composer.fill('');
  await page.getByRole('button', { name: '选择任务 Skill', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: /^athena-fixture-notes/ }).click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: '任务 Skill：athena-fixture-notes', exact: true }),
  ).toBeVisible();
  await composer.fill('Draft the notes');
  await composer.press('Enter');
  await expect.poll(async () => (await prompts()).length).toBe(2);
  await expect.poll(async () => (await conversation()).messages.at(-1)?.status).toBe('done');
  const localPrompt = (await prompts())[1].message ?? '';
  assert.match(localPrompt, /Skill: athena-fixture-notes（来源：workspace/);
  assert.match(localPrompt, /Draft the notes/);
  assert.equal((await conversation()).messages.at(-2)?.text, 'Draft the notes');
  console.log(
    'PASS: actual renderer skill selection/send (CLI reference and workspace pick) -> preload IPC -> production Pi adapter -> scripted CLI; native prompt, degraded usage, stale provider/path notices with no turn mutation, and unrelated draft preservation. No model calls. Pi RPC provides no content hash; no content-change validation claimed. Async stale-send ACK does not prove UI-submit draft retention.',
  );
} finally {
  await application?.close();
  await rm(profile, { recursive: true, force: true });
}
