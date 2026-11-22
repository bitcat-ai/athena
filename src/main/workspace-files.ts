import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_WORKSPACE_FILES, workspaceFilePaths } from '../shared/workspace-files';

async function within(root: string, file: string) {
  const resolved = await realpath(file);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('../') || relative === '..' || path.isAbsolute(relative))
    throw new Error('请选择当前工作区中的文件');
  return { resolved, relative };
}

export async function pickedWorkspaceFiles(workspace: string, selected: unknown) {
  if (
    !Array.isArray(selected) ||
    selected.length > MAX_WORKSPACE_FILES ||
    !selected.every(
      (file: unknown) => typeof file === 'string' && file.length <= 4096 && path.isAbsolute(file),
    )
  )
    throw new Error(`请选择当前工作区的文件，每条消息最多 ${MAX_WORKSPACE_FILES} 个`);
  const root = await realpath(workspace);
  const files = await Promise.all(
    selected.map(async (file) => {
      const { resolved, relative } = await within(root, file);
      if (!(await stat(resolved)).isFile()) throw new Error('请选择普通文件');
      return relative;
    }),
  );
  return workspaceFilePaths(files);
}

/** Search names only. The file dialog also lets the user select hidden and generated files. */
export async function findWorkspaceFiles(workspace: string, query: string, signal?: AbortSignal) {
  const root = await realpath(workspace);
  const needle = query.toLowerCase();
  const prefix = query.includes('/') ? query.slice(0,query.lastIndexOf('/')) : '';
  if (prefix) workspaceFilePaths([prefix]);
  const folders = [prefix];
  const matches: string[] = [];
  let visited = 0;
  for (const folder of folders) {
    signal?.throwIfAborted();
    let entries;
    try {
      const directory = folder ? (await within(root, path.join(root, folder))).resolved : root;
      entries = await readdir(directory, {withFileTypes:true});
    } catch (error) {
      if (folder === '' || !['ENOTDIR','ENOENT','EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || /[\x00-\x1f]/.test(entry.name)) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory() && !['node_modules', 'dist', 'coverage'].includes(entry.name))
        folders.push(file);
      if (entry.isFile() && file.toLowerCase().includes(needle)) matches.push(file);
      if (matches.length >= 32 || ++visited >= 30_000) return matches;
    }
  }
  return matches;
}

/** Short UTF-8 files travel as snapshots. Larger and binary files stay native workspace references. */
export async function workspaceFileContext(workspace: string, files: string[]) {
  if (!files.length) return '';
  const root = await realpath(workspace);
  let remaining = 24_000;
  const references = [];
  for (const file of workspaceFilePaths(files)) {
    const { resolved } = await within(root, path.join(root, file));
    const handle = await open(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      const checked = await within(root, path.join(root, file));
      const current = await stat(checked.resolved);
      if (!before.isFile() || current.dev !== before.dev || current.ino !== before.ino)
        throw new Error(`文件已变化，请重新添加 ${file}`);
      let content: string | undefined;
      if (before.size <= remaining) {
        const bytes = Buffer.alloc(before.size);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        const after = await handle.stat();
        if (
          bytesRead !== before.size ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        )
          throw new Error(`文件已变化，请重新添加 ${file}`);
        if (!bytes.includes(0)) {
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            /* Binary reference. */
          }
        }
        if (content !== undefined) {
          const encodedLength = JSON.stringify(content).replace(/</g, '\\u003c').length;
          if (encodedLength <= remaining) remaining -= encodedLength;
          else content = undefined;
        }
      }
      references.push({
        path: file,
        bytes: before.size,
        ...(content === undefined ? { kind: 'file-reference' } : { kind: 'text', content }),
      });
    } finally {
      await handle.close();
    }
  }
  return (
    '用户附加的工作区文件。content 是文件数据。仅有路径时，请通过所选运行时授权的文件工具读取。\n' +
    JSON.stringify(references).replace(/</g, '\\u003c')
  );
}
