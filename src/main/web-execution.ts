import { randomUUID } from 'node:crypto';
import type { AgentPlanStep, BrowserTool, WebExecutionEvent } from '../shared/types';

type Observation = { id: string; page?: number; revision: number; text: string };
type Recovery = { page?: number; signature: string; observation?: Observation };

export const planTool: BrowserTool = {
  name: 'neo_plan',
  description:
    '发布或更新多步骤网页任务的简短计划。只写用户可理解的目标和真实状态，不包含内部推理、凭据或虚构进度。完成步骤需由页面检查点支持。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 30,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            step: { type: 'string', maxLength: 500 },
            status: { type: 'string', enum: ['pending', 'inProgress', 'completed'] },
          },
          required: ['step', 'status'],
        },
      },
    },
    required: ['steps'],
  },
};

export const checkpointTool: BrowserTool = {
  name: 'neo_checkpoint',
  description:
    '记录网页任务的可核对检查点。引用最近工具返回的 observationId，并提供其中原样出现的短证据。操作失败或等待未匹配后，必须先 snapshot/read/grep 检查实际状态，再以 verified（已发生，无需重放）、not_applied（确认未发生，可重新规划）或 unknown（仍未知，等待人工）核对。恢复期间可用 tabs new 打开回执页检查；跨页面证据必须用 recoveryPage 指明原失败页编号。未知结果不能重放提交。检查点是有证据的 Agent 判断，不替代页面或服务端事实。',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      observationId: { type: 'string' },
      summary: { type: 'string', maxLength: 500 },
      evidence: { type: 'string', maxLength: 500 },
      outcome: { type: 'string', enum: ['verified', 'not_applied', 'unknown'] },
      recoveryPage: { type: 'integer', minimum: 1 },
    },
    required: ['observationId', 'summary', 'evidence', 'outcome'],
  },
};

/** A task-local recovery barrier. It never retries an operation or infers business success. */
export class WebExecution {
  private revision = 0;
  private observations = new Map<string, Observation>();
  private recovery?: Recovery;
  private completedActions = new Set<string>();
  constructor(
    readonly taskId: string,
    private publish: (event: WebExecutionEvent) => void,
  ) {
    this.emit({ kind: 'started', status: 'running' });
  }
  emit(event: Omit<WebExecutionEvent, 'id' | 'taskId' | 'at'>) {
    this.publish({ id: randomUUID(), taskId: this.taskId, at: Date.now(), ...event });
  }
  plan(value: unknown): string {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > 30 ||
      value.some(
        (step) =>
          !step ||
          typeof step.step !== 'string' ||
          !step.step.trim() ||
          step.step.length > 500 ||
          !['pending', 'inProgress', 'completed'].includes(step.status),
      )
    )
      throw new Error('计划需要 1–30 个简短步骤及有效状态');
    const plan: AgentPlanStep[] = value.map((step) => ({ step: step.step, status: step.status }));
    this.emit({
      kind: 'plan',
      status: plan.every((step) => step.status === 'completed') ? 'succeeded' : 'running',
      plan,
    });
    return '计划已记录。每个完成状态仍需实际结果核验，不能替代检查点。';
  }
  assertCanMutate(signature: string) {
    if (this.recovery)
      throw new Error(
        '上次动作结果尚未核对：先用 snapshot/read/grep 重新观察，再用 neo_checkpoint 引用证据。不能重放提交；仍未知时请求人工处理。',
      );
    if (this.completedActions.has(signature))
      throw new Error('该操作已确认生效，不能重复执行。请检查结果并继续后续步骤。');
  }
  confirmMutation(signature: string) {
    this.completedActions.add(signature);
  }
  mutate() {
    this.revision++;
    this.observations.clear();
  }
  requireRecovery(signature: string, page?: number) {
    // Further failed waits/help cannot erase the original uncertain action or its target.
    this.recovery ??= { signature, page };
    this.recovery.observation = undefined;
    this.observations.clear();
    this.emit({ kind: 'recovery', status: 'blocked', page, outcome: 'unknown' });
  }
  observe(text: string, page?: number): string {
    const observation: Observation = { id: randomUUID(), page, revision: this.revision, text };
    // Only the most recent result per page can support a checkpoint.
    for (const [id, old] of this.observations) if (old.page === page) this.observations.delete(id);
    this.observations.set(observation.id, observation);
    if (this.observations.size > 30)
      this.observations.delete(this.observations.keys().next().value!);
    if (this.recovery && (this.recovery.page === undefined || this.recovery.page === page))
      this.recovery.observation = observation;
    this.emit({ kind: 'observation', status: 'succeeded', page, observationId: observation.id });
    return observation.id;
  }
  checkpoint(args: Record<string, unknown>): string {
    const { observationId, summary, evidence, outcome } = args;
    if (
      typeof observationId !== 'string' ||
      typeof summary !== 'string' ||
      !summary.trim() ||
      summary.length > 500 ||
      typeof evidence !== 'string' ||
      !evidence.trim() ||
      evidence.length > 500 ||
      !['verified', 'not_applied', 'unknown'].includes(String(outcome))
    )
      throw new Error('检查点需要 observationId、简短 summary、原文 evidence 和有效 outcome');
    const observation = this.observations.get(observationId);
    if (
      !observation ||
      observation.revision !== this.revision ||
      !observation.text.includes(evidence)
    )
      throw new Error('检查点证据不是最近一次页面观察的原文。请重新读取实际结果后再核对。');
    if (
      this.recovery &&
      this.recovery.observation !== observation &&
      (args.recoveryPage !== this.recovery.page || this.recovery.page === undefined)
    )
      throw new Error('请先重新观察失败动作所在页面，再核对该动作的结果。');
    this.emit({
      kind: 'checkpoint',
      status: outcome === 'unknown' ? 'blocked' : 'succeeded',
      page: observation.page,
      observationId,
      outcome: outcome as WebExecutionEvent['outcome'],
      summary,
      evidence,
    });
    if (outcome === 'unknown') {
      this.requireRecovery('', observation.page);
      return '结果仍未知。保留恢复屏障；继续只读核对或请求人工处理，不能重放提交。';
    }
    if (this.recovery) {
      if (outcome === 'verified' && this.recovery.signature)
        this.confirmMutation(this.recovery.signature);
      this.recovery = undefined;
      this.emit({
        kind: 'recovery',
        status: 'succeeded',
        page: observation.page,
        observationId,
        outcome: outcome as 'verified' | 'not_applied',
      });
    }
    return '已记录有页面证据的检查点。verified 表示结果已发生，不能重放；not_applied 后需使用新引用重新规划。';
  }
  get needsRecovery() {
    return Boolean(this.recovery);
  }
}
