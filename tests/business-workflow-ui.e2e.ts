/** Isolated presentation checks; no model, repository push or external messages. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { uiBrowserExecutable } from './ui-browser';
import { readTaskSkill } from '../src/main/task-skills';

const output = path.resolve('test-results/business-workflow-ui');
await mkdir(output, { recursive: true });
const skill = await readTaskSkill(
  path.resolve('resources/skills'),
  'workbench_skill_read',
  { name: 'business-context' },
  new AbortController().signal,
);
const prd =
  '# 客户续约材料批量导出\n\n状态：需求已记录，等待源码实现与验收。\n\n## 用户原始要求\n\n为本月待续约客户整理材料。\n\n## 功能范围\n\n1. 勾选客户后按客户编号建立独立目录。\n2. 缺失或过期材料单独列入核对清单。\n\n## 验收条件\n\n1. 客户资料不能串包。\n2. 不包含内部跟进。\n\n## 参考资料\n\n[操作手册](https://example.test/handbook)\n\n## 页面预览证据\n\n```json\n{"selector":"button[data-export]","ref":"actual-ref"}\n```\n';
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AssistantTurn} from '/src/renderer/AssistantTurn.tsx';
import '/src/renderer/styles.css';
const message={id:'turn',role:'assistant',text:'',createdAt:Date.now(),status:'done',tools:[
 {id:'skill',name:'workbench_skill_read',input:{name:'business-context'},status:'done',output:${JSON.stringify(skill.text)}},
 {id:'mcp',name:'workbench_repository_resolve',input:{module:'customers'},status:'done',output:JSON.stringify({application:'meridian-crm',module:'customers',repository:'https://example.test/team/customer-operations-workspace.git',components:{frontend:{root:'frontend'},backend:{root:'backend'}},baseCommit:'1234567890',targetBranch:'demo/customer-material-review'})}
],execution:[{id:'prd',kind:'artifact',taskId:'turn',at:Date.now(),status:'succeeded',artifact:{path:'/requirements/PRD-1.md',bytes:100,sha256:'fixture'}}]};
window.fixture={message,fail:false,reads:0};
function render(){createRoot(document.getElementById('root')).render(React.createElement('main',{style:{padding:'36px',maxWidth:'680px',margin:'auto',height:'100%',overflow:'auto'}},React.createElement(AssistantTurn,{message,conversationId:'fixture',agent:'claude',requests:[],last:true,busy:false,onAction:async(action)=>{if(action==='artifact:read'){window.fixture.reads++;if(window.fixture.fail)throw Error('产物内容已变化，请先核对文件');return {name:'PRD-1.md',text:${JSON.stringify(prd)}};}},onShowBrowser:()=>{}},React.createElement('p',null,'当前页面是客户运营工作台。已核对业务手册与仓库映射。'))));}
render();`;
const fixture: Plugin = {
  name: 'business-ui',
  resolveId: (id) => (id === '/business-entry.js' ? '\0business-entry' : undefined),
  load: (id) => (id === '\0business-entry' ? entry : undefined),
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/') return next();
      res.setHeader('content-type', 'text/html');
      res.end(
        await server.transformIndexHtml(
          '/index.html',
          '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/business-entry.js"></script>',
        ),
      );
    });
  },
};
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: path.join(output, '.vite-cache'),
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: { entries: ['src/renderer/main.tsx'] },
  plugins: [react(), tailwindcss(), fixture],
  appType: 'custom',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
});
await server.listen();
const browser = await chromium.launch({
  executablePath: uiBrowserExecutable(),
  headless: true,
  args: [
    '--disable-browseros-server',
    '--disable-browseros-server-updater',
    '--disable-browseros-extensions',
    '--use-mock-keychain',
    '--disable-sync',
  ],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    reducedMotion: 'reduce',
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript('window.__name = fn => fn');
  await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`);
  await expect(page.locator('.integration-card')).toHaveCount(2);
  await expect(page.locator('[data-kind="skill"]')).toContainText('业务领域核对');
  await expect(page.locator('[data-kind="mcp"]')).toContainText('frontend');
  await expect(page.locator('.act-body')).toHaveCount(0);
  await page.screenshot({ path: path.join(output, 'skill-mcp-artifact.png') });
  await page.getByRole('button', { name: '查看 PRD', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '需求文档', exact: true });
  await expect(
    dialog.getByRole('heading', { name: '客户续约材料批量导出', exact: true }),
  ).toBeVisible();
  await expect(dialog.locator('.prd-evidence')).not.toHaveAttribute('open', '');
  await dialog.getByRole('button', { name: /03.*验收条件/ }).click();
  await expect(dialog.locator('[data-prd-section]').nth(2)).toBeFocused();
  await page.screenshot({ path: path.join(output, 'prd-reader.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  const foreground = await dialog
    .locator('.prd-document-content')
    .evaluate((node) => getComputedStyle(node).color);
  await expect
    .poll(() =>
      dialog
        .locator('.prd-document-content li')
        .first()
        .evaluate((node) => getComputedStyle(node).color),
    )
    .toBe(foreground);
  await page.setViewportSize({ width: 1060, height: 700 });
  await page.screenshot({ path: path.join(output, 'prd-reader-dark-narrow.png') });
  assert(
    await dialog.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }),
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.evaluate('window.fixture.fail=true');
  await page.getByRole('button', { name: '查看 PRD', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('产物内容已变化');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: visible Skill/MCP knowledge, PRD reader, directory navigation, dark/narrow layout and read failure',
  );
} finally {
  await browser.close();
  await server.close();
}
