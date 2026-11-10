/** 单次复制的字符上限；超出时拒绝，不复制被截断的内容。 */
export const maxCopyLength = 10_000_000;

/** Electron 剪贴板中用到的异步文本接口。 */
export interface TextClipboard {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
}

/** 等待系统写入完成后读回核对，内容完整才算复制成功。 */
export async function copyText(clipboard: TextClipboard, value: unknown): Promise<true> {
  if (typeof value !== 'string' || !value) throw new Error('没有可复制的文本');
  if (value.length > maxCopyLength) throw new Error('内容过长，无法复制');
  try {
    await clipboard.writeText(value);
  } catch (cause) {
    throw new Error('系统剪贴板写入失败，请重试', { cause });
  }
  if ((await clipboard.readText()) !== value) throw new Error('系统剪贴板没有保留这段内容，请重试');
  return true;
}
