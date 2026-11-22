import type { BrowserFrame, BrowserState } from '../shared/types';
import type { ShareServerMessage, ShareState } from '../shared/share';

export class ShareConnection {
  private socket?: WebSocket;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 0;
  private frameReaders = new Set<() => void>();
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private resume = sessionStorage.getItem('athena-share-resume') || '';
  /** Only an image delivered by this socket can acknowledge its in-flight frame. */
  receivedFrame?: BrowserFrame;
  state?: ShareState;
  browser?: BrowserState;
  participantId = '';
  frame?: BrowserFrame;
  constructor(
    private name: string,
    private invite: string,
    private receive: (message: ShareServerMessage) => void,
    private status: (value: string) => void,
  ) {}
  connect(): void {
    if (this.stopped) return;
    this.status(this.attempts ? '正在重新连接…' : '正在连接…');
    const socket = (this.socket = new WebSocket(
      `${location.origin.replace('https:', 'wss:')}/connect`,
    ));
    socket.onopen = () => {
      this.nextId = 0;
      socket.send(
        JSON.stringify({ type: 'join', name: this.name, invite: this.invite, resume: this.resume }),
      );
    };
    socket.onmessage = (event) => {
      if (this.stopped || this.socket !== socket) return;
      const message: ShareServerMessage = JSON.parse(event.data);
      if (message.type === 'welcome') {
        this.participantId = message.participantId;
        this.resume = message.resume;
        sessionStorage.setItem('athena-share-resume', message.resume);
        this.attempts = 0;
        this.status('已连接');
      }
      if (message.type === 'state') {
        this.state = message.state;
        if (message.browser) this.browser = message.browser;
        for (const check of this.frameReaders) check();
      }
      if (message.type === 'frame') this.receivedFrame = message.frame;
      if (message.type === 'result') {
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.value);
        }
        return;
      }
      if (message.type === 'ended' || message.type === 'error') {
        this.stopped = true;
        sessionStorage.removeItem('athena-share-resume');
        if (message.type === 'ended') this.status('共享已结束');
      }
      this.receive(message);
    };
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      this.receivedFrame = this.frame = undefined;
      this.rejectPending('连接已中断，未确认的操作不会重试，请查看页面后继续');
      if (event.code === 4001 || event.code === 1008) {
        this.stopped = true;
        sessionStorage.removeItem('athena-share-resume');
        this.status(event.code === 4001 ? '已退出共享' : '连接已拒绝');
      }
      if (!this.stopped) {
        this.status('连接中断，正在重连…');
        this.retry = setTimeout(
          () => {
            this.attempts++;
            this.connect();
          },
          Math.min(10_000, 750 * 2 ** Math.min(this.attempts, 4)),
        );
      }
    };
  }
  acknowledge(frame: BrowserFrame): boolean {
    if (this.stopped || this.socket?.readyState !== WebSocket.OPEN || frame !== this.receivedFrame)
      return false;
    this.frame = frame;
    this.socket.send(JSON.stringify({ type: 'ack', sequence: frame.sequence, epoch: frame.epoch }));
    for (const check of this.frameReaders) check();
    return true;
  }
  frameIsCurrent(value = this.frame) {
    const viewport = this.browser?.viewport;
    return Boolean(
      !this.stopped &&
      this.socket?.readyState === WebSocket.OPEN &&
      value &&
      value === this.frame &&
      this.browser &&
      !this.browser.loading &&
      (!this.browser.activeTabId || value.tabId === this.browser.activeTabId) &&
      (!viewport ||
        (value.epoch === viewport.epoch &&
          value.width === viewport.width &&
          value.height === viewport.height)),
    );
  }
  async invoke<T = unknown>(action: string, payload?: unknown): Promise<T> {
    const frame = this.frame,
      generation = this.state?.generation;
    try {
      return await this.request<T>(action, payload);
    } catch (error) {
      // Only refresh an automatically loaded read; edits and input are never replayed.
      if (
        action !== 'browser:element-details' ||
        !(error instanceof Error) ||
        error.message !== '画面已过期，请等待新画面后重试'
      )
        throw error;
      await this.waitForFrame(frame, generation);
      return this.request<T>(action, payload);
    }
  }
  private waitForFrame(
    previous: BrowserFrame | undefined,
    generation: number | undefined,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.frameReaders.delete(check);
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (this.stopped || this.socket?.readyState !== WebSocket.OPEN)
          return finish(new Error('连接已中断，请重新选取元素'));
        if (this.state?.generation !== generation)
          return finish(new Error('控制权已变化，请重新选取元素'));
        const frame = this.frame,
          viewport = this.browser?.viewport;
        if (
          frame &&
          frame.sequence !== previous?.sequence &&
          !this.browser?.loading &&
          (!viewport ||
            (frame.epoch === viewport.epoch &&
              frame.width === viewport.width &&
              frame.height === viewport.height))
        )
          finish();
      };
      const timer = setTimeout(() => finish(new Error('页面尚未同步，请重新选取元素')), 15_000);
      this.frameReaders.add(check);
      check();
    });
  }
  private request<T = unknown>(action: string, payload?: unknown): Promise<T> {
    const socket = this.socket;
    if (this.stopped || socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('尚未连接，请等待重连'));
    if (this.pending.size >= 64 || socket.bufferedAmount > 128_000)
      return Promise.reject(new Error('输入过快，请等待页面响应'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('操作结果尚未确认，请检查页面后继续'));
      }, 15_000);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.send(
        JSON.stringify({
          type: 'command',
          id,
          action,
          payload,
          generation: this.state?.generation,
          frame: this.frame && { sequence: this.frame.sequence, epoch: this.frame.epoch },
        }),
      );
    });
  }
  private rejectPending(message: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
    for (const check of this.frameReaders) check();
  }
  close(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
    this.rejectPending('已离开共享');
    this.receivedFrame = this.frame = undefined;
  }
}
