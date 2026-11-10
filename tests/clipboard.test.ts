import test from 'node:test';
import assert from 'node:assert/strict';
import { copyText, maxCopyLength } from '../src/main/clipboard';

/** 系统剪贴板的替身，接口与 Electron 的异步剪贴板一致；`accept` 表示系统实际保留下来的内容。 */
function fakeClipboard(accept: (text: string) => string = (text) => text) {
  let held = '';
  return {
    async writeText(text: string) {
      held = accept(text);
    },
    async readText() {
      return held;
    },
  };
}

test('copies a complete message beyond 100k characters without truncating it', async () => {
  const clipboard = fakeClipboard();
  const text =
    '参考 [发布说明](https://example.com/release?tab=notes#top)\n\n```ts\nconst total = 1;\n```\n' +
    '长'.repeat(150_000) +
    '\n结尾';
  assert.equal(await copyText(clipboard, text), true);
  assert.equal(await clipboard.readText(), text);
});

test('waits for the system clipboard before reporting success', async () => {
  let written = false;
  const clipboard = {
    async writeText() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      written = true;
    },
    async readText() {
      return written ? '完整内容' : '';
    },
  };
  assert.equal(await copyText(clipboard, '完整内容'), true);
});

test('reports a failure when the system clipboard rejects the write', async () => {
  const clipboard = {
    async writeText() {
      throw new Error('pasteboard unavailable');
    },
    async readText() {
      return '完整内容';
    },
  };
  await assert.rejects(copyText(clipboard, '完整内容'), /剪贴板/);
});

test('reports a failure when the system clipboard does not hold the full text', async () => {
  await assert.rejects(
    copyText(
      fakeClipboard(() => ''),
      '完整内容',
    ),
    /剪贴板/,
  );
  await assert.rejects(
    copyText(
      fakeClipboard((text) => text.slice(0, 2)),
      '完整内容',
    ),
    /剪贴板/,
  );
});

test('rejects payloads that are not copyable text and leaves the clipboard untouched', async () => {
  const clipboard = fakeClipboard();
  await clipboard.writeText('原有内容');
  for (const value of [undefined, null, 42, {}, ['a'], ''])
    await assert.rejects(copyText(clipboard, value), /没有可复制的文本/);
  assert.equal(await clipboard.readText(), '原有内容');
});

test('refuses oversized text instead of copying a truncated part', async () => {
  const clipboard = fakeClipboard();
  await clipboard.writeText('原有内容');
  await assert.rejects(copyText(clipboard, 'x'.repeat(maxCopyLength + 1)), /过长/);
  assert.equal(await clipboard.readText(), '原有内容');
});
