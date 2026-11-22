import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const generatedImageLimit = 32 * 1024 * 1024;
export async function readGeneratedImage(directory: string, filename: string) {
  const root = await realpath(directory),
    file = await realpath(filename);
  if (!file.startsWith(root + path.sep)) throw new Error('图片路径不在原生图片目录内');
  const reader = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await reader.stat();
    if (!info.isFile() || info.size <= 0 || info.size > generatedImageLimit)
      throw new Error('生成的图片无效或过大');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await reader.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('生成的图片未完整保存');
      offset += bytesRead;
    }
    const after = await reader.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new Error('生成图片在读取时发生变化');
    return bytes;
  } finally {
    await reader.close();
  }
}
export async function saveGeneratedImage(
  item: { result?: unknown; savedPath?: unknown; fileId?: unknown; id?: unknown },
  directory: string,
  codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex'),
  options?: { threadId?: string; startedAt?: number; decodes?: (bytes: Buffer) => boolean },
) {
  let bytes: Buffer;
  if (typeof item.result === 'string' && item.result.length > 0) {
    if (
      item.result.length > Math.ceil(generatedImageLimit / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(item.result)
    )
      throw new Error('Codex 返回的图片数据无效或过大');
    bytes = Buffer.from(item.result, 'base64');
  } else if (typeof item.savedPath === 'string' && path.isAbsolute(item.savedPath)) {
    bytes = await readGeneratedImage(path.join(codexHome, 'generated_images'), item.savedPath);
  } else if (
    typeof item.fileId === 'string' &&
    typeof item.id === 'string' &&
    /^[\w-]{1,200}$/.test(item.id) &&
    options?.threadId &&
    /^[\w-]{1,200}$/.test(options.threadId) &&
    options.startedAt !== undefined
  ) {
    const root = path.join(codexHome, 'generated_images'),
      base = path.join(root, options.threadId, item.id);
    const matches = [];
    for (const ext of ['png', 'gif']) {
      const file = base + '.' + ext,
        info = await stat(file).catch(() => undefined);
      if (info?.isFile() && info.mtimeMs >= options.startedAt) matches.push(file);
    }
    if (matches.length !== 1) throw new Error('Codex 仅返回文件标识，未交付可核对的本地图片');
    bytes = await readGeneratedImage(root, matches[0]);
  } else throw new Error('此 Codex 运行时未返回可读取的图片');
  const extension = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    ? 'png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'jpeg'
      : ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
        ? 'gif'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          ? 'webp'
          : undefined;
  if (
    !extension ||
    !bytes.length ||
    bytes.length > generatedImageLimit ||
    (options?.decodes && !options.decodes(bytes))
  )
    throw new Error('生成图片不能解码或超过大小限制');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const name = path.join(directory, randomUUID() + '.' + extension);
  const file = await open(name, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
  } catch (error) {
    await rm(name, { force: true });
    throw error;
  } finally {
    await file.close();
  }
  return {
    path: name,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mimeType: 'image/' + extension,
  };
}
