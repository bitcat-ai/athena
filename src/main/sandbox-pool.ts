import path from 'node:path';
import {
  LocalSandbox,
  localSandboxTools,
  type SandboxArtifact,
  type SandboxCallContext,
  type LocalSandboxUpdate,
} from './local-sandbox';
import { redact } from './sandbox-client';
import type { LocalSandboxView, SandboxTarget } from '../shared/sandbox';

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
    },
  },
}));

export class SandboxPool {
  private entries = new Map<string, LocalSandbox>();
  private views = new Map<string, LocalSandboxView>();
  constructor(
    private directory: string,
    private program: string,
    private onArtifact: (turnId: string, artifact: SandboxArtifact) => void,
    private onChange: (state: LocalSandboxView) => void = () => {},
  ) {}
  state(conversationId: string) {
    return [...this.views.values()].filter((view) => view.conversationId === conversationId);
  }
  private update(target: SandboxTarget, update: LocalSandboxUpdate) {
    const key = update.conversationId + ':' + target;
    const state: LocalSandboxView = this.views.get(key) ?? {
      conversationId: update.conversationId,
      target,
      connection: 'connecting',
      lines: [],
    };
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
        if(event.service.status==='starting') state.command=undefined;
        state.service = { ...state.service, status: event.service.status };
      }
    }
    this.views.set(key, state);
    this.onChange(structuredClone(state));
  }
  private get(target: unknown) {
    const key = target ?? 'default';
    if (typeof key !== 'string' || !['default', 'frontend', 'backend'].includes(key))
      throw new Error('未知的沙箱目标');
    let entry = this.entries.get(key);
    if (!entry) {
      const runtime =
        key === 'default'
          ? undefined
          : {
              image: key === 'frontend' ? 'athena-sandbox-node:1' : 'athena-sandbox-java:1',
              dockerfile: path.join(
                path.dirname(this.program),
                'sandbox-images',
                key === 'frontend' ? 'node.Dockerfile' : 'java.Dockerfile',
              ),
            };
      entry = new LocalSandbox(
        key === 'default' ? this.directory : path.join(this.directory, key),
        this.program,
        this.onArtifact,
        runtime,
        (update) => this.update(key as SandboxTarget, update),
      );
      this.entries.set(key, entry);
    }
    return entry;
  }
  call(name: string, args: Record<string, unknown>, context: SandboxCallContext) {
    const input = { ...args };
    if (
      name === 'athena_sandbox_exec' &&
      input.target === 'backend' &&
      input.timeout_seconds === undefined
    )
      input.timeout_seconds = 1200;
    return this.get(input.target).call(name, input, context);
  }
  async cancelTurn(turnId: string) {
    await Promise.all([...this.entries.values()].map((entry) => entry.cancelTurn(turnId)));
  }
  async dispose() {
    await Promise.all([...this.entries.values()].map((entry) => entry.dispose()));
  }
}
