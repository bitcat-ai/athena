/** Real compact controls and ElementInspector layout; no browser page or model calls. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createServer, type Plugin } from 'vite';
import { uiBrowserExecutable } from './ui-browser';

const root = process.cwd();
const output = path.resolve(
  process.env.ATHENA_SELECT_LAYOUT_OUTPUT || 'test-results/select-layout',
);
await mkdir(output, { recursive: true });
const entry = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {HugeiconsIcon} from '@hugeicons/react';
import {Search01Icon} from '@hugeicons-pro/core-stroke-rounded';
import {ChoiceSelect} from '/src/renderer/ChoiceSelect.tsx';
import {ElementInspector} from '/src/renderer/ElementInspector.tsx';
import {InspectorSelect,InspectorInput} from '/packages/element-inspector/src';
import '/src/renderer/styles.css';
const options=[{value:'text',label:'文字'},{value:'selector',label:'CSS'}];
const f=window.__selectLayout={queries:[]};
const action=async(name,payload)=>{if(name==='browser:query'){f.queries.push(payload);return {elements:[],truncated:false};}return true;};
function Fixture(){
 const [choice,setChoice]=useState('text'),[inspector,setInspector]=useState('text');
 return React.createElement('main',{className:'select-layout-fixture'},
  React.createElement('section',{className:'compact-choice'},
   React.createElement('h2',null,'查找方式'),
   React.createElement('div',{className:'fixture-row'},React.createElement(HugeiconsIcon,{icon:Search01Icon,size:13,'aria-hidden':true}),
    React.createElement(ChoiceSelect,{label:'通用查找方式',value:choice,onChange:setChoice,options}))),
  React.createElement('section',{className:'compact-package element-inspector'},
   React.createElement('h2',null,'查找页面'),
   React.createElement('div',{className:'element-search'},React.createElement(HugeiconsIcon,{icon:Search01Icon,size:13,'aria-hidden':true}),
    React.createElement(InspectorSelect,{label:'组件查找方式',value:inspector,onChange:setInspector,options}),
    React.createElement(InspectorInput,{placeholder:'查找文字、标题或按钮'}))),
  React.createElement('section',{className:'actual-inspector'},
   React.createElement(ElementInspector,{tabId:'fixture',previews:[],onAction:action,onClose(){}})));
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
`;
const fixture: Plugin = {
  name: 'select-layout-fixture',
  resolveId(id) {
    if (id === '/select-layout-entry.js') return '\0select-layout-entry';
  },
  load(id) {
    if (id === '\0select-layout-entry') return entry;
  },
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url !== '/') return next();
      response.setHeader('content-type', 'text/html;charset=utf-8');
      response.end(
        await server.transformIndexHtml(
          '/index.html',
          `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
#root{overflow:auto}.select-layout-fixture{width:min(600px,100%);padding:20px 0;display:grid;gap:24px}.select-layout-fixture h2{font-size:13px;font-weight:500;margin:0 24px 10px}.fixture-row{display:flex;align-items:center;gap:8px;margin:0 24px;padding:5px 12px;width:130px;border-radius:12px;background:var(--surface-secondary)}.compact-choice .choice-select{flex:0 0 58px;width:58px}.compact-choice .choice-select .choice-select-trigger{font-size:11px;padding-left:3px;padding-right:15px;height:28px;min-height:28px;background:none;box-shadow:none}.actual-inspector{height:350px}.compact-package .element-search{width:calc(100% - 48px)}
</style><div id="root"></div><script type="module" src="/select-layout-entry.js"></script></html>`,
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
const samples: any[] = [],
  errors: string[] = [];
let passed = false;
try {
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/`);
    await page.evaluate('window.__name=fn=>fn');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [kind, label] of [
        ['common', '通用查找方式'],
        ['package', '组件查找方式'],
        ['actual', '元素查找方式'],
      ]) {
        const trigger = page.locator(`button[data-choice-label="${label}"]`);
        const popup = page.locator(
          kind === 'common' ? '.choice-select-popover' : '.ei-select-popup',
        );
        const checkGeometry = async (value: string) => {
          const metrics = await trigger.evaluate((node) => {
            const value = node.querySelector('[data-slot="select-value"], .ei-select-value')!;
            const arrow = node.querySelector('.select__indicator, .ei-select-chevron')!;
            const option = document.querySelector('[role="option"][aria-selected="true"]')!;
            const label = option.querySelector('.ei-option-label, span:first-child')!;
            const check = option.querySelector(
              '.ei-option-check, [data-slot="list-box-item-indicator"]',
            )!;
            const popup = document.querySelector('.choice-select-popover, .ei-select-popup')!;
            const rect = (element: Element) => {
              const r = element.getBoundingClientRect();
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                right: r.right,
                bottom: r.bottom,
              };
            };
            const range = document.createRange();
            range.selectNodeContents(value);
            const text = range.getBoundingClientRect();
            return {
              trigger: rect(node),
              value: {
                ...rect(value),
                clientHeight: value.clientHeight,
                scrollHeight: value.scrollHeight,
                text: { x: text.x, y: text.y, right: text.right, bottom: text.bottom },
              },
              arrow: rect(arrow),
              label: rect(label),
              check: rect(check),
              popup: rect(popup),
              viewport: { width: innerWidth, height: innerHeight },
            };
          });
          samples.push({ dpr, width, kind, selectedLabel: value, ...metrics });
          await page.screenshot({
            path: path.join(output, `${kind}-${value}-${width}-dpr${dpr}.png`),
            animations: 'disabled',
            clip: { x: 0, y: 0, width: Math.min(width, 620), height: 740 },
          });
          assert(
            metrics.value.clientHeight >= metrics.value.scrollHeight,
            `${kind} ${value}: text is vertically clipped`,
          );
          assert(
            metrics.value.text.y >= metrics.trigger.y - 1 &&
              metrics.value.text.bottom <= metrics.trigger.bottom + 1,
            `${kind} ${value}: text escapes trigger`,
          );
          assert(
            metrics.value.text.right <= metrics.arrow.x - 3,
            `${kind} ${value}: text overlaps arrow`,
          );
          assert(
            metrics.label.right <= metrics.check.x - 4,
            `${kind} ${value}: text overlaps selected checkmark`,
          );
          assert(
            metrics.popup.x >= 0 &&
              metrics.popup.right <= metrics.viewport.width &&
              metrics.popup.y >= 0 &&
              metrics.popup.bottom <= metrics.viewport.height,
            `${kind}: menu leaves viewport`,
          );
          assert(
            Math.abs(metrics.trigger.width - 58) < 1 && Math.abs(metrics.trigger.height - 28) < 1,
            `${kind}: fixture must exercise the real compact geometry`,
          );
        };
        for (const value of ['文字', 'CSS']) {
          await trigger.focus();
          await trigger.press('Enter');
          await expect(popup).toBeVisible();
          if ((await trigger.innerText()).trim() !== value) {
            await page.keyboard.press(value === '文字' ? 'Home' : 'End');
            await page.keyboard.press('Enter');
            await expect(popup).toHaveCount(0);
            await expect(trigger).toContainText(value);
            await expect(trigger).toBeFocused();
            await trigger.press('Enter');
            await expect(popup).toBeVisible();
          }
          await checkGeometry(value);
          await page.keyboard.press('Escape');
          await expect(popup).toHaveCount(0);
          await expect(trigger).toBeFocused();
        }
        if (kind === 'actual') {
          await page.getByRole('textbox', { name: '查找页面元素' }).fill('#target');
          await page.getByRole('button', { name: '查找', exact: true }).click();
          await expect
            .poll(() => page.evaluate(() => (window as any).__selectLayout.queries.at(-1)))
            .toEqual({ selector: '#target' });
        }
      }
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify({ passed, samples, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed, samples: samples.length, errors }));
  await browser.close();
  await server.close();
}
