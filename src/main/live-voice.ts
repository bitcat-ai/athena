import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  LIVE_VOICE_MODEL,
  voiceContext,
  type LiveVoiceConfig,
  type LiveVoiceConnection,
  type VoiceTranscript,
} from '../shared/live-voice';
import { voiceRelay } from '../shared/voice-intent';

const endpoint = 'https://api.openai.com/v1/live/sessions';
// Written for gpt-live-1, which is told to hand over with the literal `Generate <|SpawnThinking|>`
// wording; gpt-live-1.1 takes "Delegate to the backend" in plain language instead.
const instructions = `你是 Athena 的语音助手。用简洁、自然的中文交流，语速从容，不过分热情。

Backchannel policy: 少量、自然的应声，不抢用户的话。

Interruption policy: 用户打断时停止说话并听他说。后台任务进行中，用户改口、追加、喊停或问进度时，都 Generate <|SpawnThinking|> 把这句话交给后端：后端会自己停下重做、排在后面、停止，或回答进度，并把结果告诉你。不要让用户等上一项结束再说，也不要在后端返回之前声称已经停止或已经改好。

Delegation policy:
Backend tools:
- 网页：查看、指出、读取和修改 Athena 右侧浏览器里的页面；你自己看不到网页，也不能操作它。
- 本机与项目：读取文件、运行任务、查询实时信息。

Generate <|SpawnThinking|> when:
- 用户的要求需要上面任何一项能力，或需要仔细推理。
- 用户在问网页上的东西（"看到了吗""在哪""是不是这个"）：后端会确认并指给用户看，这不是修改要求。
- 用户纠正了已经提出的要求，或说上一次做错了。
- 用户指着网页说「这个」「这里」：后端能看到指针所指的元素。

Do not generate <|SpawnThinking|> when:
- 闲聊，或可以用对话里已有的、仍然有效的结果回答。
- 要求里缺少关键条件（改哪个、改成什么），需要先用一句话问清楚。
- 用户还没有把这句话说完。

Generate <|SpawnThinking|> before giving an answer that depends on backend work. 等待时不要猜测结果。
后端收到的是用户的原话，不要替用户补充颜色、位置、范围等他没说的条件。
只转述后端返回的内容：做了什么、没做什么、还要用户确认什么。后端没有说的原因和细节不要自己解释，尤其不要猜测后端是依据什么选中某个元素的。后端返回核实的结果后才能说任务完成。
任务审批、敏感输入和人工操作必须请用户在 Athena 界面完成，口头同意不替代界面审批。`;

interface Options {
  file: string;
  encrypt(value: string): Promise<string>;
  decrypt(value: string): Promise<string>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  runTask(
    conversationId: string,
    text: string,
    context: string,
    signal: AbortSignal,
    pointer?: VoicePointer,
    /** Requests this one takes over from, which were stopped part-way. */
    relay?: string[],
  ): Promise<string>;
}

/** Where the pointer rested on the page while the request was spoken, in viewport pixels. */
export interface VoicePointer {
  x: number;
  y: number;
  tabId?: string;
}

function pointerAt(value: unknown): VoicePointer | undefined {
  const item = value as Partial<VoicePointer> | undefined;
  if (
    !item ||
    typeof item !== 'object' ||
    !Number.isFinite(item.x) ||
    !Number.isFinite(item.y) ||
    item.x! < 0 ||
    item.y! < 0 ||
    item.x! > 20_000 ||
    item.y! > 20_000
  )
    return undefined;
  return {
    x: item.x!,
    y: item.y!,
    ...(typeof item.tabId === 'string' && item.tabId.length <= 200 ? { tabId: item.tabId } : {}),
  };
}

interface Call {
  requestId: string;
  conversationId: string;
  key?: string;
  sessionId?: string;
  cancelled: boolean;
  controller: AbortController;
  connecting?: Promise<LiveVoiceConnection>;
  closing?: Promise<void>;
  tasks: Map<string, Promise<string>>;
  /** Requests in the order they are carried out; at most one is running. */
  queue: Request[];
  pumping: boolean;
  /** Delegations whose result is not to be spoken: a later request took their place. */
  silent: Set<string>;
  throughMs: number;
}

