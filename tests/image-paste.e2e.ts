/** Real Electron clipboard → composer → IPC → CLI. Default uses a fake CLI; opt in to one billed turn with ATHENA_LIVE_IMAGE_TEST=1. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { AppSnapshot } from '../src/shared/types';
import { testImage } from './image-fixture';

const live = process.env.ATHENA_LIVE_IMAGE_TEST === '1';
const root = process.cwd();
await mkdir(path.join(root, '.runtime'), { recursive: true });
const temporary = await mkdtemp(path.join(root, '.runtime/image-paste-'));
const workspace = path.join(temporary, 'workspace');
const profile = path.join(temporary, 'profile');
const bin = path.join(temporary, 'bin');
const output = path.resolve('test-results', live ? 'image-paste-live' : 'image-paste');
for (const directory of [workspace, profile, bin, output])
  await mkdir(directory, { recursive: true });
const log = path.join(temporary, 'protocol.jsonl');
await writeFile(log, '');
await writeFile(
  path.join(profile, 'workspace.json'),
  JSON.stringify({
    settings: {
      workspace,
      agent: 'codex',
      ...(live ? { modelSelections: { codex: { model: 'gpt-6.1-sol', effort: 'low' } } } : {}),
    },
    recordings: [],
    onboarding: {
      version: 1,
      status: 'complete',
      stage: 'ready',
      required: false,
      browserDeferred: true,
      workspaceConfirmed: workspace,
    },
    conversations: live
      ? []
      : [
          { id: 'saved', title: '已有对话', workspace, agent: 'codex', messages: [], updatedAt: 1 },
          {
            id: 'unsupported',
            title: 'Gemini 对话',
            workspace,
            agent: 'gemini',
            messages: [],
            updatedAt: 0,
          },
        ],
  }),
);
if (!live)
  await writeFile(
    path.join(bin, 'codex'),
    `#!${process.execPath}\n` +
      String.raw`
import fs from 'node:fs'; import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex image fixture'); process.exit(); }
const threadId = 'image-thread-' + process.pid;
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
let turn = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
  const r = JSON.parse(line), p = r.params || {};
  fs.appendFileSync(process.env.ATHENA_IMAGE_LOG, line + '\n');
  if (r.method === 'initialize') return out({id:r.id,result:{userAgent:'image-fixture'}});
  if (r.method === 'thread/start' || r.method === 'thread/resume') return out({id:r.id,result:{thread:{id:threadId}}});
  if (r.method === 'model/list') return out({id:r.id,result:{data:[]}});
  if (r.method === 'turn/start') {
    const id = 'turn-' + (++turn), text = '图片测试完成';
    out({id:r.id,result:{turn:{id,status:'inProgress'}}});
    setTimeout(() => {
      out({method:'item/agentMessage/delta',params:{threadId,turnId:id,itemId:id,delta:text}});
      out({method:'item/completed',params:{threadId,turnId:id,item:{id,type:'agentMessage',text}}});
      out({method:'turn/completed',params:{threadId,turnId:id,turn:{id,status:'completed',items:[]}}});
    }, 200);
    return;
  }
  if (r.id !== undefined) out({id:r.id,result:{}});
});
`,
    { mode: 0o700 },
  );
const env: NodeJS.ProcessEnv = {
  ...process.env,
  WORKBENCH_USER_DATA_DIR: profile,
  ATHENA_IMAGE_LOG: log,
  ...(live ? {} : { PATH: `${bin}${path.delimiter}${process.env.PATH}` }),
};
delete env.WORKBENCH_DEV_SERVER_URL;
let app!: ElectronApplication;
let page!: Page;
const errors: string[] = [];
const checks: string[] = [];
const launch = async () => {
  app = await electron.launch({
    args: [path.join(root, 'tests/electron-background.cjs')],
    cwd: root,
    env: Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate('window.__name = fn => fn');
  await expect(page.getByRole('textbox', { name: '发送给 Agent 的任务' })).toBeVisible();
};
const snapshot = () => page.evaluate(() => window.workbench.invoke<AppSnapshot>('app:snapshot'));
const composer = () => page.getByRole('textbox', { name: '发送给 Agent 的任务' });
const thumbnails = () => page.locator('.composer .image-attachments img');
const send = () => page.locator('.composer [data-slot="prompt-input-send"]');
let clipboardSaved = false;
const restoreClipboard = async () => {
  if (!clipboardSaved) return;
  await app.evaluate(async ({ clipboard }) => {
    const item = (await clipboard.read()).find((item) => item.types.includes('image/png'));
    const owned = (globalThis as any).__imageTestOwnedClipboard;
    // Preserve a clipboard change made by the user while this test was running.
    if (item && Buffer.from(await (await item.getType('image/png')).arrayBuffer()).equals(owned))
      await clipboard.write((globalThis as any).__imageTestClipboard);
  });
  clipboardSaved = false;
};
await launch();
try {
  const marker = `VISION-${randomBytes(3).toString('hex').toUpperCase()}`;
  const image = await page.evaluate((marker) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = '#111111';
    context.font = 'bold 40px sans-serif';
    context.fillText(marker, 40, 60);
    context.fillStyle = '#d12d32';
    context.fillRect(40, 110, 160, 140);
    context.fillStyle = '#2361c7';
    context.beginPath();
    context.moveTo(340, 100);
    context.lineTo(250, 250);
    context.lineTo(430, 250);
    context.fill();
    context.fillStyle = '#23854c';
    for (let i = 0; i < 3; i++) {
      context.beginPath();
      context.arc(500, 130 + i * 65, 22, 0, Math.PI * 2);
      context.fill();
    }
    return canvas.toDataURL('image/png');
  }, marker);
  await app.evaluate(async ({ clipboard, ClipboardItem }, image) => {
    const previous = await clipboard.read();
    (globalThis as any).__imageTestClipboard = await Promise.all(
      previous.map(
        async (item) =>
          new ClipboardItem(
            Object.fromEntries(
              await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
            ),
          ),
      ),
    );
    await clipboard.write([
      new ClipboardItem({
        'image/png': new Blob([Buffer.from(image.split(',')[1], 'base64')], { type: 'image/png' }),
      }),
    ]);
  }, image);
  clipboardSaved = true;
  await app.evaluate(async ({ clipboard }) => {
    const item = (await clipboard.read()).find((item) => item.types.includes('image/png'))!;
    (globalThis as any).__imageTestOwnedClipboard = Buffer.from(
      await (await item.getType('image/png')).arrayBuffer(),
    );
  });
  await page.locator('.new-conversation').click();
  await composer().focus();
  await composer().press('Meta+v');
  await expect(thumbnails()).toHaveCount(1);
  await expect
    .poll(() =>
      thumbnails()
        .first()
        .evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBe(640);
  await expect(send()).toBeEnabled();
  const pastedSource = await thumbnails().first().getAttribute('src');
  assert.ok(pastedSource);
  checks.push('Native macOS image paste produces a decoded preview and enables image-only send');

  if (live) {
    await composer().fill(
      '请只根据附图回答：图顶部的完整英文编号，以及每种形状的颜色和数量。不要使用任何工具，也不要读取文件。',
    );
    await send().click();
    await expect
      .poll(
        async () =>
          (await snapshot()).conversations
            .flatMap((c) => c.messages)
            .find((m) => m.role === 'assistant')?.status,
        { timeout: 300000 },
      )
      .toMatch(/^(done|error)$/);
    const state = await snapshot();
    const reply = state.conversations
      .flatMap((c) => c.messages)
      .find((m) => m.role === 'assistant');
    assert.equal(reply?.status, 'done', reply?.failure ?? 'No completed image response');
    assert.ok(reply.text.includes(marker), `Image marker was not read: ${reply.text}`);
    assert.equal(
      reply.tools?.length ?? 0,
      0,
      'Recognition must come from image input, not file tools',
    );
    await page.screenshot({ path: path.join(output, 'recognition.png') });
    await writeFile(
      path.join(output, 'verification.json'),
      JSON.stringify(
        { passed: true, realModelCalls: 1, marker, reply: reply.text, model: reply.model, checks },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ passed: true, realModelCalls: 1, output }));
  } else {
    // Image-only drafts remain reachable and are scoped to their own conversation.
    await page.getByRole('button', { name: '已有对话', exact: true }).click();
    await expect(thumbnails()).toHaveCount(0);
    await page
      .locator('.conversation-link')
      .filter({ hasText: /^新对话$/ })
      .click();
    await expect(thumbnails()).toHaveCount(1);
    await page.getByRole('button', { name: /移除图片/ }).click();
    await expect(thumbnails()).toHaveCount(0);
    await expect(send()).toBeDisabled();
    await composer().press('Meta+v');
    await expect(thumbnails()).toHaveCount(1);
    await page.screenshot({ path: path.join(output, 'draft.png') });
    await send().click();
    await expect
      .poll(
        async () =>
          (await snapshot()).conversations
            .flatMap((c) => c.messages)
            .filter((m) => m.role === 'assistant' && m.status === 'done').length,
      )
      .toBe(1);
    await expect(thumbnails()).toHaveCount(0);
    const imageConversation = (await snapshot()).conversations.find((c) => c.title === '图片对话')!;
    assert.ok(
      imageConversation.messages[0].images?.[0].data === pastedSource.split(',')[1],
      'Saved bytes match the clipboard preview',
    );
    const requests = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(requests.find((r) => r.method === 'turn/start').params.input, [
      { type: 'image', url: pastedSource },
    ]);
    checks.push(
      'Image-only draft survives navigation and removal; exact image bytes reach native turn/start and the saved message',
    );

    await composer().fill('一起查看');
    await composer().press('Meta+v');
    await composer().press('Meta+v');
    await expect(thumbnails()).toHaveCount(2);
    await expect(composer()).toHaveText('一起查看');
    await page
      .getByRole('button', { name: /移除图片/ })
      .first()
      .click();
    await expect(thumbnails()).toHaveCount(1);
    await composer().press('Enter');
    await expect
      .poll(
        async () =>
          (await snapshot()).conversations.find((c) => c.id === imageConversation.id)?.messages
            .length,
      )
      .toBe(4);
    await expect
      .poll(
        async () =>
          (await snapshot()).conversations
            .find((c) => c.id === imageConversation.id)
            ?.messages.at(-1)?.status,
      )
      .toBe('done');
    checks.push(
      'Text plus images, repeated paste, removing one attachment, and keyboard submit work',
    );

    for (const [index, mimeType] of ['image/jpeg', 'image/webp'].entries()) {
      await composer().evaluate((node, mimeType) => {
        const canvas = document.createElement('canvas');
        canvas.width = 40;
        canvas.height = 30;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#336699';
        context.fillRect(0, 0, 40, 30);
        const binary = atob(canvas.toDataURL(mimeType).split(',')[1]);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        const data = new DataTransfer();
        data.items.add(
          new File([bytes], mimeType === 'image/webp' ? 'sample.webp' : 'sample.jpg', {
            type: mimeType,
          }),
        );
        node.dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
        );
      }, mimeType);
      await expect(thumbnails()).toHaveCount(1);
      const preview = await thumbnails().first().getAttribute('src');
      assert.ok(
        preview?.startsWith(mimeType === 'image/webp' ? 'data:image/png;' : 'data:image/jpeg;'),
      );
      await send().click();
      await expect
        .poll(
          async () =>
            (await snapshot()).conversations
              .find((c) => c.id === imageConversation.id)
              ?.messages.filter((m) => m.role === 'assistant' && m.status === 'done').length,
        )
        .toBe(3 + index);
      const sent = (await snapshot()).conversations
        .find((c) => c.id === imageConversation.id)!
        .messages.at(-2)!.images![0];
      assert.ok(
        `data:${sent.mimeType};base64,${sent.data}` === preview,
        'Host persists the actual preview bytes',
      );
    }
    checks.push(
      'JPEG sends natively; clipboard WebP is decoded to PNG and accepted by the host without losing the preview',
    );

    await composer().evaluate((node) => {
      const data = new DataTransfer();
      data.items.add(new File(['broken'], 'broken.png', { type: 'image/png' }));
      node.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
      );
    });
    await expect(page.locator('#composer-image-error')).toContainText('图片无法读取');
    await expect(send()).toBeDisabled();
    await page.getByRole('button', { name: '移除图片 broken.png' }).click();
    await page.evaluate(() => {
      const original = window.createImageBitmap;
      (window as any).__restoreImageRead = () => {
        window.createImageBitmap = original;
      };
      window.createImageBitmap = ((...args: any[]) =>
        new Promise((resolve) => {
          (window as any).__releaseImageRead = () => resolve((original as any)(...args));
        })) as typeof createImageBitmap;
    });
    await composer().press('Meta+v');
    await expect(page.getByText('读取中…', { exact: true })).toBeVisible();
    await expect(send()).toBeDisabled();
    await page.getByRole('button', { name: /移除图片/ }).click();
    await page.evaluate(async () => {
      (window as any).__restoreImageRead();
      (window as any).__releaseImageRead();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await expect(page.locator('.composer .image-attachments')).toHaveCount(0);
    checks.push(
      'Unreadable images retain a removable error; removing an in-flight read prevents late attachment resurrection',
    );

    await page.getByRole('button', { name: 'Gemini 对话', exact: true }).click();
    await composer().press('Meta+v');
    await expect(thumbnails()).toHaveCount(1);
    await expect(page.locator('#composer-image-error')).toContainText('不支持图片');
    await expect(send()).toBeDisabled();
    for (const bad of [
      { text: 'bad', images: [{ ...testImage, data: 'file:///private/test' }] },
      { text: 'bad', images: [{ ...testImage, data: 'iVBORw0KGgo=' }] },
      { id: 'unsupported', text: 'bad', images: [testImage] },
    ]) {
      const result = await page.evaluate(
        (payload) =>
          window.workbench.invoke('conversation:send', payload).then(
            () => 'accepted',
            (error: Error) => error.message,
          ),
        bad,
      );
      assert.notEqual(result, 'accepted');
    }
    assert.equal(
      (await snapshot()).conversations.find((c) => c.id === 'unsupported')?.messages.length,
      0,
    );
    checks.push(
      'Unsupported CLI preserves the draft; invalid bytes, external URLs and unsupported IPC sends are rejected before a turn',
    );
    await page.getByRole('button', { name: '图片对话', exact: true }).click();
    await page.setViewportSize({ width: 1060, height: 740 });
    await composer().press('Meta+v');
    await expect(thumbnails()).toHaveCount(1);
    await page.screenshot({ path: path.join(output, 'narrow.png') });
    await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      document.documentElement.dataset.theme = 'dark';
    });
    await page.screenshot({ path: path.join(output, 'dark.png'), animations: 'disabled' });
    await restoreClipboard();
    await app.close();
    await launch();
    await page.getByRole('button', { name: '图片对话', exact: true }).click();
    await expect(page.locator('.message.user .image-attachments img')).toHaveCount(4);
    checks.push(
      'Sent images render again after a real app restart; light, dark and minimum width screenshots captured',
    );
    assert.deepEqual(errors, []);
    await writeFile(
      path.join(output, 'verification.json'),
      JSON.stringify({ passed: true, realModelCalls: 0, checks, errors }, null, 2),
    );
    console.log(JSON.stringify({ passed: true, checks, output }));
  }
} catch (error) {
  await page!.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await restoreClipboard().catch(() => {});
  await app!.close().catch(() => {});
}
