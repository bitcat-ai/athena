import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import * as protocol from '../src/shared/sandbox-protocol';

// Shared shapes keep readable names in $defs instead of being inlined per method.
const named = {
  ModelSelection: protocol.ModelSelection,
  ExecutionModel: protocol.ExecutionModel,
  ModelOption: protocol.ModelOption,
  TokenCounts: protocol.TokenCounts,
  ApprovalRequest: protocol.ApprovalRequest,
  UserInputRequest: protocol.UserInputRequest,
  PendingRequest: protocol.PendingRequest,
  ToolCall: protocol.ToolCall,
  PlanStep: protocol.PlanStep,
  Repo: protocol.Repo,
  WorkspaceInfo: protocol.WorkspaceInfo,
  Task: protocol.Task,
  HealthCheck: protocol.HealthCheck,
  Service: protocol.Service,
  Command: protocol.Command,
  TaskEvent: protocol.TaskEvent,
  ServerEvent: protocol.ServerEvent,
  EventEnvelope: protocol.EventEnvelope,
  RpcResponse: protocol.RpcResponse,
  RpcNotification: protocol.RpcNotification,
  SandboxManifest: protocol.SandboxManifest,
};

export function sandboxProtocolSchema() {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(named)) registry.add(schema, { id });
  for (const [method, { params, result }] of Object.entries(protocol.methods)) {
    registry.add(params, { id: `${method}.params` });
    registry.add(result, { id: `${method}.result` });
  }
  const { schemas } = z.toJSONSchema(registry, {
    uri: (id) => `#/$defs/${id}`,
    // Input mode leaves objects open: receivers must ignore unknown fields.
    io: 'input',
    unrepresentable: 'any',
  });
  const $defs = Object.fromEntries(
    Object.entries(schemas).map(([id, schema]) => {
      const { $schema: _, $id: __, ...rest } = schema as Record<string, unknown>;
      return [id, rest];
    }),
  );
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Athena Sandbox Protocol',
    version: protocol.SANDBOX_PROTOCOL_VERSION,
    maxLineBytes: protocol.MAX_LINE_BYTES,
    errorCodes: protocol.errorCodes,
    methods: Object.fromEntries(
      Object.keys(protocol.methods).map((method) => [
        method,
        {
          params: { $ref: `#/$defs/${method}.params` },
          result: { $ref: `#/$defs/${method}.result` },
        },
      ]),
    ),
    $defs,
  };
}

export const schemaPath = fileURLToPath(
  new URL('../docs/sandbox/protocol.schema.json', import.meta.url),
);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeFile(schemaPath, JSON.stringify(sandboxProtocolSchema(), null, 2) + '\n');
  console.log(`Wrote ${path.relative(process.cwd(), schemaPath)}`);
}
