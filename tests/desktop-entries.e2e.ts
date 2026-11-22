/** Real isolated Electron, the existing sharing protocol, a PTY, and a local Codex protocol fixture. */
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
import { testImage } from './image-fixture';
import type { ShareState } from '../src/shared/share';
import type { AppSnapshot } from '../src/shared/types';

const root = await mkdtemp(path.join(tmpdir(), 'athena-desktop-entries-'));
const profile = path.join(root, 'profile'),
  bin = path.join(root, 'bin');
await seedLegacyWorkspace(profile);
await mkdir(bin);
const png = testImage.data;
await writeFile(
  path.join(bin, 'codex'),
  `#!${process.execPath}
const rl=require('node:readline').createInterface({input:process.stdin});
if(process.argv.includes('--version')){console.log('codex-cli 0.171.0');process.exit(0);}
if(!process.argv.includes('app-server')){
  console.log('ATHENA-PTY '+Boolean(process.stdout.isTTY)+' '+process.cwd());
  rl.on('line',s=>{if(s==='/exit')process.exit(0);
    if(s==='/child'){const p=require('node:child_process').spawn('/bin/sleep',['30'],{stdio:'ignore'});require('node:fs').writeFileSync('child.pid',String(p.pid));}
    console.log('native-reply:'+s);});
}else{
 const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
 rl.on('line',s=>{const r=JSON.parse(s);if(r.id===undefined)return;
 let result={};if(r.method==='initialize')result={userAgent:'test'};
 if(r.method==='model/list')result={data:[]};
 if(r.method==='skills/list')result={data:[]};
 if(r.method==='thread/start'||r.method==='thread/resume')result={thread:{id:'img-thread'},model:'fixture-model'};
 if(r.method==='turn/start')result={turn:{id:'img-turn',status:'inProgress'}};
 if(r.method==='modelProvider/capabilities/read')result={imageGeneration:true,webSearch:true};
 send({id:r.id,result});
 if(r.method==='turn/start')setTimeout(()=>{
  const e=(method,x)=>send({method,params:{threadId:'img-thread',turnId:'img-turn',...x}});
  e('turn/started',{turn:{id:'img-turn',status:'inProgress'}});
  e('item/started',{item:{id:'image-item',type:'imageGeneration',status:'inProgress'}});
  e('item/completed',{item:{id:'image-item',type:'imageGeneration',status:'completed',result:'${png}'}});
  e('item/completed',{item:{id:'message',type:'agentMessage',text:'图片已生成'}});
  e('turn/completed',{turn:{id:'img-turn',status:'completed'}});
 },100);});
}`,
  { mode: 0o700 },
);
await symlink(path.join(bin, 'codex'), path.join(bin, 'amp'));
const site = createServer((_req, res) =>
  res.end('<!doctype html><title>Shared fixture</title><button>Hello</button>'),
);
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const app = await electron.launch({
  ...(process.env.ATHENA_DESKTOP_APP ? { executablePath: process.env.ATHENA_DESKTOP_APP } : {}),
  args: process.env.ATHENA_DESKTOP_APP ? [] : ['.'],
  env: {
    ...process.env,
    WORKBENCH_USER_DATA_DIR: profile,
    PATH: bin + ':' + process.env.PATH,
    WORKBENCH_DEV_SERVER_URL: '',
  },
  cwd: process.cwd(),
});
try {
  const host = await app.firstWindow();
  const invoke = <T>(name: string, value?: unknown) =>
    host.evaluate(({ name, value }) => window.workbench.invoke<T>(name, value), { name, value });
  await host.waitForFunction(() => !!window.workbench);
  await invoke('browser:start');
  await invoke('browser:navigate', {
    url: `http://127.0.0.1:${(site.address() as { port: number }).port}/`,
  });
  await host.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await host.getByRole('button', { name: '共享页面', exact: true }).click();
  await host.getByRole('tab', { name: '加入共享', exact: true }).click();
  await host.getByLabel('邀请链接', { exact: true }).fill('invalid');
  await host.getByRole('button', { name: '打开共享页面' }).click();
  await expect(host.getByRole('alert').filter({ hasText: 'HTTPS' })).toBeVisible();
  const state = await invoke<ShareState>('share:start', { address: '127.0.0.1', name: 'Host' });
  const invitation = state.invite!.url;
  const invalid = new URL(invitation);
  invalid.hash = new URLSearchParams({
    invite: new URLSearchParams(invalid.hash.slice(1)).get('invite')!,
    fingerprint: 'AB'.repeat(32),
  }).toString();
  await assert.rejects(invoke('share:join', { link: invalid.href }), /连接共享页面失败/);
  const guestReady = app.waitForEvent('window', { predicate: (p) => p !== host, timeout: 20_000 });
  await host.getByLabel('邀请链接', { exact: true }).fill(invitation);
  await host.getByRole('button', { name: '打开共享页面' }).click();
  const guest = await guestReady;
  await guest.getByLabel('你的称呼', { exact: true }).fill('Guest');
  assert.equal(await guest.evaluate(() => !!window.workbench), false);
  await guest.getByRole('button', { name: '请求加入' }).click();
  await expect(guest.getByRole('heading', { name: '等待主持人确认' })).toBeVisible();
  const pending = (await invoke<ShareState>('share:state')).participants.find(
    (p) => p.status === 'pending',
  )!;
  await invoke('share:approve', { id: pending.id, role: 'viewer' });
  await expect(guest.locator('.shared-frame')).toBeVisible();
  await invoke('share:stop');
  await guest.close();
  const nativeReady = app.waitForEvent('window', { predicate: (p) => p !== host, timeout: 20_000 });
  await invoke('runtime:open-native', {});
  const native = await nativeReady;
  await expect(native.locator('#name')).toContainText('Codex');
  assert.equal(await native.evaluate(() => !!window.workbench), false);
  await expect(native.locator('.xterm-accessibility-tree')).toContainText('ATHENA-PTY true');
  await native.locator('.xterm-helper-textarea').pressSequentially('/skills');
  await native.keyboard.press('Enter');
  await expect(native.locator('.xterm-accessibility-tree')).toContainText('native-reply:/skills');
  await native.evaluate(() => window.nativeTerminal.write('/exit\r'));
  await expect(native.locator('#status')).toContainText('已退出');
  await native.close();
  await host.getByRole('button', { name: '设置', exact: true }).click();
  await host.locator('.runtime-installations summary').click();
  await host.getByRole('button', { name: '其他本机 CLI' }).click();
  const otherReady = app.waitForEvent('window', { predicate: (p) => p !== host });
  await host.getByRole('menuitem', { name: 'Amp', exact: true }).click();
  const other = await otherReady;
  await expect(other.locator('#name')).toContainText('Amp');
  await expect(other.locator('.xterm-accessibility-tree')).toContainText('ATHENA-PTY true');
  await other.evaluate(() => window.nativeTerminal.write('/child\r'));
  await expect(other.locator('.xterm-accessibility-tree')).toContainText('native-reply:/child');
  const helperPid = Number(await readFile(path.join(profile, 'workspace', 'child.pid'), 'utf8'));
  await other.close();
  await expect
    .poll(() => {
      try {
        process.kill(helperPid, 0);
        return false;
      } catch {
        return true;
      }
    })
    .toBe(true);
  await host.getByRole('button', { name: '返回对话', exact: true }).click();
  await host.getByRole('textbox', { name: '发送给 Agent 的任务', exact: true }).fill('生成图片');
  await host.getByRole('button', { name: '发送任务', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await invoke<AppSnapshot>('app:snapshot')).conversations.some((c) =>
          c.messages.some((m) => m.execution?.some((e) => e.artifact?.mimeType === 'image/png')),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  const image = host.locator('.generated-image img');
  await expect(image).toBeVisible();
  assert.equal(await image.evaluate((n) => (n as HTMLImageElement).naturalWidth), 1);
  const saved = await readFile(path.join(profile, 'workspace.json'), 'utf8');
  assert(!saved.includes(png), 'image bytes must not be embedded in conversation history');
  console.log(
    'Desktop entry checks passed: pinned guest / approved viewer, native PTY input and exit, generated image artifact and preview.',
  );
} finally {
  await app.close();
  site.close();
  await rm(root, { recursive: true, force: true });
}
