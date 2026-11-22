import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowExpand01Icon,
  CallEnd01Icon,
  EarthIcon,
  KeyboardIcon,
  MessageSquareIcon,
  Mic01Icon,
  MicOff01Icon,
  SidebarLeftIcon,
  StopIcon,
} from '@hugeicons-pro/core-stroke-rounded';
import portrait from './assets/brand/athena-profile.png';
import type { GlyphKind } from '../shared/phase';
import { PhaseGlyph } from './PhaseGlyph';
import { ActionButton, Icon } from './ui';
import { useLiveVoice, type LiveVoiceSession } from './use-live-voice';
import './live-voice.css';

type VoiceMode = 'chat' | 'browser' | 'compact';
type Levels = RefObject<{ input: number; output: number }>;
type Fragments = LiveVoiceSession['state']['transcripts'];

interface VoiceSurfaceProps {
  conversationId: string;
  mode: VoiceMode;
  browserOverlayRoot?: HTMLElement | null;
  composerOverlayRoot?: HTMLElement | null;
  awaitingInput: boolean;
  taskRunning: boolean;
  /** The real phase of the agent turn that this conversation is running, if any. */
  agentStatus?: { text: string; glyph: GlyphKind } | null;
  onClose(): void;
  onCallActiveChange?(active: boolean): void;
  onSettings(): void;
  onToggleBrowser(): void;
  onToggleWorkspace(): void;
  onStopTask(): void;
}

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  startMs: number;
  endMs: number;
  parts: Array<{ id: string; text: string }>;
}

const reductionQuery = '(prefers-reduced-motion: reduce)';
function observeMotionPreference(change: () => void) {
  const media = matchMedia(reductionQuery);
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
}
const prefersReducedMotion = () => matchMedia(reductionQuery).matches;
const ease = [0.22, 1, 0.36, 1] as const;

/** Fragments arrive per speaker and can overlap; a pause of 0.8 s starts a new turn. */
function speakerTurns(fragments: Fragments): Turn[] {
  const turns: Turn[] = [];
  const latest = new Map<string, Turn>();
  for (const fragment of [...fragments].sort((a, b) => a.startMs - b.startMs)) {
    const previous = latest.get(fragment.role);
    if (previous && fragment.startMs <= previous.endMs + 800) {
      previous.parts.push({ id: fragment.id, text: fragment.text });
      previous.endMs = Math.max(previous.endMs, fragment.endMs);
    } else {
      const turn: Turn = {
        id: fragment.id,
        role: fragment.role,
        startMs: fragment.startMs,
        endMs: fragment.endMs,
        parts: [{ id: fragment.id, text: fragment.text }],
      };
      turns.push(turn);
      latest.set(fragment.role, turn);
    }
  }
  return turns;
}

