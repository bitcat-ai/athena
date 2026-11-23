import type { WorkbenchBridge } from '../shared/types';
import type { LiveVoiceConnection, VoiceTranscript } from '../shared/live-voice';

export interface VoiceState {
  status: 'idle' | 'connecting' | 'connected' | 'closing';
  muted: boolean;
  transcripts: Array<VoiceTranscript & { id: string }>;
  seconds?: number;
  finalized: boolean;
  tasks: number;
  error?: string;
}

interface Call {
  requestId: string;
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  audio: HTMLAudioElement;
  microphone?: MediaStream;
  abort: AbortController;
  started: boolean;
  stopping: boolean;
  finalized: boolean;
  closed: Promise<void>;
  resolveClosed(): void;
  stop?: Promise<void>;
  startupTimer?: ReturnType<typeof setTimeout>;
  delegationTimers: Set<ReturnType<typeof setTimeout>>;
  events: Set<string>;
  delegations: Set<string>;
  lastUserWords: number;
  meter?: {
    context: AudioContext;
    input?: AnalyserNode;
    output?: AnalyserNode;
    sources: MediaStreamAudioSourceNode[];
    frame?: number;
  };
}

export function voiceError(error: unknown): string {
  if (
    error instanceof DOMException &&
    ['NotAllowedError', 'PermissionDeniedError'].includes(error.name)
  )
    return '无法使用麦克风，请在系统设置中允许 Athena 访问麦克风后重试';
  if (error instanceof DOMException && error.name === 'NotFoundError')
    return '未找到麦克风，请连接后重试';
  return (error instanceof Error ? error.message : '语音连接失败，请重试').replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    '',
  );
}

function gatherIce(peer: RTCPeerConnection, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new Error('语音连接已取消'));
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelled);
      peer.removeEventListener('icegatheringstatechange', changed);
      error ? reject(error) : resolve();
    };
    const changed = () => {
      if (peer.iceGatheringState === 'complete') finish();
    };
    const cancelled = () => finish(new Error('语音连接已取消'));
    const timer = setTimeout(
      () => finish(new Error('无法建立语音网络连接，请检查网络后重试')),
      10_000,
    );
    signal.addEventListener('abort', cancelled, { once: true });
    peer.addEventListener('icegatheringstatechange', changed);
    changed();
  });
}

export class LiveVoiceClient {
  private call?: Call;
  private state: VoiceState = {
    status: 'idle',
    muted: false,
    transcripts: [],
    finalized: false,
    tasks: 0,
  };
  constructor(
    private changed: (state: VoiceState) => void,
    private bridge: WorkbenchBridge = window.workbench,
    private levels?: (input: number, output: number) => void,
    /** Where the pointer rests on the page, if the host surface tracks one. */
    private pointer?: () => { x: number; y: number; tabId?: string } | undefined,
  ) {}
  private update(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }

