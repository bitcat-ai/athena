import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Guide,
  parseGuide,
  type GuideHost,
  type GuideOptions,
  type GuideProgress,
  type GuideShown,
  type GuideShownStep,
} from '../src/main/browser-guide.ts';

const pace = { retry: 4, first: 40, later: 24, silent: 60, idle: 8, check: 30, settle: 0 };

/** A page that shows what it is given, and a user who answers through `act`. */
function setup(
  args: unknown,
  options: GuideOptions = {},
  locate: (step: GuideShownStep) => GuideShown | undefined = () => ({ shown: true, located: true }),
) {
  const page = {
    tab: 'tab-a' as string | undefined,
    alive: true,
    current: undefined as GuideShownStep | undefined,
    locate,
    shows: [] as GuideShownStep[],
    log: [] as string[],
  };
  const host: GuideHost = {
    alive: () => page.alive,
    where: () => page.tab,
    async show(step) {
      page.shows.push(step);
      let answer = page.locate(step);
      if (answer && !answer.shown && !step.require) answer = { shown: true, located: false };
      if (answer?.shown) page.current = step;
      return answer;
    },
    async shown() {
      return { token: page.current?.token };
    },
    async clear(tabId, farewell) {
      page.current = undefined;
      page.log.push(`clear ${tabId ?? 'visible'}${farewell ? ` "${farewell}"` : ''}`);
    },
    async settle() {
      page.log.push(`settle after step ${page.current!.index + 1}`);
    },
    async page() {
      return { url: 'https://example.test/done', title: 'Done', outline: 'h1 Done' };
    },
  };
  const progress: GuideProgress[] = [];
  const guide = new Guide(host, parseGuide(args), {
    pace,
    onProgress: (value) => progress.push(value),
    ...options,
  });
  const result = guide.run();
  /** Waits until the given step is on the page, then lets the user answer it. */
  const act = async (index: number, event: string, extra: Record<string, unknown> = {}) => {
    await until(() => page.current?.index === index, `step ${index + 1} on the page`);
    guide.push({
      kind: 'page',
      token: page.current!.token,
      index,
      event: event as 'advance',
      ...extra,
    });
  };
  const marks = () => progress.map((item) => item.steps.map((step) => step.status[0]).join(''));
  return { page, guide, result, act, progress, marks };
}
async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
const three = {
  title: '开通套餐',
  steps: [
    { note: '点“升级”', text: '升级', action: 'click' },
    { note: '填写公司名称', selector: '#company', action: 'input' },
    { note: '核对金额后由你决定是否提交' },
  ],
};

test('a guide needs steps that say what to do and where', () => {
  assert.deepEqual(parseGuide({ steps: [{ note: ' 看这里 ' }] }), {
    title: undefined,
    steps: [
      { note: '看这里', action: 'look', selector: undefined, text: undefined, ref: undefined },
    ],
  });
  const fails = (args: unknown, message: RegExp) => assert.throws(() => parseGuide(args), message);
  fails(undefined, /需要 steps/);
  fails({ steps: [] }, /1 到 12 步/);
  fails({ steps: Array.from({ length: 13 }, () => ({ note: 'x' })) }, /1 到 12 步/);
  fails({ steps: [{ note: '' }] }, /第 1 步的 note/);
  fails({ steps: [{ note: 'x' }, { note: 'y', action: 'press' }] }, /第 2 步的 action/);
  fails({ steps: [{ note: 'x', action: 'click' }] }, /需要 selector 或 text/);
  fails({ steps: [{ note: 'x', action: 'input' }] }, /需要 selector 或 text/);
  fails({ steps: [{ note: 'x', value: 'secret' }] }, /不支持 value/);
  fails({ steps: [{ note: 'x' }], tabId: 't' }, /不支持 tabId/);
  fails({ steps: [{ note: 'x'.repeat(281) }] }, /不能超过 280/);
});

