import test from 'node:test';
import assert from 'node:assert/strict';
import { liveWeb, webFixture, refOf } from './web-fixture';

const options = { skip: !liveWeb, timeout: 60000 };

test(
  'empty or rejected scroll input does not revoke a valid interaction observation',
  options,
  async () => {
    const f = await webFixture('/lab');
    try {
      const task = await f.begin('no-scroll');
      const snapshot = await f.call('web_snapshot', { page: task.page });
      const ref = refOf(snapshot.text, 'Count');
      await f.browser.dispatchInput({ type: 'wheel', x: 200, y: 200, deltaX: 0, deltaY: 0 });
      await assert.rejects(
        f.browser.dispatchInput({ type: 'wheel', x: 200, y: 200, deltaX: 0, deltaY: NaN }),
      );
      await f.call('web_act', { page: task.page, kind: 'click', ref });
      assert.match(await f.state("document.querySelector('#log').textContent"), /count 1/);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'reading then scrolling does not revoke a DOM preview, while page actions still re-observe',
  options,
  async () => {
    const f = await webFixture('/lab');
    try {
      const task = await f.begin('scroll-preview');
      const snapshot = await f.call('web_snapshot', { page: task.page });
      const clickRef = refOf(snapshot.text, 'Count');
      const heading = JSON.parse((await f.call('workbench_browser_query', { selector: 'h1' })).text)
        .elements[0].ref;
      const scroll = () =>
        f.browser.dispatchInput({ type: 'wheel', x: 200, y: 200, deltaX: 0, deltaY: 80 });
      await scroll();
      const edit = await f.runtime.callTool('workbench_browser_edit', {
        ref: heading,
        text: 'Headline after scrolling',
      });
      assert.notEqual(edit.isError, true, edit.text);
      assert.equal(
        await f.state("document.querySelector('h1').textContent"),
        'Headline after scrolling',
      );
      assert.equal(
        (await f.runtime.callTool('web_act', { page: task.page, kind: 'click', ref: clickRef }))
          .isError,
        true,
      );
      await f.call('web_read', { page: task.page });
      await scroll();
      const style = await f.runtime.callTool('workbench_browser_restyle', {
        css: 'h1 { color: rgb(20, 30, 40) !important; }',
      });
      assert.notEqual(style.isError, true, style.text);
      assert.equal(
        await f.state("getComputedStyle(document.querySelector('h1')).color"),
        'rgb(20, 30, 40)',
      );
      await f.browser.dispatchInput({
        type: 'mouse',
        action: 'down',
        x: 200,
        y: 200,
        button: 'left',
        buttons: 1,
      });
      await f.browser.dispatchInput({
        type: 'mouse',
        action: 'up',
        x: 200,
        y: 200,
        button: 'left',
        buttons: 0,
      });
      assert.equal(
        (
          await f.runtime.callTool('workbench_browser_edit', {
            ref: heading,
            text: 'Must not overwrite',
          })
        ).isError,
        true,
      );
      assert.match(f.runtime.unresolvedResult('scroll-preview') ?? '', /未执行|未完成/);
      await f.runtime.finishTask('scroll-preview');
      assert.equal((await f.runtime.server.detail(task.sessionId)).session.status, 'failed');
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'line-break headings support real text edits and exact undo without pseudo-element workarounds',
  options,
  async () => {
    const f = await webFixture('/lab');
    try {
      await f.begin('heading-text');
      await f.state(
        "document.querySelector('h1').innerHTML='First line<br>Second line'; window.__headingBreak=document.querySelector('h1 br')",
      );
      const result = JSON.parse(
        (
          await f.call('workbench_browser_restyle', {
            texts: [{ selector: 'h1', text: 'A real replacement' }],
          })
        ).text,
      );
      assert.equal(result.texts[0].changed, 1);
      assert.equal(await f.state("document.querySelector('h1').textContent"), 'A real replacement');
      assert.equal(await f.state("document.querySelector('h1 br')===window.__headingBreak"), true);
      await f.call('workbench_browser_undo', { editId: result.editId });
      assert.equal(
        await f.state("document.querySelector('h1').innerHTML"),
        'First line<br>Second line',
      );
      const heading = JSON.parse((await f.call('workbench_browser_query', { selector: 'h1' })).text)
        .elements[0];
      assert.equal(heading.editableText, true);
      const edit = JSON.parse(
        (await f.call('workbench_browser_edit', { ref: heading.ref, text: 'Second replacement' }))
          .text,
      );
      await f.call('workbench_browser_undo', { editId: edit.editId });
      assert.equal(
        await f.state("document.querySelector('h1').innerHTML"),
        'First line<br>Second line',
      );
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'one page-creation tool returns its new scope, preserves the old page, and rejects bad input before opening a tab',
  options,
  async () => {
    const f = await webFixture('/lab');
    try {
      await f.begin('create-preview');
      const oldTab = f.browser.getState().activeTabId;
      const before = f.browser.getState().tabs.length;
      const invalid = await f.runtime.callTool('workbench_browser_create_page', {
        title: 'Bad',
        insert: { node: { tag: 'script', text: 'alert(1)' } },
      });
      assert.equal(invalid.isError, true);
      assert.equal(f.browser.getState().tabs.length, before);
      const args = {
        title: 'Lamp Studio',
        insert: {
          node: {
            tag: 'main',
            attributes: { id: 'lamp-preview' },
            children: [
              { tag: 'h1', text: 'Quiet light' },
              { tag: 'img', text: '', children: [], attributes: { alt: 'Lamp' } },
              { tag: 'button', text: 'Explore' },
            ],
          },
        },
      };
      const created = JSON.parse((await f.call('workbench_browser_create_page', args)).text);
      assert.equal(created.status, 'created');
      assert.ok(created.page > 0 && created.editId && created.element.ref);
      assert.equal(f.browser.getState().activeTabId, created.tabId);
      assert.equal(f.browser.getState().title, 'Lamp Studio');
      assert.notEqual(created.tabId, oldTab);
      assert.equal(
        (await f.browser.nativeEvaluate(oldTab!, "document.querySelector('h1').textContent", 5000))
          .value,
        'Lab',
      );
      assert.equal(
        await f.state("document.querySelector('#lamp-preview h1').textContent"),
        'Quiet light',
      );
      assert.equal(
        await f.state("document.querySelector('#lamp-preview img').childNodes.length"),
        0,
      );
      assert.equal(
        (await f.runtime.callTool('workbench_browser_create_page', args)).isError,
        true,
        'the same creation receipt cannot be replayed',
      );
      await f.call('workbench_browser_undo', { editId: created.editId });
      assert.equal(await f.state("document.querySelector('#lamp-preview')"), null);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'a stale DOM ref rejected before dispatch can be corrected without an unknown-result barrier',
  options,
  async () => {
    const f = await webFixture('/lab');
    try {
      await f.begin('stale-preview-ref');
      const old = JSON.parse((await f.call('workbench_browser_query', { selector: 'h1' })).text)
        .elements[0];
      await f.state("document.querySelector('h1').outerHTML='<h1>New node</h1>'");
      const stale = await f.runtime.callTool('workbench_browser_edit', {
        ref: old.ref,
        text: 'Must not apply to replacement',
      });
      assert.equal(stale.execution, 'not_executed');
      assert.equal(stale.isError, true);
      const fresh = JSON.parse((await f.call('workbench_browser_query', { selector: 'h1' })).text)
        .elements[0];
      await f.call('workbench_browser_edit', { ref: fresh.ref, text: 'Freshly observed title' });
      assert.equal(f.runtime.unresolvedResult('stale-preview-ref'), undefined);
      assert.equal(
        await f.state("document.querySelector('h1').textContent"),
        'Freshly observed title',
      );
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'overlapping scroll and DOM edit keep the executor session; a real click cancels the queued edit',
  options,
  async () => {
    const f = await webFixture('/lab');
    try {
      const task = await f.begin('concurrent-preview');
      const heading = JSON.parse((await f.call('workbench_browser_query', { selector: 'h1' })).text)
        .elements[0].ref;
      const original = f.browser.callTool.bind(f.browser);
      let enter!: () => void, release!: () => void;
      let entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.browser.callTool = async (name, args) => {
        if (name === 'workbench_browser_edit') {
          enter();
          await gate;
        }
        return original(name, args);
      };
      const edit = f.runtime.callTool('workbench_browser_edit', {
        ref: heading,
        text: 'While scrolling',
      });
      await entered;
      await f.browser.dispatchInput({ type: 'wheel', x: 200, y: 200, deltaX: 0, deltaY: 40 });
      release();
      assert.notEqual((await edit).isError, true);
      assert.equal((f.runtime as any).current.client.id, task.sessionId);
      entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocked = f.runtime.callTool('workbench_browser_edit', {
        ref: heading,
        text: 'Must not run after click',
      });
      await entered;
      await f.browser.dispatchInput({
        type: 'mouse',
        action: 'down',
        x: 180,
        y: 200,
        button: 'left',
        buttons: 1,
      });
      await f.browser.dispatchInput({
        type: 'mouse',
        action: 'up',
        x: 180,
        y: 200,
        button: 'left',
        buttons: 0,
      });
      release();
      assert.equal((await blocked).execution, 'not_executed');
      assert.equal((f.runtime as any).current.execution.needsRecovery, false);
      assert.equal((f.runtime as any).current.client.id, task.sessionId);
      assert.equal(await f.state("document.querySelector('h1').textContent"), 'While scrolling');
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'scrolling during a content read keeps its document evidence without authorizing a stale page click',
  options,
  async () => {
    const f = await webFixture('/lab');
    try {
      const task = await f.begin('scroll-read');
      const original = task.client.call.bind(task.client);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      task.client.call = async (name: string, args: unknown) => {
        if (name === 'read') {
          entered();
          await gate;
        }
        return original(name, args);
      };
      const reading = f.runtime.callTool('web_read', { page: task.page });
      await started;
      const scrolling = f.browser.dispatchInput({
        type: 'wheel',
        x: 200,
        y: 200,
        deltaX: 0,
        deltaY: 60,
      });
      release();
      const read = await reading;
      await scrolling;
      assert.notEqual(read.isError, true, read.text);
      assert.match(read.text, /Athena observationId/);
      assert.equal((f.runtime as any).current.client.id, task.sessionId);
      assert.equal(
        (await f.runtime.callTool('web_act', { page: task.page, kind: 'press', key: 'Enter' }))
          .isError,
        true,
      );
      const preview = await f.runtime.callTool('workbench_browser_restyle', {
        css: 'h1 { color: rgb(9, 80, 40) !important; }',
      });
      assert.notEqual(preview.isError, true, preview.text);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'fresh native observations let page previews continue after human interaction',
  options,
  async () => {
    const f = await webFixture('/plain');
    try {
      const task = await f.begin('observe-preview');
      for (const tool of ['web_snapshot', 'web_read', 'workbench_browser_query']) {
        const element = (await f.browser.queryElements({ selector: '#title' })).elements[0];
        await f.browser.selectElement(element.ref);
        const refused = await f.runtime.callTool('workbench_browser_restyle', {
          css: 'body { color: red; }',
        });
        assert.match(refused.text, /重新读取/);
        await f.call(
          tool,
          tool === 'workbench_browser_query' ? { selector: '#title' } : { page: task.page },
        );
        const result = JSON.parse(
          (
            await f.call('workbench_browser_restyle', {
              css: 'body { color: rgb(20, 30, 40) !important; }',
            })
          ).text,
        );
        assert.equal(result.applied, true);
        assert.equal(await f.state('getComputedStyle(document.body).color'), 'rgb(20, 30, 40)');
        await f.call('workbench_browser_undo', { editId: result.editId });
      }
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'rejected preview arguments can be corrected without a result recovery round',
  options,
  async () => {
    const f = await webFixture('/plain');
    try {
      await f.begin('invalid-preview');
      const ref = JSON.parse((await f.call('workbench_browser_query', { selector: 'body' })).text)
        .elements[0].ref;
      const invalid = await f.runtime.callTool('workbench_browser_edit', {
        ref,
        insert: {
          node: { tag: 'section', styles: { 'not-a-css-property': '1px' }, text: 'Preview' },
        },
      });
      assert.equal(invalid.isError, true);
      assert.equal(await f.state("document.querySelectorAll('section').length"), 0);
      assert.match(f.runtime.unresolvedResult('invalid-preview') ?? '', /未执行/);
      const result = JSON.parse(
        (
          await f.call('workbench_browser_edit', {
            ref,
            insert: {
              node: {
                tag: 'section',
                styles: {
                  padding: '16px',
                  display: 'flex',
                  'flex-wrap': 'wrap',
                  'border-bottom': '1px solid black',
                  'object-fit': 'cover',
                },
                text: 'Preview',
              },
            },
          })
        ).text,
      );
      assert.equal(await f.state("document.querySelectorAll('section').length"), 1);
      assert.equal(f.runtime.unresolvedResult('invalid-preview'), undefined);
      assert.equal(
        await f.state("getComputedStyle(document.querySelector('section')).flexWrap"),
        'wrap',
      );
      await f.call('workbench_browser_undo', { editId: result.editId });
      assert.equal(await f.state("document.querySelectorAll('section').length"), 0);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'a lost preview reply still blocks mutations until its result is reconciled',
  options,
  async () => {
    const f = await webFixture('/plain');
    try {
      await f.begin('lost-preview-reply');
      const ref = JSON.parse((await f.call('workbench_browser_query', { selector: 'body' })).text)
        .elements[0].ref;
      const call = f.browser.callTool.bind(f.browser);
      f.browser.callTool = async (name, args) => {
        const result = await call(name, args);
        if (name === 'workbench_browser_edit' && !result.isError) throw new Error('reply lost');
        return result;
      };
      const args = { ref, insert: { node: { tag: 'section', text: 'Only once' } } };
      const result = await f.runtime.callTool('workbench_browser_edit', args);
      assert.equal(result.isError, true);
      assert.match(f.runtime.unresolvedResult('lost-preview-reply')!, /尚未核对/);
      assert.equal((await f.runtime.callTool('workbench_browser_edit', args)).isError, true);
      assert.equal(await f.state("document.querySelectorAll('section').length"), 1);
    } finally {
      await f.cleanup();
    }
  },
);
