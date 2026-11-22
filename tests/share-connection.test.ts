import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ShareConnection } from '../src/renderer/share-connection';
import type { BrowserFrame } from '../src/shared/types';

function fixture(t: TestContext) {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const connection = new ShareConnection(
    'Bob',
    '',
    () => {},
    () => {},
  ) as any;
  const messages: any[] = [];
  connection.socket = {
    readyState: WebSocket.OPEN,
    send: (data: string) => messages.push(JSON.parse(data)),
    close() {},
  };
  connection.state = { generation: 4 };
  connection.browser = { loading: false, viewport: { width: 620, height: 400, epoch: 2 } };
  const frame = (sequence: number, epoch: number): BrowserFrame => ({
    data: 'frame',
    sequence,
    epoch,
    width: 620,
    height: 400,
    tabId: 'page',
  });
  connection.frame = frame(1, 1);
  const decode = (current: BrowserFrame) => {
    connection.receivedFrame = current;
    return connection.acknowledge(current);
  };
  const reject = (message: string) => {
    const command = messages.filter((m) => m.type === 'command').at(-1);
    const pending = connection.pending.get(command.id);
    clearTimeout(pending.timer);
    connection.pending.delete(command.id);
    pending.reject(new Error(message));
  };
  const resolve = (value: unknown) => {
    const command = messages.filter((m) => m.type === 'command').at(-1);
    const pending = connection.pending.get(command.id);
    clearTimeout(pending.timer);
    connection.pending.delete(command.id);
    pending.resolve(value);
  };
  t.after(() => {
    connection.close();
    if (storage) Object.defineProperty(globalThis, 'sessionStorage', storage);
    else delete (globalThis as any).sessionStorage;
  });
  return { connection, messages, frame, reject, resolve, decode };
}

test('an old decode cannot acknowledge a new socket’s copy of the very same frame', (t) => {
  const f = fixture(t);
  const old = f.frame(2, 2),
    resumed = { ...old };
  f.connection.frame = undefined;
  f.connection.receivedFrame = resumed;
  assert.equal(f.connection.acknowledge(old), false);
  assert.equal(f.messages.length, 0);
  assert.equal(f.connection.frameIsCurrent(), false);
  assert.equal(f.connection.acknowledge(resumed), true);
  assert.equal(f.connection.frameIsCurrent(), true);
  f.connection.browser.loading = true;
  assert.equal(f.connection.frameIsCurrent(), false);
});

test('automatic element details wait for a matching fresh frame and retry once after its ACK', async (t) => {
  const f = fixture(t);
  const result = f.connection.invoke('browser:element-details', { ref: 'selected' });
  f.reject('画面已过期，请等待新画面后重试');
  await Promise.resolve();
  assert.equal(f.messages.length, 1);
  f.decode(f.frame(2, 1));
  await Promise.resolve();
  assert.equal(
    f.messages.filter((m) => m.type === 'command').length,
    1,
    'An old-epoch frame cannot release the read',
  );
  f.decode(f.frame(3, 2));
  await Promise.resolve();
  assert.deepEqual(
    f.messages.map((m) => m.type),
    ['command', 'ack', 'ack', 'command'],
  );
  assert.equal(f.messages.at(-1).frame.epoch, 2);
  f.resolve({ ref: 'selected', textContent: 'Latest title' });
  assert.equal((await result).textContent, 'Latest title');
});

test('mutations and unrelated detail errors are never retried', async (t) => {
  const f = fixture(t);
  for (const [action, error] of [
    ['browser:edit', '画面已过期，请等待新画面后重试'],
    ['browser:element-details', '元素引用已失效'],
  ]) {
    const before = f.messages.filter((m) => m.type === 'command').length;
    const result = f.connection.invoke(action, { ref: 'selected' });
    f.reject(error);
    await assert.rejects(result, new RegExp(error));
    f.decode(f.frame(f.messages.length + 1, 2));
    await Promise.resolve();
    assert.equal(f.messages.filter((m) => m.type === 'command').length, before + 1);
  }
});

test('a second stale result is returned instead of replaying a read indefinitely', async (t) => {
  const f = fixture(t);
  const result = f.connection.invoke('browser:element-details', { ref: 'selected' });
  f.reject('画面已过期，请等待新画面后重试');
  await Promise.resolve();
  f.decode(f.frame(2, 2));
  await Promise.resolve();
  f.reject('画面已过期，请等待新画面后重试');
  await assert.rejects(result, /画面已过期/);
  assert.equal(f.messages.filter((m) => m.type === 'command').length, 2);
});

test('control changes and disconnects revoke pending frame reads', async (t) => {
  const f = fixture(t);
  let result = f.connection.invoke('browser:element-details', { ref: 'selected' });
  f.reject('画面已过期，请等待新画面后重试');
  await Promise.resolve();
  f.connection.state.generation++;
  f.decode(f.frame(2, 2));
  await assert.rejects(result, /控制权已变化/);
  result = f.connection.invoke('browser:element-details', { ref: 'selected' });
  f.reject('画面已过期，请等待新画面后重试');
  await Promise.resolve();
  f.connection.close();
  await assert.rejects(result, /连接已中断/);
  assert.equal(f.messages.filter((m) => m.type === 'command').length, 2);
});
