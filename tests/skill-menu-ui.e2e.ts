import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';
import { uiBrowserExecutable } from './ui-browser';

const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SkillSlashMenu} from '/src/renderer/App.tsx';
const skills=[
 {name:'review',description:'Review code',availability:'usable',source:'workspace',packagePath:'',entryPath:'',diagnostics:[]},
 {name:'research',description:'Research a topic',availability:'usable',source:'workspace',packagePath:'',entryPath:'',diagnostics:[]},
];
function Fixture(){const [draft,setDraft]=useState('');const [dismissed,setDismissed]=useState(false);const [active,setActive]=useState(0);const open=!dismissed && /^(?:\\/[a-z0-9-]+\\s+)*\\/[^\\s/]*$/i.test(draft);const textarea=React.createElement('textarea',{ 'aria-label':'任务',value:draft,onChange:e=>{setDraft(e.target.value);setDismissed(false)},onKeyDown:e=>{if(!open)return;if(e.key==='Escape'){e.preventDefault();setDismissed(true)}if(e.key==='ArrowDown'){e.preventDefault();setActive(i=>Math.min(1,i+1))}if(e.key==='ArrowUp'){e.preventDefault();setActive(i=>Math.max(0,i-1))}if(e.key==='Enter'){e.preventDefault();const s=skills[active];setDraft('/'+s.name+' ');setDismissed(true)}}});const menu=open?React.createElement(SkillSlashMenu,{draft,skills,selected:[],activeIndex:active,onActiveChange:setActive,onSelect:s=>{setDraft('/'+s.name+' ');setDismissed(true)}}):null;return React.createElement('main',null,textarea,menu)}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const server = await createServer({ configFile:false, root:process.cwd(), appType:'custom', logLevel:'error', plugins:[react(), {name:'fixture',resolveId(id){if(id==='/entry.jsx')return id},load(id){if(id==='/entry.jsx')return {code:entry, map:null}},configureServer(s){s.middlewares.use(async (req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end(await s.transformIndexHtml('/', '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/entry.jsx"></script>'))})}}], server:{host:'127.0.0.1',port:0} });
await server.listen();
const browser=await chromium.launch({executablePath:uiBrowserExecutable(),headless:true,args:['--disable-browseros-server']});
try { const page=await browser.newPage({viewport:{width:390,height:500}}); await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as {port:number}).port}/`); const input=page.getByRole('textbox',{name:'任务'});
 await input.fill('/'); await expect(page.getByRole('listbox',{name:'可用 Skill'})).toBeVisible();
 await input.press('Escape'); await expect(page.getByRole('listbox',{name:'可用 Skill'})).toHaveCount(0); await expect(input).toHaveValue('/'); await input.type('r'); await expect(page.getByRole('listbox',{name:'可用 Skill'})).toBeVisible(); await expect(page.getByRole('option',{name:/review/})).toBeVisible();
 await input.press('ArrowDown'); await expect(page.getByRole('option',{name:/research/})).toHaveAttribute('aria-selected','true'); await input.press('Enter'); await expect(input).toHaveValue('/research '); await expect(page.getByRole('listbox',{name:'可用 Skill'})).toHaveCount(0); assert.equal(await input.evaluate(el=>document.activeElement===el),true);
 console.log('skill menu renderer interactions passed');
} finally {await browser.close(); await server.close();}