/** The portrait breathes with the measured voice level, written straight to a CSS variable. */
function VoiceOrb({ levels, live }: { levels: Levels; live: boolean }) {
  const node = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = node.current;
    if (!element || !live) {
      element?.style.setProperty('--live-level', '0');
      return;
    }
    let frame = 0,
      shown = 0;
    const tick = () => {
      const level = Math.max(levels.current.input, levels.current.output);
      // Rise quickly and settle slowly, so syllables read as one breath.
      shown += (level - shown) * (level > shown ? 0.5 : 0.12);
      element.style.setProperty('--live-level', shown.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [levels, live]);
  return (
    <span ref={node} className="live-orb" aria-hidden="true">
      <i />
      <i />
      <img className="live-portrait" src={portrait} alt="" draggable={false} />
    </span>
  );
}

/** A mirrored level trace. It rests as a row of dots, so "listening" is visible without sound. */
function VoiceWave({ levels }: { levels: Levels }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const node = canvas.current;
    const ctx = node?.getContext('2d');
    if (!node || !ctx) return;
    const bars = 9,
      width = 46,
      height = 22;
    const scale = Math.min(devicePixelRatio || 1, 2);
    node.width = width * scale;
    node.height = height * scale;
    ctx.scale(scale, scale);
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.4;
    const shown = new Float32Array(bars);
    let frame = 0;
    const tick = (now: number) => {
      const level = Math.max(levels.current.input, levels.current.output);
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = getComputedStyle(node).color;
      ctx.beginPath();
      for (let i = 0; i < bars; i++) {
        // The middle bars carry most of the level; a slow phase keeps neighbours apart.
        const weight = 1 - Math.abs(i - (bars - 1) / 2) / bars;
        const target = level * weight * (0.72 + 0.28 * Math.sin(now / 90 + i * 1.7));
        shown[i] += (target - shown[i]) * 0.32;
        const half = Math.min(9, shown[i] * 13);
        const x = 3 + i * 5;
        ctx.moveTo(x, height / 2 - half);
        ctx.lineTo(x, height / 2 + half + 0.01);
      }
      ctx.stroke();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [levels]);
  return <canvas ref={canvas} className="live-wave" aria-hidden="true" />;
}

function CaptionText({ turn }: { turn: Turn }) {
  return (
    <>
      {turn.parts.map((part) => (
        <span key={part.id} className="live-word">
          {part.text}
        </span>
      ))}
    </>
  );
}

/** In the composer the last exchange stays readable, the way a draft would. */
function InlineCaptions({ turns }: { turns: Turn[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    if (follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [turns]);
  return (
    <div
      ref={scroller}
      className="live-captions"
      role="log"
      aria-label="语音字幕"
      aria-live="off"
      tabIndex={0}
      onScroll={(event) => {
        const el = event.currentTarget;
        follow.current = el.scrollHeight - el.clientHeight - el.scrollTop < 8;
      }}
    >
      {turns.map((turn, index) => (
        <p
          key={turn.id}
          className="live-caption"
          data-speaker={turn.role}
          data-current={index === turns.length - 1}
        >
          <span className="live-caption-speaker">{turn.role === 'user' ? '你' : 'Athena'}</span>
          <CaptionText turn={turn} />
        </p>
      ))}
    </div>
  );
}

/** Over a page only the sentence being spoken is shown, and it leaves when the talking stops. */
function Subtitles({ turns, speaking }: { turns: Turn[]; speaking: 'user' | 'assistant' | null }) {
  const turn = turns.at(-1);
  const hold = Boolean(turn) && speaking === turn!.role;
  const stamp = turn ? turn.id + ':' + turn.parts.length : '';
  // What was said before the page opened is in the conversation, not replayed over the page.
  const [expired, setExpired] = useState(stamp);
  useEffect(() => {
    if (!stamp) return;
    // A sentence stays while its speaker is still audible, though never on sound alone for long.
    const timer = setTimeout(() => setExpired(stamp), hold ? 15_000 : 4200);
    return () => clearTimeout(timer);
  }, [stamp, hold]);
  const visible = Boolean(turn) && expired !== stamp;
  return (
    <div className="live-subtitles" role="log" aria-label="语音字幕" aria-live="off">
      <AnimatePresence initial={false} mode="popLayout">
        {visible && turn && (
          <motion.p
            key={turn.id}
            className="live-subtitle"
            data-speaker={turn.role}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease }}
          >
            {/* The tail of a long sentence stays in view; earlier lines scroll out above. */}
            <span className="live-subtitle-clip">
              <span>
                {turn.role === 'user' && <span className="live-subtitle-speaker">你</span>}
                <CaptionText turn={turn} />
              </span>
            </span>
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

function voiceStatus(
  state: LiveVoiceSession['state'],
  speaking: LiveVoiceSession['speaking'],
  failed: boolean,
  needsHangup: boolean,
  awaitingInput: boolean,
  agent?: string,
) {
  if (failed) return needsHangup ? '等待结束通话' : '语音暂不可用';
  if (awaitingInput) return '等待你确认';
  if (state.status === 'connecting') return '正在接通';
  if (state.status === 'closing') return '正在结束';
  if (state.status === 'idle') return needsHangup ? '等待结束通话' : '尚未接通';
  if (state.muted) return '麦克风已静音';
  if (agent) return agent;
  if (speaking === 'assistant') return 'Athena 正在说';
  return speaking === 'user' ? '正在听你说' : '我在听';
}

export function LiveVoiceSurface({
  conversationId,
  onClose,
  onCallActiveChange,
  mode,
  browserOverlayRoot,
  composerOverlayRoot,
  awaitingInput,
  taskRunning,
  agentStatus,
  onSettings,
  onToggleBrowser,
  onToggleWorkspace,
  onStopTask,
}: VoiceSurfaceProps) {
  const { state, config, configError, speaking, levels, start, mute, close, needsHangup } =
    useLiveVoice(conversationId, onClose);
  const panel = useRef<HTMLElement>(null);
  const reducedMotion = useSyncExternalStore(
    observeMotionPreference,
    prefersReducedMotion,
    () => true,
  );
  const connected = state.status === 'connected';
  const inCall = state.status !== 'idle' || needsHangup;
  const reportedActive = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (reportedActive.current !== inCall) {
      reportedActive.current = inCall;
      onCallActiveChange?.(inCall);
    }
  }, [inCall, onCallActiveChange]);

  // Entering Live is the request to talk: connect once, and leave retries to the person.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !config) return;
    autoStarted.current = true;
    if (config.configured && !config.active && !inCall) void start();
    // Only the first reading of the configuration starts a call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  const turns = useMemo(() => speakerTurns(state.transcripts), [state.transcripts]);
  const error = state.error || configError;
  const agent = taskRunning ? (agentStatus?.text ?? 'Agent 正在执行') : undefined;
  const status =
    !inCall && !error && !config?.configured
      ? config
        ? '还没有语音密钥'
        : '正在准备'
      : voiceStatus(state, speaking, Boolean(error), needsHangup, awaitingInput, agent);
  const elapsed =
    state.seconds === undefined
      ? ''
      : [Math.floor(state.seconds / 60), Math.floor(state.seconds % 60)]
          .map((n) => String(n).padStart(2, '0'))
          .join(':');
  useLayoutEffect(() => {
    if (mode !== 'compact') panel.current?.focus({ preventScroll: true });
  }, [mode, browserOverlayRoot, composerOverlayRoot]);

  const endLabel =
    state.status === 'connecting'
      ? '取消连接'
      : state.status === 'idle'
        ? '重试结束通话'
        : '结束通话';
  const primary = inCall ? (
    <ActionButton
      className="live-round live-hangup"
      size="md"
      isIconOnly
      aria-label={endLabel}
      isDisabled={state.status === 'closing'}
      onPress={() => void close()}
      title={state.tasks > 0 ? '结束通话，并停止本次语音发起的任务' : endLabel}
    >
      <Icon icon={CallEnd01Icon} size={18} />
    </ActionButton>
  ) : config?.configured ? (
    <ActionButton
      className="live-round live-start"
      size="md"
      isIconOnly
      aria-label="开始通话"
      onPress={() => void start()}
    >
      <Icon icon={Mic01Icon} size={17} />
    </ActionButton>
  ) : (
    <ActionButton
      className="live-start live-setup"
      size="md"
      variant="primary"
      isDisabled={!config && !configError}
      onPress={onSettings}
    >
      {!config && !configError ? '正在准备' : '设置语音'}
    </ActionButton>
  );
  const exitButton = !inCall && (
    <ActionButton
      className="live-round live-quiet"
      isIconOnly
      size="md"
      title="返回键盘输入"
      aria-label="关闭语音"
      onPress={() => void close()}
    >
      <Icon icon={KeyboardIcon} size={17} />
    </ActionButton>
  );
  const muteButton = connected && (
    <ActionButton
      className="live-round live-mute"
      isIconOnly
      size="md"
      aria-label={state.muted ? '取消麦克风静音' : '麦克风静音'}
      aria-pressed={state.muted}
      onPress={mute}
    >
      <Icon icon={state.muted ? MicOff01Icon : Mic01Icon} size={17} />
    </ActionButton>
  );
  const stopButton = taskRunning && (
    <ActionButton
      className="live-round live-stop"
      isIconOnly
      size="md"
      aria-label="停止任务"
      onPress={onStopTask}
    >
      <Icon icon={StopIcon} size={15} />
    </ActionButton>
  );
  const timer = connected && elapsed && (
    <time aria-label={'语音用量 ' + state.seconds + ' 秒'}>{elapsed}</time>
  );
  const statusLine = (
    <span
      className="live-status"
      data-connected={connected}
      data-muted={state.muted}
      data-agent={Boolean(agent && connected && !state.muted) || undefined}
    >
      {agent && agentStatus && connected && !state.muted ? (
        <PhaseGlyph kind={agentStatus.glyph} still={agentStatus.glyph === 'wait'} />
      ) : (
        <i aria-hidden="true" />
      )}
      <span role="status">{status}</span>
    </span>
  );
  const errorLine = error && (
    <p className="live-call-error" role="alert">
      {error}
    </p>
  );
  const rootProps = {
    ref: panel,
    tabIndex: -1,
    'aria-label': '实时语音',
    'data-voice-mode': mode,
    'data-status': state.status,
    'data-speaking': connected ? (speaking ?? undefined) : undefined,
    'data-muted': state.muted || undefined,
  } as const;
  const orb = <VoiceOrb levels={levels} live={connected && !reducedMotion} />;
  const wave = connected && !reducedMotion && <VoiceWave levels={levels} />;

  if (mode === 'chat') {
    const prompt =
      state.status === 'connecting'
        ? '正在接通 Athena…'
        : connected
          ? state.muted
            ? '麦克风已静音，Athena 听不到你'
            : '说吧，我在听。需要动手的事，我会交给 Agent 去做。'
          : config && !config.configured && !error
            ? '保存语音密钥后，就可以直接和 Athena 说话。'
            : '';
    const strip = (
      <section
        {...rootProps}
        className="live-voice-surface live-inline"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented && !inCall) void close();
        }}
      >
        <div className="live-field">
          {orb}
          <div className="live-field-body">
            {turns.length > 0 ? (
              <InlineCaptions turns={turns.slice(-4)} />
            ) : (
              prompt && <p className="live-prompt">{prompt}</p>
            )}
            {errorLine}
          </div>
        </div>
        <div className="live-toolbar">
          <div className="live-toolbar-start">
            {exitButton}
            <ActionButton
              className="live-round live-quiet"
              isIconOnly
              size="md"
              title="边说边看网页"
              aria-label="打开浏览器"
              onPress={onToggleBrowser}
            >
              <Icon icon={EarthIcon} size={17} />
            </ActionButton>
            {wave}
            {statusLine}
          </div>
          <div className="live-toolbar-end">
            {timer}
            {muteButton}
            {stopButton}
            {primary}
          </div>
        </div>
      </section>
    );
    return composerOverlayRoot ? createPortal(strip, composerOverlayRoot) : strip;
  }

  if (mode === 'browser') {
    const bar = (
      <section
        {...rootProps}
        className="live-voice-surface live-bar"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented && !inCall) void close();
        }}
      >
        {/* Subtitles float over the lower edge of the page and never take its clicks. */}
        <Subtitles turns={turns} speaking={speaking} />
        {errorLine}
        <motion.div
          className="live-bar-row"
          initial={reducedMotion ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease }}
        >
          <div className="live-bar-identity">
            {orb}
            <span className="live-bar-name">
              <strong>Athena</strong>
              {statusLine}
            </span>
            {wave}
          </div>
          {connected && !state.muted && turns.length === 0 && (
            <span className="live-bar-hint">指着网页上的任何地方，说「把这个…」</span>
          )}
          <div className="live-bar-actions">
            {timer}
            <ActionButton
              className="live-round live-quiet"
              isIconOnly
              size="md"
              title="回到对话，通话继续"
              aria-label="查看对话"
              onPress={onToggleWorkspace}
            >
              <Icon icon={SidebarLeftIcon} size={17} />
            </ActionButton>
            <ActionButton
              className="live-round live-quiet"
              isIconOnly
              size="md"
              title="收起网页，只留语音"
              aria-label="返回语音对话"
              onPress={onToggleBrowser}
            >
              <Icon icon={MessageSquareIcon} size={17} />
            </ActionButton>
            {exitButton}
            {muteButton}
            {stopButton}
            {primary}
          </div>
        </motion.div>
      </section>
    );
    return browserOverlayRoot ? createPortal(bar, browserOverlayRoot) : null;
  }

  return (
    <section {...rootProps} className="live-voice-surface live-pill-dock">
      <motion.div
        className="live-pill"
        initial={reducedMotion ? false : { opacity: 0, y: 10, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.26, ease }}
      >
        {orb}
        <span className="live-bar-name">
          <strong>Athena</strong>
          {statusLine}
        </span>
        <ActionButton
          className="live-round live-quiet"
          isIconOnly
          size="md"
          title="回到沉浸语音"
          aria-label="返回沉浸语音"
          isDisabled={awaitingInput}
          onPress={onToggleWorkspace}
        >
          <Icon icon={ArrowExpand01Icon} size={16} />
        </ActionButton>
        {exitButton}
        {muteButton}
        {stopButton}
        {primary}
      </motion.div>
      {errorLine}
    </section>
  );
}
