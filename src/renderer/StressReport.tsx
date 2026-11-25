import { useRef } from 'react';
import {
  PAGE_STRESSES,
  STRESS_PROBLEMS,
  type StressResult,
} from '../shared/page-stress';
import { ActionButton } from './ui';
import './stress-report.css';

const short: Record<keyof typeof STRESS_PROBLEMS, string> = {
  page: '横向滚动',
  clipped: '截断',
  overflow: '溢出',
  overlap: '重叠',
  wrapped: '换行',
  collapsed: '塌陷',
};

/** What trying the page on with extreme content found, with a way to look at each spot and to hand them over. */
export function StressReport({
  result,
  disabled,
  onReveal,
  onFix,
  onRestore,
}: {
  result: StressResult;
  disabled: boolean;
  onReveal: (mark: number) => void;
  onFix?: () => void;
  onRestore: () => void;
}) {
  const label = PAGE_STRESSES.find((item) => item.id === result.kind)?.label ?? result.kind;
  const count = result.issues.length;
  // One chip per kind of problem; pressing it again walks through the places of that kind.
  const turn = useRef<Record<string, number>>({});
  const groups = (Object.keys(short) as Array<keyof typeof short>)
    .map((problem) => ({
      problem,
      issues: result.issues.filter((issue) => issue.problem === problem),
    }))
    .filter((group) => group.issues.length);
  return (
    <div
      className="stress-report"
      role="group"
      aria-label={`压测结果：${label}`}
      data-clean={count === 0 || undefined}
    >
      <span className="stress-report-lead" role="status">
        <strong>{label}</strong>
        {count
          ? `发现 ${count} 处问题`
          : `替换了 ${result.replaced} 处文字，没有发现截断、溢出、重叠或换行`}
      </span>
      {count > 0 && (
        <span className="stress-report-issues">
          {groups.map(({ problem, issues }) => {
            const marks = issues.flatMap((issue) => (issue.mark === undefined ? [] : [issue.mark]));
            return (
              <ActionButton
                key={problem}
                className="stress-issue"
                title={
                  marks.length
                    ? `${STRESS_PROBLEMS[problem]}：点击逐个查看`
                    : STRESS_PROBLEMS[problem]
                }
                isDisabled={disabled || !marks.length}
                onPress={() => {
                  const at = (turn.current[problem] ?? -1) + 1;
                  turn.current[problem] = at;
                  onReveal(marks[at % marks.length]);
                }}
              >
                {short[problem]}
                {problem === 'page' ? '' : ` ${issues.length}`}
              </ActionButton>
            );
          })}
        </span>
      )}
      <span className="stress-report-actions">
        {count > 0 && onFix && (
          <ActionButton className="stress-fix" isDisabled={disabled} onPress={onFix}>
            交给 Athena 修
          </ActionButton>
        )}
        <ActionButton className="stress-restore" isDisabled={disabled} onPress={onRestore}>
          恢复原样
        </ActionButton>
      </span>
    </div>
  );
}
