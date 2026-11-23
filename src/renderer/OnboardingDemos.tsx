import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Input } from '@heroui/react';
import { motion, useReducedMotion } from 'motion/react';
import {
  CallEnd01Icon,
  CubeIcon,
  CursorPointer02Icon,
  Folder01Icon,
  MagicWand01Icon,
  Mic01Icon,
  RefreshIcon,
  Tick02Icon,
} from '@hugeicons-pro/core-stroke-rounded';
import type { LiveVoiceConfig } from '../shared/live-voice';
import { LiveVoiceClient, voiceError, type VoiceState } from './live-voice-client';
import { Icon } from './ui';
import './onboarding-demos.css';

export type DemoId = 'page' | 'voice' | 'sandbox' | 'guide';

/** In the order they are offered. */
export const demos: Array<{ id: DemoId; label: string; ask: string; icon: typeof Mic01Icon }> = [
  { id: 'page', label: '改网页', ask: '怎么改网页？', icon: MagicWand01Icon },
  { id: 'voice', label: 'Live 语音', ask: '可以直接说话吗？', icon: Mic01Icon },
  { id: 'sandbox', label: '沙箱', ask: '沙箱是什么？', icon: CubeIcon },
  { id: 'guide', label: '带你做', ask: '能带我做一遍吗？', icon: CursorPointer02Icon },
];

const easing = [0.22, 1, 0.36, 1] as const;
const TRIAL_SECONDS = 60;

function Stage({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="onboarding-demo" role="group" aria-label={label}>
      {children}
    </div>
  );
}

function PageBar({ title }: { title: string }) {
  return (
    <div className="onboarding-demo-bar" aria-hidden="true">
      <i />
      <i />
      <i />
      <span>{title}</span>
    </div>
  );
}

/** Athena's pointer on a sample page; `label` is what it says about where it rests. */
function Pointer({
  at,
  label = 'Athena',
}: {
  /** `flip` hangs the label to the left, for a spot near the right edge of the page. */
  at: { x: number; y: number; flip?: boolean };
  label?: string;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.div
      className="onboarding-demo-cursor"
      data-flip={at.flip}
      aria-hidden="true"
      initial={reducedMotion ? false : { opacity: 0, x: at.x + 60, y: at.y + 40 }}
      animate={{ opacity: 1, x: at.x, y: at.y }}
      transition={{ duration: reducedMotion ? 0 : 0.45, ease: easing }}
    >
      <svg width="16" height="18" viewBox="0 0 16 18">
        <path d="M1 1l13 7.2-5.6 1.5L5.6 16z" />
      </svg>
      <span>{label}</span>
    </motion.div>
  );
}

/* ── Live page edits ─────────────────────────────────────────────────────────────── */

type EditId = 'button' | 'title' | 'dark';
const edits: Array<{ id: EditId; label: string }> = [
  { id: 'button', label: '把按钮改成黑色圆角' },
  { id: 'title', label: '标题再大一点' },
  { id: 'dark', label: '整页换成深色' },
];

