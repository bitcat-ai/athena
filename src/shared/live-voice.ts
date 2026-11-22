export interface LiveVoiceConfig {
  configured: boolean;
  active: boolean;
}

export interface LiveVoiceConnection {
  sessionId: string;
  sdp: string;
}

export interface VoiceTranscript {
  role: 'user' | 'assistant';
  text: string;
  startMs: number;
  endMs: number;
}

export const LIVE_VOICE_MODEL = 'gpt-live-1';

/**
 * The call as sentences. Speech arrives a syllable at a time and both speakers can overlap, so
 * fragments of one speaker are joined across pauses under 0.8 s. What was said after `afterMs`
 * is the new request; the rest is what has already been dealt with.
 */
export function voiceContext(fragments: VoiceTranscript[], afterMs: number, limit = 24): string {
  const turns: Array<{ role: string; fresh: boolean; text: string; startMs: number; endMs: number }> =
    [];
  const latest = new Map<string, (typeof turns)[number]>();
  for (const item of [...fragments].sort((a, b) => a.startMs - b.startMs)) {
    const fresh = item.endMs > afterMs;
    const previous = latest.get(item.role);
    if (previous && previous.fresh === fresh && item.startMs <= previous.endMs + 800) {
      previous.text += item.text;
      previous.endMs = Math.max(previous.endMs, item.endMs);
    } else {
      const turn = { role: item.role, fresh, text: item.text, startMs: item.startMs, endMs: item.endMs };
      turns.push(turn);
      latest.set(item.role, turn);
    }
  }
  return turns
    .slice(-limit)
    .map(
      (turn) =>
        `${turn.role === 'user' ? '用户' : '语音助手'}（${turn.fresh ? '本次新增' : '之前，已处理'}）：${turn.text.trim()}`,
    )
    .join('\n');
}
