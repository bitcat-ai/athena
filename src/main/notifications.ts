import type { AgentEvent } from '../shared/types.ts';

function excerpt(text: string, length = 1000) {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏]')
    .replace(/(Bearer\s+)\S+/gi, '$1[已隐藏]')
    .replace(/https?:\/\/[^\s<>]+/g, (value) => {
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
      } catch {
        return '[链接]';
      }
    })
    .slice(0, length);
}

// Each instance belongs to one turn; delivery never blocks or changes the Agent result.
// Only a task that came from Feishu is told there that it needs attention. A conversation held on
// the desktop stays on the desktop: the bot is the user's way in, not a copy of their work.
export class TurnNotifications {
  private sent = new Set<string>();
  private requests = new Set<string>();
  private ended = false;
  private containsSecretInput = false;
  private queue = Promise.resolve();

  constructor(
    private task: { id: string; title: string; source: 'desktop' | 'feishu' },
    private send: (id: string, text: string) => Promise<boolean>,
    private onFailure: () => void,
  ) {}

  get includesSecretInput() {
    return this.containsSecretInput;
  }

  handle(event: AgentEvent) {
    if (event.type === 'request-resolved') {
      this.requests.delete(event.id);
      return;
    }
    if (this.ended) return;
    if (event.type === 'approval') {
      this.requests.add(event.request.id);
      this.enqueue(
        `request:${event.request.id}`,
        `需要你审核\n${event.request.title}\n请回到 Mac 上的 Athena 查看操作详情并确认。`,
        event.request.id,
      );
    } else if (event.type === 'user-input') {
      this.requests.add(event.request.id);
      this.containsSecretInput ||= event.request.questions.some((question) => question.isSecret);
      const questions = event.request.questions.map((question, index) =>
        this.containsSecretInput
          ? `${index + 1}. 需要提供受保护的信息，请在 Athena 中填写。`
          : `${index + 1}. ${excerpt(question.question, 500)}${
              question.options?.length
                ? `\n可选：${question.options.map((option) => excerpt(option.label, 100)).join(' / ')}`
                : ''
            }`,
      );
      this.enqueue(
        `request:${event.request.id}`,
        `需要你的回答\n${questions.join('\n')}\n请回到 Mac 上的 Athena 回答，任务正在等待。`,
        event.request.id,
      );
    } else if (event.type === 'complete' || event.type === 'error') {
      // The result itself goes back as the reply to the Feishu message that asked for it.
      this.ended = true;
      this.requests.clear();
    }
  }

  private enqueue(key: string, body: string, requestId?: string) {
    if (this.task.source !== 'feishu' || this.sent.has(key)) return;
    this.sent.add(key);
    const text = `Athena · ${excerpt(this.task.title, 120)}\n${body}`;
    this.queue = this.queue.then(async () => {
      if (requestId && !this.requests.has(requestId)) return;
      try {
        await this.send(`${this.task.id}:${key}`, text);
      } catch {
        this.onFailure();
      }
    });
  }

  settled() {
    return this.queue;
  }
}
