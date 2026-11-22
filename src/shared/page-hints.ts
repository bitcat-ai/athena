/** Counts of what a page holds. They say nothing about its content. */
export interface PageFacts {
  fields: number;
  password: boolean;
  tables: number;
  paragraphs: number;
  characters: number;
  headings: number;
  prices: number;
}

/** Something Athena can do with the page that is open, offered before it is asked. */
export interface PageHint {
  id: string;
  label: string;
  /** What the offer leads to, shown under its name. */
  detail: string;
  /** The request that is sent when the offer is taken. */
  prompt: string;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function pageFacts(value: unknown): PageFacts | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  return {
    fields: number(item.fields),
    password: item.password === true,
    tables: number(item.tables),
    paragraphs: number(item.paragraphs),
    characters: number(item.characters),
    headings: number(item.headings),
    prices: number(item.prices),
  };
}

/** At most three offers, the most specific to this page first. */
export function pageHints(facts: PageFacts | undefined): PageHint[] {
  if (!facts) return [];
  const hints: PageHint[] = [];
  if (facts.password)
    hints.push({
      id: 'sign-in',
      label: '带我登录',
      detail: '一步步指给你看，由你输入',
      prompt: '带着我完成右侧页面的登录：每一步指给我看要点哪里、填哪里，由我自己输入。',
    });
  else if (facts.fields >= 3)
    hints.push({
      id: 'form',
      label: '带我填这张表单',
      detail: `页面上有 ${facts.fields} 个待填项`,
      prompt: '带着我把右侧页面的表单一步步填完：每一步指给我看要填哪里、该填什么。',
    });
  if (facts.tables >= 1)
    hints.push({
      id: 'table',
      label: '整理这张表格',
      detail: '读出数据，指出最突出的一项',
      prompt: '读取右侧页面里的表格，整理成一份清晰的 Markdown 表格，并说明其中最突出的数据。',
    });
  if (facts.prices >= 3)
    hints.push({
      id: 'prices',
      label: '比较这些价格',
      detail: `页面上有 ${facts.prices} 处价格`,
      prompt: '读取右侧页面上的商品和价格，列出对比，并指出最划算的选择。',
    });
  if (facts.paragraphs >= 4 && facts.characters >= 1200)
    hints.push({
      id: 'summary',
      label: '总结这一页',
      detail: '分条列出要点',
      prompt: '总结右侧这一页的要点，分条列出，并指出最值得注意的一点。',
    });
  if (facts.headings >= 1)
    hints.push({
      id: 'headline',
      label: '让标题更有力',
      detail: '直接在页面上预览，可撤销',
      prompt: '把右侧页面的主标题改得更有力量，直接在页面上预览。',
    });
  return hints.slice(0, 3);
}
