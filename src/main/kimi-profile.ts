import {
  mkdir,
  readFile,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import type { BrowserTool } from '../shared/types';
import type { ModelOption } from '../shared/usage';

type Fields = Record<string, any>;
const fields = (v: unknown): Fields =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Fields) : {};
const safe = (v: unknown): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= 256 && !/[\u0000-\u001f]/.test(v);
const sourceHome = () =>
  path.resolve(process.env.KIMI_CODE_HOME || path.join(homedir(), '.kimi-code'));

async function nativeConfig(): Promise<Fields> {
  try {
    const file = path.join(sourceHome(), 'config.toml');
    if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error();
    return parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('无法读取 Kimi 模型配置，请在终端运行 kimi doctor');
  }
}

export async function discoverKimiModels(): Promise<ModelOption[]> {
  const config = await nativeConfig();
  const models: ModelOption[] = Object.entries(fields(config.models))
    .filter(([alias]) => safe(alias))
    .map(([alias, input]) => {
      const model = fields(input);
      const efforts = Array.isArray(model.support_efforts)
        ? model.support_efforts.filter(safe)
        : [];
      return {
        id: alias,
        model: alias,
        name: safe(model.display_name) ? model.display_name : alias,
        description: safe(model.model) ? model.model : '',
        isDefault: alias === config.default_model && !process.env.KIMI_MODEL_NAME,
        efforts: efforts.map((id: string) => ({ id, description: id })),
        defaultEffort: efforts.includes(model.default_effort) ? model.default_effort : undefined,
      };
    });
  if (safe(process.env.KIMI_MODEL_NAME))
    models.push({
      id: '__kimi_env_model__',
      model: '__kimi_env_model__',
      name: process.env.KIMI_MODEL_NAME,
      description: '',
      isDefault: true,
      efforts: [],
    });
  return models;
}

// Kimi 2.1 can approve Git file edits internally. The ACP mode uses reviewed shell calls instead.
const nativeTools = ['Bash', 'Skill', 'SetTodoList', 'AskUserQuestion'];
export function supportsKimiVersion(version: string) {
  const v = /^2\.(\d+)\.(\d+)(?:\+[^\s]+)?$/.exec(version);
  return !!v && (+v[1] > 1 || (+v[1] === 1 && +v[2] >= 1));
}
function permitted(pattern: string, tool: string) {
  if (pattern === tool) return true;
  if (!pattern.startsWith('mcp__') || !tool.startsWith('mcp__')) return false;
  const parts = pattern.split('*');
  let offset = 0;
  if (!tool.startsWith(parts[0]) || !tool.endsWith(parts.at(-1)!)) return false;
  for (const part of parts) {
    const at = tool.indexOf(part, offset);
    if (at < 0) return false;
    offset = at + part.length;
  }
  return true;
}

/** Keep Kimi's own OAuth storage in place. Hooks, plugins, workspace trust and MCP registrations use a separate home. */
export async function kimiEnvironment(
  directory: string | undefined,
  tools: BrowserTool[],
  env: NodeJS.ProcessEnv,
) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('Kimi 需要 Athena 的本机会话目录');
  const home = path.join(directory, 'kimi');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const source = await nativeConfig();
  const providers: Fields = Object.create(null);
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    KIMI_CODE_HOME: home,
    KIMI_DISABLE_TELEMETRY: '1',
    KIMI_DISABLE_CRON: '1',
  };
  for (const [name, input] of Object.entries(fields(source.providers))) {
    const item = fields(input);
    if (!safe(name) || !safe(item.type)) continue;
    const provider: Fields = { type: item.type };
    if (item.base_url) {
      const u = new URL(item.base_url);
      if (
        !['http:', 'https:'].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash
      )
        throw new Error('该 Kimi Provider 地址无法安全传递，请在原生终端中使用');
      provider.base_url = u.href;
    }
    if (Object.keys(fields(item.custom_headers)).length || Object.keys(fields(item.env)).length)
      throw new Error('含自定义请求头或 Provider env 的 Kimi 配置需在原生终端中使用');
    if (item.oauth) {
      const { storage, key } = fields(item.oauth);
      if (!safe(storage) || !safe(key)) throw new Error('Kimi OAuth 引用无效');
      provider.oauth = { storage, key };
    } else if (safe(item.api_key_env)) {
      provider.api_key_env = item.api_key_env;
    } else if (typeof item.api_key === 'string' && item.api_key) {
      const variable =
        'ATHENA_KIMI_PROVIDER_' + createHash('sha256').update(name).digest('hex').slice(0, 16);
      childEnv[variable] = item.api_key;
      provider.api_key_env = variable;
    }
    providers[name] = provider;
  }
  const original = fields(source.tools);
  const ruleConfig = fields(source.permission);
  const denied = [
    ...(Array.isArray(ruleConfig.deny) ? ruleConfig.deny : []),
    ...(Array.isArray(ruleConfig.rules)
      ? ruleConfig.rules.filter((r: Fields) => r?.decision === 'deny').map((r: Fields) => r.pattern)
      : []),
  ]
    .filter(safe)
    .map((rule) => rule.split('(')[0]);
  const enabled = [...nativeTools, ...tools.map((t) => 'mcp__athena__' + t.name)].filter(
    (tool) =>
      !denied.some((rule) => rule === '*' || permitted(rule, tool)) &&
      (!Array.isArray(original.enabled) ||
        !original.enabled.length ||
        original.enabled.some((p: unknown) => safe(p) && permitted(p, tool))) &&
      !(
        Array.isArray(original.disabled) &&
        original.disabled.some((p: unknown) => safe(p) && permitted(p, tool))
      ),
  );
  const config: Fields = {
    providers,
    models: Object.fromEntries(
      Object.entries(fields(source.models)).map(([alias, model]) => [
        alias,
        Object.fromEntries(
          [
            'provider',
            'model',
            'display_name',
            'capabilities',
            'max_context_size',
            'max_output_size',
            'support_efforts',
            'default_effort',
            'reasoning_key',
          ]
            .filter((key) => fields(model)[key] !== undefined)
            .map((key) => [key, fields(model)[key]]),
        ),
      ]),
    ),
    auto_session_title: false,
    telemetry: false,
    extra_skill_dirs: [
      path.join(sourceHome(), 'skills'),
      ...(Array.isArray(source.extra_skill_dirs) ? source.extra_skill_dirs.filter(safe) : []),
    ],
    default_permission_mode: 'manual',
    tools: { enabled: enabled.length ? enabled : ['athena_no_tools'] },
    permission: {
      dangerous_command_guard: true,
      rules: [
        ...(Array.isArray(source.permission?.rules)
          ? source.permission.rules.filter((r: Fields) => r?.decision === 'deny')
          : []),
        ...nativeTools
          .filter((tool) => !['AskUserQuestion', 'SetTodoList'].includes(tool))
          .map((pattern) => ({ pattern, decision: 'ask' })),
      ],
    },
  };
  if (safe(source.default_model)) config.default_model = source.default_model;
  if (source.thinking) config.thinking = fields(source.thinking);
  if (Object.values(providers).some((p) => p.oauth)) {
    const destination = path.join(home, 'credentials'),
      credentials = path.join(sourceHome(), 'credentials');
    try {
      await symlink(credentials, destination, 'dir');
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        (await readlink(destination).catch(() => '')) !== credentials
      )
        throw new Error('Kimi 原生凭据目录无法连接');
    }
  }
  const temporary = path.join(home, 'config-' + randomUUID() + '.toml');
  try {
    await writeFile(temporary, stringify(config), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path.join(home, 'config.toml'));
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return childEnv;
}
