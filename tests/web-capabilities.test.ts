/** Real pinned daemon and owned Chrome; no model requests or personal browser data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { liveWeb, refOf, webFixture, type WebFixture } from './web-fixture';

const options = { skip: !liveWeb, timeout: 120000 };
const log = (f: WebFixture) => f.state(`document.querySelector('#log').textContent`);
const box = (f: WebFixture, selector: string) =>
  f.state(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: Math.round(r.x), top: Math.round(r.y), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
  );

test('observation tools read the page, its frames and its changes', options, async () => {
  const f = await webFixture();
  try {
    const { page } = await f.begin('observe');
    const full = await f.call('neo_snapshot', { page });
    assert.match(full.text, /UNTRUSTED_PAGE_CONTENT/);
    assert.match(full.text, /Athena observationId: [a-f0-9-]+/);
    const name = refOf(full.text, 'Name');
    refOf(full.text, 'Email');
    assert.match(full.text, /Confirm contact/, 'same-origin frame content is inline');

    const interactive = await f.call('neo_snapshot', { page, mode: 'interactive' });
    assert.equal(refOf(interactive.text, 'Name'), name, 'an unchanged element keeps its ref');
    assert(/Bottom marker/.test(full.text) && !/Bottom marker/.test(interactive.text));
    assert(interactive.text.length < full.text.length);
    const shallow = await f.call('neo_snapshot', { page, depth: 1 });
    assert(shallow.text.split('\n').length < full.text.split('\n').length);

    assert.match((await f.call('neo_diff', { page })).text, /页面没有变化/);
    await f.call('neo_act', {
      page,
      kind: 'click',
      ref: refOf(full.text, 'Load later'),
      diff: 'none',
    });
    assert.match(
      (await f.call('neo_wait', { page, for: 'selector', value: '#late', timeout: 5000 })).text,
      /matched selector "#late"/,
    );
    const diff = await f.call('neo_diff', { page });
    assert.match(diff.text, /页面变化：\+\d+ -\d+/);
    assert.match(diff.text, /\+ .*Arrived later/);

    const markdown = await f.call('neo_read', { page });
    assert.match(markdown.text, /Bottom marker/);
    assert.match(markdown.text, /unconfirmed/, 'frame text is part of the page content');
    assert.match(markdown.text, /Athena observationId: /);
    const scoped = await f.call('neo_read', { page, format: 'text', selector: '#bottom' });
    assert.match(scoped.text, /Bottom marker/);
    assert(!scoped.text.includes('Hover target'));
    assert.match((await f.call('neo_read', { page, format: 'links' })).text, /\/popup/);
    const output = await f.call('neo_read', { page, format: 'console' });
    assert.match(output.text, /lab ready/);
    assert.match(output.text, /lab warning/);
    const visible = await f.call('neo_read', { page, format: 'text', viewportOnly: true });
    assert.match(visible.text, /Hover target/);
    assert(!visible.text.includes('Bottom marker'));
    const absent = await f.runtime.callTool('neo_read', { page, selector: '#nothing-here' });
    assert(absent.isError);
    assert.match(absent.text, /没有元素匹配该选择器/);

    const located = await f.call('neo_grep', { page, pattern: 'confirm contact' });
    assert.match(located.text, /button "Confirm contact" \[.*ref=ab[a-f0-9]{8}:e\d+/);
    assert.match(
      (await f.call('neo_grep', { page, pattern: 'bottom m', over: 'content' })).text,
      /\d+: Bottom marker/,
    );
    assert.match(
      (await f.call('neo_grep', { page, pattern: 'button', limit: 1 })).text,
      /只显示前 1 处匹配。/,
    );
    assert.match((await f.call('neo_grep', { page, pattern: 'zz-not-on-page' })).text, /没有匹配/);
    const invalid = await f.runtime.callTool('neo_grep', { page, pattern: '(' });
    assert.match(invalid.text, /正则表达式无效/);
    const runaway = await f.runtime.callTool('neo_grep', {
      page,
      pattern: '(a+)+$',
      over: 'content',
    });
    assert.match(runaway.text, /正则匹配超时/);

    const shot = await f.call('neo_screenshot', { page });
    assert.match(shot.images![0], /^data:image\/jpeg;base64,/);
    const [, width, height] = shot.text.match(/截图 (\d+)×(\d+)/)!.map(Number);
    assert(width > 100 && height > 100);
    const whole = await f.call('neo_screenshot', { page, format: 'png', fullPage: true });
    assert.match(whole.images![0], /^data:image\/png;base64,/);
    assert(Number(whole.text.match(/×(\d+)/)![1]) > height);
    const small = await f.call('neo_screenshot', { page, size: { width: 200, height: 200 } });
    assert(Number(small.text.match(/截图 (\d+)×/)![1]) <= 200);
    const marked = await f.call('neo_screenshot', { page, annotate: true });
    assert.match(marked.text, /标注截图 \d+×\d+，共 \d+ 个元素/);
    const count = marked.text.match(/\[\d+\] button "Count" ref=(ab[a-f0-9]{8}:e\d+)/)?.[1];
    assert(count, marked.text);
    assert.equal(await f.state(`!!document.getElementById('__athena_marks')`), false);
    await f.call('neo_act', { page, kind: 'click', ref: count, diff: 'none' });
    assert.equal(await log(f), 'count 1 detail 1');

    const pdf = await f.call('neo_pdf', { page });
    assert.match(pdf.text, /Athena verified artifact: /);
    const saved = pdf.text.match(/Saved PDF to: (.+)/)![1];
    assert.equal((await readFile(saved)).subarray(0, 4).toString(), '%PDF');

    assert.match((await f.call('neo_wait', { page, value: 50 })).text, /waited 50ms/);
    assert.match(
      (await f.call('neo_wait', { page, for: 'text', value: 'Arrived later' })).text,
      /matched text "Arrived later"/,
    );
    const missed = await f.runtime.callTool('neo_wait', {
      page,
      for: 'text',
      value: 'never-published-marker',
      timeout: 300,
    });
    assert(missed.isError);
    assert.match(missed.text, /timed out after 300ms waiting for text/);
    assert.match(missed.text, /等待条件未匹配/);
    const blocked = await f.runtime.callTool('neo_act', { page, kind: 'click', ref: count });
    assert.match(blocked.text, /尚未核对/);
    await f.recover(page, 'Arrived later');
    await f.call('neo_act', { page, kind: 'click', ref: count, diff: 'none' });
    assert.equal(await log(f), 'count 2 detail 1');
    await f.runtime.finishTask('observe');
  } finally {
    await f.cleanup();
  }
});

test(
  'act covers element, keyboard, pointer and coordinate input with read-back',
  options,
  async () => {
    const f = await webFixture();
    try {
      const { page } = await f.begin('act');
      const act = (args: Record<string, unknown>) => f.call('neo_act', { page, ...args });
      const value = (selector: string) =>
        f.state(`document.querySelector(${JSON.stringify(selector)}).value`);
      const snap = (await f.call('neo_snapshot', { page })).text;
      const name = refOf(snap, 'Name');
      const secret = refOf(snap, 'Secret');
      const count = refOf(snap, 'Count');

      let done = await act({ kind: 'fill', ref: name, value: 'Ada' });
      assert.match(done.text, /^已执行 fill/);
      assert(done.text.includes(`${name}：当前值 "Ada"`), done.text);
      await act({ kind: 'fill', ref: name, value: ' Lovelace', clear: false });
      assert.equal(await value('#name'), 'Ada Lovelace');
      done = await act({ kind: 'fill', ref: secret, value: 'hunter2-secret', sensitive: true });
      assert.match(done.text, /值已隐藏，回读一致/);
      assert(!done.text.includes('hunter2-secret'));
      assert.equal(await value('#secret'), 'hunter2-secret');

      done = await act({
        kind: 'fill',
        fields: [
          { ref: name, value: 'Grace' },
          { ref: refOf(snap, 'Email'), value: 'grace@example.com' },
        ],
        diff: 'summary',
      });
      assert(done.text.includes(`${name}：当前值 "Grace"`), done.text);
      assert.match(done.text, /当前值 "grace@example.com"/);
      assert(!done.text.includes('UNTRUSTED_PAGE_CONTENT'), 'summary carries no tree');
      await act({ kind: 'click', ref: refOf(snap, 'Confirm contact'), diff: 'none' });
      assert.equal(
        await f.state(
          `document.querySelector('iframe').contentDocument.querySelector('#state').textContent`,
        ),
        'confirmed grace@example.com',
      );

      await act({ kind: 'type', ref: name, text: '!' });
      assert.equal(await value('#name'), 'Grace!');
      await act({ kind: 'focus', ref: secret });
      assert.equal(await f.state('document.activeElement.id'), 'secret');
      await act({ kind: 'type', text: 'x', diff: 'none' });
      assert.equal(await value('#secret'), 'hunter2-secretx');
      await act({ kind: 'press', key: 'Backspace', diff: 'none' });
      assert.equal(await value('#secret'), 'hunter2-secret');
      await act({ kind: 'press', ref: name, key: 'Backspace' });
      assert.equal(await value('#name'), 'Grace');
      const field = await box(f, '#name');
      await act({ kind: 'type_at', x: field.x, y: field.y, text: 'Linus', clear: true });
      assert.equal(await value('#name'), 'Linus');

      done = await act({ kind: 'check', ref: refOf(snap, 'Agree') });
      assert.match(done.text, /当前值 true/);
      assert.equal(await f.state(`document.querySelector('#agree').checked`), true);
      done = await act({ kind: 'uncheck', ref: refOf(snap, 'Agree') });
      assert.match(done.text, /当前值 false/);
      done = await act({ kind: 'select', ref: refOf(snap, 'Plan'), value: 'pro' });
      assert.match(done.text, /当前值 "pro"/);
      assert.equal(await value('#plan'), 'pro');

      await act({ kind: 'hover', ref: refOf(snap, 'Hover target') });
      assert.equal(await log(f), 'hovered');
      done = await act({ kind: 'click', ref: count });
      assert.equal(await log(f), 'count 1 detail 1');
      assert.match(done.text, /页面变化：\+\d+ -\d+/);
      assert.match(done.text, /count 1 detail 1/);
      await act({ kind: 'click', ref: count, clickCount: 2 });
      assert.equal(await log(f), 'double');
      await act({ kind: 'click', ref: count, button: 'right' });
      assert.equal(await log(f), 'context');
      await act({ kind: 'click', ref: count, clickCount: 3 });
      assert.match(await log(f), /detail 3$/);
      done = await act({ kind: 'click', ref: count, diff: 'none' });
      assert.equal(done.text, '已执行 click');
      done = await act({ kind: 'click', ref: count, diff: 12 });
      assert.match(done.text, /（已截断）/);

      const pad = await box(f, '#pad');
      await act({ kind: 'click_at', x: pad.x, y: pad.y });
      assert.match(await log(f), /^up \d+,\d+ moves false$/);
      await act({ kind: 'hover_at', x: pad.left + 10, y: pad.top + 10 });
      assert.deepEqual(await f.state('window.__hover'), [10, 10]);
      await act({
        kind: 'drag_at',
        startX: pad.left + 20,
        startY: pad.top + 20,
        endX: pad.left + 200,
        endY: pad.top + 90,
      });
      assert.equal(await log(f), 'up 200,90 moves true');
      await act({ kind: 'drag', ref: refOf(snap, 'Card'), targetRef: refOf(snap, 'Bin') });
      assert.equal(await log(f), 'dropped card');

      await act({ kind: 'scroll', direction: 'down', amount: 10, diff: 'none' });
      const lowered = await f.state('window.scrollY');
      assert(lowered >= 900, `scrolled to ${lowered}`);
      await act({ kind: 'scroll', direction: 'up', amount: 4, x: 300, y: 300, diff: 'none' });
      const raised = await f.state('window.scrollY');
      assert(raised < lowered, `wheel moved from ${lowered} to ${raised}`);
      await act({ kind: 'scroll', ref: name, diff: 'none' });
      const top = (await box(f, '#name')).top;
      assert(top >= 0 && top < (await f.state('window.innerHeight')), `Name is at ${top}`);

      const stale = await f.runtime.callTool('neo_act', {
        page,
        kind: 'click',
        ref: 'ab00000000:e1',
      });
      assert(stale.isError);
      assert.match(stale.text, /元素引用已失效或属于其他页面/);
      assert.match(
        (await f.runtime.callTool('neo_act', { page, kind: 'click', ref: count })).text,
        /尚未核对/,
      );
      await f.recover(page, 'dropped card');
      await act({ kind: 'click', ref: count, diff: 'none' });
      assert.match(await log(f), /^count \d+ detail 1$/);
      await f.runtime.finishTask('act');
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'page dialogs are reported, block other work and are answered by the task',
  options,
  async () => {
    const f = await webFixture();
    try {
      const { page } = await f.begin('dialogs');
      const act = (args: Record<string, unknown>) => f.call('neo_act', { page, ...args });
      const snap = (await f.call('neo_snapshot', { page })).text;

      let done = await act({ kind: 'click', ref: refOf(snap, 'Show alert') });
      assert.match(done.text, /页面弹出了 alert 弹窗："Heads up"/);
      const waiting = await f.runtime.callTool('neo_snapshot', { page });
      assert(waiting.isError);
      assert.match(waiting.text, /dialog_accept/);
      done = await act({ kind: 'dialog_accept' });
      assert.equal(await log(f), 'alert closed');
      assert.match(done.text, /alert closed/);

      await act({ kind: 'click', ref: refOf(snap, 'Ask confirm') });
      await act({ kind: 'dialog_dismiss' });
      assert.equal(await log(f), 'confirm false');
      done = await act({ kind: 'click', ref: refOf(snap, 'Ask confirm') });
      assert.match(done.text, /confirm 弹窗："Proceed\?"/);
      await act({ kind: 'dialog_accept' });
      assert.equal(await log(f), 'confirm true');

      await act({ kind: 'click', ref: refOf(snap, 'Ask prompt') });
      await act({ kind: 'dialog_accept', text: 'Ada' });
      assert.equal(await log(f), 'prompt Ada');
      await act({ kind: 'click', ref: refOf(snap, 'Ask prompt') });
      await act({ kind: 'dialog_dismiss' });
      assert.equal(await log(f), 'prompt null');

      done = await f.call('neo_evaluate_in_page', {
        page,
        code: `setTimeout(() => alert('From script'), 0); await new Promise((resolve) => setTimeout(resolve, 200)); return 1;`,
      });
      assert.match(done.text, /alert 弹窗："From script"/);
      await act({ kind: 'dialog_accept' });
      await f.call('neo_snapshot', { page });
      await f.runtime.finishTask('dialogs');
    } finally {
      await f.cleanup();
    }
  },
);

test('files are uploaded after approval and downloads are verified on disk', options, async () => {
  const f = await webFixture();
  try {
    const one = path.join(f.directory, 'one.txt');
    const two = path.join(f.directory, 'two.txt');
    await writeFile(one, 'hello');
    await writeFile(two, 'world!!');
    const { page } = await f.begin('files');
    const snap = (await f.call('neo_snapshot', { page })).text;
    const input = refOf(snap, 'Attachment');

    let done = await f.call('neo_upload', { page, ref: input, files: [one] });
    assert.match(done.text, /已选择 1 个文件：one\.txt/);
    assert.equal(await log(f), 'files one.txt:5');
    assert.equal(f.approvals.at(-1)!.action, 'browser-upload');
    await f.call('neo_upload', { page, ref: input, files: [one, two] });
    assert.equal(await log(f), 'files one.txt:5,two.txt:7');
    done = await f.call('neo_upload', { page, ref: input, files: [] });
    assert.match(done.text, /已清空文件选择/);
    assert.equal(await f.state(`document.querySelector('#file').files.length`), 0);

    done = await f.call('neo_act', { page, kind: 'click', ref: refOf(snap, 'Choose file') });
    assert.match(done.text, /页面打开了文件选择（可多选）/);
    await f.call('neo_upload', { page, file: two });
    assert.equal(await log(f), 'files two.txt:7');

    done = await f.call('neo_download', { page, ref: refOf(snap, 'Download report') });
    assert.match(done.text, /Downloaded report\.txt to: /);
    const artifact = JSON.parse(done.text.match(/Athena verified artifact: (.+)/)![1]);
    assert.equal(artifact.bytes, 11);
    assert.equal(await readFile(artifact.path, 'utf8'), 'report body');
    assert(
      artifact.path.startsWith(await realpath(f.browser.getDownloadDirectory())),
      artifact.path,
    );

    done = await f.call('neo_navigate', { page, action: 'url', url: f.origin + '/file.txt' });
    assert.match(done.text, /该地址是文件，页面没有变化。/);
    assert.match(done.text, /Athena verified artifact: /);
    assert.equal(await f.state('location.pathname'), '/lab');

    const relative = await f.runtime.callTool('neo_upload', {
      page,
      ref: input,
      files: ['relative.txt'],
    });
    assert(relative.isError);
    assert.match(relative.text, /文件必须使用绝对路径/);
    await f.runtime.finishTask('files', false);
  } finally {
    await f.cleanup();
  }
});

test('tabs, groups, popups and history stay in Athena’s own browser', options, async () => {
  const f = await webFixture();
  try {
    const { page } = await f.begin('tabs');
    const tabs = async () =>
      JSON.parse((await f.call('neo_tabs', { action: 'list' })).text) as Array<{
        pageId: number;
        url: string;
        isActive: boolean;
        groupId?: string;
      }>;
    assert.deepEqual(
      (await tabs()).map((item) => item.pageId),
      [page],
    );

    const opened = await f.call('neo_tabs', { action: 'new', url: f.origin + '/popup' });
    const second = Number(opened.text.match(/^opened page (\d+)/)![1]);
    assert.match(opened.text, /Order 42 confirmed/);
    assert.equal(
      JSON.parse((await f.call('neo_tabs', { action: 'active' })).text).pageId,
      second,
      'the new page is shown to the user',
    );

    let groups = JSON.parse(
      (
        await f.call('neo_tab_groups', {
          action: 'create',
          pages: [page, second],
          title: 'Work',
          color: 'blue',
        })
      ).text,
    );
    assert.deepEqual(groups, [
      {
        groupId: groups[0].groupId,
        title: 'Work',
        color: 'blue',
        collapsed: false,
        pages: [page, second],
      },
    ]);
    const groupId = groups[0].groupId;
    groups = JSON.parse(
      (
        await f.call('neo_tab_groups', {
          action: 'update',
          groupId,
          title: 'Later',
          collapsed: true,
        })
      ).text,
    );
    assert.equal(groups[0].title, 'Later');
    assert.equal(groups[0].collapsed, true);
    groups = JSON.parse(
      (await f.call('neo_tab_groups', { action: 'ungroup', pages: [page] })).text,
    );
    assert.deepEqual(groups[0].pages, [second]);
    assert.equal((await tabs()).find((item) => item.pageId === second)!.groupId, groupId);
    assert.deepEqual(JSON.parse((await f.call('neo_tab_groups', { action: 'list' })).text), groups);
    await f.call('neo_tab_groups', { action: 'close', groupId });
    assert.deepEqual(
      (await tabs()).map((item) => item.pageId),
      [page],
    );
    await f.call('neo_focus_page', { page });

    const snap = (await f.call('neo_snapshot', { page })).text;
    let done = await f.call('neo_act', { page, kind: 'click', ref: refOf(snap, 'Open receipt') });
    let popup = Number(done.text.match(/打开了新页面 (\d+)：/)?.[1]);
    assert(popup, done.text);
    assert.match((await f.call('neo_read', { page: popup })).text, /Order 42 confirmed/);
    assert.match((await f.call('neo_tabs', { action: 'close', page: popup })).text, /closed page/);
    await f.call('neo_focus_page', { page });
    done = await f.call('neo_act', { page, kind: 'click', ref: refOf(snap, 'Open window') });
    popup = Number(done.text.match(/打开了新页面 (\d+)：/)?.[1]);
    assert(popup, done.text);
    assert.match((await f.call('neo_snapshot', { page: popup })).text, /Order 42 confirmed/);
    await f.call('neo_tabs', { action: 'close', page: popup });
    await f.call('neo_focus_page', { page });

    done = await f.call('neo_act', { page, kind: 'click', ref: refOf(snap, 'Go to receipt') });
    assert.match(done.text, /页面地址变为 .*\/popup/);
    assert.match(done.text, /Order 42 confirmed/);
    done = await f.call('neo_navigate', { page, action: 'back' });
    assert.match(done.text, /已打开 .*\/lab/);
    assert.match(done.text, /Hover target/);
    assert.match((await f.call('neo_navigate', { page, action: 'forward' })).text, /Order 42/);
    assert.match((await f.call('neo_navigate', { page, action: 'reload' })).text, /Order 42/);
    done = await f.call('neo_navigate', { page, action: 'url', url: f.origin + '/missing' });
    assert.match(done.text, /HTTP 状态 404/);
    assert.match(done.text, /Not here/);

    const blank = Number(
      (await f.call('neo_tabs', { action: 'new' })).text.match(/^opened page (\d+)/)![1],
    );
    assert.match(
      (await f.call('neo_navigate', { page: blank, action: 'back' })).text,
      /没有可后退的历史记录/,
    );
    done = await f.call('neo_navigate', {
      page: blank,
      action: 'url',
      url: f.foreign + '/foreign',
    });
    const remote = refOf(done.text, 'Email');
    await f.call('neo_act', { page: blank, kind: 'fill', ref: remote, value: 'far@example.com' });
    done = await f.call('neo_act', {
      page: blank,
      kind: 'click',
      ref: refOf(done.text, 'Confirm contact'),
    });
    assert.match(
      (await f.call('neo_read', { page: blank })).text,
      /confirmed far@example\.com/,
      'a frame from another origin is read and operated like the rest of the page',
    );

    const unreachable = await f.runtime.callTool('neo_navigate', {
      page: blank,
      action: 'url',
      url: 'http://127.0.0.1:1/',
    });
    assert(unreachable.isError, unreachable.text);
    const gone = await f.runtime.callTool('neo_snapshot', { page: popup });
    assert.match(gone.text, /页面引用已变化/);
    await f.runtime.finishTask('tabs', false);
  } finally {
    await f.cleanup();
  }
});

test(
  'page code and scripts run only after approval and report what they changed',
  options,
  async () => {
    const f = await webFixture();
    try {
      const attachment = path.join(f.directory, 'note.txt');
      await writeFile(attachment, 'note');
      const { page } = await f.begin('scripts');
      let out = await f.call('neo_evaluate_in_page', { page, code: 'return document.title' });
      assert.match(out.text, /"Lab"/);
      assert.equal(f.approvals.at(-1)!.action, 'browser-script');
      assert(!out.text.includes('脚本改动了页面'));
      out = await f.call('neo_evaluate_in_page', {
        page,
        func: '() => ({ buttons: document.querySelectorAll("button").length })',
      });
      assert.match(out.text, /\{"buttons":\d+\}/);
      out = await f.call('neo_evaluate_in_page', {
        page,
        code: `document.body.dataset.touched = '1'; return 1`,
      });
      assert.match(out.text, /脚本改动了页面/);
      out = await f.call('neo_evaluate_in_page', {
        page,
        code: `return 'x'.repeat(500)`,
        maxChars: 50,
      });
      assert.match(out.text, /结果超过 50 字节，已截断。/);

      const before = f.approvals.length;
      out = await f.call('neo_run', {
        code: `
        const page = browser.page(${page});
        const snap = await page.snapshot();
        const ref = (label) => Object.entries(snap.refs).find(([, item]) => item.name === label)[0];
        await page.fill(ref('Name'), 'Scripted');
        await page.selectOption(ref('Plan'), 'pro');
        await page.check(ref('Agree'));
        await page.click(ref('Load later'));
        const waited = await page.waitForText('Arrived later', { timeout: 5000 });
        const title = await page.evaluateInPage((suffix) => document.title + suffix, '!');
        const late = await page.read('#late');
        const found = await page.grep('arrived', { over: 'content' });
        const shot = await page.screenshot({ format: 'png' });
        const file = await page.download(ref('Download report'));
        await page.upload(ref('Attachment'), ['${attachment}']);
        const opening = await page.click(ref('Show alert'));
        await page.dialogAccept();
        const other = await browser.open('${f.origin}/popup');
        const info = await other.info();
        await other.close();
        console.log('pages', (await browser.pages.list()).length);
        return { waited: waited.matched, title: title.value, late, found, shot: shot.mimeType, bytes: shot.data.length > 100, file: file.name, dialog: opening.dialogOpen, info: info.title };
      `,
      });
      assert.equal(f.approvals.length, before + 1, 'one approval covers the whole script');
      assert.match(out.text, /\[log\] pages 1/);
      const result = JSON.parse(out.text.match(/^result: (.+)$/m)![1]);
      assert.equal(result.waited, true);
      assert.equal(result.title, 'Lab!');
      assert.match(result.late, /Arrived later/);
      assert.match(result.found, /Arrived later/);
      assert.deepEqual(
        [result.shot, result.bytes, result.file, result.dialog, result.info],
        ['image/png', true, 'report.txt', true, 'Receipt'],
      );
      assert.match(out.text, /Athena verified artifact: /);
      assert.equal(await f.state(`document.querySelector('#name').value`), 'Scripted');
      assert.equal(await f.state(`document.querySelector('#plan').value`), 'pro');
      assert.equal(await f.state(`document.querySelector('#agree').checked`), true);
      assert.equal(await f.state(`document.querySelector('#file').files[0].name`), 'note.txt');

      const hidden = await f.runtime.callTool('neo_run', {
        code: `
        const page = browser.page(${page});
        const snap = await page.snapshot();
        const input = Object.entries(snap.refs).find(([, item]) => item.name === 'Attachment')[0];
        await page.upload(input, ['${f.directory}' + '/one' + '.txt']);
      `,
      });
      assert(hidden.isError);
      assert.match(hidden.text, /脚本只能上传在脚本里写明完整路径的文件/);
      await f.recover(page, 'Arrived later');
      const thrown = await f.runtime.callTool('neo_run', { code: `throw new Error('boom')` });
      assert(thrown.isError);
      assert.match(thrown.text, /error: Error: boom/);
      await f.recover(page, 'Arrived later');
      const endless = await f.runtime.callTool('neo_run', {
        code: 'while (true) {}',
        timeout: 500,
      });
      assert(endless.isError);
      assert.match(endless.text, /脚本在 500 ms 内没有完成，已终止/);
      await f.recover(page, 'Arrived later');
      const both = await f.runtime.callTool('neo_evaluate_in_page', {
        page,
        code: 'return 1',
        func: '() => 1',
      });
      assert.match(both.text, /code 和 func 需要且只能提供一个/);
      await f.recover(page, 'Arrived later');
      const failing = await f.runtime.callTool('neo_evaluate_in_page', {
        page,
        code: `throw new Error('page boom')`,
      });
      assert.match(failing.text, /脚本出错：.*page boom/);
      await f.runtime.finishTask('scripts', false);
    } finally {
      await f.cleanup();
    }
  },
);
