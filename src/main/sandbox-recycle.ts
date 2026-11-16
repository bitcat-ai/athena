import { SANDBOX_POLICY_CHOICES, type SandboxPolicy } from '../shared/sandbox';

export const defaultSandboxPolicy: SandboxPolicy = {
  idleStopMinutes: 30,
  retainDays: 7,
  maxRunning: 4,
};
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A sandbox used this recently is never stopped to make room for another. */
const EVICTION_GRACE = MINUTE;

export function normalizePolicy(value: unknown): SandboxPolicy {
  const input = (value ?? {}) as Record<string, unknown>;
  const pick = <K extends keyof SandboxPolicy>(key: K) =>
    (SANDBOX_POLICY_CHOICES[key] as readonly number[]).includes(input[key] as number)
      ? (input[key] as number)
      : defaultSandboxPolicy[key];
  return {
    idleStopMinutes: pick('idleStopMinutes'),
    retainDays: pick('retainDays'),
    maxRunning: pick('maxRunning'),
  };
}

export interface RecycleItem {
  id: string;
  lastUsedAt: number;
  keep: boolean;
  running: boolean;
  /** A command or a start is in progress inside it. */
  busy: boolean;
  /** Something outside depends on it right now: the current task, or its preview in a tab. */
  held: boolean;
}

/** When the host will act on an item that nothing touches in the meantime. */
export function recycleTimes(
  item: Pick<RecycleItem, 'lastUsedAt' | 'keep' | 'running'>,
  policy: SandboxPolicy,
) {
  return {
    stopsAt: item.running ? item.lastUsedAt + policy.idleStopMinutes * MINUTE : undefined,
    removesAt: item.keep ? undefined : item.lastUsedAt + policy.retainDays * DAY,
  };
}

/**
 * What one recycling pass does. Stopping only ends processes, so it applies to every idle
 * sandbox; removing deletes files, so it waits for the retention period and skips kept ones.
 * Nothing busy or held is touched, whatever its age.
 */
export function planRecycle(items: RecycleItem[], policy: SandboxPolicy, now: number) {
  const free = items.filter((item) => !item.busy && !item.held);
  const remove = free.filter((item) => {
    const { removesAt } = recycleTimes(item, policy);
    return removesAt !== undefined && now >= removesAt;
  });
  const gone = new Set(remove.map((item) => item.id));
  const stop = free.filter(
    (item) =>
      item.running &&
      !gone.has(item.id) &&
      now >= item.lastUsedAt + policy.idleStopMinutes * MINUTE,
  );
  for (const item of stop) gone.add(item.id);
  // A lowered limit takes effect on the least recently used ones.
  const running = items.filter((item) => item.running && !gone.has(item.id));
  const spare = running
    .filter((item) => !item.busy && !item.held)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  for (let excess = running.length - policy.maxRunning; excess > 0 && spare.length; excess--)
    stop.push(spare.shift()!);
  return { stop: stop.map((item) => item.id), remove: remove.map((item) => item.id) };
}

/**
 * Whether one more sandbox may start, and which one has to stop first. `full` means every
 * running sandbox is in use, so the caller must refuse instead of interrupting someone's work.
 */
export function makeRoom(others: RecycleItem[], policy: SandboxPolicy, now: number) {
  const running = others.filter((item) => item.running);
  if (running.length < policy.maxRunning) return { full: false as const };
  const [evict] = running
    .filter((item) => !item.busy && !item.held && now - item.lastUsedAt >= EVICTION_GRACE)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  return evict ? { full: false as const, evict: evict.id } : { full: true as const };
}
