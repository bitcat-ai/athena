import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSON5 from 'json5';
import { parseDocument } from 'yaml';
import type { ProviderSkill, ProviderSkillDiscovery } from '../shared/skills';

const provider = { id: 'claude', name: 'Claude Code' };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const flag = (value: unknown) => value === true || value === 1 || (typeof value === 'string' && /^(true|yes|on|y|1)$/i.test(value));
const off = (value: unknown) => value === false || value === 0 || (typeof value === 'string' && /^(false|no|off|n|0)$/i.test(value));
const inside = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

function metadata(contents: string): Record<string, unknown> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents);
  if (!match) return contents.startsWith('---') ? undefined : {};
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) return;
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  return record(value) ? value : undefined;
}

/** Read data only: never start Claude, execute a plugin, or render a skill. */
export async function discoverClaudeSkills(workspace: string): Promise<ProviderSkillDiscovery> {
  const config = process.env.CLAUDE_CONFIG_DIR?.trim();
  const configDirectory = config ? path.resolve(workspace, config) : path.join(os.homedir(), '.claude');
  const diagnostics: ProviderSkillDiscovery['diagnostics'] = [];
  const warn = (code: ProviderSkillDiscovery['diagnostics'][number]['code'], message: string) => {
    if (!diagnostics.some((item) => item.code === code)) diagnostics.push({ code, message });
  };
  const overrides = new Map<string, string>();
  const enabledPlugins = new Map<string, boolean>();
  const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : process.platform === 'win32' ? path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'ClaudeCode/managed-settings.json')
    : '/etc/claude-code/managed-settings.json';
  const repositoryRoot = await findRepositoryRoot(workspace);
  const settingsPaths = [path.join(configDirectory, 'settings.json'), path.join(workspace, '.claude/settings.json'), path.join(workspace, '.claude/settings.local.json'),
    ...(repositoryRoot && repositoryRoot !== workspace ? [path.join(repositoryRoot, '.claude/settings.local.json')] : []), managed];
  for (const file of settingsPaths) {
    try {
      const settings: unknown = JSON5.parse(await boundedRead(file));
      if (!record(settings)) continue;
      if (record(settings.skillOverrides)) {
        const entries = Object.entries(settings.skillOverrides);
        if (entries.every(([, value]) => typeof value === 'string' && ['on', 'name-only', 'user-invocable-only', 'off'].includes(value))) {
          for (const [name, value] of entries) overrides.set(name, value as string);
        } else warn('invalid-metadata', 'Claude skillOverrides 配置无效，已忽略该文件的覆盖项');
      }
      if (record(settings.enabledPlugins)) {
        for (const [key, value] of Object.entries(settings.enabledPlugins)) {
          if (typeof value === 'boolean') enabledPlugins.set(key, value);
          else enabledPlugins.delete(key);
        }
      }
    } catch (error) { if (!missing(error)) warn('unreadable-entry', '部分 Claude Skill 配置无法读取'); }
  }
  const skills = new Map<string, ProviderSkill>();
  let bytesLeft = 8_000_000;
  let entriesLeft = 10_000;
  const addSkill = async (file: string, name: string, singlePluginPrefix?: string) => {
    if (entriesLeft-- <= 0 || bytesLeft <= 0) return;
    try {
      const contents = await boundedRead(file);
      bytesLeft -= Buffer.byteLength(contents);
      if (bytesLeft < 0) return;
      const values = metadata(contents);
      if (!values) { warn('invalid-metadata', '部分 Claude Skill 元数据无效'); return; }
      if (singlePluginPrefix) {
        const declared = typeof values.name === 'string' ? values.name : path.basename(path.dirname(file));
        const unprefixed = declared.startsWith(`${singlePluginPrefix}:`) ? declared.slice(singlePluginPrefix.length + 1) : declared;
        name = `${singlePluginPrefix}:${unprefixed.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,254}$/.test(name) || skills.has(name)) return;
      const override = name.includes(':') ? undefined : overrides.get(name);
      // Reserve disabled user names too, so project duplicates cannot re-enable them.
      skills.set(name, {
        name, description: typeof values.description === 'string' ? values.description.trim() : '',
        providerPath: file, contentHash: createHash('sha256').update(contents).digest('hex'),
        userInvocable: !off(values['user-invocable']) && override !== 'off',
        userInvocableOnly: flag(values['disable-model-invocation']) || override === 'user-invocable-only',
        source: 'provider', provider,
      });
    } catch (error) { if (!missing(error)) warn('unreadable-entry', '部分 Claude Skill 无法读取或超出预算'); }
  };
  const scan = async (root: string, prefix?: string) => {
    let entries: string[];
    try { entries = (await readdir(root)).sort(); }
    catch (error) { if (!missing(error)) warn('unreadable-entry', '部分 Claude Skill 目录无法读取'); return; }
    for (const name of entries) {
      if (entriesLeft <= 0 || bytesLeft <= 0) break;
      // A folder's name is its native command; frontmatter name is not a rename.
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(name)) continue;
      await addSkill(path.join(root, name, 'SKILL.md'), prefix ? `${prefix}:${name}` : name);
    }
  };
  await scan(path.join(configDirectory, 'skills'));
  await scan(path.join(workspace, '.claude/skills'));
  const pluginDirectory = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim();
  const pluginsRoot = pluginDirectory ? path.resolve(workspace, pluginDirectory) : path.join(configDirectory, 'plugins');
  try {
    const installed: unknown = JSON.parse(await boundedRead(path.join(pluginsRoot, 'installed_plugins.json')));
    const plugins = record(installed) && record(installed.plugins) ? installed.plugins : {};
    for (const [key, values] of Object.entries(plugins).slice(0, 10000)) {
      if (entriesLeft <= 0 || bytesLeft <= 0) break;
      if (enabledPlugins.get(key) !== true || !Array.isArray(values)) continue;
      let installEntry: Record<string, unknown> | undefined;
      for (const item of values) {
        if (!record(item) || typeof item.installPath !== 'string') continue;
        const applies = item.scope === 'user' || item.scope === 'managed' ||
          ((item.scope === 'project' || item.scope === 'local') && typeof item.projectPath === 'string' &&
            (path.resolve(item.projectPath) === workspace || (repositoryRoot !== undefined && await findRepositoryRoot(path.resolve(item.projectPath)) === repositoryRoot)));
        if (!applies) continue;
        installEntry ??= item;
        try { await stat(path.resolve(workspace, item.installPath)); installEntry = item; break; } catch { /* next install */ }
      }
      if (!installEntry || typeof installEntry.installPath !== 'string') continue;
      const installPath = path.resolve(workspace, installEntry.installPath);
      let manifest: Record<string, unknown> = {};
      try { const value: unknown = JSON.parse(await boundedRead(path.join(installPath, '.claude-plugin/plugin.json'))); if (record(value)) manifest = value; } catch { /* optional manifest */ }
      const prefix = typeof manifest.name === 'string' ? manifest.name : key.split('@')[0];
      const defaultRoot = path.join(installPath, 'skills');
      let hasDefault = false;
      try { hasDefault = (await stat(defaultRoot)).isDirectory(); } catch { /* optional default */ }
      if (hasDefault) await scan(defaultRoot, prefix);
      const declared = typeof manifest.skills === 'string' ? [manifest.skills] : Array.isArray(manifest.skills) ? manifest.skills : [];
      if (!hasDefault && manifest.skills === undefined) await addSkill(path.join(installPath, 'SKILL.md'), '', prefix);
      for (const relative of declared) {
        if (typeof relative !== 'string') continue;
        const candidate = path.resolve(installPath, relative);
        try {
          if (!inside(installPath, candidate) || !inside(await realpath(installPath), await realpath(candidate))) { warn('unsafe-path', '已跳过越界的 Claude Plugin Skill 路径'); continue; }
          try { await stat(path.join(candidate, 'SKILL.md')); await addSkill(path.join(candidate, 'SKILL.md'), '', prefix); }
          catch { await scan(candidate, prefix); }
        } catch (error) { if (!missing(error)) warn('unreadable-entry', '部分 Claude Plugin Skill 无法读取'); }
      }
    }
  } catch (error) { if (!missing(error)) warn('unreadable-entry', 'Claude Plugin Skill 索引无法读取'); }
  if (entriesLeft <= 0 || bytesLeft <= 0) warn('capability-degraded', 'Claude Skill 扫描达到读取预算，结果可能不完整');
  const available = [...skills.values()].filter((skill) => overrides.get(skill.name) !== 'off').sort((a, b) => a.name.localeCompare(b.name));
  return { provider, source: 'provider', status: available.length ? 'ready' : diagnostics.length ? 'unavailable' : 'empty', skills: available, diagnostics };
}

async function findRepositoryRoot(workspace: string): Promise<string | undefined> {
  for (let directory = workspace; ; directory = path.dirname(directory)) {
    try { await stat(path.join(directory, '.git')); return directory; } catch { /* walk upwards */ }
    if (path.dirname(directory) === directory) return;
  }
}

async function boundedRead(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1_000_000) throw new Error('Invalid skill data');
    const buffer = Buffer.alloc(1_000_001);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > 1_000_000) throw new Error('Skill data exceeds budget');
    return buffer.subarray(0, size).toString('utf8');
  } finally { await handle.close(); }
}
