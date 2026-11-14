/** A message the user sent while a turn was running. It waits in the host for its turn. */
export interface QueuedMessage {
  id: string;
  conversationId: string;
  /** What the user wrote, as the conversation will show it. */
  text: string;
  /** Number of images that go with it. */
  images: number;
  createdAt: number;
}

export interface MessageQueueState {
  /** Oldest first: the order in which they are sent. */
  items: QueuedMessage[];
  /** Conversations whose messages wait for the user, after their turn was stopped or failed. */
  paused: string[];
}

export const emptyQueue: MessageQueueState = { items: [], paused: [] };
