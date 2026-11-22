import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LiveVoiceConfig } from '../shared/live-voice';
import { pointedAt } from './page-pointer';
import { LiveVoiceClient, voiceError, type VoiceState } from './live-voice-client';

type Speaker = 'user' | 'assistant' | null;

/** Mount once per conversation. Moving the call controls never reacquires the microphone. */
export function useLiveVoice(conversationId: string, onClose: () => void) {
  const [state, setState] = useState<VoiceState>({
    status: 'idle',
    muted: false,
    transcripts: [],
    finalized: false,
    tasks: 0,
  });
  const [config, setConfig] = useState<LiveVoiceConfig>();
  const [configError, setConfigError] = useState('');
  const [speaking, setSpeaking] = useState<Speaker>(null);
  const levels = useRef({ input: 0, output: 0 });
  const speech = useRef({ lastInput: -Infinity, lastOutput: -Infinity, speaker: null as Speaker });
  const mounted = useRef(false);
  const notified = useRef(false);
  const endingPrevious = useRef(false);
  const closePanel = useRef(onClose);
  useLayoutEffect(() => {
    closePanel.current = onClose;
  }, [onClose]);

  const [client] = useState(
    () =>
      new LiveVoiceClient(
        (next) => {
          if (mounted.current) setState(next);
        },
        window.workbench,
        (input, output) => {
          levels.current.input = input;
          levels.current.output = output;
          if (!mounted.current) return;
          const last = speech.current,
            now = performance.now();
          if (input > 0.07) last.lastInput = now;
          if (output > 0.07) last.lastOutput = now;
          // Keep the same speaker through short gaps between syllables.
          const active =
            now - last.lastOutput < 260 ? 'assistant' : now - last.lastInput < 260 ? 'user' : null;
          if (active !== last.speaker) {
            last.speaker = active;
            setSpeaking(active);
          }
        },
        () => pointedAt(),
      ),
  );

  useEffect(() => {
    let current = true;
    mounted.current = true;
    void window.workbench
      .invoke<LiveVoiceConfig>('voice:config')
      .then((value) => {
        if (current) setConfig(value);
      })
      .catch((error) => {
        if (current) setConfigError(voiceError(error));
      });
    return () => {
      current = false;
      mounted.current = false;
      void client.stop();
    };
  }, [client]);

  const finish = useCallback(() => {
    if (!mounted.current || notified.current || client.needsHangup) return;
    notified.current = true;
    closePanel.current();
  }, [client]);
  useEffect(() => {
    if (state.status === 'idle' && state.finalized && !state.error) finish();
  }, [state.status, state.finalized, state.error, finish]);

  const start = () => {
    if (!config?.configured || config.active || client.needsHangup) return;
    speech.current = { lastInput: -Infinity, lastOutput: -Infinity, speaker: null };
    setSpeaking(null);
    return client.start(conversationId);
  };
  const close = async () => {
    if (config?.active && !client.needsHangup) {
      if (endingPrevious.current) return;
      endingPrevious.current = true;
      setState((previous) => ({ ...previous, status: 'closing', error: undefined }));
      try {
        await window.workbench.invoke('voice:disconnect', {});
        const refreshed = await window.workbench.invoke<LiveVoiceConfig>('voice:config');
        if (refreshed.active) throw new Error('上次通话尚未结束，请重试');
        if (mounted.current) setConfig(refreshed);
      } catch (error) {
        if (mounted.current) setState((previous) => ({ ...previous, error: voiceError(error) }));
      } finally {
        endingPrevious.current = false;
        if (mounted.current) setState((previous) => ({ ...previous, status: 'idle' }));
      }
      return;
    }
    await client.stop();
    finish();
  };

  return {
    state,
    config,
    configError,
    speaking: state.status === 'connected' ? speaking : null,
    levels,
    start,
    mute: () => client.mute(),
    close,
    needsHangup: client.needsHangup || config?.active === true,
  };
}

export type LiveVoiceSession = ReturnType<typeof useLiveVoice>;
