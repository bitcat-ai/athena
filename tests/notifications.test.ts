import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnNotifications } from '../src/main/notifications.ts';
import type { AgentEvent } from '../src/shared/types.ts';

const approval: AgentEvent = {
  type: 'approval',
  request: { id: 'a1', title: '允许修改文件？', detail: 'private command', kind: 'file' },
};

function fixture(source: 'desktop' | 'feishu' = 'feishu') {
  const sent: { id: string; text: string }[] = [];
  let failures = 0;
  const notifications = new TurnNotifications(
    { id: 'turn-one', title: '检查网页', source },
    async (id, text) => {
      sent.push({ id, text });
      return true;
    },
    () => failures++,
  );
  return { notifications, sent, failures: () => failures };
}

const question: AgentEvent = {
  type: 'user-input',
  request: {
    id: 'q0',
    questions: [{ id: 'which', header: '选择', question: '用哪个环境？', isSecret: false }],
  },
};

test('a conversation held on the desktop sends nothing to Feishu', async () => {
  for (const end of [
    { type: 'complete', text: '页面检查完成' },
    { type: 'error', message: '任务已停止' },
  ] satisfies AgentEvent[]) {
    const f = fixture('desktop');
    f.notifications.handle(approval);
    f.notifications.handle(question);
    await f.notifications.settled();
    f.notifications.handle(end);
    await f.notifications.settled();
    assert.deepEqual(f.sent, []);
    assert.equal(f.failures(), 0);
  }
});

test('a desktop turn still knows that it asked for protected information', () => {
  const f = fixture('desktop');
  f.notifications.handle({
    type: 'user-input',
    request: {
      id: 'secret-request',
      questions: [{ id: 'secret', header: 'Secret', question: 'secret content', isSecret: true }],
    },
  });
  assert.equal(f.notifications.includesSecretInput, true);
});

test('Feishu tasks hear once that they need attention, without command details or a second result', async () => {
  const f = fixture();
  f.notifications.handle(approval);
  f.notifications.handle(approval);
  await f.notifications.settled();
  f.notifications.handle({ type: 'complete', text: 'remote result' });
  f.notifications.handle({ type: 'complete', text: 'duplicate' });
  await f.notifications.settled();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /需要你审核/);
  assert.doesNotMatch(f.sent[0].text, /private command/);
});

test('a guide asks the user back to the page once, however often its card changes', async () => {
  const f = fixture();
  const guide = (current: number): AgentEvent => ({
    type: 'approval',
    request: {
      id: 'g1',
      kind: 'other',
      action: 'browser-guide',
      title: '带你做：开通套餐',
      detail: '跟着页面上的提示操作，每一步都由你自己完成。',
      guide: {
        steps: ['点“升级”', '填写公司名称'].map((note, at) => ({
          note,
          status: at < current ? 'done' : at === current ? 'current' : 'pending',
        })),
      },
    },
  });
  f.notifications.handle(guide(0));
  f.notifications.handle(guide(1));
  await f.notifications.settled();
  assert.deepEqual(
    f.sent.map((item) => item.text),
    ['Athena · 检查网页\n带你做：开通套餐\n请回到 Mac 上的 Athena，跟着页面上的提示操作。'],
  );
});

test('resolved and ended requests are discarded before delivery', async () => {
  const f = fixture();
  f.notifications.handle(approval);
  f.notifications.handle({ type: 'request-resolved', id: 'a1' });
  await f.notifications.settled();
  assert.equal(f.sent.length, 0);
  f.notifications.handle({ ...approval, request: { ...approval.request, id: 'a2' } });
  f.notifications.handle({ type: 'error', message: '任务已停止' });
  await f.notifications.settled();
  assert.equal(f.sent.length, 0);
});

test('question notification omits secret questions and strips access-bearing URLs', async () => {
  const f = fixture();
  f.notifications.handle({
    type: 'user-input',
    request: {
      id: 'q1',
      questions: [
        {
          id: 'choice',
          header: '选择',
          question: '选择 https://example.com/page?token=private#key',
          isSecret: false,
          options: [{ label: '继续', description: 'description' }],
        },
      ],
    },
  });
  await f.notifications.settled();
  assert.match(f.sent[0].text, /需要你的回答/);
  assert.match(f.sent[0].text, /https:\/\/example.com\/page/);
  assert.match(f.sent[0].text, /继续/);
  assert.doesNotMatch(f.sent[0].text, /secret content|token=|#key/);
  f.notifications.handle({
    type: 'user-input',
    request: {
      id: 'secret-request',
      questions: [{ id: 'secret', header: 'Secret', question: 'secret content', isSecret: true }],
    },
  });
  await f.notifications.settled();
  f.notifications.handle({
    type: 'user-input',
    request: {
      id: 'followup',
      questions: [
        {
          id: 'confirm',
          header: '确认',
          question: '继续使用 secret answer？',
          isSecret: false,
          options: [{ label: '使用 secret answer', description: 'private' }],
        },
      ],
    },
  });
  await f.notifications.settled();
  assert.doesNotMatch(f.sent[1].text, /secret content/);
  assert.doesNotMatch(f.sent[2].text, /secret answer/);
  assert.equal(f.notifications.includesSecretInput, true);
  f.notifications.handle({ type: 'complete', text: 'secret answer echoed by Agent' });
  await f.notifications.settled();
  assert.equal(f.sent.length, 3);
});

test('notification failures do not throw into Agent execution or prevent later delivery', async () => {
  const sent: string[] = [];
  let failures = 0;
  const n = new TurnNotifications(
    { id: 'two', title: 'test', source: 'feishu' },
    async (_id, text) => {
      sent.push(text);
      if (sent.length === 1) throw new Error('offline');
      return true;
    },
    () => failures++,
  );
  assert.doesNotThrow(() => n.handle(approval));
  await n.settled();
  n.handle({ ...approval, request: { ...approval.request, id: 'a2' } });
  await n.settled();
  assert.equal(failures, 1);
  assert.equal(sent.length, 2);
});
