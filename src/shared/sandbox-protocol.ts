// Athena Sandbox Protocol (ASP). Normative prose lives in docs/sandbox/protocol.md;
// the JSON Schema handed to the sandbox side is generated from this file.
import { z } from 'zod/v4';

export const SANDBOX_PROTOCOL_VERSION = 1;
/** Hard upper bound for one JSON line in either direction. */
export const MAX_LINE_BYTES = 1024 * 1024;

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const timestamp = z.number().int().nonnegative().describe('Unix epoch milliseconds');
const text = (max: number) => z.string().max(max);

export const ModelSelection = z.object({ model: text(200), effort: text(50).optional() });
export const ExecutionModel = z.object({
  requested: text(200).optional(),
  model: text(200).optional(),
  effort: text(50).optional(),
});
export const ModelOption = z.object({
  id: text(200),
  model: text(200),
  name: text(200),
  description: text(2000),
  isDefault: z.boolean(),
  efforts: z.array(z.object({ id: text(50), description: text(500) })).max(20),
  defaultEffort: text(50).optional(),
});
const tokenCount = z.number().int().nonnegative().nullable();
export const TokenCounts = z.object({
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cachedInputTokens: tokenCount,
  cacheWriteInputTokens: tokenCount,
  reasoningOutputTokens: tokenCount,
  totalTokens: tokenCount,
});

export const ApprovalRequest = z.object({
  id,
  title: text(500),
  detail: text(20_000),
  kind: z.enum(['command', 'file', 'other']),
});
export const UserInputRequest = z.object({
  id,
  questions: z
    .array(
      z.object({
        id,
        header: text(200),
        question: text(4000),
        isSecret: z.boolean(),
        isOther: z.boolean().optional(),
        options: z
          .array(z.object({ label: text(200), description: text(1000) }))
          .max(20)
          .optional(),
      }),
    )
    .min(1)
    .max(10),
});
export const PendingRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approval'), request: ApprovalRequest }),
  z.object({ kind: z.literal('input'), request: UserInputRequest }),
]);

export const ToolCall = z.object({
  id,
  name: text(200),
  input: z.unknown().optional(),
  status: z.enum(['running', 'done', 'error']),
  output: text(20_000).optional(),
  startedAt: timestamp.optional(),
  finishedAt: timestamp.optional(),
});
export const PlanStep = z.object({
  step: text(1000),
  status: z.enum(['pending', 'inProgress', 'completed']),
});

export const Repo = z.object({
  url: text(2000),
  ref: text(200).optional(),
  commit: text(64).optional(),
});
/** What runs inside one Coder workspace. Lifecycle (create/start/stop) belongs to Coder. */
export const WorkspaceInfo = z.object({
  repos: z.array(Repo.extend({ path: text(1000) })).max(20),
  agent: z.object({
    id: text(50),
    status: z.enum(['ready', 'unavailable']),
    message: text(2000).optional(),
  }),
  activeTaskId: id.optional(),
});

export const TaskStatus = z.enum([
  'queued',
  'running',
  'waiting',
  'stopping',
  'completed',
  'failed',
  'cancelled',
  'unknown',
]);
export const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled', 'unknown'] as const;
export const Task = z.object({
  id,
  status: TaskStatus,
  pendingRequests: z.array(PendingRequest).max(20),
  failure: text(4000).optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const HealthCheck = z.object({
  path: text(500).optional().describe('HTTP path; TCP connect check when omitted'),
  timeoutSeconds: z.number().int().min(1).max(600).optional(),
});
export const ServiceStatus = z.enum(['starting', 'healthy', 'unhealthy', 'stopped', 'failed']);
export const Service = z.object({
  id,
  name: text(63),
  status: ServiceStatus,
  port: z
    .number()
    .int()
    .min(1)
    .max(65_535)
    .describe('Listening port inside the workspace; Athena derives the Coder URL from it'),
  message: text(4000).optional(),
  updatedAt: timestamp,
});

export const TaskEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started'), model: ExecutionModel.optional() }),
  z.object({
    type: z.literal('status'),
    status: z.enum(['thinking', 'working', 'waiting', 'idle']),
    label: text(200).optional(),
  }),
  z.object({ type: z.literal('delta'), text: text(64_000) }),
  z.object({ type: z.literal('tool'), call: ToolCall }),
  z.object({ type: z.literal('plan'), steps: z.array(PlanStep).max(100) }),
  z.object({ type: z.literal('approval'), request: ApprovalRequest }),
  z.object({ type: z.literal('user-input'), request: UserInputRequest }),
  z.object({ type: z.literal('request-resolved'), requestId: id }),
  z.object({ type: z.literal('usage'), total: TokenCounts, last: TokenCounts }),
  z.object({ type: z.literal('completed'), text: text(64_000).optional() }),
  z.object({ type: z.literal('failed'), message: text(4000), code: text(100).optional() }),
  z.object({ type: z.literal('cancelled') }),
]);

