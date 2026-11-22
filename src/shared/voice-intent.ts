/**
 * What a spoken request is for. Only a clear question is singled out: it is the one case the
 * host enforces, by starting the turn unable to change the page. Everything else stays with
 * the agent, so a wrong reading here can make Athena ask again but never change something.
 */
export type VoiceIntent = 'ask' | 'act';

const fillers = /^(?:嗯+|呃+|啊+|哎+|诶+|哦+|喂+|那个|就是说?|然后|那|你|请)+/;
/** Words that ask for something to be done to the page or elsewhere. */
const acting =
  /改|换|调|添加|加上|加个|加一|加到|加粗|删|去掉|移|挪|拖|设置|设成|设为|变成|变为|做成|弄成|放大|缩小|隐藏|撤销|撤回|恢复|还原|填(?!空)|输入(?!框|法)|点击|点一下|点开|打开|关闭|关掉|跳转|搜索(?!框|栏)|搜一下|新建|创建|生成|画一|总结|整理|翻译|对齐|居中|保存|提交|发送|运行|执行|帮我把|替我把/;
const asking =
  /吗|嘛[？?]?$|呢[？?]?$|[？?]|是不是|有没有|(?<!不)对不对|能不能|可不可以|看到了?没|看见了?没|在哪|哪个|哪里|哪儿|哪些|什么|多少|怎么|为什么|为啥|是否|几个/;
/** "…你看到了吗": asking whether something is seen is a question whatever came before it. */
const perceiving = /(?:看到|看见|看得到|看得见|找到|找得到|注意到|认得|知道)[^，,。.]{0,8}?(?:吗|嘛|没|没有|么|不)[？?。.！!\s]*$/;
/** A tag at the end of a complete request: "把它改成红色，可以吗". */
const tag = /^(?:可以|好|行|成|能|ok|okay|对|是)(?:吗|嘛|不|么|不行|不好|不可以|吧)?[？?]?$/i;

function clauses(text: string): string[] {
  return text
    .split(/[，,。.！!；;、\n]+|(?<=[？?])/)
    .map((part) => part.trim().replace(fillers, '').trim())
    .filter(Boolean);
}

export function voiceIntent(text: string): VoiceIntent {
  const spoken = text.trim();
  if (!spoken) return 'act';
  const parts = clauses(spoken);
  while (parts.length > 1 && tag.test(parts.at(-1)!)) parts.pop();
  const last = parts.at(-1) ?? '';
  if (perceiving.test(spoken.replace(/[，,]\s*(?:可以|好|行)[吗嘛不]?[？?]?\s*$/, ''))) return 'ask';
  // The sentence ends on a question that asks for nothing to be done.
  if (asking.test(last) && !acting.test(last)) {
    // "把它改成红色，你觉得怎么样" still asks for the change; a trailing question about the
    // thing itself does not carry an earlier, unfinished "改一下" with it.
    const earlier = parts.slice(0, -1).join('，');
    return /(?:改|换|调|设|变|做|弄)(?:成|为|到)\S/.test(earlier) && /觉得|怎么样|如何|好不好|行不行/.test(last)
      ? 'act'
      : 'ask';
  }
  if (parts.some((part) => acting.test(part))) return 'act';
  // No request to do anything and a question somewhere: a question.
  return parts.some((part) => asking.test(part)) ? 'ask' : 'act';
}

/**
 * What to do with words spoken while an earlier request is still being carried out.
 * - `revise`: the request changed; stop the work and carry on from where it got to.
 * - `add`: something more; do it after the work in hand.
 * - `stop`: stop, with nothing new to do.
 * - `status`: a question about the work in hand; answer without disturbing it.
 */
export type VoiceRelay = 'revise' | 'add' | 'stop' | 'status';

const stopping =
  /^(?:(?:先|就|那)?(?:停下来|停一下|停下|停止|停|取消|暂停|算了|不用改了|不用了|别(?:改|做|弄|搞)了|不要(?:改|做|弄|搞)了|不做了|不改了)(?:吧|啊|了)?)+$/;
const progress =
  /(?:好|完成|做完|改完|弄完|结束)了(?:吗|嘛|没|没有)|(?:做|改|弄|进行)到哪|还要多久|还有多久|进度|怎么样了|还在(?:做|改|弄|忙)吗|还没好/;
const adding = /^(?:再|另外|还有|顺便|然后|接着|对了|同时|以及|完了(?:之后)?|(?:做|改|弄)完(?:之后|以后|了)?|等(?:它|你|这个)?(?:做|改|弄)?完)/;
const correcting = /不对|不是|错了|搞错|弄错|别|不要|不用|算了|重新|停/;

export function voiceRelay(text: string): VoiceRelay {
  // Only interjections are dropped here: "然后" and "那" are what mark an addition.
  const bare = text.replace(/[，,。.！!？?；;、\s]/g, '').replace(/^(?:嗯|呃|啊|哎|诶|哦|喂)+/, '');
  if (stopping.test(bare)) return 'stop';
  if (progress.test(bare)) return 'status';
  // Any other question is answered once the work in hand is done.
  if (correcting.test(bare)) return 'revise';
  if (voiceIntent(text) === 'ask') return 'add';
  return adding.test(bare) ? 'add' : 'revise';
}
