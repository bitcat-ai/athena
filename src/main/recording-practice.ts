import type { Recording, RecordedStep } from '../shared/types';
import type { BrowserRuntime } from './browser';
import type { GuideStep, PracticeTarget } from './browser-guide';
import { containsExample } from './recording-analysis';

type Practice = NonNullable<Recording['practice']>;
type Runtime = Pick<
  BrowserRuntime,
  'getState' | 'guide' | 'startRecording' | 'stopRecording' | 'verifyRecordedDownload'
>;

function objectLabel(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\r\n]/.test(value))
    throw new Error('请输入 1–120 个字符的对象名称或编号');
  return value.trim();
}

export function recordingPracticePlan(
  recording: Recording,
  input: Record<string, unknown>,
  url: string,
) {
  const workflow = recording.workflow;
  if (!workflow || workflow.revision !== input.revision) throw new Error('流程已更新，请重新查看');
  if (recording.truncated) throw new Error('录制未完整保存，请重新录制这段流程');
  const example = objectLabel(input.example),
    target = objectLabel(input.target);
  if (example.toLowerCase() === target.toLowerCase()) throw new Error('请选择与示例不同的新对象');
  if (workflow.questions.some((q) => !q.answer?.trim()))
    throw new Error('请先回答流程里待确认的问题');
  if (workflow.questions.length && input.rulesReviewed !== true)
    throw new Error('请确认这些回答适用于本次对象');
  if (typeof input.verifyCustomerZip !== 'boolean' || typeof input.excludeInternal !== 'boolean')
    throw new Error('请重新选择本次核验条件');
  if (
    input.expectedFeedback !== undefined &&
    (typeof input.expectedFeedback !== 'string' || input.expectedFeedback.length > 180)
  )
    throw new Error('页面提示最多 180 个字符');
  const expectedFeedback =
    typeof input.expectedFeedback === 'string' ? input.expectedFeedback.trim() : '';
  const page = new URL(url);
  if (!['https:', 'http:'].includes(page.protocol)) throw new Error('请打开录制对应的网站');
  const steps: GuideStep[] = [],
    targets: PracticeTarget[] = [];
  const replace = (s: string) =>
    s.replaceAll(example, (match, pos: number) => {
      const word = /[a-zA-Z0-9_]/;
      if (
        (word.test(example[0]) && word.test(s.charAt(pos - 1))) ||
        (word.test(example.at(-1)!) && word.test(s.charAt(pos + example.length)))
      )
        return match;
      return target;
    });
  const included = new Set(workflow.steps.flatMap((s) => s.stepIds));
  const usedRules = new Set<string>();
  const recorded = recording.steps.filter(
    (s) =>
      included.has(s.id) &&
      s.source === 'human' &&
      ['click', 'fill', 'select', 'key', 'edit', 'undo'].includes(s.kind),
  );
  if (!recorded.length) throw new Error('流程里没有可带做的人工操作');
  if (
    !recorded.some((s) =>
      [s.scopeText, s.value, s.target?.name, s.url].some(
        (value) => value && containsExample(value, example),
      ),
    )
  )
    throw new Error('示例对象与录制证据不一致，请使用原步骤中的名称或编号');
  const rulesFor = (step: RecordedStep) =>
    workflow.questions.filter((q) => q.stepIds.includes(step.id));
  const add = (step: GuideStep, match: PracticeTarget) => {
    steps.push(step);
    targets.push(match);
  };
  const initial = recording.steps.find((s) => s.kind === 'navigate');
  for (const [i, event] of recorded.entries()) {
    const at = new URL(event.url);
    if (initial?.tabId && event.tabId && initial.tabId !== event.tabId)
      throw new Error('请单独录制一个标签页中的流程');
    if (initial?.frameId && event.frameId && initial.frameId !== event.frameId)
      throw new Error('带做目前只支持主页面中的控件');
    if (at.origin !== page.origin)
      throw new Error('请打开录制对应的网站，同一次带做只支持一个网站');
    const element = event.target;
    const locator =
      element?.name && element.name !== element.tag && !element.name.includes('[hidden]')
        ? replace(element.name)
        : undefined;
    const stableSelector = element?.selector?.match(/^#[\w-]+$/)?.[0];
    const match: PracticeTarget = {
      origin: at.origin,
      pathname: at.pathname
        .split('/')
        .map((part) => (part === encodeURIComponent(example) ? encodeURIComponent(target) : part))
        .join('/'),
      object: target,
      inRow: Boolean(event.scopeText),
      tag: element?.tag,
    };
    const heading = event.scopeText?.toLowerCase().trim();
    if (heading && !containsExample(heading, example.toLowerCase()))
      throw new Error('示例对象与录制行不一致，请使用录制中的名称或编号');
    const next = recorded[i + 1];
    const previous = recorded[i - 1];
    if (
      event.kind === 'click' &&
      next &&
      ['fill', 'select'].includes(next.kind) &&
      element?.ref &&
      element.ref === next.target?.ref
    )
      continue;
    const linked = workflow.steps.find((s) => s.stepIds.includes(event.id))!;
    const rules = rulesFor(event);
    if (
      ['fill', 'select'].includes(event.kind) &&
      previous?.kind === 'click' &&
      element?.ref &&
      previous.target?.ref === element.ref
    )
      rules.push(...rulesFor(previous));
    for (const rule of rules) {
      if (usedRules.has(rule.question)) continue;
      usedRules.add(rule.question);
      add({ action: 'look', note: rule.question + '\n' + rule.answer }, match);
    }
    // A corrected toggle may intentionally differ from the demo; only the person sets it.
    if (!rules.length && typeof event.checked === 'boolean') match.checked = event.checked;
    const action =
      typeof event.checked === 'boolean'
        ? 'look'
        : event.kind === 'click'
          ? 'click'
          : event.kind === 'fill' || event.kind === 'select'
            ? 'input'
            : 'look';
    const label = locator || element?.tag || '页面';
    const note =
      rules.length && action === 'look'
        ? `按刚确认的规则核对「${label}」，需要时由你调整后继续。`
        : rules.length && action === 'click'
          ? `按确认的规则处理「${label}」。需要执行时，请亲自点击。`
          : typeof match.checked === 'boolean'
            ? `请${match.checked ? '勾选' : '取消勾选'}「${label}」后继续。`
            : event.kind === 'fill' && event.value === example
              ? `在「${label}」填入 ${target}`
              : replace(linked.note);
    if (!element?.tag || (!locator && !stableSelector))
      throw new Error('录制中有一步无法可靠定位，请重新录制并选用有名称的控件');
    add({ note, action, text: locator, selector: locator ? undefined : stableSelector }, match);
  }
  for (const rule of workflow.questions) {
    if (usedRules.has(rule.question)) continue;
    if (!recording.steps.some((s) => rule.stepIds.includes(s.id)))
      throw new Error('规则缺少对应的原步骤');
    // A rule inferred from navigation or outcome evidence still applies to the practice.
    steps.unshift({ action: 'look', note: rule.question + '\n' + rule.answer });
    targets.unshift({ ...targets[0] });
  }
  if (steps.length > 12) throw new Error('本次带做超过 12 步，请录制一个较短的流程');
  if (page.pathname !== targets[0].pathname) throw new Error('请先打开这段流程的起始页面');
  return {
    steps,
    targets,
    target,
    origin: page.origin,
    verifyCustomerZip: input.verifyCustomerZip,
    excludeInternal: input.excludeInternal,
    expectedFeedback,
  };
}

export function pageFeedbackResult(trial: Recording, expected: string, tabId: string, url: string) {
  const frame = trial.steps[0]?.frameId;
  const page = new URL(url);
  const steps = trial.steps.filter(
    (s) =>
      frame && s.frameId === frame && s.tabId === tabId && s.url === page.origin + page.pathname,
  );
  const lastAction = steps.findLastIndex(
    (s) => s.source === 'human' && ['click', 'fill', 'select', 'key', 'navigate'].includes(s.kind),
  );
  const message =
    lastAction < 0
      ? undefined
      : steps.slice(lastAction + 1).findLast((s) => s.feedback)?.feedback?.text;
  if (!message || trial.truncated)
    return { verification: 'unknown' as const, detail: '未观察到可核对的完整页面提示' };
  if (!expected)
    return { verification: 'unknown' as const, detail: `页面反馈「${message}」，业务结果未核验` };
  const matched = message.replace(/\s+/g, ' ').trim() === expected.replace(/\s+/g, ' ').trim();
  return {
    verification: matched ? ('passed' as const) : ('failed' as const),
    detail: matched
      ? `已核对页面提示「${message}」`
      : `预期提示「${expected}」，页面最后显示「${message}」`,
  };
}

export async function practiseRecording(
  browser: Runtime,
  plan: ReturnType<typeof recordingPracticePlan>,
  tabId: string,
  signal: AbortSignal,
  changed: (practice: Practice) => void,
): Promise<Practice> {
  const practice: Practice = {
    target: plan.target,
    status: 'guiding',
    progress: plan.steps.map(({ note }) => ({ note, status: 'pending' })),
    verification: 'unknown',
    detail: '等待完成页面操作',
  };
  const publish = () =>
    changed({ ...practice, progress: practice.progress.map((s) => ({ ...s })) });
  signal.throwIfAborted();
  if (browser.getState().recording) throw new Error('请先结束当前录制');
  browser.startRecording(undefined, undefined, { tabId, origin: plan.origin });
  let trial: Recording;
  try {
    publish();
    const result = await browser.guide(
      { title: '按录制流程带做', steps: plan.steps },
      {
        signal,
        practice: { tabId, targets: plan.targets },
        onProgress(p) {
          practice.progress = p.steps;
          publish();
        },
      },
    );
    const complete =
      result.ended === 'completed' &&
      result.steps?.length === plan.steps.length &&
      result.steps.every(
        (s, i) =>
          s.status === 'done' &&
          (s.located !== false || (!plan.steps[i].text && !plan.steps[i].selector)) &&
          (plan.steps[i].action !== 'click' || s.by === 'click') &&
          (plan.steps[i].action !== 'input' || s.filled === true),
      );
    practice.status = complete ? 'finished' : 'stopped';
    const issue =
      result.reason === 'ambiguous_target'
        ? '页面上有多个符合条件的控件'
        : result.reason === 'wrong_tab' ||
            result.reason === 'wrong_origin' ||
            result.reason === 'wrong_page'
          ? '当前页面与录制步骤不一致'
          : result.reason === 'not_found'
            ? '该对象的控件未找到'
            : '请核对目标位置和跳过的步骤';
    practice.detail = complete
      ? '已走完带做步骤，业务结果未核验'
      : signal.aborted
        ? '已停止带做，结果未核验'
        : `带做在第 ${result.next ?? (practice.progress.findIndex((s) => s.status !== 'done') + 1 || 1)} 步停止，${issue}。`;
  } finally {
    trial = await browser.stopRecording();
  }
  if (practice.status === 'finished' && plan.verifyCustomerZip && !signal.aborted) {
    const result = await browser.verifyRecordedDownload(trial, {
      customerId: plan.target,
      excludeInternal: plan.excludeInternal,
      tabId,
      origin: plan.origin,
      signal,
    });
    practice.verification = result.status;
    practice.detail = result.detail;
  } else if (practice.status === 'finished' && !signal.aborted) {
    const state = browser.getState();
    if (
      state.activeTabId === tabId &&
      URL.canParse(state.url) &&
      new URL(state.url).origin === plan.origin
    )
      Object.assign(practice, pageFeedbackResult(trial, plan.expectedFeedback, tabId, state.url));
  }
  if (signal.aborted) {
    practice.status = 'stopped';
    practice.verification = 'unknown';
    practice.detail = '已停止带做，结果未核验';
  }
  return practice;
}