  /** `trial` is the first-run tryout: no conversation, and nothing is carried out. */
  async start(conversationId: string, trial = false) {
    if (this.call) return;
    let peer: RTCPeerConnection | undefined;
    let channel: RTCDataChannel;
    let audio: HTMLAudioElement;
    try {
      peer = new RTCPeerConnection();
      channel = peer.createDataChannel('oai-events');
      audio = new Audio();
    } catch {
      peer?.close();
      this.update({ status: 'idle', error: '无法建立 WebRTC 语音连接，请重新进入通话后重试' });
      return;
    }
    let resolveClosed!: () => void;
    const call: Call = {
      requestId: crypto.randomUUID(),
      peer,
      channel,
      audio,
      abort: new AbortController(),
      started: false,
      stopping: false,
      finalized: false,
      closed: new Promise((resolve) => {
        resolveClosed = resolve;
      }),
      resolveClosed: () => resolveClosed(),
      delegationTimers: new Set(),
      events: new Set(),
      delegations: new Set(),
      lastUserWords: -Infinity,
    };
    this.call = call;
    this.update({
      status: 'connecting',
      transcripts: [],
      muted: false,
      finalized: false,
      seconds: undefined,
      tasks: 0,
      error: undefined,
    });
    const check = () => {
      if (this.call !== call || call.stopping) throw new Error('语音连接已取消');
    };
    const failed = (message: string) => {
      if (this.call === call && !call.stopping) void this.stop(message);
    };
    call.startupTimer = setTimeout(() => failed('语音连接超时，已停止本机收音，请重试'), 45_000);
    peer.ontrack = (event) => {
      if (call.stopping) return;
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      call.audio.srcObject = stream;
      this.observeAudio(call, stream, 'output');
      void call.audio.play().catch(() => failed('无法播放语音，请检查音频输出后重新开始通话'));
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected')
        failed('语音连接已断开，请重新开始通话');
    };
    channel.onmessage = (event) => this.receive(call, event.data);
    channel.onerror = () => failed('语音事件连接失败，请重新开始通话');
    channel.onclose = () => failed(call.finalized ? '' : '语音连接已断开，最终用量未确认');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (this.call !== call || call.stopping) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      call.microphone = stream;
      this.observeAudio(call, stream, 'input');
      for (const track of stream.getTracks()) {
        track.onended = () => failed('麦克风已断开，通话已停止');
        peer.addTrack(track, stream);
      }
      await peer.setLocalDescription(await peer.createOffer());
      check();
      await gatherIce(peer, call.abort.signal);
      check();
      const answer = await this.bridge.invoke<LiveVoiceConnection>('voice:connect', {
        requestId: call.requestId,
        ...(trial ? { trial: true } : { conversationId }),
        sdp: peer.localDescription?.sdp,
      });
      check();
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      check();
    } catch (error) {
      if (this.call === call && !call.stopping) await this.stop(voiceError(error));
    }
  }

  private observeAudio(call: Call, stream: MediaStream, kind: 'input' | 'output') {
    if (!this.levels || call.stopping) return;
    try {
      if (!call.meter) {
        const context = new AudioContext();
        const meter: NonNullable<Call['meter']> = { context, sources: [] };
        call.meter = meter;
        void context.resume().catch(() => {});
        const samples = new Float32Array(256);
        const read = (analyser?: AnalyserNode) => {
          if (!analyser) return 0;
          analyser.getFloatTimeDomainData(samples);
          let energy = 0;
          for (const sample of samples) energy += sample * sample;
          return Math.min(1, Math.max(0, Math.sqrt(energy / samples.length) * 8 - 0.02));
        };
        let previous = 0,
          input = 0,
          output = 0;
        const tick = (time: number) => {
          if (call.stopping) return;
          // Update only the visualizer at 30 Hz, not the conversation's React state.
          if (time - previous >= 32) {
            input = this.state.muted ? 0 : input * 0.6 + read(meter.input) * 0.4;
            output = output * 0.6 + read(meter.output) * 0.4;
            this.levels?.(input, output);
            previous = time;
          }
          meter.frame = requestAnimationFrame(tick);
        };
        meter.frame = requestAnimationFrame(tick);
      }
      const source = call.meter.context.createMediaStreamSource(stream);
      const analyser = call.meter.context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      call.meter.sources.push(source);
      call.meter[kind] = analyser;
    } catch {
      // Metering is optional; a device failure must not interrupt a working audio track.
    }
  }

  private send(call: Call, type: string, fields: Record<string, unknown> = {}) {
    if (call.channel.readyState !== 'open') throw new Error('语音连接尚未就绪');
    call.channel.send(JSON.stringify({ type, event_id: crypto.randomUUID(), ...fields }));
  }

  private receive(call: Call, data: unknown) {
    if (this.call !== call || typeof data !== 'string' || data.length > 64_000) return;
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!event || typeof event.type !== 'string') return;
    if (typeof event.event_id === 'string') {
      if (call.events.has(event.event_id)) return;
      call.events.add(event.event_id);
      if (call.events.size > 8000) call.events.delete(call.events.values().next().value!);
    }
    if (event.type === 'session.closed') {
      call.finalized = true;
      call.resolveClosed();
      this.update({
        finalized: true,
        ...(Number.isFinite(event.usage?.seconds) ? { seconds: event.usage.seconds } : {}),
      });
      if (!call.stopping)
        void this.stop(event.reason === 'content' ? '本次语音已由服务结束' : undefined);
      return;
    }
    if (call.stopping) return;
    if (event.type === 'session.started') {
      call.started = true;
      clearTimeout(call.startupTimer);
      this.update({ status: 'connected' });
    } else if (
      event.type === 'session.usage.updated' &&
      Number.isFinite(event.usage?.seconds) &&
      event.usage.seconds >= 0
    ) {
      this.update({ seconds: event.usage.seconds });
    } else if (
      ['session.input_transcript.delta', 'session.output_transcript.delta'].includes(event.type)
    ) {
      if (
        typeof event.delta !== 'string' ||
        event.delta.length > 12_000 ||
        !Number.isFinite(event.start_ms) ||
        !Number.isFinite(event.end_ms) ||
        event.start_ms < 0 ||
        event.end_ms < event.start_ms
      )
        return;
      const fragment: VoiceTranscript & { id: string } = {
        id: typeof event.event_id === 'string' ? event.event_id : crypto.randomUUID(),
        role: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
        text: event.delta,
        startMs: event.start_ms,
        endMs: event.end_ms,
      };
      if (fragment.role === 'user') call.lastUserWords = performance.now();
      const fragments = [...this.state.transcripts, fragment].slice(-200);
      while (fragments.reduce((sum, item) => sum + item.text.length, 0) > 24_000) fragments.shift();
      this.update({ transcripts: fragments });
    } else if (
      event.type === 'session.delegation.created' &&
      event.delegation?.target === 'client' &&
      typeof event.delegation.id === 'string'
    ) {
      const id: string = event.delegation.id;
      if (!call.started || call.delegations.has(id)) return;
      call.delegations.add(id);
      // Transcript delivery lags behind the delegation event, and the person is often still
      // finishing the sentence. Hand over once their words have stopped arriving.
      const began = performance.now();
      const settle = () => {
        const timer = setTimeout(() => {
          call.delegationTimers.delete(timer);
          if (call.stopping) return;
          const now = performance.now();
          if (now - call.lastUserWords < 900 && now - began < 4000) settle();
          else void this.delegate(call, id, this.spokenThrough(event.offset_ms));
        }, 300);
        call.delegationTimers.add(timer);
      };
      settle();
    } else if (event.type === 'error') {
      // API errors can contain request content; show the code, not echoed user data.
      const code =
        typeof event.error?.code === 'string' && /^[\w-]{1,80}$/.test(event.error.code)
          ? `（${event.error.code}）`
          : '';
      void this.stop(`OpenAI 语音发生错误${code}，请重新开始通话`);
    }
  }

  /**
   * A request ends where the person stopped, not where the delegation was raised: words that
   * follow without a pause belong to the same sentence.
   */
  private spokenThrough(offsetMs: unknown): unknown {
    if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs)) return offsetMs;
    let through = offsetMs;
    for (const item of this.state.transcripts
      .filter((fragment) => fragment.role === 'user')
      .sort((a, b) => a.startMs - b.startMs))
      if (item.endMs > through && item.startMs <= through + 900) through = item.endMs;
    return through;
  }

  private async delegate(call: Call, delegationId: string, offsetMs: unknown) {
    this.update({ tasks: this.state.tasks + 1 });
    let result: string;
    let silent = false;
    try {
      const reply = await this.bridge.invoke<string | { text: string; silent?: boolean }>('voice:delegate', {
        requestId: call.requestId,
        delegationId,
        offsetMs,
        transcripts: this.state.transcripts,
        // What the pointer rests on travels with the words, so "this" has a referent.
        pointer: this.pointer?.(),
      });
      result = typeof reply === 'string' ? reply : reply.text;
      silent = typeof reply !== 'string' && reply.silent === true;
    } catch (error) {
      result = `任务未完成：${voiceError(error)}`;
    }
    if (this.call !== call || call.stopping) return;
    this.update({ tasks: Math.max(0, this.state.tasks - 1) });
    if (silent) {
      // A later request took this one's place: the model learns that, and says nothing of it.
      try {
        this.send(call, 'session.thinking.append', { delegation_id: delegationId, content: result });
      } catch (error) {
        await this.stop(voiceError(error));
      }
      return;
    }
    try {
      // What should be said goes in as commentary, which the model paraphrases aloud; anything
      // beyond that is background it may draw on later. An instruction is never sent as
      // commentary: it would be read out as part of the result.
      if (!result.trim())
        result = 'Agent 已结束本轮，但没有返回文字结果。请在 Athena 对话里核对，目前不能确认任务已完成。';
      const characters = [...result];
      const spoken = characters.slice(0, 700);
      const rest = characters.slice(700, 8000);
      const append = (type: string, text: string[]) => {
        // UTF-8 byte limits also bound token counts below Live's 500-token append limit.
        const encoder = new TextEncoder();
        let chunk = '';
        let bytes = 0;
        for (const char of text) {
          const length = encoder.encode(char).length;
          // Prefer to break after a sentence, so a chunk that is spoken early is still whole.
          if (bytes + length > 400 || (bytes > 240 && /[。！？!?\n]/.test(chunk.at(-1) ?? ''))) {
            this.send(call, type, { delegation_id: delegationId, content: chunk });
            chunk = '';
            bytes = 0;
          }
          chunk += char;
          bytes += length;
        }
        if (chunk.trim()) this.send(call, type, { delegation_id: delegationId, content: chunk });
      };
      append('session.commentary.append', spoken);
      if (rest.length) {
        append('session.thinking.append', rest);
        this.send(call, 'session.commentary.append', {
          delegation_id: delegationId,
          content: '以上是结果的开头，完整内容在 Athena 的对话里。',
        });
      }
    } catch (error) {
      await this.stop(voiceError(error));
    }
  }

  mute() {
    const call = this.call;
    if (!call || !call.started || call.stopping) return;
    const muted = !this.state.muted;
    call.microphone?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    this.update({ muted });
    try {
      this.send(call, muted ? 'session.input_audio.mute' : 'session.input_audio.unmute');
    } catch (error) {
      void this.stop(voiceError(error));
    }
  }

  async stop(error?: string) {
    const call = this.call;
    if (!call) return;
    if (call.stop) return call.stop;
    call.stopping = true;
    call.abort.abort();
    clearTimeout(call.startupTimer);
    call.delegationTimers.forEach(clearTimeout);
    call.microphone?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    call.audio.pause();
    call.audio.srcObject = null;
    if (call.meter) {
      if (call.meter.frame !== undefined) cancelAnimationFrame(call.meter.frame);
      call.meter.sources.forEach((source) => source.disconnect());
      void call.meter.context.close().catch(() => {});
      call.meter = undefined;
    }
    this.levels?.(0, 0);
    this.update({ status: 'closing', muted: true, ...(error ? { error } : {}) });
    call.stop = (async () => {
      try {
        if (call.started && !call.finalized && call.channel.readyState === 'open') {
          try {
            this.send(call, 'session.close');
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 2000);
              void call.closed.then(() => {
                clearTimeout(timer);
                resolve();
              });
            });
          } catch {
            /* The host can still hang up if the data channel just closed. */
          }
        }
        await this.bridge.invoke('voice:disconnect', {
          requestId: call.requestId,
          finalized: call.finalized,
          // What the service last said this call has used; the host keeps it with the usage records.
          seconds: this.state.seconds,
        });
        if (this.call === call) this.call = undefined;
        this.update({ status: 'idle', tasks: 0 });
      } catch (failure) {
        this.update({ status: 'idle', tasks: 0, error: voiceError(failure) });
      } finally {
        call.channel.close();
        call.peer.close();
      }
    })().finally(() => {
      call.stop = undefined;
    });
    return call.stop;
  }

  get needsHangup() {
    return Boolean(this.call);
  }
}