test('the user walks through every step and the agent learns how each was passed', async () => {
  const { page, result, act, marks } = setup(three, { handover: true });
  await act(0, 'advance', { by: 'click', located: true });
  await act(1, 'advance', { by: 'input', located: true, filled: true });
  await act(2, 'advance', { by: 'button', located: false });
  const outcome = await result;
  assert.equal(outcome.started, true);
  assert.equal(outcome.ended, 'completed');
  assert.deepEqual(outcome.steps, [
    { note: '点“升级”', status: 'done', by: 'click' },
    { note: '填写公司名称', status: 'done', by: 'input', filled: true },
    { note: '核对金额后由你决定是否提交', status: 'done', by: 'button', located: false },
  ]);
  assert.equal(outcome.next, undefined);
  assert.deepEqual(outcome.page, { url: 'https://example.test/done', title: 'Done' });
  assert.equal(outcome.outline, 'h1 Done');
  assert.match(outcome.message, /亲手完成了 3\/3 步.*重新读取页面/);
  // The card in the conversation follows along and ends with nothing in progress.
  assert.deepEqual(marks(), ['cpp', 'dcp', 'ddc', 'ddd']);
  // Only the user's click may have set the page in motion.
  assert.deepEqual(page.log, ['settle after step 1', 'clear visible "完成了"']);
  // Every presentation has its own token; the first step offers no way back.
  assert.equal(new Set(page.shows.map((step) => step.token)).size, 3);
  assert.deepEqual(
    page.shows.map((step) => [step.index, step.total, step.title, step.back, step.handover]),
    [
      [0, 3, '开通套餐', false, true],
      [1, 3, '开通套餐', true, true],
      [2, 3, '开通套餐', true, true],
    ],
  );
});

test('a first step that cannot be placed starts nothing', async () => {
  const missing = setup(three, {}, () => ({ shown: false, reason: 'text_not_found' }));
  const outcome = await missing.result;
  assert.equal(outcome.started, false);
  assert.equal(outcome.reason, 'text_not_found');
  assert.match(outcome.message, /没有开始带做.*没有找到这段可见文字/);
  assert.equal(missing.page.current, undefined);
  assert.deepEqual(missing.progress, []);
  // The element was given a moment to appear, and was never shown without its place.
  assert.ok(missing.page.shows.length > 2);
  assert.ok(missing.page.shows.every((step) => step.require));

  // An element that appears a moment later is enough.
  let asked = 0;
  const late = setup(three, {}, () =>
    ++asked < 3 ? { shown: false, reason: 'not_found' } : { shown: true, located: true },
  );
  await late.act(0, 'end');
  assert.equal((await late.result).started, true);

  // Waiting does not fix a selector that is not one.
  const invalid = setup(three, {}, () => ({ shown: false, reason: 'invalid_selector' }));
  assert.equal((await invalid.result).reason, 'invalid_selector');
  assert.equal(invalid.page.shows.length, 1);

  // A page that never answers is reported as such.
  const silent = setup(three, {}, () => undefined);
  assert.equal((await silent.result).reason, 'no_answer');
});

test('a later step whose element is missing is shown anyway and can be skipped', async () => {
  const { page, result, act } = setup(three, {}, (step) =>
    step.index === 1 ? { shown: false, reason: 'not_found' } : { shown: true, located: true },
  );
  await act(0, 'advance', { by: 'click', located: true });
  await until(() => page.current?.index === 1, 'the second step');
  assert.equal(page.current!.require, false);
  await act(1, 'advance', { by: 'skip', located: false });
  await act(2, 'advance', { by: 'button', located: true });
  const outcome = await result;
  assert.equal(outcome.ended, 'completed');
  assert.deepEqual(outcome.steps![1], { note: '填写公司名称', status: 'skipped', located: false });
  assert.match(outcome.message, /亲手完成了 2\/3 步，其余步骤被跳过/);
});

