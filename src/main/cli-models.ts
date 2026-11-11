import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { readCliOutput } from './agent-process';
import type { ModelOption } from '../shared/usage';

const text = (value: unknown, limit = 256): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  value.length <= limit &&
  !/[\x00-\x1f\x7f]/.test(value);

export async function discoverClaudeModels(
  executable: string,
  workspace: string,
  signal: AbortSignal,
): Promise<ModelOption[]> {
  const requestId = randomUUID();
  const output = await readCliOutput(
    executable,
    workspace,
    [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--safe-mode',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--no-session-persistence',
      '--no-chrome',
    ],
    JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'initialize', hooks: {} },
    }) + '\n',
    signal,
  );
  let records: any[];
  try {
    records = output
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    throw new Error('Claude 模型目录响应格式无效');
  }
  const response = records.find(
    (record) => record?.type === 'control_response' && record.response?.request_id === requestId,
  )?.response;
  if (response?.subtype !== 'success' || !Array.isArray(response.response?.models))
    throw new Error('Claude 未返回有效模型目录，请更新 CLI 后刷新');
  if (response.response.models.length > 4096) throw new Error('Claude 模型目录返回过大');
  const models = new Map<string, ModelOption>();
  for (const model of response.response.models) {
    if (!model || !text(model.value) || !text(model.displayName))
      throw new Error('Claude 模型目录条目无效');
    const levels: unknown[] =
      model.supportsEffort === true && Array.isArray(model.supportedEffortLevels)
        ? model.supportedEffortLevels
        : [];
    models.set(model.value, {
      id: model.value,
      model: model.value,
      name: model.displayName,
      description: text(model.description, 2000) ? model.description : '',
      isDefault: model.value === 'default',
      efforts: [...new Set(levels)]
        .filter(
          (level): level is string =>
            typeof level === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(level),
        )
        .map((id) => ({ id, description: '' })),
    });
  }
  return [...models.values()];
}

export async function discoverCursorModels(
  executable: string,
  workspace: string,
  signal: AbortSignal,
): Promise<ModelOption[]> {
  const output = stripVTControlCharacters(
    await readCliOutput(executable, workspace, ['--list-models'], '', signal),
  );
  if (!/^Available models\s*$/m.test(output))
    throw new Error('Cursor 未返回有效模型目录，请检查登录后刷新');
  const models = new Map<string, ModelOption>();
  for (const line of output.split('\n')) {
    const match = line.match(/^([\w][\w./:[\],=-]{0,255}) - (.+)$/);
    if (!match) continue;
    const [, id, label] = match;
    if (!text(label)) throw new Error('Cursor 模型目录条目无效');
    models.set(id, {
      id,
      model: id,
      name: label.replace(/ \(default\)$/, ''),
      description: '',
      isDefault: label.endsWith(' (default)'),
      efforts: [],
    });
  }
  if (!models.size) throw new Error('Cursor 模型目录为空，请检查账号可用模型后刷新');
  return [...models.values()];
}

export async function discoverGeminiModels(
  executable: string,
  workspace: string,
  signal: AbortSignal,
): Promise<ModelOption[]> {
  const output = await readCliOutput(
    executable,
    workspace,
    ['--list-models', '--output-format', 'json'],
    '',
    signal,
  );
  let entries: unknown;
  try {
    entries = JSON.parse(output);
  } catch {
    throw new Error('Gemini 未返回有效模型目录，请更新 CLI 后刷新');
  }
  if (!Array.isArray(entries) || entries.length > 4096) throw new Error('Gemini 模型目录格式无效');
  const models = new Map<string, ModelOption>();
  for (const model of entries) {
    if (!model || !text(model.modelId) || !text(model.name))
      throw new Error('Gemini 模型目录条目无效');
    models.set(model.modelId, {
      id: model.modelId,
      model: model.modelId,
      name: model.name,
      description: text(model.description, 2000) ? model.description : '',
      isDefault: false,
      efforts: [],
    });
  }
  return [...models.values()];
}

export async function discoverOpenCodeModels(
  executable: string,
  workspace: string,
  signal: AbortSignal,
): Promise<ModelOption[]> {
  const output = await readCliOutput(executable, workspace, ['models', '--pure'], '', signal);
  const models = new Map<string, ModelOption>();
  for (const line of output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)) {
    if (!text(line) || !/^[a-zA-Z0-9_.-]+\/\S+$/.test(line))
      throw new Error('OpenCode 模型目录格式无效');
    models.set(line, {
      id: line,
      model: line,
      name: line,
      description: '',
      isDefault: false,
      efforts: [],
    });
  }
  return [...models.values()];
}
