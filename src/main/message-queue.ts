import { randomUUID } from 'node:crypto';
import type { MessageQueueState, QueuedMessage } from '../shared/queue';

export const QUEUE_LIMIT = 20;

export interface QueueEntry<T> {
  item: QueuedMessage;
  /** What it takes to send the message when its turn comes. */
  payload: T;
}

/**
 * Messages sent while a turn runs. One turn runs at a time, so they go out one by one, oldest
 * first, each after the turn before it has finished. A conversation whose turn was stopped or
 * failed keeps its messages back until the user says to go on: they were written for an answer
 * that never came.
 */
export class MessageQueue<T> {
  private entries: QueueEntry<T>[] = [];
  private paused = new Set<string>();

  constructor(private readonly onChange: (state: MessageQueueState) => void = () => {}) {}

  state(): MessageQueueState {
    return { items: this.entries.map((entry) => entry.item), paused: [...this.paused] };
  }

  get full() {
    return this.entries.length >= QUEUE_LIMIT;
  }

  add(conversationId: string, text: string, images: number, payload: T, files?: string[]) {
    if (this.full) throw new Error(`最多排队 ${QUEUE_LIMIT} 条消息，请等前面的任务完成后再发送`);
    const item = {
      id: randomUUID(),
      conversationId,
      text,
      images,
      ...(files?.length ? { files } : {}),
      createdAt: Date.now(),
    };
    this.entries.push({ item, payload });
    this.changed();
    return item;
  }

  remove(id: string) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.item.id !== id);
    if (this.entries.length === before) return false;
    this.changed();
    return true;
  }

  /** The conversation is gone or archived: nothing of it is sent any more. */
  drop(conversationId: string) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.item.conversationId !== conversationId);
    if (this.entries.length !== before || this.paused.has(conversationId)) this.changed();
  }

  /** A turn of this conversation is over. Unless it finished cleanly, its messages wait. */
  settle(conversationId: string, finished: boolean) {
    if (finished || this.paused.has(conversationId)) return;
    if (!this.entries.some((entry) => entry.item.conversationId === conversationId)) return;
    this.paused.add(conversationId);
    this.changed();
  }

  resume(conversationId: string) {
    if (this.paused.delete(conversationId)) this.changed();
  }

  /** The oldest message that may go now; it leaves the queue. */
  take(ready: (item: QueuedMessage) => boolean = () => true) {
    const index = this.entries.findIndex(
      (entry) => !this.paused.has(entry.item.conversationId) && ready(entry.item),
    );
    if (index < 0) return undefined;
    const [entry] = this.entries.splice(index, 1);
    this.changed();
    return entry;
  }

  /** A taken message did not go out: it returns to the front, waiting for the user if asked. */
  restore(entry: QueueEntry<T>, pause: boolean) {
    this.entries.unshift(entry);
    if (pause) this.paused.add(entry.item.conversationId);
    this.changed();
  }

  private changed() {
    // A pause only means something while there is a message to hold back.
    for (const id of this.paused)
      if (!this.entries.some((entry) => entry.item.conversationId === id)) this.paused.delete(id);
    this.onChange(this.state());
  }
}
