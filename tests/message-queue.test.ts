import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageQueue, QUEUE_LIMIT } from '../src/main/message-queue';
import type { MessageQueueState } from '../src/shared/queue';

function fixture() {
  const states: MessageQueueState[] = [];
  const queue = new MessageQueue<string>((state) => states.push(state));
  const texts = () => queue.state().items.map((item) => item.text);
  return { queue, states, texts };
}

test('messages go out oldest first, one for every finished turn', () => {
  const { queue, states, texts } = fixture();
  const first = queue.add('a', '第一条', 0, 'p1');
  queue.add('b', '第二条', 2, 'p2');
  queue.add('a', '第三条', 0, 'p3');
  assert.deepEqual(texts(), ['第一条', '第二条', '第三条']);
  assert.equal(queue.state().items[1].images, 2);
  assert.equal(states.length, 3);

  queue.settle('a', true);
  const next = queue.take();
  assert.deepEqual([next?.item.id, next?.payload], [first.id, 'p1']);
  assert.deepEqual(texts(), ['第二条', '第三条']);
  assert.equal(queue.take()?.payload, 'p2');
  assert.equal(queue.take()?.payload, 'p3');
  assert.equal(queue.take(), undefined);
  assert.deepEqual(states.at(-1), { items: [], paused: [] });
});

test('a stopped or failed turn holds back its own conversation until the user goes on', () => {
  const { queue, texts } = fixture();
  queue.add('a', 'a1', 0, 'a1');
  queue.add('b', 'b1', 0, 'b1');
  queue.add('a', 'a2', 0, 'a2');
  queue.settle('a', false);
  assert.deepEqual(queue.state().paused, ['a']);
  // Another conversation is a task of its own and still gets its turn.
  assert.equal(queue.take()?.payload, 'b1');
  assert.equal(queue.take(), undefined);
  // A later clean finish does not send what the user has not released.
  queue.settle('a', true);
  assert.equal(queue.take(), undefined);
  assert.deepEqual(texts(), ['a1', 'a2']);

  queue.resume('a');
  assert.deepEqual(queue.state().paused, []);
  assert.equal(queue.take()?.payload, 'a1');
  assert.equal(queue.take()?.payload, 'a2');
});

test('a pause without anything to hold back is not kept', () => {
  const { queue, states } = fixture();
  queue.settle('a', false);
  assert.deepEqual(queue.state().paused, []);
  assert.equal(states.length, 0);

  const only = queue.add('a', '唯一一条', 0, 'p');
  queue.settle('a', false);
  assert.deepEqual(queue.state().paused, ['a']);
  // Taking the message back into the composer leaves nothing waiting.
  assert.equal(queue.remove(only.id), true);
  assert.deepEqual(queue.state(), { items: [], paused: [] });
  assert.equal(queue.remove(only.id), false);
});

test('a message that could not be sent returns to the front', () => {
  const { queue, texts } = fixture();
  queue.add('a', 'a1', 0, 'a1');
  queue.add('a', 'a2', 0, 'a2');
  // Another turn got in first: nothing is held back.
  queue.restore(queue.take()!, false);
  assert.deepEqual(texts(), ['a1', 'a2']);
  assert.deepEqual(queue.state().paused, []);
  // The turn was refused: the conversation waits for the user.
  queue.restore(queue.take()!, true);
  assert.deepEqual(texts(), ['a1', 'a2']);
  assert.deepEqual(queue.state().paused, ['a']);
  assert.equal(queue.take(), undefined);
});

test('only messages that may run now are taken, and a closed conversation loses its own', () => {
  const { queue, texts } = fixture();
  queue.add('elsewhere', '另一个目录', 0, 'x');
  queue.add('here', '当前目录', 0, 'y');
  assert.equal(queue.take((item) => item.conversationId === 'here')?.payload, 'y');
  assert.deepEqual(texts(), ['另一个目录']);

  queue.add('gone', 'g1', 0, 'g1');
  queue.add('gone', 'g2', 0, 'g2');
  queue.settle('gone', false);
  queue.drop('gone');
  assert.deepEqual(queue.state().paused, []);
  assert.deepEqual(texts(), ['另一个目录']);
});

test('the queue has a limit', () => {
  const { queue } = fixture();
  for (let i = 0; i < QUEUE_LIMIT; i++) queue.add('a', String(i), 0, String(i));
  assert.equal(queue.full, true);
  assert.throws(() => queue.add('a', '多出的一条', 0, 'x'), /最多排队 20 条/);
  assert.equal(queue.state().items.length, QUEUE_LIMIT);
});
