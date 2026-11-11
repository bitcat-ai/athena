export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: (typeof IMAGE_TYPES)[number];
  data: string;
}

export const imageSource = (image: ImageAttachment) =>
  `data:${image.mimeType};base64,${image.data}`;

/** Shared IPC validation: only bounded embedded images, never URLs or local file paths. */
export function parseImages(value: unknown): ImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES)
    throw new Error(`每条消息最多附加 ${MAX_IMAGES} 张图片`);
  let total = 0;
  const ids = new Set<string>();
  return value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,64}$/.test(item.id) ||
      ids.has(item.id) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 128 ||
      !IMAGE_TYPES.includes(item.mimeType) ||
      typeof item.data !== 'string'
    )
      throw new Error('图片格式无效，请粘贴 PNG、JPEG 或 WebP 图片');
    ids.add(item.id);
    if (item.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
      throw new Error('单张图片不能超过 5 MB');
    if (!item.data.length || item.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data))
      throw new Error('图片数据无效，请重新复制图片');
    const bytes = atob(item.data);
    total += bytes.length;
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 5 MB');
    if (total > MAX_IMAGE_TOTAL_BYTES) throw new Error('每条消息的图片总大小不能超过 10 MB');
    const matches =
      item.mimeType === 'image/png'
        ? bytes.startsWith('\x89PNG\r\n\x1a\n')
        : item.mimeType === 'image/jpeg'
          ? bytes.startsWith('\xff\xd8\xff')
          : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP';
    if (!matches) throw new Error('图片内容与格式不符，请重新复制图片');
    return { id: item.id, name: item.name, mimeType: item.mimeType, data: item.data };
  });
}