interface Request {
  id: string;
  text: string;
  context: string;
  pointer?: VoicePointer;
  relay: string[];
  state: 'waiting' | 'running' | 'done';
  superseded: boolean;
  controller: AbortController;
  settled: Promise<void>;
  finish(): void;
  resolve(value: string): void;
  reject(error: unknown): void;
}

const SUPERSEDED = '这项任务已被用户后来的要求取代，不要播报它。结果随新的任务返回。';
const quoted = (text: string) => `「${text.trim().slice(0, 60)}」`;

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,150}$/.test(value))
    throw new Error('语音会话标识无效');
  return value;
}

function transcripts(value: unknown): VoiceTranscript[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error('语音上下文过长');
  let size = 0;
  return value.map((item) => {
    if (
      !item ||
      !['user', 'assistant'].includes(item.role) ||
      typeof item.text !== 'string' ||
      !Number.isFinite(item.startMs) ||
      !Number.isFinite(item.endMs) ||
      item.startMs < 0 ||
      item.endMs < item.startMs ||
      (size += item.text.length) > 24_000
    )
      throw new Error('语音转写格式无效');
    return { role: item.role, text: item.text, startMs: item.startMs, endMs: item.endMs };
  });
}

/** Keys and authenticated HTTP requests stay in the host, never in the renderer. */
export class LiveVoice {
  private encrypted?: string;
  private call?: Call;
  private saving = false;
  constructor(private options: Options) {}

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.options.file, 'utf8'));
      if (saved.version === 1 && typeof saved.key === 'string' && saved.key)
        this.encrypted = saved.key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('无法读取语音配置，请检查本机数据目录');
    }
  }

  config(): LiveVoiceConfig {
    return { configured: Boolean(this.encrypted), active: Boolean(this.call) };
  }

  async configure(key: unknown) {
    if (this.call || this.saving) throw new Error('请先结束语音通话，再更改密钥');
    if (typeof key !== 'string' || !/^sk-[\w-]{16,500}$/.test(key.trim()))
      throw new Error('请输入有效的 OpenAI API 密钥');
    this.saving = true;
    try {
      const encrypted = await this.options.encrypt(key.trim());
      await mkdir(path.dirname(this.options.file), { recursive: true, mode: 0o700 });
      await writeFile(`${this.options.file}.tmp`, JSON.stringify({ version: 1, key: encrypted }), {
        mode: 0o600,
      });
      await rename(`${this.options.file}.tmp`, this.options.file);
      this.encrypted = encrypted;
      return this.config();
    } finally {
      this.saving = false;
    }
  }

  async forget() {
    if (this.call || this.saving) throw new Error('请先结束语音通话，再移除密钥');
    this.saving = true;
    try {
      await rm(this.options.file, { force: true });
      this.encrypted = undefined;
      return this.config();
    } finally {
      this.saving = false;
    }
  }

  connect(requestId: unknown, conversationId: string, sdp: unknown): Promise<LiveVoiceConnection> {
    if (this.call || this.saving) throw new Error('已有语音连接正在处理，请先结束通话');
    if (!this.encrypted) throw new Error('请先在「设置 › 语音」保存 OpenAI API 密钥');
    if (
      typeof sdp !== 'string' ||
      sdp.length > 65_536 ||
      !sdp.startsWith('v=0') ||
      !sdp.includes('m=audio') ||
      sdp.includes('m=video')
    )
      throw new Error('语音连接请求无效');
    const call: Call = {
      requestId: identifier(requestId),
      conversationId,
      cancelled: false,
      controller: new AbortController(),
      tasks: new Map(),
      queue: [],
      pumping: false,
      silent: new Set(),
      throughMs: -1,
    };
    this.call = call;
    call.connecting = this.create(call, sdp);
    return call.connecting;
  }

  private async create(call: Call, sdp: string): Promise<LiveVoiceConnection> {
    try {
      try {
        call.key = await this.options.decrypt(this.encrypted!);
      } catch {
        throw new Error('无法解锁语音密钥，请在「设置 › 语音」重新保存');
      }
      if (call.cancelled) throw new Error('语音连接已取消');
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: `Bearer ${call.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session: {
              model: LIVE_VOICE_MODEL,
              instructions,
              delegation: { type: 'client' },
              store: false,
            },
            transport: { type: 'webrtc', sdp },
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new Error(
          '连接 OpenAI 超时或网络不可用，未确认通话是否建立，可能产生初始化费用。未自动重试，请先检查网络',
        );
      }
      if (!response.ok) {
        const hint =
          response.status === 401
            ? '密钥无效，请重新保存'
            : response.status === 403 || response.status === 404
              ? '请确认此项目拥有 GPT-Live 使用权限'
              : response.status === 429
                ? '请检查 API 额度或稍后重试'
                : '请稍后重试';
        throw new Error(`OpenAI 语音连接失败（${response.status}），${hint}`);
      }
      const result = await response.json().catch(() => {
        throw new Error('OpenAI 未返回有效的语音连接');
      });
      call.sessionId = identifier(result?.session?.id);
      if (typeof result?.transport?.sdp !== 'string' || !result.transport.sdp.startsWith('v=0'))
        throw new Error('OpenAI 未返回有效的语音连接');
      if (call.cancelled) throw new Error('语音连接已取消');
      return { sessionId: call.sessionId, sdp: result.transport.sdp };
    } catch (error) {
      call.cancelled = true;
      if (call.sessionId) await this.hangup(call);
      if (this.call === call) this.call = undefined;
      throw error;
    }
  }

  delegate(
    requestId: unknown,
    delegationId: unknown,
    input: unknown,
    offset: unknown,
    pointer?: unknown,
  ): Promise<string> {
    const call = this.call;
    if (!call || call.requestId !== identifier(requestId) || !call.sessionId || call.cancelled)
      throw new Error('语音会话已结束，未执行新任务');
    const id = identifier(delegationId);
    const existing = call.tasks.get(id);
    if (existing) return existing;
    if (call.tasks.size >= 200) throw new Error('本次通话的任务数已达上限，请结束后重新连接');
    if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0)
      throw new Error('语音任务时间无效');
    const fragments = transcripts(input).filter((item) => item.startMs <= offset);
    const previous = call.throughMs;
    const inputs = fragments
      .filter((item) => item.role === 'user' && item.endMs > previous)
      .sort((a, b) => a.startMs - b.startMs);
    const text = inputs.map((item) => item.text).join('');
    // Speech can continue while an earlier delegation is being delivered or refused.
    call.throughMs = Math.max(previous, offset, ...inputs.map((item) => item.endMs));
    if (!text.trim()) {
      const refused = Promise.resolve(
        previous >= 0
          ? '这句话已经随上一项任务一起交给后端，本次未执行新任务。以上一项的结果为准，不要让用户重说。'
          : '尚未收到新的用户转写，未执行任务。请用户再说一次具体要求。',
      );
      call.tasks.set(id, refused);
      return refused;
    }
    const context = voiceContext(fragments, previous);
    const open = call.queue.filter((item) => item.state !== 'done');
    const running = open.find((item) => item.state === 'running');
    // Words spoken while work is in hand change it, follow it, stop it or ask about it.
    const relay = open.length ? voiceRelay(text) : undefined;
    let task: Promise<string>;
    if (relay === 'status') {
      task = Promise.resolve(
        `还在处理${quoted((running ?? open[0]).text)}${open.length > 1 ? `，后面还排着 ${open.length - 1} 项` : ''}，没有打断它，完成后会告诉用户结果。`,
      );
    } else if (relay === 'stop') {
      const stopped = this.supersede(call, open);
      task = Promise.all(open.map((item) => item.settled)).then(
        () =>
          `已按用户的要求停下${quoted(stopped[0])}${stopped.length > 1 ? `等 ${stopped.length} 项` : ''}。停下之前已经做出的改动还在，可以让我撤销。`,
      );
    } else {
      // A changed request takes over from everything still open and inherits what they wanted.
      const inherited = relay === 'revise' ? this.supersede(call, open) : [];
      task = this.enqueue(call, id, text, context, pointerAt(pointer), inherited);
    }
    // Repeated delegation events must never repeat a side effect, including after a failure.
    call.tasks.set(id, task);
    return task;
  }

  /** Whether a delegation's result should reach the voice model without being spoken. */
  silent(delegationId: unknown): boolean {
    return typeof delegationId === 'string' && Boolean(this.call?.silent.has(delegationId));
  }

  /** Stops the given requests and returns what they asked for, oldest first. */
  private supersede(call: Call, open: Request[]): string[] {
    const wanted: string[] = [];
    for (const item of open) {
      // A request that itself took over others still stands for what they wanted.
      wanted.push(...item.relay, item.text);
      item.superseded = true;
      call.silent.add(item.id);
      item.controller.abort();
    }
    return [...new Set(wanted)];
  }

  private enqueue(
    call: Call,
    id: string,
    text: string,
    context: string,
    pointer: VoicePointer | undefined,
    relay: string[],
  ): Promise<string> {
    const controller = new AbortController();
    if (call.controller.signal.aborted) controller.abort();
    else call.controller.signal.addEventListener('abort', () => controller.abort(), { once: true });
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const task = new Promise<string>((resolve, reject) => {
      call.queue.push({
        id,
        text,
        context,
        pointer,
        relay,
        state: 'waiting',
        superseded: false,
        controller,
        settled,
        finish,
        resolve,
        reject,
      });
    });
    void this.pump(call);
    return task;
  }

  /** Carries out the open requests one at a time, in the order they were spoken. */
  private async pump(call: Call) {
    if (call.pumping) return;
    call.pumping = true;
    try {
      for (;;) {
        const item = call.queue.find((entry) => entry.state === 'waiting');
        if (!item) break;
        if (item.superseded) item.resolve(SUPERSEDED);
        else {
          item.state = 'running';
          try {
            if (call.cancelled) throw new Error('语音会话已结束，未执行新任务');
            const result = await this.options.runTask(
              call.conversationId,
              item.text,
              item.context,
              item.controller.signal,
              item.pointer,
              item.relay.length ? item.relay : undefined,
            );
            item.resolve(item.superseded ? SUPERSEDED : result);
          } catch (error) {
            // Work that was stopped to make way has no failure to report.
            if (item.superseded) item.resolve(SUPERSEDED);
            else item.reject(error);
          }
        }
        item.state = 'done';
        item.finish();
      }
    } finally {
      call.pumping = false;
    }
  }

  async disconnect(requestId?: unknown, finalized = false) {
    const call = this.call;
    if (!call || (requestId !== undefined && call.requestId !== identifier(requestId))) return;
    if (call.closing) return call.closing;
    call.cancelled = true;
    call.controller.abort();
    call.closing = (async () => {
      await call.connecting?.catch(() => {});
      if (this.call !== call) return;
      if (!finalized) await this.hangup(call);
      if (this.call === call) this.call = undefined;
    })();
    try {
      await call.closing;
    } finally {
      call.closing = undefined;
    }
  }

  private async hangup(call: Call) {
    if (!call.sessionId || !call.key) return;
    try {
      const result = await (this.options.fetch ?? fetch)(
        `${endpoint}/${encodeURIComponent(call.sessionId)}/hangup`,
        {
          method: 'POST',
          redirect: 'error',
          headers: { Authorization: `Bearer ${call.key}` },
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!result.ok && result.status !== 404 && result.status !== 410) throw new Error();
    } catch {
      throw new Error('本机收音已停止，但未确认远端通话结束。请重试结束通话');
    }
  }
}
