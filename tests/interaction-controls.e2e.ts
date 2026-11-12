/** Real HeroUI controls and ModelPicker, with deterministic local model/settings responses. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { uiBrowserExecutable } from './ui-browser';
import { chromium, expect } from '@playwright/test';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createServer, type Plugin } from 'vite';

const root = process.cwd();
const output = path.resolve('test-results/interaction-refinement/controls');
await mkdir(output, { recursive: true });
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ModelPicker} from '/src/renderer/ModelPicker.tsx';
import {ChoiceSelect} from '/src/renderer/ChoiceSelect.tsx';
import '/src/renderer/styles.css';
const f=window.__controls={listCalls:[],saves:[],busy:false,failList:false,failSave:false,selection:null,filter:'30',focusChanges:[]};
document.addEventListener('focusin',event=>{const node=event.target;f.focusChanges.push({tag:node.tagName,type:node.type,role:node.getAttribute('role'),label:node.getAttribute('aria-label')});f.focusChanges=f.focusChanges.slice(-20);});
f.models=[
 {id:'alpha',model:'alpha',name:'Alpha',description:'',isDefault:true,defaultEffort:'medium',efforts:['low','medium','high'].map(id=>({id,description:''}))},
 {id:'beta',model:'beta',name:'Beta',description:'',isDefault:false,defaultEffort:'high',efforts:['low','medium','high','future-effort'].map(id=>({id,description:''}))},
 {id:'basic',model:'basic',name:'Basic',description:'',isDefault:false,efforts:[]},
 {id:'single',model:'single',name:'Single',description:'',isDefault:false,efforts:[{id:'low',description:''}]},
];
window.workbench={async invoke(name,payload){
 if(name==='models:list'){f.listCalls.push(payload);if(f.failList)throw Error('unavailable');return f.models;}
 if(name==='settings:model'){
  await new Promise(resolve=>setTimeout(resolve,40));
  if(f.failSave)throw Error('保存失败，请重试');
  f.saves.push(payload);
  return {...f.settings,modelSelection:{model:payload.model,effort:payload.effort}};
 }
 throw Error('Unexpected '+name);
}};
function Fixture(){
 const [settings,setSettings]=useState({agent:'codex',modelSelection:{model:'alpha',effort:'medium'}});
 const [busy,setBusy]=useState(false),[filter,setFilter]=useState('30'),[connectionReady,setConnectionReady]=useState(false);
 f.setConnectionReady=setConnectionReady;
 f.settings=settings;f.selection=settings.modelSelection;f.busy=busy;f.setBusy=setBusy;f.setSettings=setSettings;f.filter=filter;
 return React.createElement('main',{className:'controls-fixture'},
  React.createElement('section',{className:'fixture-work'},
   React.createElement('h1',null,'今日工作'),
   React.createElement(ChoiceSelect,{label:'时间范围',value:filter,onChange:setFilter,options:[{value:'7',label:'最近 7 天'},{value:'30',label:'最近 30 天'},{value:'all',label:'全部记录'}]})),
  React.createElement('section',{className:'fixture-composer'},
   React.createElement('p',null,'描述任务，或选中页面中的元素…'),
   React.createElement(ModelPicker,{settings,busy,connectionReady,onChange:setSettings})),
 );
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`;
const fixture: Plugin = {
  name: 'interaction-controls-fixture',
  resolveId(id) {
    if (id === '/controls-entry.js') return '\0controls-entry';
  },
  load(id) {
    if (id === '\0controls-entry') return entry;
  },
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/') return next();
      response.setHeader('content-type', 'text/html');
      response.end(
        await server.transformIndexHtml(
          '/index.html',
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
.controls-fixture{height:100vh;max-width:620px;margin:auto;padding:32px 24px;display:flex;flex-direction:column;gap:24px}.fixture-work{display:grid;gap:18px}.fixture-work h1{font-size:21px;font-weight:550}.fixture-work>.choice-select{width:180px}.fixture-composer{margin-top:auto;border:1px solid var(--border);background:white;border-radius:18px;padding:20px 16px 12px}.fixture-composer p{margin:0 0 24px;color:var(--muted);font-size:12px}
</style><div id="root"></div><script type="module" src="/controls-entry.js"></script></html>`,
        ),
      );
    });
  },
};
const server = await createServer({
  configFile: false,
  root,
  appType: 'custom',
  logLevel: 'error',
  plugins: [react(), tailwindcss(), fixture],
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: uiBrowserExecutable(),
  headless: true,
  args: ['--use-mock-keychain', '--disable-sync'],
});
const checks: string[] = [];
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 780 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/`);
  await expect.poll(() => page.evaluate(() => (window as any).__controls.listCalls.length)).toBe(1);
  await expect(page.locator('.model-controls')).toHaveCount(0);
  checks.push('Model catalog loads before opening the chooser; reopening does not reconnect');
  const open = async () => {
    await page.getByRole('button', { name: '选择模型', exact: true }).click();
    await expect(page.locator('.model-controls')).toBeVisible();
  };
  const selected = () => page.evaluate(() => (window as any).__controls.selection);
  const models = page.getByRole('listbox', { name: '模型', exact: true });
  const modelOption = (name: string) => models.getByRole('option', { name, exact: true });
  await open();
  const button = await page.getByRole('button', { name: '选择模型', exact: true }).boundingBox();
  const popover = await page.locator('.model-controls').boundingBox();
  assert(button && popover && popover.y + popover.height <= button.y + 4);
  assert(button.y - (popover.y + popover.height) < 24);
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await page.screenshot({
    path: path.join(output, 'wide-model-controls.png'),
    animations: 'disabled',
  });
  await expect(modelOption('Alpha')).toHaveAttribute('aria-selected', 'true');
  await modelOption('Alpha').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(selected).toEqual({ model: 'beta', effort: 'high' });
  await expect(modelOption('Beta')).toHaveAttribute('aria-selected', 'true');
  const slider = page.getByRole('slider', { name: '推理强度', exact: true });
  await expect(slider).toHaveValue('2');
  await slider.focus();
  await page.keyboard.press('Home');
  await expect.poll(selected).toEqual({ model: 'beta', effort: 'low' });
  for (const effort of ['medium', 'high', 'future-effort']) {
    await expect(slider).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect.poll(selected).toEqual({ model: 'beta', effort });
  }
  // Saving disables the native range briefly; repeated keyboard edits must retain its focus.
  for (let index = 0; index < 6; index++) {
    await slider.press('Home');
    await expect.poll(selected).toEqual({ model: 'beta', effort: 'low' });
    await expect(slider).toBeFocused();
    await slider.press('End');
    await expect.poll(selected).toEqual({ model: 'beta', effort: 'future-effort' });
    await expect(slider).toBeFocused();
  }
  await expect(page.locator('.reasoning-heading output')).toHaveText('future-effort');
  await page.screenshot({ path: path.join(output, 'keyboard-focus.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '恢复默认推理强度', exact: true }).click();
  await expect.poll(selected).toEqual({ model: 'beta', effort: 'high' });
  await page.evaluate(() => {
    const f = (window as any).__controls;
    f.crests = 0;
    document.addEventListener('animationstart', (event) => {
      if (event.animationName === 'reasoning-crest') f.crests++;
    });
  });
  const track = await page.locator('.reasoning-slider .slider__track').boundingBox();
  const thumb = await page.locator('.reasoning-slider .slider__thumb').boundingBox();
  assert(track && thumb);
  const saveCount = () => page.evaluate(() => (window as any).__controls.saves.length);
  const beforeDrag = await saveCount();
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + 1, track.y + track.height / 2, { steps: 6 });
  await page.mouse.move(track.x + track.width - 1, track.y + track.height / 2, { steps: 12 });
  await expect(page.locator('.reasoning-heading output')).toHaveText('future-effort');
  await expect
    .poll(() => page.evaluate(() => (window as any).__controls.crests))
    .toBeGreaterThan(0);
  assert.equal(await saveCount(), beforeDrag);
  await page.mouse.up();
  await expect.poll(selected).toEqual({ model: 'beta', effort: 'future-effort' });
  assert.equal(await saveCount(), beforeDrag + 1);
  await page.getByRole('button', { name: '恢复默认推理强度', exact: true }).click();
  await expect.poll(selected).toEqual({ model: 'beta', effort: 'high' });
  checks.push(
    'Dragging previews each step, animates at the model maximum and commits once on release',
  );
  checks.push(
    'Every catalog effort, including a future value, is selected by keyboard and persisted; reset restores model default',
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('.model-controls')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toBeFocused();
  await open();
  assert.equal(await page.evaluate(() => (window as any).__controls.listCalls.length), 1);
  assert.deepEqual(await selected(), { model: 'beta', effort: 'high' });
  checks.push('Escape closes the anchored control and restores trigger focus');
  await page.evaluate(() => (window as any).__controls.setBusy(true));
  await expect(modelOption('Alpha')).toBeDisabled();
  await expect(slider).toBeDisabled();
  await page.evaluate(() => (window as any).__controls.setBusy(false));
  await expect(slider).toBeEnabled();
  assert.deepEqual(await selected(), { model: 'beta', effort: 'high' });
  await page.evaluate(() => {
    (window as any).__controls.failSave = true;
  });
  await slider.press('ArrowRight');
  await expect(page.getByRole('alert')).toHaveText('保存失败，请重试');
  await expect(slider).toHaveValue('2');
  assert.deepEqual(await selected(), { model: 'beta', effort: 'high' });
  checks.push('Busy tasks disable configuration; a failed save restores the confirmed value');
  await page.evaluate(() => {
    const f = (window as any).__controls;
    f.failSave = false;
    f.setSettings({ ...f.settings, modelSelection: { model: 'retired', effort: 'old' } });
  });
  await expect(models).toContainText('retired');
  await expect(slider).toHaveCount(0);
  await modelOption('Basic').click();
  await expect.poll(selected).toEqual({ model: 'basic' });
  await expect(slider).toHaveCount(0);
  await modelOption('Alpha').click();
  await expect.poll(selected).toEqual({ model: 'alpha', effort: 'medium' });
  await page.evaluate(() => {
    const f = (window as any).__controls;
    f.setSettings({ ...f.settings, modelSelection: { model: 'alpha', effort: 'retired-level' } });
  });
  await expect(slider).toHaveAttribute('aria-valuetext', /retired-level/);
  await slider.press('Home');
  await expect.poll(selected).toEqual({ model: 'alpha', effort: 'low' });
  await modelOption('Single').click();
  await expect(slider).toHaveCount(0);
  await page.getByRole('button', { name: '使用轻快', exact: true }).click();
  await expect.poll(selected).toEqual({ model: 'single', effort: 'low' });
  checks.push(
    'Unavailable models remain identifiable; a valid model recovers, and models without effort expose no artificial slider',
  );
  await page.evaluate(() => {
    const f = (window as any).__controls;
    f.setSettings({ ...f.settings, modelSelection: undefined });
  });
  await expect(page.locator('.model-control-status')).toHaveText('使用本机 CLI 默认配置');
  await expect(slider).toHaveCount(0);
  await expect(page.getByRole('button', { name: '选择模型', exact: true })).toContainText(
    '默认模型',
  );
  await expect(modelOption('Alpha')).toBeVisible();
  await expect(modelOption('Alpha')).not.toHaveAttribute('aria-selected', 'true');
  await modelOption('Alpha').click();
  await expect(slider).toHaveValue('1');
  await slider.press('End');
  await expect.poll(selected).toEqual({ model: 'alpha', effort: 'high' });
  const beforeReselect = await saveCount();
  await modelOption('Alpha').click();
  assert.equal(await saveCount(), beforeReselect);
  assert.deepEqual(await selected(), { model: 'alpha', effort: 'high' });
  await page.getByRole('button', { name: '刷新模型', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__controls.listCalls.at(-1)))
    .toEqual({ agent: 'codex', conversationId: undefined, refresh: true });
  await page.evaluate(() => {
    (window as any).__controls.failList = true;
  });
  await page.getByRole('button', { name: '刷新模型', exact: true }).click();
  const catalogError = page.getByText('无法读取模型目录，请刷新后重试。');
  await expect(catalogError).toBeVisible();
  const listCount = () => page.evaluate(() => (window as any).__controls.listCalls.length);
  const beforeRecovery = await listCount();
  await page.evaluate(() => (window as any).__controls.setConnectionReady(true));
  await expect.poll(listCount).toBe(beforeRecovery + 1);
  await expect(catalogError).toBeVisible();
  await page.evaluate(() => (window as any).__controls.setConnectionReady(false));
  await page.evaluate(() => {
    (window as any).__controls.failList = false;
    (window as any).__controls.setConnectionReady(true);
  });
  await expect(catalogError).toHaveCount(0);
  assert.equal(await listCount(), beforeRecovery + 2);
  checks.push(
    'A failed catalog read retries once per connection recovery, including after a failed retry',
  );
  checks.push(
    'Unselected CLI configuration is not replaced by the catalog default; explicit model selection enables its slider and refresh is requested explicitly',
  );
  await page.keyboard.press('Escape');
  await expect(page.locator('.model-controls')).toHaveCount(0);
  await page.locator('.fixture-work [data-slot="select-trigger"]').click();
  await page.getByRole('option', { name: '最近 7 天', exact: true }).click();
  assert.equal(await page.evaluate(() => (window as any).__controls.filter), '7');
  await expect(page.getByRole('listbox', { name: '时间范围', exact: true })).toHaveCount(0);
  const timeChoice = page.locator('button[data-choice-label="时间范围"]');
  await timeChoice.focus();
  await timeChoice.press('Enter');
  await expect(page.getByRole('listbox', { name: '时间范围', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: '时间范围', exact: true })).toHaveCount(0);
  await expect(timeChoice).toBeFocused();
  assert(
    await page
      .locator('select')
      .evaluateAll((nodes) => nodes.every((node) => !!node.closest('[aria-hidden="true"]'))),
  );
  checks.push(
    'Shared Select uses a styled listbox, supports keyboard open/Escape with restored focus; native selects are hidden helpers only',
  );
  await page.setViewportSize({ width: 375, height: 700 });
  await open();
  await page.screenshot({
    path: path.join(output, 'narrow-model-controls.png'),
    animations: 'disabled',
  });
  const narrow = await page.locator('.model-controls').boundingBox();
  assert(narrow && narrow.x >= 0 && narrow.x + narrow.width <= 375);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await slider.press('Home');
  await expect.poll(selected).toEqual({ model: 'alpha', effort: 'low' });
  await slider.press('End');
  await expect.poll(selected).toEqual({ model: 'alpha', effort: 'high' });
  await page.screenshot({ path: path.join(output, 'reduced-motion.png'), animations: 'disabled' });
  await expect(page.locator('.reasoning-slider .slider__thumb')).toHaveCSS(
    'transition-duration',
    '0s',
  );
  const ticks = page.locator('.reasoning-slider .reasoning-tick');
  assert.ok(await ticks.count());
  assert.ok(
    await ticks.evaluateAll((nodes) =>
      nodes.every((node) => getComputedStyle(node).animationName === 'none'),
    ),
  );
  checks.push(
    '375px layout fits the viewport; reduced motion preserves the highest level without animation',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify({ passed: true, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(
      {
        passed: false,
        checks,
        errors,
        error: String(error),
        focus: await browser
          .contexts()[0]
          ?.pages()[0]
          ?.evaluate(() => ({
            active: document.activeElement?.outerHTML,
            changes: (window as any).__controls.focusChanges,
          })),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
  await server.close();
}
