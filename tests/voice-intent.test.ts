import assert from 'node:assert/strict';
import test from 'node:test';
import {
  voiceIntent,
  voiceRelay,
  type VoiceIntent,
  type VoiceRelay,
} from '../src/shared/voice-intent';

/**
 * Spoken requests with what they are for. The first block is taken from real calls; the rest
 * covers the forms a request and a question take in speech, with and without punctuation.
 */
const spoken: Array<[string, VoiceIntent]> = [
  // From the call of 2026-11-22 in which a question changed an input field.
  ['哎,你怎么知道我要改的是这个按钮啊没有没有,我没有指针,你重新帮我改一下,就是应用标题旁边那个输入框你看到了吗', 'ask'],
  ['哈喽嗯你能做什么嗯难道我现在的网页吗', 'ask'],
  ['呃,你帮我把按钮改成橙色的', 'act'],
  ['呃,你等它结束后通知我吧啊不用,你接着帮我把页面改成复古的风格吧', 'act'],
  // Questions and confirmations.
  ['应用标题旁边那个输入框你看到了吗', 'ask'],
  ['应用标题旁边那个输入框你看到了吗？', 'ask'],
  ['你重新帮我改一下就是应用标题旁边那个输入框你看到了吗', 'ask'],
  ['你能看到我现在打开的网页吗', 'ask'],
  ['这个页面是讲什么的', 'ask'],
  ['标题在哪', 'ask'],
  ['页面上有几个按钮', 'ask'],
  ['是不是右上角那个', 'ask'],
  ['你说的是哪个按钮', 'ask'],
  ['这个输入框是干什么用的？', 'ask'],
  ['那个深色按钮你找到了没', 'ask'],
  ['为什么它是黑色的', 'ask'],
  ['你知道我指的是哪一块吗', 'ask'],
  ['嗯，下面那段文字，看得见吗', 'ask'],
  ['现在这个页面有登录入口吗', 'ask'],
  ['刚才那个按钮现在是什么颜色', 'ask'],
  ['搜索框在哪', 'ask'],
  ['那个输入框现在是什么颜色', 'ask'],
  ['你看到那个设置按钮了吗', 'ask'],
  // Requests, including ones phrased as a question.
  ['把这个改大一点', 'act'],
  ['能把按钮改成橙色吗', 'act'],
  ['可以帮我把标题换成更有力的说法吗', 'act'],
  ['把标题改成红色，可以吗', 'act'],
  ['把它改成红色，你觉得怎么样', 'act'],
  ['把那个输入框的边框改成橙色', 'act'],
  ['帮我把页面改成复古的风格吧', 'act'],
  ['撤销刚才的修改', 'act'],
  ['恢复成原来的黑色', 'act'],
  ['打开百度', 'act'],
  ['帮我搜索一下明天的天气', 'act'],
  ['在标题下面加一个副标题', 'act'],
  ['把导航栏隐藏掉', 'act'],
  ['删掉最后一段', 'act'],
  ['总结一下这一页', 'act'],
  ['点一下应用标题那个按钮', 'act'],
  ['在输入框里填上你好', 'act'],
  ['让字体再大一号，行吗', 'act'],
  // Answers to a question Athena asked: they complete a request and stay with the agent.
  ['橙色的', 'act'],
  ['对，就是它', 'act'],
  ['好的', 'act'],
  ['左边那个', 'act'],
];

test('a spoken question is never taken for a request to change something', () => {
  const wrong = spoken.filter(([text, expected]) => voiceIntent(text) !== expected);
  // The dangerous direction: a question let through as a request.
  const leaked = wrong.filter(([, expected]) => expected === 'ask');
  // The safe direction: a request held back, which costs the person one more sentence.
  const held = wrong.filter(([, expected]) => expected === 'act');
  const asks = spoken.filter(([, expected]) => expected === 'ask').length;
  console.log(
    `voice intent: ${spoken.length} requests, questions let through ${leaked.length}/${asks}, requests held back ${held.length}/${spoken.length - asks}`,
  );
  assert.deepEqual(leaked, [], 'questions that would have been allowed to change the page');
  assert.deepEqual(held, [], 'requests that would have needed to be said again');
});

test('an empty or unreadable request is left to the agent, which asks', () => {
  assert.equal(voiceIntent(''), 'act');
  assert.equal(voiceIntent('   '), 'act');
});

/** Words spoken while an earlier request is still being carried out. */
const interrupting: Array<[string, VoiceRelay]> = [
  ['不对，改成蓝色', 'revise'],
  ['不是这个按钮，是右上角那个', 'revise'],
  ['哎不对不对，我说的是输入框', 'revise'],
  ['算了还是绿色吧', 'revise'],
  ['改成红色', 'revise'],
  ['别改按钮了，改标题', 'revise'],
  ['重新来，用衬线字体', 'revise'],
  ['等一下，颜色再深一点', 'revise'],
  ['再把标题加粗', 'add'],
  ['另外把副标题也改短', 'add'],
  ['还有，下面那段文字放大一点', 'add'],
  ['顺便把导航栏隐藏掉', 'add'],
  ['然后总结一下', 'add'],
  ['嗯，然后把字调大', 'add'],
  ['改完之后帮我总结一下这一页', 'add'],
  ['对了，标题现在是什么颜色', 'add'],
  ['这个按钮是干什么用的', 'add'],
  ['这个标题是不是太大了', 'add'],
  ['不对吧，你看到的是哪个按钮', 'add'],
  ['把别的按钮也改成蓝色', 'revise'],
  ['另外把特别大的那张图缩小', 'add'],
  ['停', 'stop'],
  ['停下', 'stop'],
  ['算了，停下吧', 'stop'],
  ['取消', 'stop'],
  ['呃，不用了', 'stop'],
  ['别改了', 'stop'],
  ['好的', 'ack'],
  ['同意，执行', 'ack'],
  ['嗯嗯，可以', 'ack'],
  ['谢谢', 'ack'],
  ['好的继续吧', 'ack'],
  ['好的，再把标题加粗', 'revise'],
  ['好了吗', 'status'],
  ['做到哪了', 'status'],
  ['还要多久', 'status'],
  ['改完了没有', 'status'],
  ['怎么样了', 'status'],
];

test('words spoken during a task are told apart: a change, something more, stop, or how it is going', () => {
  const wrong = interrupting.filter(([text, expected]) => voiceRelay(text) !== expected);
  // Stopping work that should have continued is the costly mistake; count it on its own.
  const interrupted = wrong.filter(([, expected]) => ['add', 'status', 'ack'].includes(expected));
  console.log(
    `voice relay: ${interrupting.length} interruptions, wrong ${wrong.length}, work stopped needlessly ${interrupted.length}`,
  );
  assert.deepEqual(wrong.map(([text]) => [text, voiceRelay(text)]), []);
});
