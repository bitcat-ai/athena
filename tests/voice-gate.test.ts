import assert from 'node:assert/strict';
import test from 'node:test';
import { ASK_ONLY_REFUSAL } from '../src/main/web-runtime';
import { voiceIntent } from '../src/shared/voice-intent';
import { liveWeb, webFixture } from './web-fixture';

const options = { skip: !liveWeb, timeout: 90000 };

test(
  'a spoken question can look at the page and point, and cannot change it whatever the agent tries',
  options,
  async () => {
    const f = await webFixture();
    const text = () => f.state(`document.querySelector('#log').textContent`);
    try {
      const question = '就是应用标题旁边那个输入框你看到了吗';
      assert.equal(voiceIntent(question), 'ask');
      await f.begin('asked', false, true);
      const before = await text();
      for (const [name, args] of [
        ['workbench_browser_edit', { selector: '#log', text: 'changed' }],
        ['workbench_browser_edit', { selector: '#log', styles: { color: 'orange' } }],
        ['workbench_browser_restyle', { css: '#log{color:orange}' }],
        ['workbench_browser_undo', {}],
      ] as const) {
        const refused = await f.runtime.callTool(name, args);
        assert.equal(refused.isError, true, name);
        assert.equal(refused.text.includes(ASK_ONLY_REFUSAL), true, refused.text);
      }
      assert.equal(await text(), before, 'the page is as it was');
      const seen = await f.runtime.callTool('workbench_browser_inspect', { selector: '#log' });
      assert(!seen.isError, seen.text);
      await f.runtime.finishTask('asked');

      // The next sentence asks for the change, and the same call goes through.
      assert.equal(voiceIntent('把它的文字改成 changed'), 'act');
      await f.begin('requested');
      const applied = await f.runtime.callTool('workbench_browser_edit', {
        selector: '#log',
        text: 'changed',
      });
      assert(!applied.isError, applied.text);
      assert.equal(await text(), 'changed');
      await f.runtime.finishTask('requested');
    } finally {
      await f.cleanup();
    }
  },
);
