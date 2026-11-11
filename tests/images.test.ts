import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_IMAGE_BYTES, parseImages } from '../src/shared/images';
import { testImage } from './image-fixture';

test('image inputs accept bounded embedded data and reject paths, URLs, mismatched formats and oversized batches', () => {
  assert.deepEqual(parseImages(undefined), []);
  assert.deepEqual(parseImages([{ ...testImage, path: '/private/file' }]), [testImage]);
  for (const value of [
    {},
    [null],
    [{ ...testImage, id: '../../file' }],
    [testImage, testImage],
    [{ ...testImage, data: 'https://example.com/image.png' }],
    [{ ...testImage, data: 'file:///private/image.png' }],
    [{ ...testImage, data: 'AAAA' }],
    [{ ...testImage, mimeType: 'image/jpeg' }],
    [{ ...testImage, mimeType: 'image/svg+xml' }],
    Array.from({ length: 5 }, (_, i) => ({ ...testImage, id: `image-${i}` })),
    [{ ...testImage, data: 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) }],
  ])
    assert.throws(() => parseImages(value));
  const large = Buffer.concat([
    Buffer.from(testImage.data, 'base64').subarray(0, 8),
    Buffer.alloc(4 * 1024 * 1024),
  ]).toString('base64');
  assert.throws(
    () => parseImages([0, 1, 2].map((i) => ({ ...testImage, id: `image-${i}`, data: large }))),
    /总大小/,
  );
});