function PageEditDemo() {
  const reducedMotion = useReducedMotion();
  const [applied, setApplied] = useState<Record<EditId, boolean>>({
    button: false,
    title: false,
    dark: false,
  });
  const [working, setWorking] = useState<EditId>();
  const [cursor, setCursor] = useState<{ x: number; y: number }>();
  const [said, setSaid] = useState('');
  const frame = useRef<HTMLDivElement>(null);
  const targets = useRef<Partial<Record<EditId, HTMLElement | null>>>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (id: EditId, label: string) => {
    if (working) return;
    const apply = () => {
      // Nothing else can change while one edit is under way, so this render's value is current.
      setSaid(applied[id] ? `已撤回：${label}` : `已修改：${label}`);
      setApplied((previous) => ({ ...previous, [id]: !previous[id] }));
      setWorking(undefined);
    };
    const target = targets.current[id]?.getBoundingClientRect();
    const origin = frame.current?.getBoundingClientRect();
    if (reducedMotion || !target || !origin) return apply();
    // The pointer goes to the element first, as it does on a real page; then the change lands.
    setCursor({
      // The lower right corner of the element, so the pointer and its tag do not cover the text.
      x: target.left - origin.left + Math.min(target.width - 6, 360),
      y: target.top - origin.top + Math.min(target.height - 6, 120),
    });
    setWorking(id);
    timer.current = setTimeout(apply, 520);
  };

  return (
    <Stage label="示例：网页即时修改">
      <div className="onboarding-demo-frame" ref={frame}>
        <PageBar title="示例页面" />
        <div
          className="onboarding-demo-page"
          ref={(node) => {
            targets.current.dark = node;
          }}
          data-dark={applied.dark}
        >
          <small>周六 · 14:00</small>
          <strong
            className="onboarding-demo-title"
            ref={(node) => {
              targets.current.title = node;
            }}
            data-large={applied.title}
            data-working={working === 'title'}
          >
            街角咖啡节
          </strong>
          <p>十二家本地烘焙店，一下午的手冲。</p>
          <span
            className="onboarding-demo-cta"
            ref={(node) => {
              targets.current.button = node;
            }}
            data-round={applied.button}
            data-working={working === 'button'}
          >
            立即报名
          </span>
        </div>
        {cursor && <Pointer at={cursor} />}
      </div>
      <div className="onboarding-demo-chips">
        {edits.map((edit) => (
          <Button
            key={edit.id}
            size="sm"
            variant="secondary"
            className="onboarding-demo-chip"
            aria-pressed={applied[edit.id]}
            data-applied={applied[edit.id]}
            onPress={() => change(edit.id, edit.label)}
          >
            {applied[edit.id] && <Icon icon={Tick02Icon} size={14} />}
            {edit.label}
          </Button>
        ))}
      </div>
      <p className="sr-only" role="status">
        {said}
      </p>
    </Stage>
  );
}

/* ── Sandbox ─────────────────────────────────────────────────────────────────────── */

const sandboxLines = [
  { command: '创建沙箱 shop-web', result: '全新环境，不挂载本机项目和凭据' },
  { command: 'npm ci && npm run build', result: '构建完成' },
  { command: 'npm run dev', result: '预览已启动' },
];
const projectFiles = ['src/Home.tsx', 'src/theme.css', 'package.json'];
const changedFiles = 2;

