import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  findWorkspaceFiles,
  pickedWorkspaceFiles,
  workspaceFileContext,
} from '../src/main/workspace-files';
import { workspaceFilePaths } from '../src/shared/workspace-files';

test('workspace attachments carry selected text and binary references, with no path traversal', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'athena-files-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'project');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'notes.md'), '客户材料说明');
  await writeFile(path.join(root, 'input.bin'), Buffer.from([0, 2, 3, 0]));
  await writeFile(path.join(root, 'large.txt'), 'a'.repeat(100000));
  await writeFile(path.join(dir, 'outside.txt'), 'outside');
  await symlink(path.join(dir, 'outside.txt'), path.join(root, 'external'));
  const files = await pickedWorkspaceFiles(root, [
    path.join(root, 'docs', 'notes.md'),
    path.join(root, 'input.bin'),
    path.join(root, 'large.txt'),
  ]);
  assert.deepEqual(await findWorkspaceFiles(root, 'noTes'), ['docs/notes.md']);
  assert.deepEqual(workspaceFilePaths([...files, files[0]]), files);
  const entries = JSON.parse((await workspaceFileContext(root, files)).split('\n')[1]);
  assert.equal(entries[0].content, '客户材料说明');
  assert.equal(entries[1].kind, 'file-reference');
  assert.equal(entries[2].kind, 'file-reference');
  for (const unsafe of ['../outside.txt', '/etc/passwd', 'external'])
    await assert.rejects(workspaceFileContext(root, [unsafe]));
  await assert.rejects(pickedWorkspaceFiles(root, [path.join(dir, 'outside.txt')]));
});
