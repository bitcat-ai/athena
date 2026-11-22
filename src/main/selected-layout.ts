import type { ChatMessage, ElementMention } from '../shared/types';

/** An explicit desktop arrangement of named selections. Extra requirements stay with the model. */
export interface SelectedLayout {
  ref: string;
  otherRef?: string;
  direction: 'row' | 'column';
  revision: number;
}

export function selectedLayout(
  text: string,
  mentions: ElementMention[],
  revision: number,
): SelectedLayout | undefined {
  if (
    mentions.length < 1 ||
    mentions.length > 2 ||
    text.length > 140 ||
    mentions.some((m) => m.edit)
  )
    return;
  const tokens = text.match(/\[ele\d+\]/g) ?? [];
  if (tokens.length !== mentions.length || new Set(tokens).size !== tokens.length) return;
  const ordered = tokens.map((token) => mentions.find((m) => m.token === token));
  if (ordered.some((m) => !m)) return;
  const sentence = text
    .replace(/\[ele\d+\]/g, '@')
    .replace(/\s+/g, '')
    .replace(/[。！!]$/, '');
  const subject =
    mentions.length === 1
      ? /^(?:请)?(?:把|将|让)?@(?:把|将|让)?(?:它|这个标题|标题)?(?:与|和|跟)(?:它的|旁边的|下面的)?副标题[，,]?/
      : /^(?:请)?(?:把|将|让)?@(?:与|和|跟|、)?@(?:这两个元素|这两项|它们)?[，,]?/;
  const match = subject.exec(sentence);
  if (!match) return;
  const instruction = sentence.slice(match[0].length);
  const layout =
    /^(?:(?:请)?(?:改|调|设|排)(?:成|为)|改一下|使用|采用)?(左右|横向|并排|上下|纵向|垂直)(?:布局|排列|排布|显示|放置|排)?$/.exec(
      instruction,
    );
  if (!layout) return;
  return {
    ref: ordered[0]!.ref,
    otherRef: ordered[1]?.ref,
    direction: ['左右', '横向', '并排'].includes(layout[1]) ? 'row' : 'column',
    revision,
  };
}

export function isSelectedAppearance(text: string) {
  return (
    text.length <= 180 &&
    !/(源码|代码|文件|仓库|实现|保存|需求|规则|规范|知识|参考|整页|全站|其他页面|项目|沙箱|code|repo|files?)/i.test(
      text,
    ) &&
    /(改|设|调|换|排|对齐|resize|change|align)/i.test(text) &&
    /(布局|排列|字号|字体|颜色|间距|边距|圆角|背景|宽度|高度|加粗|左对齐|右对齐|color|font|padding|margin|layout|spacing)/i.test(
      text,
    )
  );
}

/** These local turns are present in Athena history but have never reached the provider thread. */
export function recentLocalPreviews(messages: ChatMessage[]) {
  const previews = [];
  for (let i = messages.length - 1; i > 0 && previews.length < 4; i -= 2) {
    const answer = messages[i],
      request = messages[i - 1];
    if (!answer.localPreview || request.role !== 'user') break;
    if (answer.status !== 'done') continue;
    previews.unshift({
      request: request.text.slice(0, 200),
      targets: request.mentions?.map((m) => m.name.slice(0, 100)),
      result: answer.text.slice(0, 240),
      receipt: answer.tools?.find((t) => t.name === 'workbench_selection_layout')?.output,
    });
  }
  return previews.length
    ? `<recent_local_previews>\n以下是宿主已完成的本地预览记录。当前页面状态仍需以有效引用和读取结果为准。\n${JSON.stringify(previews).replace(/</g, '\\u003c')}\n</recent_local_previews>`
    : '';
}
