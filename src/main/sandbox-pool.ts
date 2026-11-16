import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  LocalSandbox,
  localSandboxTools,
  type SandboxArtifact,
  type SandboxCallContext,
  type LocalSandboxUpdate,
} from './local-sandbox';
import { redact } from './sandbox-client';
import {
  defaultSandboxPolicy,
  makeRoom,
  normalizePolicy,
  planRecycle,
  recycleTimes,
  type RecycleItem,
} from './sandbox-recycle';
import {
  SANDBOX_RUNTIMES,
  type LocalSandboxView,
  type SandboxInstanceView,
  type SandboxInstancesState,
  type SandboxTarget,
} from '../shared/sandbox';

const targets: SandboxTarget[] = ['default', 'frontend', 'backend'];
const isTarget = (value: unknown): value is SandboxTarget =>
  targets.includes(value as SandboxTarget);
export const sandboxNames: Record<SandboxTarget, string> = {
  default: '默认沙箱',
  frontend: '前端沙箱',
  backend: '后端沙箱',
};
const MAX_USER_INSTANCES = 20;
const instanceName = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
const statusNames: Record<SandboxInstanceView['status'], string> = {
  starting: '启动中',
  running: '运行中',
  stopped: '已停止',
  failed: '启动失败',
};

export const sandboxPoolTools = localSandboxTools.map((tool) => ({
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    properties: {
      ...(tool.inputSchema as { properties: Record<string, unknown> }).properties,
      target: {
        type: 'string',
        enum: ['default', 'frontend', 'backend'],
        description:
          '独立沙箱：default 为原有 Node 环境；frontend 提供 Node/Git；backend 提供 Java 21/Maven/Node/Git。每次调用必须使用同一目标。',
      },
      sandbox: {
        type: 'string',
        maxLength: 40,
        description:
          '用户在「设置 › 沙箱」创建的实例名称。用户点名某个实例时填写并省略 target；可用实例见 athena_sandbox_status。',
      },
    },
  },
}));

/** One sandbox the host keeps track of: a container plus its files, wherever it came from. */
interface SandboxRecord {
  /** `sbx_…` for the user's own, `<conversation>:<target>` for an agent's, `legacy:<container>`. */
  id: string;
  name: string;
  runtime: SandboxTarget;
  origin: SandboxInstanceView['origin'];
  conversationId?: string;
  container: string;
  createdAt: number;
  lastUsedAt: number;
  keep: boolean;
}
const isRecord = (value: any): value is SandboxRecord =>
  typeof value?.id === 'string' &&
  typeof value.name === 'string' &&
  typeof value.container === 'string' &&
  isTarget(value.runtime) &&
  ['user', 'agent', 'legacy'].includes(value.origin) &&
  Number.isFinite(value.createdAt) &&
  Number.isFinite(value.lastUsedAt);

export type SandboxBackend = Pick<
  LocalSandbox,
  | 'prefix'
  | 'containerName'
  | 'open'
  | 'containers'
  | 'workspaces'
  | 'release'
  | 'call'
  | 'cancelTurn'
  | 'dispose'
>;
export interface SandboxPoolOptions {
  /** Conversations that still exist; a sandbox left by any other can only be removed. */
  conversations?: () => string[];
  /** True while something outside the pool depends on the sandbox, e.g. its preview in a tab. */
  held?: (instance: SandboxInstanceView) => boolean;
  onInstances?: (state: SandboxInstancesState) => void;
  /** A sandbox is gone; `key` is what its conversation called it (see `sandboxKey`). */
  onRemoved?: (conversationId: string | undefined, key: string) => void;
  now?: () => number;
  backend?: (
    target: SandboxTarget,
    onUpdate: (update: LocalSandboxUpdate) => void,
  ) => SandboxBackend;
}

/**
 * Every sandbox of this profile: the ones agents open per conversation and the ones the user
 * creates by name. The pool also recycles them: idle ones stop, unused ones are removed.
 */