/** A shell command run on behalf of a client, e.g. clone, install or build. */
export const CommandStatus = z.enum(['running', 'succeeded', 'failed', 'cancelled', 'unknown']);
export const Command = z.object({
  id,
  command: text(4000),
  cwd: text(4000),
  status: CommandStatus,
  exitCode: z.number().int().optional(),
  signal: text(20).optional(),
  outputBytes: z.number().int().nonnegative().describe('Total output produced so far'),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
});

export const ServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workspace.state'), workspace: WorkspaceInfo }),
  z.object({ type: z.literal('task.state'), task: Task }),
  z.object({ type: z.literal('task.event'), taskId: id, event: TaskEvent }),
  z.object({ type: z.literal('service.state'), service: Service }),
  z.object({ type: z.literal('service.removed'), serviceId: id }),
  z.object({ type: z.literal('command.state'), command: Command }),
  z.object({
    type: z.literal('command.output'),
    commandId: id,
    stream: z.enum(['stdout', 'stderr']),
    text: text(16 * 1024),
  }),
]);
export const EventEnvelope = z.object({
  seq: z.number().int().positive().describe('Per-workspace monotonic, survives reconnects'),
  at: timestamp,
  event: ServerEvent,
});

const empty = z.object({});
const taskRef = z.object({ taskId: id });
const serviceRef = z.object({ serviceId: id });
const commandRef = z.object({ commandId: id });
const env = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), text(4000));

/** Every client → server request: params and result schemas. */
export const methods = {
  hello: {
    params: z.object({
      protocol: z.number().int().positive(),
      client: z.object({ name: text(100), version: text(50) }),
    }),
    result: z.object({
      protocol: z.number().int().positive(),
      server: z.object({ name: text(100), version: text(50) }),
      latestSeq: z.number().int().nonnegative(),
      capabilities: z.object({
        agents: z.array(text(50)).max(20),
        services: z.boolean(),
        diff: z.boolean(),
      }),
    }),
  },
  ping: { params: empty, result: z.object({ at: timestamp }) },
  'events.subscribe': {
    params: z.object({ after: z.number().int().nonnegative() }),
    result: z.object({ latestSeq: z.number().int().nonnegative() }),
  },
  'workspace.info': { params: empty, result: z.object({ workspace: WorkspaceInfo }) },
  'workspace.diff': {
    params: z.object({
      maxBytes: z
        .number()
        .int()
        .min(1024)
        .max(MAX_LINE_BYTES / 2)
        .optional(),
    }),
    result: z.object({
      base: text(64),
      files: z
        .array(
          z.object({
            path: text(4000),
            status: z.enum(['added', 'modified', 'deleted', 'renamed']),
            additions: z.number().int().nonnegative().optional(),
            deletions: z.number().int().nonnegative().optional(),
          }),
        )
        .max(5000),
      patch: z.string(),
      truncated: z.boolean(),
    }),
  },
  'models.list': { params: empty, result: z.object({ models: z.array(ModelOption) }) },
  'task.start': {
    params: z.object({
      taskId: id.describe('Chosen by the client; repeating it never starts a second run'),
      text: text(64 * 1024).min(1),
      context: text(256 * 1024).optional(),
      model: ModelSelection.optional(),
    }),
    result: z.object({ task: Task }),
  },
  'task.get': { params: taskRef, result: z.object({ task: Task }) },
  'task.stop': { params: taskRef, result: z.object({ task: Task }) },
  'request.resolve': {
    params: z.object({
      taskId: id,
      requestId: id,
      resolution: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('approval'), approved: z.boolean() }),
        z.object({
          kind: z.literal('input'),
          answers: z.record(id, z.array(text(4000)).max(20)),
        }),
      ]),
    }),
    result: empty,
  },
  'service.list': { params: empty, result: z.object({ services: z.array(Service) }) },
  'service.start': {
    params: z.object({
      name: text(63),
      command: text(4000).optional().describe('Omit to use the .athena/sandbox.json entry'),
      port: z.number().int().min(1).max(65_535).optional(),
      env: env.optional(),
      health: HealthCheck.optional(),
    }),
    result: z.object({ service: Service }),
  },
  'service.stop': { params: serviceRef, result: z.object({ service: Service }) },
  'service.restart': { params: serviceRef, result: z.object({ service: Service }) },
  'service.logs': {
    params: serviceRef.extend({ lines: z.number().int().min(1).max(1000).optional() }),
    result: z.object({ lines: z.array(text(4000)).max(1000) }),
  },
  'command.run': {
    params: z.object({
      commandId: id.describe('Chosen by the client; repeating it never runs the command twice'),
      command: text(4000).min(1),
      cwd: text(4000).optional().describe('Relative to the primary repository, or absolute'),
      env: env.optional(),
      timeoutSeconds: z.number().int().min(1).max(6 * 3600).optional(),
    }),
    result: z.object({ command: Command }),
  },
  'command.get': {
    params: commandRef.extend({ tailBytes: z.number().int().min(0).max(256 * 1024).optional() }),
    result: z.object({ command: Command, output: z.string(), truncated: z.boolean() }),
  },
  'command.stop': { params: commandRef, result: z.object({ command: Command }) },
} as const;

