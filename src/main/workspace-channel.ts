import {
  TERMINAL_TASK_STATUSES,
  type SandboxEventEnvelope,
  type SandboxService,
  type SandboxTask,
  type SandboxWorkspaceInfo,
} from '../shared/sandbox-protocol';
import {
  SandboxClient,
  type SandboxClientOptions,
  type SandboxConnectionState,
} from './sandbox-client';

export interface SandboxListener {
  onEvent?(envelope: SandboxEventEnvelope): void;
  /** Events may have been missed; re-read whatever the listener depends on. */
  onResync?(): void;
  onConnection?(state: SandboxConnectionState): void;
}

export interface WorkspaceChannelOptions {
  /** SSH host alias, normally `coder.<workspace>` from `coder config-ssh`. */
  ssh: string;
  clientVersion: string;
  /** Test seam: replaces the ssh command. */
  transport?: Pick<SandboxClientOptions, 'command' | 'args' | 'env'>;
  clientOptions?: Partial<SandboxClientOptions>;
  onChange?: () => void;
}

const isTerminal = (task: SandboxTask) =>
  (TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status);

/**
 * One Coder workspace: a control channel plus a cache of what the workspace reported. The
 * cache only mirrors remote state; it is never the source of truth for task outcomes.
 */
export class WorkspaceChannel {
  readonly client: SandboxClient;
  private workspace?: SandboxWorkspaceInfo;
  private services = new Map<string, SandboxService>();
  private tasks = new Map<string, SandboxTask>();
  private running = new Set<string>();
  private listeners = new Set<SandboxListener>();
  private resyncing?: Promise<void>;

  constructor(private readonly options: WorkspaceChannelOptions) {
    this.client = new SandboxClient({
      ...options.clientOptions,
      ...options.transport,
      host: options.ssh,
      clientVersion: options.clientVersion,
      onState: (state) => {
        for (const listener of this.listeners) listener.onConnection?.(state);
        this.options.onChange?.();
      },
      onEvent: (envelope) => this.apply(envelope),
      onResync: () => void this.resync().catch(() => {}),
    });
  }

  get ssh() {
    return this.options.ssh;
  }
  get info() {
    return this.workspace;
  }
  get serviceList() {
    return [...this.services.values()];
  }
  /** Commands this channel has seen start and not yet finish. */
  get runningCommands() {
    return this.running.size;
  }
  get activeTask() {
    const id = this.workspace?.activeTaskId;
    return id ? this.tasks.get(id) : undefined;
  }

  connect() {
    return this.client.connect();
  }
  close() {
    this.client.close();
    this.listeners.clear();
  }
  subscribe(listener: SandboxListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-reads everything; also used for an explicit refresh from the UI. */
  resync(): Promise<void> {
    this.resyncing ??= (async () => {
      try {
        const [{ workspace }, { services }] = await Promise.all([
          this.client.request('workspace.info', {}),
          this.client.request('service.list', {}),
        ]);
        this.workspace = workspace;
        this.services = new Map(services.map((service) => [service.id, service]));
        if (workspace.activeTaskId) {
          const { task } = await this.client.request('task.get', {
            taskId: workspace.activeTaskId,
          });
          this.tasks.set(task.id, task);
        }
        this.options.onChange?.();
      } finally {
        this.resyncing = undefined;
      }
      for (const listener of this.listeners) listener.onResync?.();
    })();
    return this.resyncing;
  }

  private apply(envelope: SandboxEventEnvelope) {
    const { event } = envelope;
    switch (event.type) {
      case 'workspace.state':
        this.workspace = event.workspace;
        break;
      case 'task.state':
        if (isTerminal(event.task)) this.tasks.delete(event.task.id);
        else this.tasks.set(event.task.id, event.task);
        break;
      case 'service.state':
        this.services.set(event.service.id, event.service);
        break;
      case 'service.removed':
        this.services.delete(event.serviceId);
        break;
      case 'command.state':
        if (event.command.status === 'running') this.running.add(event.command.id);
        else this.running.delete(event.command.id);
        break;
      case 'task.event':
      case 'command.output':
        break;
    }
    for (const listener of this.listeners) listener.onEvent?.(envelope);
    if (event.type !== 'task.event') this.options.onChange?.();
  }
}