export class SandboxPool {
  private entries = new Map<SandboxTarget, SandboxBackend>();
  private views = new Map<string, LocalSandboxView>();
  private records = new Map<string, SandboxRecord>();
  /** Docker's last reported state per container; refreshed before anything is recycled. */
  private containers = new Map<string, string>();
  private docker: SandboxInstancesState['docker'] = { available: true };
  private policy = defaultSandboxPolicy;
  private starting = new Map<string, AbortController>();
  /** Tool calls in progress per sandbox: such a sandbox is in use from their first moment. */
  private calls = new Map<string, number>();
  /** Sandboxes given a running place whose container Docker does not report as running yet. */
  private placed = new Map<string, number>();
  private reservations: Promise<void> = Promise.resolve();
  /** Stops and removals in progress; whoever wants the sandbox next waits for them. */
  private releasing = new Map<string, Promise<void>>();
  private failures = new Map<string, string>();
  /** The conversation that last used each of the user's instances. */
  private callers = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();
  private sweepTimer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private publishTimer?: NodeJS.Timeout;
  private sweeping = false;
  private closed = false;
  constructor(
    private directory: string,
    private program: string,
    private onArtifact: (turnId: string, artifact: SandboxArtifact) => void,
    private onChange: (state: LocalSandboxView) => void = () => {},
    private options: SandboxPoolOptions = {},
  ) {}
  private get file() {
    return path.join(this.directory, 'instances.json');
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** Reads the saved list. Docker is consulted afterwards, so a slow Docker never delays startup. */
  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      this.policy = normalizePolicy(saved.policy);
      for (const record of Array.isArray(saved.instances) ? saved.instances : [])
        if (isRecord(record))
          this.records.set(record.id, { ...record, keep: record.keep === true });
    } catch {
      // No list yet, or an unreadable one: whatever is on disk is picked up again below.
    }
    this.sweepTimer = setInterval(() => void this.sweep().catch(() => {}), 60_000);
    this.sweepTimer.unref();
    void this.reconcile().catch(() => {});
  }
  /** Brings the list in line with Docker and the disk, then recycles what is already due. */
  async reconcile() {
    await this.refresh();
    await this.adopt();
    await this.sweep();
    this.publish();
  }
  private async refresh() {
    try {
      const prefixes = targets.map((target) => this.backend(target).prefix);
      this.containers = new Map(
        [...(await this.backend('default').containers())].filter(([name]) =>
          prefixes.some((prefix) => name.startsWith(prefix)),
        ),
      );
      this.docker = { available: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      this.docker = {
        available: false,
        message: /Cannot connect to the Docker daemon|docker daemon running/i.test(message)
          ? 'Docker 没有运行，请启动 Docker Desktop'
          : message || 'Docker 不可用',
      };
    }
    return this.docker.available;
  }
  /**
   * Lists sandboxes that exist without being on the list, such as those made by versions
   * that never recycled anything. They are not deleted here: they get the usual retention
   * period, during which the user can see and remove them.
   */
  private async adopt() {
    const known = new Set([...this.records.values()].map((record) => record.container));
    const conversations = this.options.conversations?.() ?? [];
    let changed = false;
    for (const target of targets) {
      const backend = this.backend(target);
      const expected = new Map(conversations.map((id) => [backend.containerName(id), id]));
      const found = new Set([
        ...(await backend.workspaces()),
        ...[...this.containers.keys()].filter((name) => name.startsWith(backend.prefix)),
      ]);
      for (const container of found) {
        if (known.has(container)) continue;
        const conversationId = expected.get(container);
        const record: SandboxRecord = {
          id: conversationId ? `${conversationId}:${target}` : `legacy:${container}`,
          name: conversationId ? sandboxNames[target] : '已删除对话的沙箱',
          runtime: target,
          origin: conversationId ? 'agent' : 'legacy',
          conversationId,
          container,
          createdAt: this.now(),
          lastUsedAt: this.now(),
          keep: false,
        };
        this.records.set(record.id, record);
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  private backend(target: SandboxTarget) {
    let entry = this.entries.get(target);
    if (!entry) {
      const onUpdate = (update: LocalSandboxUpdate) => this.update(target, update);
      const runtime =
        target === 'default'
          ? undefined
          : {
              image: target === 'frontend' ? 'athena-sandbox-node:1' : 'athena-sandbox-java:1',
              dockerfile: path.join(
                path.dirname(this.program),
                'sandbox-images',
                target === 'frontend' ? 'node.Dockerfile' : 'java.Dockerfile',
              ),
            };
      entry =
        this.options.backend?.(target, onUpdate) ??
        new LocalSandbox(
          target === 'default' ? this.directory : path.join(this.directory, target),
          this.program,
          this.onArtifact,
          runtime,
          onUpdate,
        );
      this.entries.set(target, entry);
    }
    return entry;
  }
  state(conversationId: string) {
    return [...this.views.values()].filter((view) => view.conversationId === conversationId);
  }
  /** Name and environment of what a conversation calls `key` (see `sandboxKey`). */
  describe(key: string) {
    const record = this.records.get(key);
    if (record?.origin === 'user') return { name: record.name, runtime: record.runtime };
    return isTarget(key) ? { name: sandboxNames[key], runtime: key } : undefined;
  }
  private update(target: SandboxTarget, update: LocalSandboxUpdate) {
    // The user's instances run under their own id; an agent's under its conversation's.
    const instance = this.records.get(update.conversationId);
    const key = instance ? instance.id : update.conversationId + ':' + target;
    const state: LocalSandboxView = this.views.get(key) ?? {
      conversationId: instance ? '' : update.conversationId,
      target,
      ...(instance ? { instance: instance.id } : {}),
      connection: 'connecting',
      lines: [],
    };
    if (instance) state.conversationId = this.callers.get(instance.id) ?? state.conversationId;
    const line = (kind: LocalSandboxView['lines'][number]['kind'], text: string) => {
      for (const value of redact(text)
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .split(/\r?\n/)
        .filter(Boolean))
        state.lines.push({ kind, text: value.slice(-1200) });
      state.lines = state.lines.slice(-60);
    };
    if (update.type === 'connection') {
      state.name = update.name;
      state.connection = update.status === 'idle' ? 'closed' : update.status;
      if (update.status === 'ready') this.containers.set(update.name, 'running');
    } else if (update.type === 'preview')
      state.service = { status: update.status, url: update.url };
    else if (update.type === 'files')
      line('status', `已写入 ${update.paths.length} 个文件：${update.paths.join('、')}`);
    else if (update.type === 'service-command') {
      state.command = undefined;
      state.service = { ...state.service, status: 'starting' };
      line('command', '启动服务：' + update.command);
    } else if (update.type === 'event') {
      const event = update.data;
      if (event.type === 'command.state') {
        if (state.command?.id !== event.command.id) line('command', '$ ' + event.command.command);
        if (
          event.command.status !== 'running' &&
          (state.command?.id !== event.command.id || state.command?.status !== event.command.status)
        )
          line(
            'status',
            event.command.exitCode === undefined
              ? event.command.status
              : `退出码 ${event.command.exitCode}`,
          );
        state.command = { ...event.command, command: redact(event.command.command) };
      } else if (event.type === 'command.output') line(event.stream, event.text);
      else if (event.type === 'service.state') {
        if (event.service.status === 'starting') state.command = undefined;
        state.service = { ...state.service, status: event.service.status };
      }
      // A command that is still producing output keeps its sandbox in use.
      const record = this.records.get(key);
      if (record && event.type.startsWith('command.') && this.now() - record.lastUsedAt > 15_000)
        this.touch(record);
    }
    this.views.set(key, state);
    this.onChange(structuredClone(state));
    this.publish();
  }

  private present(record: SandboxRecord): SandboxInstanceView {
    const view = this.views.get(record.id);
    const starting = this.starting.has(record.id);
    const running = this.containers.get(record.container) === 'running';
    const message = this.failures.get(record.id);
    return {
      id: record.id,
      name: record.name,
      runtime: record.runtime,
      origin: record.origin,
      conversationId: record.conversationId ?? this.callers.get(record.id),
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      keep: record.keep,
      status: starting ? 'starting' : running ? 'running' : message ? 'failed' : 'stopped',
      busy:
        starting ||
        this.calls.has(record.id) ||
        view?.connection === 'connecting' ||
        (running && (view?.command?.status === 'running' || view?.service?.status === 'starting')),
      message,
      previewUrl: running && view?.service?.status === 'healthy' ? view.service.url : undefined,
      ...recycleTimes({ ...record, running }, this.policy),
    };
  }
  private snapshot(): SandboxInstancesState {
    return {
      docker: this.docker,
      policy: this.policy,
      instances: [...this.records.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((record) => this.present(record)),
    };
  }
  private items(): RecycleItem[] {
    return [...this.records.values()].map((record) => {
      const view = this.present(record);
      return {
        id: record.id,
        lastUsedAt: record.lastUsedAt,
        keep: record.keep,
        running: view.status === 'running' || this.placed.has(record.id),
        busy: view.busy,
        held: this.options.held?.(view) ?? false,
      };
    });
  }
  async instances(refresh = false) {
    if (refresh) await this.refresh();
    return this.snapshot();
  }
  /** For the agent: the instances the user made, so it can use one the user names. */
  prompt() {
    const users = this.snapshot().instances.filter((instance) => instance.origin === 'user');
    if (!users.length) return '';
    return `<athena_sandboxes>\n用户在「设置 › 沙箱」创建的实例：${users
      .map(
        (instance) =>
          `「${instance.name}」（${SANDBOX_RUNTIMES[instance.runtime]}，${statusNames[instance.status]}）`,
      )
      .join(
        '、',
      )}。用户点名其中一个时，在 athena_sandbox_* 的 sandbox 参数填它的名称并省略 target；已停止的实例会在调用时自动启动，文件仍在。未点名时照常使用 target。闲置的沙箱会被停止，长期不用的会连同文件一起回收，需要留存的结果用 athena_sandbox_artifact 导出。\n</athena_sandboxes>`;
  }

  private record(id: unknown) {
    const record = typeof id === 'string' ? this.records.get(id) : undefined;
    if (!record) throw new Error('找不到这个沙箱，它可能已被回收');
    return record;
  }
  private touch(record: SandboxRecord) {
    record.lastUsedAt = this.now();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save().catch(() => {}), 1000);
    this.publish();
  }
  private publish() {
    if (this.publishTimer || !this.options.onInstances) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      if (!this.closed) this.options.onInstances?.(this.snapshot());
    }, 100);
  }
  private save() {
    clearTimeout(this.saveTimer);
    const json = JSON.stringify(
      { version: 1, policy: this.policy, instances: [...this.records.values()] },
      null,
      2,
    );
    this.writes = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(`${this.file}.tmp`, json, { mode: 0o600 });
        await rename(`${this.file}.tmp`, this.file);
      });
    return this.writes;
  }

  private count(map: Map<string, number>, id: string, by: 1 | -1) {
    const next = (map.get(id) ?? 0) + by;
    if (next > 0) map.set(id, next);
    else map.delete(id);
  }
  /**
   * Gives a sandbox that is about to start one of the running places, to be handed back
   * through `placed` once the start is over. One request at a time: two sandboxes starting
   * together would otherwise each count the same free place.
   */
  private reserve(record: SandboxRecord) {
    const run = this.reservations.catch(() => {}).then(() => this.place(record));
    this.reservations = run;
    return run;
  }
  private async place(record: SandboxRecord) {
    if (this.containers.get(record.container) !== 'running') await this.makeRoom(record);
    this.count(this.placed, record.id, 1);
  }
  private async makeRoom(record: SandboxRecord) {
    const room = () =>
      makeRoom(
        this.items().filter((item) => item.id !== record.id),
        this.policy,
        this.now(),
      );
    if (!room().full && !room().evict) return;
    // The cached states may still count sandboxes that were stopped outside Athena.
    await this.refresh();
    const { full, evict } = room();
    if (full)
      throw new Error(
        `同时运行的沙箱已达上限（${this.policy.maxRunning} 个），而且都在使用中。请先在「设置 › 沙箱」停止一个，或调高上限。`,
      );
    if (evict) await this.release(this.records.get(evict)!, false);
  }
  /** Stops or removes a sandbox; a second request for the same one waits for the first. */
  private release(record: SandboxRecord, remove: boolean) {
    this.starting.get(record.id)?.abort();
    const run: Promise<void> = (this.releasing.get(record.id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => (this.records.get(record.id) === record ? this.end(record, remove) : undefined))
      .finally(() => {
        if (this.releasing.get(record.id) === run) this.releasing.delete(record.id);
      });
    this.releasing.set(record.id, run);
    return run;
  }
  private async end(record: SandboxRecord, remove: boolean) {
    await this.backend(record.runtime).release(record.container, remove);
    const view = this.views.get(record.id);
    if (remove) {
      this.containers.delete(record.container);
      this.records.delete(record.id);
      this.views.delete(record.id);
      this.failures.delete(record.id);
      this.options.onRemoved?.(
        record.conversationId ?? this.callers.get(record.id),
        record.origin === 'user' ? record.id : record.runtime,
      );
      this.callers.delete(record.id);
    } else {
      if (this.containers.has(record.container)) this.containers.set(record.container, 'exited');
      if (view) {
        view.connection = 'closed';
        view.command = undefined;
        view.service = undefined;
        this.onChange(structuredClone(view));
      }
    }
    this.publish();
  }

  async create(name: unknown, runtime: unknown) {
    const title = typeof name === 'string' ? name.trim() : '';
    if (!instanceName.test(title))
      throw new Error('名称需为 1–40 个字符，可用文字、数字、空格和 . _ -');
    if (!isTarget(runtime)) throw new Error('未知的沙箱环境');
    const users = [...this.records.values()].filter((record) => record.origin === 'user');
    if (users.some((record) => record.name.toLowerCase() === title.toLowerCase()))
      throw new Error(`已有名为「${title}」的沙箱`);
    if (users.length >= MAX_USER_INSTANCES)
      throw new Error(`最多保留 ${MAX_USER_INSTANCES} 个自建沙箱，请先删除不再使用的`);
    const id = 'sbx_' + randomBytes(4).toString('hex');
    this.records.set(id, {
      id,
      name: title,
      runtime,
      origin: 'user',
      container: this.backend(runtime).containerName(id),
      createdAt: this.now(),
      lastUsedAt: this.now(),
      keep: false,
    });
    await this.save();
    // Building the image can take minutes; the list shows the progress and any failure.
    void this.start(id).catch(() => {});
    return this.snapshot();
  }
  async start(id: unknown): Promise<SandboxInstancesState> {
    const record = this.record(id);
    if (record.origin === 'legacy') throw new Error('这个沙箱的对话已不存在，只能删除');
    const leaving = this.releasing.get(record.id);
    if (leaving) {
      await leaving.catch(() => {});
      return this.start(id);
    }
    if (this.starting.has(record.id)) return this.snapshot();
    const abort = new AbortController();
    this.starting.set(record.id, abort);
    this.failures.delete(record.id);
    this.publish();
    let placed = false;
    try {
      await this.reserve(record);
      placed = true;
      await this.backend(record.runtime).open({
        conversationId: record.origin === 'user' ? record.id : record.conversationId!,
        turnId: 'open-' + record.id,
        signal: abort.signal,
      });
      this.containers.set(record.container, 'running');
      this.touch(record);
    } catch (error) {
      if (!abort.signal.aborted)
        this.failures.set(record.id, error instanceof Error ? error.message : '沙箱启动失败');
      throw error;
    } finally {
      if (placed) this.count(this.placed, record.id, -1);
      this.starting.delete(record.id);
      this.publish();
    }
    return this.snapshot();
  }
  async stop(id: unknown) {
    await this.release(this.record(id), false);
    return this.snapshot();
  }
  /** Deletes the container and every file in the sandbox. */
  async remove(id: unknown) {
    await this.release(this.record(id), true);
    await this.save();
    return this.snapshot();
  }
  async keep(id: unknown, keep: unknown) {
    this.record(id).keep = keep === true;
    await this.save();
    this.publish();
    return this.snapshot();
  }
  async setPolicy(policy: unknown) {
    this.policy = normalizePolicy({ ...this.policy, ...(policy as object) });
    await this.save();
    await this.sweep();
    this.publish();
    return this.snapshot();
  }
  /** A deleted conversation takes the sandboxes its agent opened with it. */
  async forgetConversation(conversationId: string) {
    for (const record of [...this.records.values()])
      if (record.origin === 'agent' && record.conversationId === conversationId)
        await this.release(record, true).catch(() => {
          // Docker did not answer. Keep it listed, so the retention period removes it later.
          this.records.delete(record.id);
          this.views.delete(record.id);
          const id = `legacy:${record.container}`;
          this.records.set(id, {
            ...record,
            id,
            origin: 'legacy',
            conversationId: undefined,
            name: '已删除对话的沙箱',
          });
        });
    for (const [id, caller] of this.callers) if (caller === conversationId) this.callers.delete(id);
    for (const view of this.views.values())
      if (view.instance && view.conversationId === conversationId) view.conversationId = '';
    await this.save();
    this.publish();
  }
  /** One recycling pass; see `planRecycle` for what is due. */
  async sweep() {
    if (this.sweeping || this.closed || !this.records.size) return;
    this.sweeping = true;
    try {
      const due = () => planRecycle(this.items(), this.policy, this.now());
      if (!due().stop.length && !due().remove.length) return;
      // Act on what Docker reports now, not on what was true a while ago.
      if (!(await this.refresh())) return;
      const plan = due();
      for (const [ids, remove] of [
        [plan.remove, true],
        [plan.stop, false],
      ] as const)
        for (const id of ids) {
          // Each stop takes a while: one that came into use in the meantime is left alone.
          const record = this.records.get(id);
          if (record && due()[remove ? 'remove' : 'stop'].includes(id))
            await this.release(record, remove).catch(() => {});
        }
      await this.save();
    } finally {
      this.sweeping = false;
    }
  }

  private find(name: unknown) {
    const wanted = typeof name === 'string' ? name.trim().toLowerCase() : '';
    const users = [...this.records.values()].filter((record) => record.origin === 'user');
    const record = users.find((item) => item.id === wanted || item.name.toLowerCase() === wanted);
    if (!record)
      throw new Error(
        users.length
          ? `没有名为「${String(name).slice(0, 40)}」的沙箱。可用实例：${users.map((item) => item.name).join('、')}`
          : '用户还没有创建沙箱实例；请省略 sandbox 参数，改用 target',
      );
    return record;
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    context: SandboxCallContext,
  ): ReturnType<SandboxBackend['call']> {
    const { sandbox: requested, ...input } = args;
    let record: SandboxRecord | undefined;
    let target: SandboxTarget;
    if (requested !== undefined && requested !== '') {
      record = this.find(requested);
      target = record.runtime;
      this.callers.set(record.id, context.conversationId);
      const view = this.views.get(record.id);
      if (view) view.conversationId = context.conversationId;
    } else {
      const wanted = input.target ?? 'default';
      if (!isTarget(wanted)) throw new Error('未知的沙箱目标');
      target = wanted;
      record = this.records.get(`${context.conversationId}:${target}`);
    }
    if (
      name === 'athena_sandbox_exec' &&
      target === 'backend' &&
      input.timeout_seconds === undefined
    )
      input.timeout_seconds = 1200;
    const backend = this.backend(target);
    const inner = record?.origin === 'user' ? { ...context, conversationId: record.id } : context;
    if (name === 'athena_sandbox_status') {
      const result = await backend.call(name, input, inner);
      return {
        ...result,
        text: JSON.stringify({
          ...JSON.parse(result.text),
          instances: this.snapshot()
            .instances.filter((instance) => instance.origin === 'user')
            .map(({ name, runtime, status }) => ({ name, runtime, status })),
        }),
      };
    }
    const leaving = this.releasing.get(record?.id ?? `${context.conversationId}:${target}`);
    if (leaving) {
      // Being stopped or removed right now: use it once that is over, or whatever replaces it.
      await leaving.catch(() => {});
      return this.call(name, args, context);
    }
    const known = !!record;
    record ??= {
      id: `${context.conversationId}:${target}`,
      name: sandboxNames[target],
      runtime: target,
      origin: 'agent',
      conversationId: context.conversationId,
      container: backend.containerName(context.conversationId),
      createdAt: this.now(),
      lastUsedAt: this.now(),
      keep: false,
    };
    this.failures.delete(record.id);
    // Listed and in use before anything is awaited, so that no recycling pass picks it now.
    this.records.set(record.id, record);
    this.count(this.calls, record.id, 1);
    let placed = false;
    try {
      await this.reserve(record);
      placed = true;
      this.records.set(record.id, record);
      this.touch(record);
      return await backend.call(name, input, inner);
    } catch (error) {
      // A first use that never got as far as a container leaves nothing to list.
      if (!known && !this.containers.has(record.container)) this.records.delete(record.id);
      throw error;
    } finally {
      this.count(this.calls, record.id, -1);
      if (placed) this.count(this.placed, record.id, -1);
      if (this.records.has(record.id)) this.touch(record);
    }
  }
  async cancelTurn(turnId: string) {
    await Promise.all([...this.entries.values()].map((entry) => entry.cancelTurn(turnId)));
  }
  async dispose() {
    this.closed = true;
    clearInterval(this.sweepTimer);
    clearTimeout(this.publishTimer);
    for (const abort of this.starting.values()) abort.abort();
    await this.save().catch(() => {});
    await Promise.all([...this.entries.values()].map((entry) => entry.dispose()));
  }
}
