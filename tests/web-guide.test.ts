import assert from 'node:assert/strict';
import test from 'node:test';
import type { GuideOptions } from '../src/main/browser-guide';
import type { GuideCard } from '../src/main/web-runtime';
import type { ApprovalRequest } from '../src/shared/types';
import { liveWeb, refOf, until, webFixture, type WebFixture } from './web-fixture';

const options = { skip: !liveWeb, timeout: 90000 };

type Shown = Omit<ApprovalRequest, 'id' | 'kind'>;
/** The conversation's side of a guide: every card the runtime opens, and what became of it. */
function conversation(f: WebFixture) {
  const cards: Array<{ shown: Shown[]; closed?: { summary?: string }; end(): void }> = [];
  (f.runtime as any).options.guideCard = (request: Shown): GuideCard => {
    let end!: () => void;
    const card = {
      shown: [request],
      closed: undefined as { summary?: string } | undefined,
      end: () => end(),
    };
    cards.push(card);
    return {
      ended: new Promise<void>((resolve) => (end = resolve)),
      update: (next) => void card.shown.push(next),
      close: (summary) => void (card.closed = { summary }),
    };
  };
  const marks = (card = cards.at(-1)) =>
    card?.shown
      .at(-1)
      ?.guide?.steps.map((step) => step.status[0])
      .join('');
  return { cards, marks };
}
/** A click from the person at the screen, not from the agent. */
async function press(f: WebFixture, selector: string) {
  const point = await f.state(
    `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await f.browser.dispatchInput({ type: 'mouse', action: 'down', button: 'left', ...point });
  await f.browser.dispatchInput({ type: 'mouse', action: 'up', button: 'left', ...point });
}
/** The step the page is showing, asked the way the guide itself asks. */
const onPage = (f: WebFixture): Promise<{ token?: string }> =>
  (f.browser as any).guideHost().shown();
const steps = {
  title: '数一次',
  steps: [
    { note: '点一下 Count', selector: '#count', action: 'click' },
    { note: '看看结果', selector: '#log' },
  ],
};

test(
  'a guide waits while the user acts, shows its progress in the conversation, and leaves the page to be read again',
  options,
  async () => {
    const f = await webFixture();
    const { cards, marks } = conversation(f);
    try {
      const task = await f.begin('guide');
      const ref = refOf((await f.call('web_snapshot', { page: task.page })).text, 'Name');

      // A first step that is not on the page starts nothing, in the conversation or on the page.
      const missing = await f.runtime.callTool('workbench_browser_guide', {
        steps: [{ note: '点“删除账号”', text: '删除账号', action: 'click' }],
      });
      assert.equal(missing.isError, true);
      assert.equal(JSON.parse(missing.text).started, false);
      assert.equal(cards.length, 0);
      // Nothing changed, so what the agent knew of the page still stands.
      await f.call('web_act', { page: task.page, kind: 'fill', ref, value: 'before' });

      const fresh = refOf((await f.call('web_snapshot', { page: task.page })).text, 'Name');
      const running = f.runtime.callTool('workbench_browser_guide', steps);
      await until(() => marks() === 'cp', 'the card with the first step');
      assert.deepEqual(
        { action: cards[0].shown[0].action, title: cards[0].shown[0].title },
        { action: 'browser-guide', title: '带你做：数一次' },
      );
      // The user's click is what the guide waits for: it neither cancels the call nor the task.
      await press(f, '#count');
      await until(() => marks() === 'dc', 'the card to move on');
      assert.match(await f.state(`document.querySelector('#log').textContent`), /^count 1 /);
      assert.equal(cards[0].closed, undefined);
      assert.equal((f.runtime as any).current.stopped, false);
      assert.ok((await onPage(f)).token);

      // Ending it from the conversation is the user's decision.
      cards[0].end();
      const result = await running;
      assert.equal(result.isError, false, result.text);
      const ended = JSON.parse(result.text);
      assert.equal(ended.ended, 'ended_by_user');
      assert.deepEqual(
        ended.steps.map((step: { status: string }) => step.status),
        ['done', 'pending'],
      );
      assert.deepEqual(cards[0].closed, { summary: '完成 1/2 步后由你结束' });
      assert.deepEqual(await onPage(f), { token: undefined });

      // What the agent saw before the guide is stale: it reads the page again before it acts.
      const stale = await f.runtime.callTool('web_act', {
        page: task.page,
        kind: 'fill',
        ref: fresh,
        value: 'after',
      });
      assert.equal(stale.isError, true);
      assert.match(stale.text, /重新观察|重新读取/);
      assert.equal(await f.state(`document.querySelector('#name').value`), 'before');
      const again = refOf((await f.call('web_snapshot', { page: task.page })).text, 'Name');
      await f.call('web_act', { page: task.page, kind: 'fill', ref: again, value: 'after' });
      assert.equal(await f.state(`document.querySelector('#name').value`), 'after');

      // A guide the user finishes says so, and what it reports holds nothing they typed.
      const second = f.runtime.callTool('workbench_browser_guide', {
        steps: [{ note: '点一下 Count', text: 'Count', action: 'click' }],
      });
      await until(() => cards.length === 2 && marks() === 'c', 'the second card');
      await press(f, '#count');
      const done = JSON.parse((await second).text);
      assert.equal(done.ended, 'completed');
      assert.deepEqual(cards[1].closed, { summary: '完成 1/1 步' });
      assert.equal(marks(), 'd');
      await f.runtime.finishTask('guide');
    } finally {
      await f.cleanup();
    }
  },
);

test(
  'a turn that may only read can still guide, without the offer to take over, and stops with the turn',
  options,
  async () => {
    const f = await webFixture();
    const { cards, marks } = conversation(f);
    try {
      await f.begin('readonly', true);
      let given: GuideOptions | undefined;
      const guide = f.browser.guide.bind(f.browser);
      f.browser.guide = (args, opts) => guide(args, (given = opts));
      const refused = await f.runtime.callTool('workbench_browser_edit', {
        selector: '#log',
        text: 'changed',
      });
      assert.equal(refused.isError, true);
      const running = f.runtime.callTool('workbench_browser_guide', steps);
      await until(() => marks() === 'cp', 'the card with the first step');
      assert.equal(given?.handover, false);
      await f.runtime.cancelTask();
      const stopped = JSON.parse((await running).text);
      assert.equal(stopped.ended, 'stopped');
      // A stopped turn takes its card away without a line about it.
      assert.deepEqual(cards[0].closed, { summary: undefined });
      assert.deepEqual(await onPage(f), { token: undefined });
      await f.runtime.finishTask('readonly');
    } finally {
      await f.cleanup();
    }
  },
);
