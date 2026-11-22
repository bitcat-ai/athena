import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';

export interface RecordingVerification {
  status: 'passed' | 'failed' | 'unknown';
  detail: string;
}

const materials = ['营业资质.md', '服务协议.md', '结算说明.md'];
const maxArchive = 4 * 1024 * 1024;
const run = promisify(execFile);

async function archiveText(bytes: Buffer, args: string[], signal?: AbortSignal) {
  // macOS libarchive reads the owned bytes on stdin; nothing in the ZIP is extracted or executed.
  const process = run('/usr/bin/tar', args, {
    timeout: 3000,
    maxBuffer: 1024 * 1024,
    encoding: 'buffer',
    signal,
    env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
  });
  process.child.stdin?.on('error', () => {}).end(bytes);
  return new TextDecoder('utf-8', { fatal: true }).decode((await process).stdout);
}

/** Checks the explicitly selected customer-materials format. The caller supplies an owned download. */
export async function verifyCustomerMaterials(
  file: string,
  options: { customerId: string; excludeInternal: boolean; signal?: AbortSignal },
  expected?: { dev: number; ino: number; size: number; mtimeMs: number },
): Promise<RecordingVerification> {
  if (
    !/^[\p{L}\p{N}_.-]{1,80}$/u.test(options.customerId) ||
    typeof options.excludeInternal !== 'boolean'
  )
    return { status: 'unknown', detail: '请指定要核对的客户编号和材料规则。' };
  try {
    options.signal?.throwIfAborted();
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (
        expected &&
        (info.ino !== expected.ino ||
          info.dev !== expected.dev ||
          info.mtimeMs !== expected.mtimeMs ||
          info.size !== expected.size)
      )
        return { status: 'unknown', detail: '下载文件已经变化，请重新核对。' };
      if (!info.isFile() || info.size > maxArchive)
        return { status: 'unknown', detail: '文件不是可读取的小型材料包。' };
      bytes = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      if (bytesRead !== bytes.length || after.size !== bytesRead || after.mtimeMs !== info.mtimeMs)
        return { status: 'unknown', detail: '文件在核对期间发生变化。' };
    } finally {
      await handle.close();
    }
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50)
      return { status: 'failed', detail: '下载文件不是客户材料 ZIP。' };
    const names = (await archiveText(bytes, ['-tf', '-'], options.signal)).trimEnd().split('\n');
    const required = ['customer.json', ...materials];
    if (names.length !== required.length || !required.every((name) => names.includes(name)))
      return { status: 'failed', detail: '压缩包的文件清单与客户材料格式不符。' };
    const texts: string[] = [];
    for (const name of required)
      texts.push(await archiveText(bytes, ['-xOf', '-', name], options.signal));
    let customer;
    try {
      customer = JSON.parse(texts[0]);
    } catch {
      return { status: 'failed', detail: '客户信息不是有效的 JSON。' };
    }
    if (customer?.id !== options.customerId)
      return { status: 'failed', detail: '压缩包中的客户编号与本次目标不符。' };
    const belongs = texts.slice(1).every((text) => {
      const owners = [...text.matchAll(/^客户[：:]\s*([^\s]+).*$/gm)];
      return owners.length === 1 && owners[0][1] === options.customerId;
    });
    if (
      !belongs ||
      texts.some((text) =>
        [...text.matchAll(/\bC\d{4}\b/g)].some((m) => m[0] !== options.customerId),
      )
    )
      return { status: 'failed', detail: '材料的客户归属与本次目标不符。' };
    if (
      options.excludeInternal &&
      (Object.keys(customer).some((key) => !['id', 'company', 'status', 'owner'].includes(key)) ||
        Object.values(customer).some((value) => typeof value !== 'string') ||
        texts.some((text) => text.includes('INTERNAL_ONLY') || /内部(?:跟进)?备注/.test(text)))
    )
      return { status: 'failed', detail: '材料含内部标记或客户清单以外的字段。' };
    return {
      status: 'passed',
      detail: options.excludeInternal
        ? '已核对客户编号、四份文件清单、材料归属和内部标记。'
        : '已核对客户编号、四份文件清单及材料归属。',
    };
  } catch {
    options.signal?.throwIfAborted();
    return { status: 'unknown', detail: '材料包无法完整读取，未能核对内容。' };
  }
}
