import { access, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentId, AgentInfo } from '../shared/types';
import { cliEnvironment } from './agent-process';

const exec = promisify(execFile);
const definitions: { id: AgentId; name: string; commands: string[]; supported: boolean }[] = [
  { id: 'codex', name: 'Codex', commands: ['codex'], supported: true },
  { id: 'claude', name: 'Claude Code', commands: ['claude'], supported: true },
  { id: 'gemini', name: 'Gemini CLI', commands: ['gemini'], supported: true },
  { id: 'pi', name: 'Pi', commands: ['pi'], supported: true },
  { id: 'cursor', name: 'Cursor Agent', commands: ['cursor-agent', 'agent'], supported: true },
  { id: 'opencode', name: 'OpenCode', commands: ['opencode'], supported: false },
];

export async function executableDirectories(): Promise<string[]> {
  const home = homedir();
  const result = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.dirname(process.execPath),
    path.join(home, '.local/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.npm-global/bin'),
    path.join(home, 'Library/pnpm'),
    path.join(home, '.local/share/pnpm'),
    path.join(home, 'Library/pnpm/bin'),
    path.join(home, '.local/share/pnpm/bin'),
    path.join(home, '.volta/bin'),
    path.join(home, '.asdf/shims'),
    path.join(home, '.local/share/mise/shims'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  for (const [base, suffix] of [
    [path.join(home, '.nvm/versions/node'), 'bin'],
    [path.join(home, 'Library/Application Support/fnm/node-versions'), 'installation/bin'],
    [path.join(home, '.local/share/fnm/node-versions'), 'installation/bin'],
  ]) {
    try {
      const versions = (await readdir(base)).filter((name) => /^v\d+\.\d+\.\d+$/.test(name));
      versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      result.push(...versions.map((version) => path.join(base, version, suffix)));
    } catch {
      /* Optional version manager. Never execute shell startup files. */
    }
  }
  return [...new Set(result.filter((entry) => path.isAbsolute(entry)))];
}
export async function discoverExecutables(names: string[], directories: string[]) {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const directory of directories)
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
        const identity = await realpath(candidate);
        if (!seen.has(identity)) {
          seen.add(identity);
          candidates.push(candidate);
        }
      } catch {
        /* Stale shims are not usable installations. */
      }
    }
  return candidates;
}

export function piIsolationArguments(help: string): string[] | undefined {
  const flags = ['--no-extensions', '--no-skills', '--no-prompt-templates'];
  if (flags.some((flag) => !help.includes(flag))) return;
  if (help.includes('--no-mcp')) flags.push('--no-mcp');
  else if (
    !/--no-extensions(?:,\s*-\w+)?\s+Disables? extension discovery and built-in extensions/i.test(
      help,
    )
  )
    return;
  // Pi 1.x ships MCP as a built-in extension, covered by --no-extensions.
  return [...flags, '--no-approve'];
}

export async function detectAgents(
  codexFallback?: string,
  searchDirectories?: string[],
): Promise<AgentInfo[]> {
  const directories = searchDirectories ?? (await executableDirectories());
  return Promise.all(
    definitions.map(async ({ id, name, commands, supported }) => {
      const candidates = await discoverExecutables(commands, directories);
      if (id === 'codex' && codexFallback && !candidates.includes(codexFallback))
        candidates.splice(Math.min(1, candidates.length), 0, codexFallback);
      let found: AgentInfo = {
        id,
        name,
        supported,
        available: false,
        detail: '未找到本机 CLI，请在终端安装后刷新',
      };
      for (const executable of candidates) {
        try {
          await access(executable, constants.X_OK);
          if (!(await stat(executable)).isFile()) continue;
          const options = {
            timeout: 8000,
            killSignal: 'SIGKILL' as const,
            maxBuffer: 256 * 1024,
            env: cliEnvironment(executable),
          };
          // A runtime that starts is usable. Whether it can reach its model service is only
          // known once it connects, so login state is never probed here.
          const version = await exec(executable, ['--version'], options).catch(() => undefined);
          if (!version?.stdout.trim()) {
            found = {
              ...found,
              path: executable,
              detail: '已找到 CLI，但启动检查失败；请在终端检查后刷新',
            };
            continue;
          }
          if (id === 'cursor' || id === 'pi' || id === 'claude' || id === 'gemini') {
            const help = await exec(executable, ['--help'], options);
            if (id === 'cursor' && !/cursor agent|start the cursor agent/i.test(help.stdout))
              continue;
            if (id === 'pi' && !/--mode.*rpc|RPC mode/i.test(help.stdout)) continue;
            const required =
              id === 'claude'
                ? ['--safe-mode', '--permission-prompts', '--tools']
                : id === 'gemini'
                  ? ['--admin-policy', '--approval-mode']
                  : id === 'cursor'
                    ? ['--mode', '--output-format', '--approve-mcps']
                    : [];
            if (
              required.some((flag) => !help.stdout.includes(flag)) ||
              (id === 'pi' && !piIsolationArguments(help.stdout))
            ) {
              found = {
                id,
                name,
                path: executable,
                available: true,
                supported: false,
                detail: '当前 CLI 版本不支持所需的受限执行模式，请在终端更新后刷新',
              };
              continue;
            }
          }
          return {
            id,
            name,
            supported,
            available: true,
            path: executable,
            version: version.stdout
              .replace(/\x1b\[[0-9;]*m/g, '')
              .trim()
              .split('\n')[0]
              .slice(0, 120),
            detail:
              id === 'claude'
                ? '支持 Neo 网页工具；本地文件和命令工具不可用'
                : id === 'gemini'
                  ? '支持文本任务；本地文件和命令工具不可用'
                  : id === 'cursor'
                    ? '本地目录只读，Neo 网页工具由 Athena 授权'
                    : supported
                      ? '沿用本机登录与模型服务配置，工具操作逐项确认'
                      : '已检测到本机安装',
          };
        } catch {
          found = {
            ...found,
            path: executable,
            detail: '已找到 CLI，但启动检查失败；请在终端检查后刷新',
          };
        }
      }
      return found;
    }),
  );
}
