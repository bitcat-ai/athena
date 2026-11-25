/**
 * Extreme content a page can be tried on with: each replaces the text that is there with a harder
 * case of itself, so the layout shows what it does with it. No model is involved.
 */
export interface PageStress {
  id: 'long' | 'empty' | 'numbers' | 'pseudo' | 'rtl';
  label: string;
  /** What the case stands for, shown beside its name. */
  hint: string;
}
export const PAGE_STRESSES: PageStress[] = [
  { id: 'long', label: '超长内容', hint: '每段文字变成三倍长，单个词接上一个很长的姓氏' },
  { id: 'empty', label: '清空内容', hint: '所有文字清空，看空状态下布局是否塌陷' },
  { id: 'numbers', label: '大数字', hint: '页面上的数字换成十位数金额' },
  { id: 'pseudo', label: '伪翻译', hint: '加重音并加长四成，模拟德语等更长的语言' },
  { id: 'rtl', label: '从右到左', hint: '换成阿拉伯语并把页面方向改为从右到左' },
];
export const STRESS_PROBLEMS = {
  page: '整页出现横向滚动',
  clipped: '内容被截断',
  overflow: '撑出了容器',
  overlap: '与相邻元素重叠',
  wrapped: '被挤成多行',
  collapsed: '清空后塌陷',
} as const;
export interface StressIssue {
  problem: keyof typeof STRESS_PROBLEMS;
  selector: string;
  tag: string;
  /** The text the element held before, so a person can tell which one it is. */
  was: string;
  /** Which marked element on the page this is; absent for a finding about the whole page. */
  mark?: number;
}
export interface StressResult {
  kind: PageStress['id'];
  editId: string;
  replaced: number;
  issues: StressIssue[];
}
/** Page data arrives as text from the page's own script: keep only what the shape allows. */
export function readStressIssues(value: unknown): StressIssue[] {
  if (!Array.isArray(value)) return [];
  const issues: StressIssue[] = [];
  for (const item of value.slice(0, 60)) {
    if (!item || typeof item !== 'object') continue;
    const { problem, selector, tag, was, mark } = item as Record<string, unknown>;
    if (typeof problem !== 'string' || !Object.hasOwn(STRESS_PROBLEMS, problem)) continue;
    issues.push({
      problem: problem as StressIssue['problem'],
      selector: typeof selector === 'string' ? selector.slice(0, 160) : '',
      tag: typeof tag === 'string' ? tag.slice(0, 40) : '',
      was: typeof was === 'string' ? was.slice(0, 40) : '',
      ...(Number.isSafeInteger(mark) && (mark as number) >= 0 ? { mark: mark as number } : {}),
    });
  }
  return issues;
}
/** What to ask the agent for once the weak spots are known. */
export function stressPrompt(result: StressResult): string {
  const label = PAGE_STRESSES.find((item) => item.id === result.kind)?.label ?? result.kind;
  return [
    `我把这个页面的内容换成了「${label}」来试它的布局，发现 ${result.issues.length} 处问题：`,
    ...result.issues.map(
      (issue, index) =>
        `${index + 1}. ${STRESS_PROBLEMS[issue.problem]}：${issue.selector}${issue.was ? `（原文「${issue.was}」）` : ''}`,
    ),
    '请逐个修改这些元素的样式，让它们在这种内容下也不破版，也不影响原来内容下的样子。改完告诉我每一处是怎么处理的。',
  ].join('\n');
}