function SandboxDemo() {
  const reducedMotion = useReducedMotion();
  // Half-steps: an odd value shows the command still running, an even one its result.
  const last = sandboxLines.length * 2;
  const [step, setStep] = useState(reducedMotion ? last : 0);
  const [outcome, setOutcome] = useState<'applied' | 'discarded'>();
  useEffect(() => {
    if (step >= last) return;
    const timer = setTimeout(() => setStep((value) => value + 1), step % 2 ? 1100 : 500);
    return () => clearTimeout(timer);
  }, [step, last]);
  const ready = step >= last;

  return (
    <Stage label="示例：沙箱">
      <div className="onboarding-demo-sandbox">
        <div className="onboarding-demo-project" data-applied={outcome === 'applied'}>
          <div className="onboarding-demo-caption">
            <Icon icon={Folder01Icon} size={15} />
            <b>你的项目</b>
            <span>{outcome === 'applied' ? `${changedFiles} 个文件已更新` : '没有改动'}</span>
          </div>
          <ul>
            {projectFiles.map((file, index) => {
              const changed = outcome === 'applied' && index < changedFiles;
              return (
                <li key={file} data-changed={changed} style={{ animationDelay: `${index * 120}ms` }}>
                  <code>{file}</code>
                  {changed && <Icon icon={Tick02Icon} size={13} />}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="onboarding-demo-box" data-discarded={outcome === 'discarded'}>
          <div className="onboarding-demo-caption">
            <Icon icon={CubeIcon} size={15} />
            <b>沙箱</b>
            <span>{outcome === 'discarded' ? '已丢掉' : ready ? '运行中' : '准备中'}</span>
          </div>
          <div className="onboarding-demo-terminal" aria-hidden="true">
            <code className="onboarding-demo-task"># 给活动页加一个深色模式</code>
            {sandboxLines.map((line, index) => {
              if (step < index * 2 + 1) return null;
              const finished = step >= index * 2 + 2;
              return (
                <div key={line.command} className="onboarding-demo-terminal-line">
                  <code>
                    <b>$</b> {line.command}
                  </code>
                  {finished ? <span>✓ {line.result}</span> : <i />}
                </div>
              );
            })}
          </div>
          {ready && outcome !== 'discarded' && (
            <motion.div
              className="onboarding-demo-pip"
              aria-hidden="true"
              initial={reducedMotion ? false : { opacity: 0, scale: 0.86, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 26 }}
            >
              <PageBar title="沙箱预览" />
              <div className="onboarding-demo-pip-page">
                <strong>街角咖啡节</strong>
                <span>立即报名</span>
              </div>
            </motion.div>
          )}
        </div>
      </div>
      <div className="onboarding-demo-row">
        <span role="status">
          {outcome === 'applied'
            ? '改动已用到你的项目里。'
            : outcome === 'discarded'
              ? '沙箱丢掉了，你的项目没有任何变化。'
              : ready
                ? '在沙箱里跑通了。要用到你的项目里吗？'
                : '正在沙箱里运行…'}
        </span>
        {outcome ? (
          <Button
            size="sm"
            variant="secondary"
            className="onboarding-demo-chip"
            onPress={() => {
              setOutcome(undefined);
              setStep(reducedMotion ? last : 0);
            }}
          >
            <Icon icon={RefreshIcon} size={14} />
            再来一次
          </Button>
        ) : (
          ready && (
            <div className="onboarding-demo-choice">
              <Button
                size="sm"
                variant="secondary"
                className="onboarding-demo-chip"
                onPress={() => setOutcome('discarded')}
              >
                丢掉
              </Button>
              <Button
                size="sm"
                variant="primary"
                className="onboarding-demo-chip"
                onPress={() => setOutcome('applied')}
              >
                用到项目里
              </Button>
            </div>
          )
        )}
      </div>
    </Stage>
  );
}

/* ── Guided practice ─────────────────────────────────────────────────────────────── */

const guideTabs = ['概览', '成员', '设置'] as const;
const guideSteps = ['打开「成员」', '点「邀请成员」', '填上邮箱，点「发送邀请」'];
const members = [
  { name: '林夏', role: '管理员' },
  { name: '周屿', role: '成员' },
];

function GuideDemo() {
  const [tab, setTab] = useState<(typeof guideTabs)[number]>('概览');
  const [inviting, setInviting] = useState(false);
  const [sent, setSent] = useState(false);
  const [point, setPoint] = useState<{ x: number; y: number; flip: boolean }>();
  const frame = useRef<HTMLDivElement>(null);
  // Read from the page, never counted: wandering off to another tab moves the hint back.
  const step = sent ? 3 : tab !== '成员' ? 0 : inviting ? 2 : 1;
  const guided = (index: number) => (step === index ? 'true' : undefined);
  useLayoutEffect(() => {
    const origin = frame.current;
    if (!origin) return;
    const measure = () => {
      const target = origin.querySelector('[data-guided="true"]')?.getBoundingClientRect();
      const box = origin.getBoundingClientRect();
      setPoint(
        target && {
          x: target.right - box.left - 8,
          y: target.bottom - box.top - 6,
          flip: target.right - box.left > box.width * 0.6,
        },
      );
    };
    measure();
    const resized = new ResizeObserver(measure);
    resized.observe(origin);
    return () => resized.disconnect();
  }, [step]);

  return (
    <Stage label="示例：带你做">
      <div className="onboarding-demo-guide">
        <div className="onboarding-demo-frame" ref={frame}>
          <PageBar title="示例后台" />
          <div className="onboarding-demo-admin">
            <div className="onboarding-demo-tabs" role="tablist" aria-label="示例后台">
              {guideTabs.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={tab === name}
                  data-guided={name === '成员' ? guided(0) : undefined}
                  onClick={() => setTab(name)}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="onboarding-demo-panel" role="tabpanel">
              {tab !== '成员' ? (
                <p>{tab === '概览' ? '3 位成员，2 个项目。' : '团队名称与通知。'}</p>
              ) : (
                <>
                  <div className="onboarding-demo-panel-head">
                    <b>成员</b>
                    {inviting && !sent ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          setSent(true);
                        }}
                      >
                        <input type="text" aria-label="同事的邮箱" placeholder="同事的邮箱" />
                        <button type="submit" data-guided={guided(2)}>
                          发送邀请
                        </button>
                      </form>
                    ) : (
                      !sent && (
                        <button
                          type="button"
                          data-guided={guided(1)}
                          onClick={() => setInviting(true)}
                        >
                          邀请成员
                        </button>
                      )
                    )}
                  </div>
                  <ul>
                    {sent && (
                      <li data-new="true">
                        <i>新</i>
                        <span>新成员</span>
                        <small>已邀请</small>
                      </li>
                    )}
                    {members.map((member) => (
                      <li key={member.name}>
                        <i>{member.name[0]}</i>
                        <span>{member.name}</span>
                        <small>{member.role}</small>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
          {point && step < 3 && <Pointer at={point} label={guideSteps[step]} />}
        </div>
        <div className="onboarding-demo-steps">
          <span role="status">
            {step === 3 ? '完成了，每一步都是你自己点的。' : `第 ${step + 1} / 3 步 · ${guideSteps[step]}`}
          </span>
          <ol aria-hidden="true">
            {guideSteps.map((text, index) => (
              <li key={text} data-state={index < step ? 'done' : index === step ? 'current' : 'next'}>
                <i>{index < step ? <Icon icon={Tick02Icon} size={12} /> : index + 1}</i>
                {text}
              </li>
            ))}
          </ol>
          {step === 3 && (
            <Button
              size="sm"
              variant="secondary"
              className="onboarding-demo-chip"
              onPress={() => {
                setTab('概览');
                setInviting(false);
                setSent(false);
              }}
            >
              <Icon icon={RefreshIcon} size={14} />
              再来一次
            </Button>
          )}
        </div>
      </div>
    </Stage>
  );
}

/* ── Live voice ──────────────────────────────────────────────────────────────────── */

function VoiceDemo({
  config,
  onConfig,
}: {
  config?: LiveVoiceConfig;
  onConfig: (config: LiveVoiceConfig) => void;
}) {
  const [voice, setVoice] = useState<VoiceState>({
    status: 'idle',
    muted: false,
    transcripts: [],
    finalized: false,
    tasks: 0,
  });
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [tried, setTried] = useState(false);
  const [left, setLeft] = useState(TRIAL_SECONDS);
  const meter = useRef<HTMLSpanElement>(null);
  const mounted = useRef(false);
  const [client] = useState(
    () =>
      new LiveVoiceClient(
        (next) => {
          if (mounted.current) setVoice(next);
        },
        window.workbench,
        // Straight to the element: sound levels never re-render the conversation.
        (input, output) => {
          meter.current?.style.setProperty('--level', Math.max(input, output).toFixed(3));
        },
      ),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the example, or setup altogether, always ends the call.
      void client.stop();
    };
  }, [client]);
  const connected = voice.status === 'connected';
  useEffect(() => {
    if (!connected) return;
    setLeft(TRIAL_SECONDS);
    const timer = setInterval(() => setLeft((value) => value - 1), 1000);
    return () => clearInterval(timer);
  }, [connected]);
  useEffect(() => {
    if (connected && left <= 0) void client.stop();
  }, [connected, left, client]);
  const turns = useMemo(() => {
    const result: Array<{ id: string; role: 'user' | 'assistant'; text: string }> = [];
    for (const item of [...voice.transcripts].sort((a, b) => a.startMs - b.startMs)) {
      const previous = result.at(-1);
      if (previous?.role === item.role) previous.text += item.text;
      else result.push({ id: item.id, role: item.role, text: item.text });
    }
    return result.slice(-2);
  }, [voice.transcripts]);

  if (!config)
    return (
      <Stage label="示例：Live 语音">
        <div className="onboarding-demo-row">
          <span role="status">正在查看语音设置…</span>
        </div>
      </Stage>
    );

  if (!config.configured) {
    const save = async () => {
      if (saving || !key.trim()) return;
      setSaving(true);
      setKeyError('');
      try {
        onConfig(await window.workbench.invoke<LiveVoiceConfig>('voice:configure', { key }));
        setKey('');
      } catch (failure) {
        setKeyError(voiceError(failure));
      } finally {
        setSaving(false);
      }
    };
    return (
      <Stage label="示例：Live 语音">
        <form
          className="onboarding-demo-key"
          aria-busy={saving}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor="onboarding-voice-key">OpenAI API 密钥</label>
          <div className="onboarding-demo-key-row">
            <Input
              id="onboarding-voice-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="sk-…"
              aria-describedby="onboarding-voice-key-note"
            />
            <Button type="submit" size="sm" variant="secondary" isDisabled={saving || !key.trim()}>
              {saving ? '正在保存…' : '保存并试用'}
            </Button>
          </div>
          <p id="onboarding-voice-key-note">
            密钥加密保存在本机。需要拥有 GPT-Live 使用权限的 OpenAI 项目密钥。
          </p>
          {keyError && (
            <p className="onboarding-demo-error" role="alert">
              {keyError}
            </p>
          )}
        </form>
      </Stage>
    );
  }

  const busy = voice.status !== 'idle';
  const elsewhere = config.active && !busy && !client.needsHangup;
  return (
    <Stage label="示例：Live 语音">
      <div className="onboarding-demo-voice" data-status={voice.status}>
        <span className="onboarding-demo-meter" ref={meter} aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <div className="onboarding-demo-voice-copy" aria-live="polite">
          {connected ? (
            turns.length ? (
              turns.map((turn) => (
                <p key={turn.id} data-role={turn.role}>
                  <b>{turn.role === 'user' ? '你' : 'Athena'}</b>
                  {turn.text}
                </p>
              ))
            ) : (
              <p>接通了，说点什么吧。</p>
            )
          ) : voice.status === 'connecting' ? (
            <p>正在接通，请允许使用麦克风…</p>
          ) : voice.status === 'closing' ? (
            <p>正在结束通话…</p>
          ) : elsewhere ? (
            <p>另一处的语音通话还在进行，结束后再来试。</p>
          ) : tried && !voice.error ? (
            <p>
              试用结束
              {voice.seconds !== undefined ? `，通话 ${Math.round(voice.seconds)} 秒` : ''}。
            </p>
          ) : (
            <p>点一下开始，随便说一句。</p>
          )}
        </div>
      </div>
      {voice.error && (
        <p className="onboarding-demo-error" role="alert">
          {voice.error}
        </p>
      )}
      <div className="onboarding-demo-row">
        <span>
          {connected
            ? `还剩 ${Math.max(0, left)} 秒`
            : '音频会发送给 OpenAI，按通话时长计费。试用最长 1 分钟。'}
        </span>
        {busy ? (
          <Button
            size="sm"
            variant="secondary"
            className="onboarding-demo-chip"
            isDisabled={voice.status === 'closing'}
            onPress={() => void client.stop()}
          >
            <Icon icon={CallEnd01Icon} size={14} />
            结束试用
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            className="onboarding-demo-chip"
            isDisabled={elsewhere}
            onPress={() => {
              setTried(true);
              void client.start('', true);
            }}
          >
            <Icon icon={Mic01Icon} size={14} />
            {tried ? '再试一次' : '开始试用'}
          </Button>
        )}
      </div>
    </Stage>
  );
}

export function OnboardingDemo({
  id,
  voiceConfig,
  onVoiceConfig,
}: {
  id: DemoId;
  voiceConfig?: LiveVoiceConfig;
  onVoiceConfig: (config: LiveVoiceConfig) => void;
}) {
  if (id === 'page') return <PageEditDemo />;
  if (id === 'sandbox') return <SandboxDemo />;
  if (id === 'guide') return <GuideDemo />;
  return <VoiceDemo config={voiceConfig} onConfig={onVoiceConfig} />;
}
