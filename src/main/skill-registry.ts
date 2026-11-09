import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SkillDiagnostic, WorkspaceSkill } from '../shared/skills';

const MAX_ENTRY_BYTES = 12 * 1024;
const HEADER = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function diagnostic(code: SkillDiagnostic['code'], message: string): SkillDiagnostic {
  return { code, message };
}

function metadata(header: string): { name: string; description: string } | undefined {
  const values = new Map<string, string>();
  for (const line of header.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (match) values.set(match[1].toLowerCase(), match[2].trim());
  }
  const name = values.get('name');
  const description = values.get('description');
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !description) return undefined;
  return { name, description };
}

export async function discoverWorkspaceSkills(workspace: string): Promise<WorkspaceSkill[]> {
  const root = path.resolve(workspace, '.agents', 'skills');
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const workspaceRoot = await realpath(path.resolve(workspace));
  if (!realRoot.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error('Skill root is outside the workspace boundary.');
  }
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const skills: WorkspaceSkill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const packagePath = path.resolve(root, entry.name);
    const entryPath = path.resolve(packagePath, 'SKILL.md');
    const base: WorkspaceSkill = {
      name: entry.name,
      source: 'workspace',
      packagePath,
      entryPath,
      availability: 'unavailable',
      diagnostics: [],
    };
    if (!entryPath.startsWith(`${root}${path.sep}`)) {
      base.diagnostics.push(diagnostic('unsafe-path', 'Skill entry path is outside the workspace boundary.'));
      skills.push(base);
      continue;
    }
    let content: Buffer;
    try {
      const realPackagePath = await realpath(packagePath);
      const realEntryPath = await realpath(entryPath);
      if (
        (realPackagePath !== realRoot && !realPackagePath.startsWith(`${realRoot}${path.sep}`)) ||
        !realEntryPath.startsWith(`${realRoot}${path.sep}`)
      ) {
        base.diagnostics.push(diagnostic('unsafe-path', 'Skill entry path is outside the workspace boundary.'));
        skills.push(base);
        continue;
      }
      const info = await stat(realEntryPath);
      if (!info.isFile()) throw Object.assign(new Error(), { code: 'ENOENT' });
      if (info.size > MAX_ENTRY_BYTES) {
        base.diagnostics.push(diagnostic('oversized-entry', 'SKILL.md exceeds the 12KB limit.'));
        skills.push(base);
        continue;
      }
      content = await readFile(entryPath);
    } catch (error) {
      base.diagnostics.push(diagnostic(
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-entry' : 'unreadable-entry',
        (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'SKILL.md is missing.' : 'SKILL.md could not be read.',
      ));
      skills.push(base);
      continue;
    }
    const parsed = HEADER.exec(content.toString('utf8'));
    const info = parsed && metadata(parsed[1]);
    if (!info) {
      base.diagnostics.push(diagnostic('invalid-metadata', 'SKILL.md metadata must include a valid name and description.'));
      skills.push(base);
      continue;
    }
    base.name = info.name;
    base.description = info.description;
    base.contentHash = createHash('sha256').update(content).digest('hex');
    base.availability = 'usable';
    skills.push(base);
  }
  return skills;
}