test('the step follows the user onto the next page, and reports from the old one are ignored', async () => {
  const { page, guide, result, act } = setup(three);
  await act(0, 'advance', { by: 'click', located: true });
  await until(() => page.current?.index === 1, 'the second step');
  const before = page.current!.token;
  // The click's navigation arrives after the step was placed: the new document knows nothing.
  page.current = undefined;
  guide.push({ kind: 'navigated' });
  await until(() => page.current?.index === 1, 'the second step again');
  assert.notEqual(page.current!.token, before);
  guide.push({ kind: 'page', token: before, index: 1, event: 'advance', by: 'input' });
  guide.push({ kind: 'page', token: page.current!.token, index: 0, event: 'end' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(page.current!.index, 1);
  // A navigation that kept the document, like a hash change, does not redraw the step.
  const shows = page.shows.length;
  guide.push({ kind: 'navigated' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(page.shows.length, shows);
  // A page that lost the step without telling anyone gets it back.
  page.current = undefined;
  await until(() => page.current?.index === 1, 'the second step once more');
  await act(1, 'end');
  assert.equal((await result).ended, 'ended_by_user');
});

test('the user can go back, stop, or hand the rest to the agent', async () => {
  const back = setup(three, { handover: true });
  await back.act(0, 'advance', { by: 'click', located: true });
  await back.act(1, 'back');
  await until(() => back.page.current?.index === 0, 'the first step again');
  assert.deepEqual(back.marks(), ['cpp', 'dcp', 'cpp']);
  await back.act(0, 'advance', { by: 'skip', located: true });
  await back.act(1, 'handover');
  const handed = await back.result;
  assert.equal(handed.ended, 'handed_over');
  assert.equal(handed.next, 1);
  assert.deepEqual(
    handed.steps!.map((step) => step.status),
    ['skipped', 'pending', 'pending'],
  );
  assert.match(handed.message, /把剩下的交给你.*从第 1 步起由你完成/);
  assert.equal(back.page.log.at(-1), 'clear visible "好，接下来交给我"');

  const ended = setup(three);
  await ended.act(0, 'advance', { by: 'click', located: true });
  await ended.act(1, 'end');
  const outcome = await ended.result;
  assert.equal(outcome.ended, 'ended_by_user');
  assert.equal(outcome.next, 2);
  assert.match(outcome.message, /用户在第 2 步结束了带做.*不要重新开始带做/);
  assert.equal(ended.page.log.at(-1), 'clear visible');

  // A turn that may only read cannot be handed the page: the step simply stays.
  const readonly = setup(three, { handover: false });
  await readonly.act(0, 'handover');
  const first = readonly.page.current!.token;
  await until(() => readonly.page.current?.token !== first, 'the step shown again');
  assert.equal(readonly.page.current!.index, 0);
  assert.equal(readonly.page.current!.handover, false);
  await readonly.act(0, 'end');
  await readonly.result;
});

test('a guide ends when it is stopped, when the browser goes away, or when nobody finishes it', async () => {
  const abort = new AbortController();
  const stopped = setup(three, { signal: abort.signal });
  await stopped.act(0, 'advance', { by: 'click', located: true });
  await until(() => stopped.page.current?.index === 1, 'the second step');
  abort.abort();
  const outcome = await stopped.result;
  assert.equal(outcome.ended, 'stopped');
  assert.equal(stopped.page.current, undefined);
  assert.deepEqual(stopped.marks().at(-1), 'dpp');

  // Ending it from the conversation is the user's decision, like ending it on the page.
  const declined = new AbortController();
  const ended = setup(three, { signal: declined.signal });
  await until(() => ended.page.current?.index === 0, 'the first step');
  declined.abort('ended_by_user');
  const decision = await ended.result;
  assert.equal(decision.ended, 'ended_by_user');
  assert.match(decision.message, /不要重新开始带做/);
  assert.equal(ended.page.current, undefined);

  const closed = setup(three);
  await until(() => closed.page.current?.index === 0, 'the first step');
  closed.page.alive = false;
  assert.equal((await closed.result).ended, 'page_closed');

  const forgotten = setup(three, { pace: { ...pace, limit: 40 } });
  const late = await forgotten.result;
  assert.equal(late.ended, 'timed_out');
  assert.match(late.message, /停在第 1 步/);
});

test('the guide moves with the user to another tab', async () => {
  const { page, result, act } = setup(three);
  await until(() => page.current?.index === 0, 'the first step');
  const before = page.current!.token;
  page.tab = 'tab-b';
  await until(() => page.current?.token !== before && page.current?.index === 0, 'the step again');
  assert.deepEqual(page.log, ['clear tab-a']);
  await act(0, 'end');
  await result;
});
