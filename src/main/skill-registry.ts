import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SkillDiagnostic, SkillDiscovery, SkillSource, SkillSourceStatus, WorkspaceSkill } from '../shared/skills';

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

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

async function scanRoot(root: string, source: SkillSource, strictRoot: string): Promise<{ skills: WorkspaceSkill[]; status: SkillSourceStatus }> {
  const status: SkillSourceStatus = { source, rootPath: path.resolve(root), diagnostics: [] };
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') status.diagnostics.push(diagnostic('missing-root', `${source} Skill root is missing.`));
    else status.diagnostics.push(diagnostic('unreadable-entry', `${source} Skill root could not be read.`));
    return { skills: [], status };
  }
  const realBoundary = await realpath(strictRoot);
  if (!inside(realRoot, realBoundary)) {
    status.diagnostics.push(diagnostic('unsafe-path', `${source} Skill root is outside its allowed boundary.`));
    return { skills: [], status };
  }
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { status.diagnostics.push(diagnostic('unreadable-entry', `${source} Skill root could not be read.`)); return { skills: [], status }; }
  const skills: WorkspaceSkill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const packagePath = path.resolve(root, entry.name);
    const entryPath = path.resolve(packagePath, 'SKILL.md');
    const base: WorkspaceSkill = { name: entry.name, source, packagePath, entryPath, availability: 'unavailable', diagnostics: [] };
    try {
      const realPackage = await realpath(packagePath);
      const realEntry = await realpath(entryPath);
      if (!inside(realPackage, realRoot) || !inside(realEntry, realRoot)) {
        base.diagnostics.push(diagnostic('unsafe-path', `Skill entry path is outside the ${source} boundary.`)); skills.push(base); continue;
      }
      const info = await stat(realEntry);
      if (!info.isFile()) throw Object.assign(new Error(), { code: 'ENOENT' });
      if (info.size > MAX_ENTRY_BYTES) { base.diagnostics.push(diagnostic('oversized-entry', 'SKILL.md exceeds the 12KB limit.')); skills.push(base); continue; }
      const content = await readFile(realEntry);
      const parsed = HEADER.exec(content.toString('utf8'));
      const infoMetadata = parsed && metadata(parsed[1]);
      if (!infoMetadata) { base.diagnostics.push(diagnostic('invalid-metadata', 'SKILL.md metadata must include a valid name and description.')); skills.push(base); continue; }
      base.name = infoMetadata.name;
      base.description = infoMetadata.description;
      base.contentHash = createHash('sha256').update(content).digest('hex');
      base.availability = 'usable';
    } catch (error) {
      base.diagnostics.push(diagnostic((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-entry' : 'unreadable-entry', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'SKILL.md is missing.' : 'SKILL.md could not be read.'));
    }
    skills.push(base);
  }
  return { skills, status };
}

export async function discoverSkills(workspace: string, home = os.homedir()): Promise<SkillDiscovery> {
  const workspaceRoot = path.resolve(workspace);
  const globalHome = path.resolve(home);
  const [workspaceResult, globalResult] = await Promise.all([
    scanRoot(path.join(workspaceRoot, '.agents', 'skills'), 'workspace', workspaceRoot),
    scanRoot(path.join(globalHome, '.agents', 'skills'), 'global', globalHome),
  ]);
  const effective = new Map<string, WorkspaceSkill>();
  for (const skill of [...globalResult.skills, ...workspaceResult.skills]) {
    if (skill.availability === 'usable' || !effective.has(skill.name)) effective.set(skill.name, skill);
  }
  return { skills: [...effective.values()].sort((a, b) => a.name.localeCompare(b.name)), workspace: workspaceResult.status, global: globalResult.status };
}

export async function discoverWorkspaceSkills(workspace: string): Promise<WorkspaceSkill[]> {
  const root = path.resolve(workspace, '.agents', 'skills');
  const result = await scanRoot(root, 'workspace', path.resolve(workspace));
  if (result.status.diagnostics.some((item) => item.code === 'unsafe-path')) throw new Error('Skill root is outside the workspace boundary.');
  return result.skills;
}