export type SandboxMethod = keyof typeof methods;
export type MethodParams<M extends SandboxMethod> = z.input<(typeof methods)[M]['params']>;
export type MethodResult<M extends SandboxMethod> = z.output<(typeof methods)[M]['result']>;

export const errorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  PROTOCOL_UNSUPPORTED: -32001,
  NOT_FOUND: -32002,
  CONFLICT: -32003,
  EVENTS_EXPIRED: -32004,
  UNAVAILABLE: -32005,
  INVALID_STATE: -32007,
} as const;
export type SandboxErrorReason = keyof typeof errorCodes;

const rpcId = z.union([z.string().max(128), z.number().int()]);
// Error first: `result: z.unknown()` would also accept an error reply with no result field.
export const RpcResponse = z.union([
  z.object({
    jsonrpc: z.literal('2.0'),
    id: rpcId.nullable(),
    error: z.object({
      code: z.number().int(),
      message: text(4000),
      data: z
        .object({ reason: text(100).optional(), oldestSeq: z.number().int().optional() })
        .loose()
        .optional(),
    }),
  }),
  z.object({ jsonrpc: z.literal('2.0'), id: rpcId, result: z.unknown() }),
]);
export const RpcNotification = z.discriminatedUnion('method', [
  z.object({ jsonrpc: z.literal('2.0'), method: z.literal('event'), params: EventEnvelope }),
  z.object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('fatal'),
    params: z.object({
      reason: z.enum(['DAEMON_UNAVAILABLE', 'PROTOCOL_UNSUPPORTED', 'INTERNAL']),
      message: text(4000),
    }),
  }),
]);

/** Optional repo file `.athena/sandbox.json` that declares default services. */
export const SandboxManifest = z.object({
  version: z.literal(1),
  services: z
    .array(
      z.object({
        name: text(63),
        command: text(4000),
        port: z.number().int().min(1).max(65_535),
        cwd: text(1000).optional(),
        env: env.optional(),
        health: HealthCheck.optional(),
        restart: z.enum(['never', 'on-failure']).optional(),
        autostart: z.boolean().optional(),
      }),
    )
    .max(20),
});

export type SandboxWorkspaceInfo = z.output<typeof WorkspaceInfo>;
export type SandboxTask = z.output<typeof Task>;
export type SandboxService = z.output<typeof Service>;
export type SandboxTaskEvent = z.output<typeof TaskEvent>;
export type SandboxServerEvent = z.output<typeof ServerEvent>;
export type SandboxEventEnvelope = z.output<typeof EventEnvelope>;
export type SandboxCommand = z.output<typeof Command>;
