import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';
import { uiBrowserExecutable } from './ui-browser';

const entry = `
import React, {useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {SkillComposer} from '/src/renderer/SkillComposer.tsx';
import {emptySkillDocument,serializeSkillDocument} from '/src/renderer/skill-composer-document.ts';
import '/src/renderer/theme.css';
import '/src/renderer/agent-experience.css';
const skills=['review','research'].map(name=>({name,description:name,userInvocable:true,source:'provider',provider:{id:'codex',name:'Codex'}}));
function Fixture(){const [doc,setDoc]=useState(emptySkillDocument);const [visible,setVisible]=useState(true);const [sent,setSent]=useState(null);const ref=useRef(null);return <main>
<button onClick={()=>setVisible(v=>!v)}>切换</button>
{visible&&<SkillComposer value={doc} skills={skills} selectedSkills={[]} editorRef={ref} discovery={{status:'ready',skills,source:'provider',provider:{id:'codex',name:'Codex'},diagnostics:[]}} onMenuOpenChange={()=>{}} placeholder="任务" onValueChange={setDoc} onSubmit={()=>setSent(serializeSkillDocument(ref.current.getJSON()))}/>}
<output>{JSON.stringify(sent)}</output></main>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const server = await createServer({ configFile: false, root: process.cwd(), appType: 'custom', logLevel: 'error', plugins: [react(), {
  name: 'fixture', resolveId(id) { if (id === '/entry.jsx') return id; },
  load(id) { if (id === '/entry.jsx') return { code: entry, map: null }; },
  configureServer(s) { s.middlewares.use(async (req, res, next) => {
    if (req.url !== '/') return next();
    res.setHeader('content-type', 'text/html');
    res.end(await s.transformIndexHtml('/', '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/entry.jsx"></script>'));
  }); },
}], server: { host: '127.0.0.1', port: 0 } });
await server.listen();
const browser = await chromium.launch({ executablePath: uiBrowserExecutable(), headless: true, args: ['--disable-browseros-server'] });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 500 } });
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/`);
  const input = page.getByRole('textbox', { name: '发送给 Agent 的任务' });
  const menu = page.getByRole('listbox', { name: '可用 Skill' });
  await input.fill('请检查 /re');
  await expect(menu).toBeVisible();
  await input.press('ArrowDown');
  await input.press('Tab');
  await expect(input.locator('[data-skill-name="research"]')).toBeVisible();
  await expect(menu).toHaveCount(0);
  assert.equal(await input.evaluate((el) => document.activeElement === el), true);
  await input.press('End');
  await page.keyboard.insertText('正文');
  await input.press('Enter');
  await expect(page.locator('output')).toContainText('"names":["research"]');
  await expect(page.locator('output')).toContainText('"text":"请检查  正文"');
  await page.getByRole('button', { name: '切换', exact: true }).click();
  await page.getByRole('button', { name: '切换', exact: true }).click();
  await expect(input.locator('[data-skill-name="research"]')).toBeVisible();
  await input.fill('前文 /rev 后文');
  await input.evaluate((element) => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(element.querySelector('p')!.firstChild!, 7);
    range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
  });
  await input.press('ArrowLeft');
  await expect(menu).toBeVisible();
  await input.press('Tab');
  await expect(input.locator('[data-skill-name="review"]')).toBeVisible();
  await expect(input).toContainText('后文');
  await input.fill('https://example.com/re');
  await expect(menu).toHaveCount(0);
  await input.fill('/tmp/file');
  await expect(menu).toHaveCount(0);
  await input.fill('/');
  await expect(menu).toBeVisible();
  await input.press('Escape');
  await expect(menu).toHaveCount(0);
  console.log('PASS: real SkillComposer inline trigger, Tab, atom, send serialization, remount, cursor suffix, URL/path and Escape; no model calls');
} finally { await browser.close(); await server.close(); }
