import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { saveGeneratedImage } from '../src/main/generated-image';
import { shareInvitation } from '../src/shared/share';
import { testImage } from './image-fixture';

test('shared invitations preserve the invitation secret in a fragment and require a usable certificate pin', () => {
  const token = randomBytes(32).toString('base64url'),
    pin = '01'.repeat(32);
  const link = `https://127.0.0.1:8000/#invite=${token}`;
  assert.equal(shareInvitation(link, pin).url, link);
  assert.equal(shareInvitation(link + '&fingerprint=' + pin).fingerprint, pin);
  for (const bad of [
    link.replace('https:', 'http:'),
    link.replace('/#', '/other#'),
    link + '&invite=' + token,
    link.replace('127.0.0.1', 'user@127.0.0.1'),
  ])
    assert.throws(() => shareInvitation(bad, pin));
  assert.throws(() => shareInvitation(link), /指纹/);
});

test('Codex file-based generation imports only the native image directory and supports fileId completions', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'athena-generated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = path.join(root, 'generated_images'),
    out = path.join(root, 'output');
  await mkdir(files);
  const bytes = Buffer.from(testImage.data, 'base64');
  const savedPath = path.join(files, 'img.png');
  await writeFile(savedPath, bytes);
  const artifact = await saveGeneratedImage({ savedPath }, out, root);
  assert.equal(artifact.mimeType, 'image/png');
  assert.deepEqual(await readFile(artifact.path), bytes);
  const outside = path.join(root, 'unrelated.png');
  await writeFile(outside, bytes);
  await symlink(outside, path.join(files, 'linked.png'));
  await assert.rejects(
    saveGeneratedImage({ savedPath: path.join(files, 'linked.png') }, out, root),
    /原生图片目录/,
  );
  await assert.rejects(saveGeneratedImage({ result: 'invalid-data' }, out, root), /图片数据/);
  await assert.rejects(saveGeneratedImage({}, out, root), /未返回/);
  await assert.rejects(
    saveGeneratedImage({ savedPath }, out, root, { decodes: () => false }),
    /解码/,
  );
  const thread = 'thread-1';
  await mkdir(path.join(files, thread));
  await writeFile(path.join(files, thread, 'call_1.png'), bytes);
  const item = { fileId: 'fixture-file', id: 'call_1' };
  const recovered = await saveGeneratedImage(item, out, root, { threadId: thread, startedAt: 0 });
  assert.deepEqual(await readFile(recovered.path), bytes);
  await assert.rejects(
    saveGeneratedImage(item, out, root, { threadId: thread, startedAt: Date.now() + 5000 }),
    /仅返回文件标识/,
  );
});
