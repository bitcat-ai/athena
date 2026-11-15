import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { seedLegacyWorkspace } from './legacy-workspace-fixture';
const root = process.cwd();
const dir = await mkdtemp(path.join(root, '.runtime/element-ui-'));
await seedLegacyWorkspace(path.join(dir, 'data'));
const site = createServer((req, res) => {
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(
    '<!doctype html><meta charset="utf-8"><title>工作计划</title><style>body{font:16px system-ui;margin:40px;color:#202735;background:#f8fafc}h1{font-size:30px}p{color:#6b7483;line-height:1.8}.action{display:inline-block;padding:18px 32px;color:white;background:#336699;border-radius:8px;cursor:pointer;margin:16px 12px 0 0}</style><h1>下一步，从这里开始</h1><p>整理今天的计划，专注最重要的一件事。</p><div role="button" tabindex="0" id="target" class="action" onclick="this.textContent=\'已点击\'">开始整理</div><div role="button" tabindex="0" id="decoy" class="action">开始整理</div>' +
      '<output id="shortcut-count" style="display:block">0</output>' +
      '<script>document.addEventListener("keydown",event=>{if(event.key.toLowerCase()==="k"){const counter=document.getElementById("shortcut-count");counter.textContent=String(Number(counter.textContent)+1);}});</script>',
  );
});
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${(site.address() as any).port}`;
const packaged = process.env.ATHENA_TEST_APP;
const app = await electron.launch({
  ...(packaged ? { executablePath: packaged } : {}),
  args: packaged ? [] : [path.join(root, 'tests/electron-background.cjs')],
  cwd: packaged ? dir : root,
  env: { ...process.env, WORKBENCH_USER_DATA_DIR: path.join(dir, 'data') },
});
const errors: string[] = [];
try {
  const page = await app.firstWindow();
  await page.addLocatorHandler(
    page
      .getByRole('region', { name: '工作台提示', exact: true })
      .filter({ hasText: 'Codex CLI 有新版本' })
      .getByRole('button', { name: '收起提醒', exact: true }),
    async (button) => {
      await button.click();
    },
  );
  await page.evaluate('window.__name = (fn) => fn');
  page.on('pageerror', (e) => errors.push(e.message));
  if (packaged) {
    page.on('console', (message) => {
      if (message.text().startsWith('WEB_STATE ')) console.log(message.text());
    });
    await page.evaluate(() =>
      window.workbench.onEvent((event) => {
        if (event.type === 'web:state') console.log('WEB_STATE ' + JSON.stringify(event.state));
      }),
    );
  }
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.setBackgroundThrottling(false);
    w.hide();
  });
  const state = () => page.evaluate(() => window.workbench.invoke<any>('app:snapshot'));
  await expect.poll(async () => (await state()).browser.status, { timeout: 30000 }).toBe('ready');
  if (packaged) {
    const deadline = Date.now() + 150000;
    let native;
    do {
      native = (await state()).web;
      if (native?.status === 'ready' || native?.status === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(native.status, 'ready', native.error);
  }
  await page.getByRole('button', { name: '展开浏览器', exact: true }).click();
  await page.evaluate((url) => window.workbench.invoke('browser:navigate', { url }), url);
  await expect(page.locator('.frame-loading')).toHaveCount(0);
  const geometry = () =>
    page.evaluate(async () => {
      const box = document.querySelector('.browser-surface')!.getBoundingClientRect();
      const state = await window.workbench.invoke<any>('app:snapshot');
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        frameWidth: state.browserFrame.width,
        frameHeight: state.browserFrame.height,
      };
    });
  await expect
    .poll(() => page.locator('.browser-pane').evaluate((node) => getComputedStyle(node).transform))
    .toBe('matrix(1, 0, 0, 1, 0, 0)');
  await page
    .locator('.browser-drawer')
    .evaluate(async (node) =>
      Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {}))),
    );
  const before = await geometry();
  await page.screenshot({ path: path.join(root, 'test-results/inspector-layout-before.png') });
  const readShortcutCount = () =>
    page.evaluate(async () => {
      const result = await window.workbench.invoke<any>('browser:query', {
        selector: '#shortcut-count',
      });
      return result.elements[0]?.text;
    });
  const browserKeyboard = page.locator('.browser-keyboard');
  await browserKeyboard.focus();
  await expect(browserKeyboard).toBeFocused();
  // The plain key proves that the fixture observes real forwarded page input.
  await page.keyboard.press('k');
  await expect.poll(readShortcutCount).toBe('1');
  await page.keyboard.press('Meta+k');
  const searchDialog = page.getByRole('dialog', { name: '搜索对话', exact: true });
  await expect(searchDialog).toBeVisible();
  const preserveShortcutFailure = async (error: unknown) => {
    const evidence = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        activeElement: active
          ? {
              tag: active.tagName,
              id: active.id,
              role: active.getAttribute('role'),
              label: active.getAttribute('aria-label'),
              placeholder: active.getAttribute('placeholder'),
              className: active.className,
            }
          : null,
        searchPresent: Boolean(document.querySelector('.conversation-search')),
      };
    });
    await writeFile(
      path.join(root, 'test-results/inspector-shortcut-failure.json'),
      JSON.stringify({ passed: false, ...evidence, error: String(error) }, null, 2),
    );
    await page.screenshot({ path: path.join(root, 'test-results/inspector-shortcut-failure.png') });
    throw error;
  };
  await expect(searchDialog.getByPlaceholder('搜索当前工作区的对话'))
    .toBeFocused()
    .catch(preserveShortcutFailure);
  assert.equal(await readShortcutCount(), '1', 'Cmd+K must not reach the embedded page');
  await page.keyboard.press('Escape');
  await expect(searchDialog).toHaveCount(0).catch(preserveShortcutFailure);
  assert.equal(await readShortcutCount(), '1', 'Closing search must not release a queued K');
  assert.deepEqual(await geometry(), before, 'Application search must not resize the browser');
  const applicationShortcut = {
    shortcut: 'Cmd+K',
    focusedSurface: 'browser-keyboard',
    plainKeyCount: 1,
    afterApplicationShortcut: Number(await readShortcutCount()),
    openedApplicationSearch: true,
    searchInputFocused: true,
    escapeClosedSearch: true,
  };
  await page.getByRole('textbox', { name: '发送给 Agent 的任务' }).fill('保留这段草稿 ');
  const target = await page.evaluate(async () => {
    const result = await window.workbench.invoke<any>('browser:query', { selector: '#target' });
    return result.elements[0];
  });
  await page.getByRole('button', { name: '选取元素', exact: true }).click();
  await page.mouse.click(
    before.x + ((target.bounds.x + target.bounds.width / 2) * before.width) / before.frameWidth,
    before.y + ((target.bounds.y + target.bounds.height / 2) * before.height) / before.frameHeight,
  );
  await page.getByRole('button', { name: '元素检查器', exact: true }).click();
  await expect(page.getByRole('slider', { name: '圆角滑块' })).toBeVisible();
  const after = await geometry();
  assert.deepEqual(
    after,
    before,
    'Selecting and opening the inspector must not change the browser surface or native viewport',
  );
  assert.equal(await page.locator('.browser-pane .element-inspector').count(), 0);
  await expect(page.getByRole('tab', { name: '元素', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('heading', { name: '外观', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, 'test-results/inspector-layout-wide.png') });
  const selected = (await state()).browser.selectedElement;
  assert.equal(selected.text, '开始整理', 'Picking must not activate the div button');
  await page.getByRole('tab', { name: '内容', exact: true }).click();
  await page.getByRole('textbox', { name: '元素文字', exact: true }).fill('我的开始按钮');
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  assert.deepEqual(await geometry(), before);
  await expect(page.getByRole('textbox', { name: '发送给 Agent 的任务' })).toBeVisible();
  await page.getByRole('button', { name: '元素检查器', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '元素文字', exact: true })).toHaveValue(
    '我的开始按钮',
  );
  await page.getByRole('button', { name: '关闭元素检查器', exact: true }).click();
  await page.getByRole('button', { name: '元素检查器', exact: true }).click();
  assert.deepEqual(await geometry(), before);
  await expect(page.getByRole('textbox', { name: '元素文字', exact: true })).toHaveValue(
    '我的开始按钮',
  );
  await page.getByRole('button', { name: '应用预览', exact: true }).click();
  await expect
    .poll(async () => (await state()).browser.selectedElement.textContent)
    .toBe('我的开始按钮');
  await page.getByRole('tab', { name: '调整', exact: true }).click();
  const radius = page.getByRole('slider', { name: '圆角滑块' });
  await radius.focus();
  await page.keyboard.press('ArrowRight');
  await radius.blur();
  await expect
    .poll(async () => (await state()).browser.selectedElement.computed['border-radius'])
    .toBe('9px');
  assert.deepEqual(await geometry(), before);
  await page.getByRole('button', { name: '撤销页面修改', exact: true }).click();
  await expect
    .poll(async () => (await state()).browser.selectedElement.computed['border-radius'])
    .toBe('8px');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1060, 720));
  await expect(page.locator('.frame-loading')).toHaveCount(0);
  await expect
    .poll(async () => {
      const g = await geometry();
      return Math.abs(g.width - g.frameWidth) + Math.abs(g.height - g.frameHeight);
    })
    .toBeLessThanOrEqual(2);
  await page
    .locator('.browser-drawer')
    .evaluate(async (node) =>
      Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => {}))),
    );
  const narrow = await geometry();
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  assert.deepEqual(await geometry(), narrow);
  await page.getByRole('button', { name: '元素检查器', exact: true }).click();
  assert.deepEqual(await geometry(), narrow);
  await page.getByRole('tab', { name: '元素', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: '对话', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '元素', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  assert.deepEqual(await geometry(), narrow);
  const overflow = await page
    .locator('.element-inspector')
    .evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth }));
  assert(overflow.scroll <= overflow.width + 1);
  await page.screenshot({ path: path.join(root, 'test-results/inspector-layout-narrow.png') });
  await page.getByRole('button', { name: '修改源码', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: '对话', exact: true, includeHidden: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: '发送给 Agent 的任务' })).toContainText(
    '保留这段草稿',
  );
  await expect(page.locator('.composer .element-token')).toContainText('我的开始按钮');
  assert.equal((await state()).browser.selectedElement.ref, selected.ref);
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    browserBefore: before,
    browserWithInspector: after,
    narrowBrowser: narrow,
    overflow,
    applicationShortcut,
    checks: [
      'Cmd+K opens application search without forwarding K to the focused embedded page',
      'Viewport and hit coordinates stay unchanged on selection, tab switch, close/reopen and edits',
      'Draft survives switching between conversation and inspector',
      'Live edit and undo keep exact selected node',
      'Source handoff returns to conversation with the draft',
      'Wide and minimum window layouts stay inside their containers',
    ],
    errors,
  };
  await writeFile(
    path.join(root, 'test-results/inspector-layout.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await app.close();
  await new Promise<void>((r) => site.close(() => r()));
  await rm(dir, { recursive: true, force: true });
}
