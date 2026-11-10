import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Card } from '@heroui/react';
import { LayoutGroup, motion, useReducedMotion } from 'motion/react';
import {
  ArrowDown02Icon,
  CommandLineIcon,
  Download04Icon,
  Folder01Icon,
  Globe02Icon,
  InformationCircleIcon,
  Loading02Icon,
} from '@hugeicons-pro/core-stroke-rounded';
import { Icon } from './ui';
import { AgentIcon } from './AgentIcon';
import { supportsBrowser } from '../shared/agents';
import athenaLogo from './assets/brand/athena-profile.png';
import type {
  OnboardingCommandPayloads,
  OnboardingInstallPlan,
  OnboardingState,
} from '../shared/onboarding';
import './onboarding.css';

type Screen =
  | 'welcome'
  | 'about'
  | 'resume'
  | 'connect'
  | 'detecting'
  | 'agents'
  | 'agentConnecting'
  | 'missing'
  | 'planLoading'
  | 'installPlan'
  | 'installing'
  | 'loginWait'
  | 'connected'
  | 'details'
  | 'folder'
  | 'folderWait'
  | 'folderConfirm'
  | 'workspaceChecking'
  | 'folderError'
  | 'browser'
  | 'browserPreparing'
  | 'browserError'
  | 'ready'
  | 'readyWithoutBrowser'
  | 'finishing'
  | 'cancelled'
  | 'error';
type Intent =
  | 'discover'
  | 'select'
  | 'personal'
  | 'detect'
  | 'plan'
  | 'install'
  | 'login'
  | 'pick'
  | 'confirm'
  | 'browser'
  | 'complete'
  | 'cancel'
  | 'defer';
type StatusCard = {
  icon: 'download' | 'info' | 'terminal' | 'folder' | 'globe' | 'pending';
  title: string;
  detail?: string;
  label?: string;
};
type AssistantEntry = {
  id: string;
  role: 'assistant';
  screen: Screen;
  state: OnboardingState;
  phase?: string;
};
type Entry = AssistantEntry | { id: string; role: 'user'; text: string; layoutId?: string };
type Action = {
  label: string;
  ghost?: boolean;
  disabled?: boolean;
  interrupt?: boolean;
  cancel?: boolean;
  run: (layoutId: string) => void;
};

const icons = {
  download: Download04Icon,
  info: InformationCircleIcon,
  terminal: CommandLineIcon,
  folder: Folder01Icon,
  globe: Globe02Icon,
};
const setupSteps = ['认识', '连接', '网页', '开始'] as const;
const easing = [0.22, 1, 0.36, 1] as const;
const pendingScreens = new Set<Screen>([
  'detecting',
  'agentConnecting',
  'planLoading',
  'installing',
  'loginWait',
  'folderWait',
  'workspaceChecking',
  'browserPreparing',
  'finishing',
]);
const activityLabels: Partial<Record<Screen, string>> = {
  detecting: '查看本机 Agent',
  agentConnecting: '核对连接',
  loginWait: '等你完成登录',
  workspaceChecking: '准备对话空间',
  browserPreparing: '连接网页工具',
  finishing: '确认准备结果',
};
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || '工作目录';
const formatBytes = (value: number) =>
  value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(value / 1024)} KB`;
const cleanError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    '',
  );

function MessageText({
  text,
  reveal,
  delay,
  as: Tag = 'p',
}: {
  text: string;
  reveal: boolean;
  delay: number;
  as?: 'p' | 'span';
}) {
  const phrases = text.match(/[^，。！？；]+[，。！？；]?/gu) || [text];
  return (
    <Tag className="onboarding-message-text">
      {phrases.map((phrase, index) => (
        <motion.span
          key={`${index}-${phrase}`}
          initial={reveal ? { opacity: 0, y: 5 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, delay: reveal ? delay + index * 0.12 : 0, ease: easing }}
        >
          {phrase}
        </motion.span>
      ))}
    </Tag>
  );
}

function screenForState(state: OnboardingState, intent: Intent): Screen {
  if (state.operation) {
    if (state.operation.kind === 'detect')
      return intent === 'complete'
        ? 'finishing'
        : intent === 'select'
          ? 'agentConnecting'
          : 'detecting';
    if (state.operation.kind === 'install-codex') return 'installing';
    if (state.operation.kind === 'login') return 'loginWait';
    if (state.operation.kind === 'workspace-check')
      return intent === 'pick' ? 'folderWait' : 'workspaceChecking';
    if (state.operation.kind === 'prepare-browser') return 'browserPreparing';
  }
  if (intent === 'cancel') return 'cancelled';
  if (state.plan && (intent === 'plan' || intent === 'browser')) return 'installPlan';
  if (state.workspace.candidate && (intent === 'pick' || intent === 'confirm'))
    return state.workspace.error ? 'folderError' : 'folderConfirm';
  if (state.workspace.status === 'error' && (intent === 'pick' || intent === 'confirm'))
    return 'folderError';
  if (state.browser.status === 'error' && (intent === 'browser' || intent === 'install'))
    return 'browserError';
  if (state.error) return 'error';
  if (intent === 'discover') return 'agents';
  if (intent === 'pick') return 'folder';
  if (state.selectedAgent && state.selectedAgent !== 'codex') {
    if (!state.executor?.available || !state.executor.supported) return 'missing';
  } else {
    if (state.codex.status === 'missing') return 'missing';
    if (state.codex.status === 'error') return 'error';
    if (state.codex.status !== 'ready') return 'connect';
  }
  if (state.workspace.status === 'error') return 'folderError';
  if (state.coreReady) {
    if (state.browser.status === 'ready') return 'ready';
    if (state.browser.status === 'deferred' || state.status === 'complete')
      return 'readyWithoutBrowser';
    return 'browser';
  }
  if (intent === 'confirm') return 'folder';
  return 'connected';
}

function content(
  screen: Screen,
  state: OnboardingState,
  context: { hasDraft: boolean; existingWorkbench: boolean },
): {
  title: string;
  lines: string[];
  cards?: StatusCard[];
  note?: string;
  plan?: OnboardingInstallPlan;
} {
  const operation = state.operation;
  const pendingCard: StatusCard = {
    icon: 'pending',
    title: operation?.message || '正在处理',
    detail:
      operation?.receivedBytes !== undefined
        ? operation.totalBytes
          ? `${formatBytes(operation.receivedBytes)} / ${formatBytes(operation.totalBytes)}`
          : `已下载 ${formatBytes(operation.receivedBytes)}`
        : undefined,
    label: '进行中',
  };
  const external = state.selectedAgent && state.selectedAgent !== 'codex';
  const name = state.executor?.name || state.selectedAgent || 'Codex';
  const connection: StatusCard = {
    icon: 'terminal',
    title: external ? name : 'Codex',
    detail:
      screen === 'details'
        ? external
          ? state.executor?.path
          : state.codex.path || state.codex.version
        : external
          ? state.executor?.version
          : state.codex.version,
    label: external
      ? state.executor?.available && state.executor.supported
        ? '已连接'
        : '未就绪'
      : state.codex.status === 'ready'
        ? '已连接'
        : state.codex.status === 'missing'
          ? '未安装'
          : '待核对',
  };
  const directory: StatusCard = {
    icon: 'folder',
    title:
      state.workspace.mode === 'personal' && !state.workspace.candidate
        ? '不绑定项目文件夹'
        : basename(state.workspace.candidate?.path || state.workspace.path),
    detail:
      state.workspace.mode === 'personal' && !state.workspace.candidate
        ? '先开始对话，需要时再选择项目'
        : state.workspace.candidate?.path || state.workspace.path,
    label: state.workspace.candidate
      ? '待确认'
      : state.workspace.status === 'ready'
        ? '可访问'
        : '待核对',
  };
  if (external && ['connect', 'missing', 'connected', 'details'].includes(screen)) {
    if (screen === 'missing')
      return {
        title: `${name} 尚不可用。`,
        lines: ['请在终端检查安装，或选择其他已安装的 CLI，然后重新检查。'],
        cards: [connection],
      };
    return {
      title: screen === 'connected' ? `已找到本机 ${name}。` : `使用本机 ${name}。`,
      lines: ['沿用你已有的配置。想先聊聊，还是选一个项目一起做？'],
      cards: [connection],
    };
  }
  switch (screen) {
    case 'welcome':
      return {
        title: 'hello, Athena.',
        lines: ['你好，我是 Athena。', '从第一个想法，到一起把事情做好。'],
      };
    case 'about':
      return {
        title: '你来决定，我们一起完成。',
        lines: ['写一段代码，调整一个页面，或把网页上的操作交给我。', '先一起把工作的地方准备好。'],
      };
    case 'resume':
      return {
        title: '欢迎回来，我们接着来。',
        lines: ['我会重新核对现状，再继续准备。', '已经确认的设置会保留。'],
      };
    case 'connect':
      return {
        title: '先让我们连接起来。',
        lines: ['先看看这台 Mac 上有哪些 AI Agent。', '你可以选择自己熟悉的那一个。'],
      };
    case 'detecting':
      return {
        title: '我先看看，你的 Mac 上有哪些 AI Agent。',
        lines: [],
        cards: [pendingCard],
      };
    case 'agents': {
      const installed = state.agents?.filter((agent) => agent.available) ?? [];
      return {
        title: installed.length ? '找到了。你想用哪一位？' : '先准备一位 AI Agent。',
        lines: installed.length
          ? ['选一个就好，我会沿用它已有的配置。']
          : [
              '还没有检测到本机 AI Agent。',
              '可以先安装 Codex，或在终端安装你熟悉的 Agent 后重新检查。',
            ],
      };
    }
    case 'agentConnecting':
      return {
        title: '好，我来接上它。',
        lines: [],
        cards: [pendingCard],
      };
    case 'missing':
      return {
        title: '还没有找到 Codex。',
        lines: ['先把它准备好，我们就能开始合作。', '我会在安装前告诉你要下载和更改什么。'],
        cards: [
          { icon: 'download', title: 'Codex CLI', detail: '来自 OpenAI 官方发布', label: '未安装' },
        ],
      };
    case 'planLoading':
      return {
        title: '先核对这次安装。',
        lines: ['正在读取官方来源、安装位置和需要更改的内容。'],
        cards: [pendingCard],
      };
    case 'installPlan': {
      const plan = state.plan;
      const title =
        plan?.kind === 'browser' ? '准备网页工作需要的组件。' : '这一步，交给我来准备。';
      return {
        title,
        lines: ['请先核对下载来源和安装位置。', '完成后，我会检查它能否正常启动。'],
        cards: [
          {
            icon: 'download',
            title: plan?.kind === 'browser' ? 'BrowserOS neo' : 'Codex CLI',
            detail: plan?.version ? `版本 ${plan.version}` : undefined,
            label: '等待确认',
          },
          { icon: 'info', title: '保留现有配置', detail: '如发现已有版本，先核对，不直接覆盖' },
        ],
        plan,
        note: '需要额外权限时，另行确认。',
      };
    }
    case 'installing':
      return {
        title: '正在把 Codex 准备好。',
        lines: ['你可以留在这里，或稍后回来继续。'],
        cards: [pendingCard],
      };
    case 'loginWait':
      return {
        title: '我在这里等你。',
        lines: ['在打开的登录页面完成授权，回来后我们继续。', '如果页面没有打开，可以再打开一次。'],
        cards: [
          {
            icon: 'pending',
            title: '官方登录页面',
            detail: '等待账号授权完成',
            label: '等待中',
          },
        ],
      };
    case 'connected':
      return {
        title: '连接好了。',
        lines: ['想先聊聊，还是选一个项目一起做？'],
        cards: [connection],
      };
    case 'details':
      return {
        title: '这是我们使用的连接。',
        lines: [
          'Athena 复用本机 Codex，并保留它已有的配置。',
          '切换登录会影响使用同一 Codex 登录的其他本机客户端。',
        ],
        cards: [connection],
        note: state.codex.detail,
      };
    case 'folder':
      return {
        title: '我们在哪里开始？',
        lines: ['不选文件夹，也能先开始对话。', '如果这次想处理代码，可以选择一个项目。'],
        cards: state.workspace.status === 'ready' ? [directory] : undefined,
        note: '选择目录后，我会先确认它是否可访问。',
      };
    case 'folderWait':
      return {
        title: '选好后，我就在这里继续。',
        lines: ['请在系统文件夹选择窗口中，选中你的项目目录。'],
        cards: [
          {
            icon: 'folder',
            title: '系统文件夹选择器',
            detail: '等待你选择工作目录',
            label: '等待中',
          },
        ],
      };
    case 'folderConfirm':
      return {
        title: '就从这里开始。',
        lines: ['我会在这个目录中处理你交给我的项目任务。'],
        cards: [directory],
        note:
          context.existingWorkbench && state.workspace.candidate?.path !== state.workspace.path
            ? `确认后检查目录访问；切换项目会清除${context.hasDraft ? '当前草稿和' : ''}页面源码上下文，已有对话记录保留。`
            : '确认后检查目录访问。需要额外审批的操作，仍会说明具体范围并等待你决定。',
      };
    case 'workspaceChecking':
      return {
        title:
          state.operation?.phase === 'preparing-personal-workspace'
            ? '好，我们就从对话开始。'
            : '我确认一下，这个文件夹能不能使用。',
        lines: [],
        cards: [pendingCard],
      };
    case 'folderError':
      return {
        title: '这个工作目录暂时不可用。',
        lines: [
          state.workspace.error || '文件夹可能已被移动，或当前没有访问权限。',
          '连接已经保留，可以重新选择目录。',
        ],
        cards: [directory],
      };
    case 'browser':
      return {
        title: '接下来，把网页也接上。',
        lines: [
          '这样，你就能一边聊，一边操作右侧的页面。',
          ...(!supportsBrowser(state.selectedAgent || 'codex')
            ? ['想让我帮你操作网页时，进入工作台后新建一个 Codex 对话就好。']
            : []),
        ],
        cards: [
          {
            icon: 'globe',
            title: 'BrowserOS neo',
            detail: '使用独立浏览器数据，不导入你的日常浏览器配置',
            label: '可选',
          },
        ],
        note:
          state.browser.status === 'missing'
            ? '还没有找到浏览器。下载前会展示来源、大小和安装位置。'
            : undefined,
      };
    case 'browserPreparing':
      return {
        title: '我正在打开我们的第一页，稍等一下。',
        lines: [],
        cards: [pendingCard],
      };
    case 'browserError':
      return {
        title: '网页工具还差一步。',
        lines: [
          state.browser.error || state.error || '浏览器没有启动成功。',
          '也可以先开始项目任务，稍后再处理网页工具。',
        ],
      };
    case 'ready':
      return {
        title: '准备好了，轮到你的想法。',
        lines: ['你的 Agent 和网页工具都已就绪。', '走吧，Athena 的第一页正在等你。'],
        cards: context.existingWorkbench
          ? [
              connection,
              directory,
              { icon: 'globe', title: '网页工具', detail: 'BrowserOS neo 已就绪', label: '完成' },
            ]
          : undefined,
      };
    case 'readyWithoutBrowser':
      return {
        title: '准备好了，轮到你的想法。',
        lines: ['已经可以开始对话。', '网页工具可以在第一次用到时再准备。'],
        cards: context.existingWorkbench
          ? [
              connection,
              directory,
              {
                icon: 'globe',
                title: '网页工具',
                detail: '以后可以在设置中准备',
                label: '稍后准备',
              },
            ]
          : undefined,
      };
    case 'finishing':
      return {
        title: '最后确认一下，我们就可以开始了。',
        lines: [],
        cards: [pendingCard],
      };
    case 'cancelled':
      return {
        title: '这次先停在这里。',
        lines: ['已经确认的设置会保留。', '继续时，我会先重新检查当前状态。'],
      };
    case 'error':
      return {
        title: '这一步还没有完成。',
        lines: [state.error || state.codex.detail || '请重新检查当前状态后继续。'],
      };
  }
}

export function Onboarding({
  state,
  initial,
  hasDraft,
  onState,
  onExit,
}: {
  state: OnboardingState;
  initial: boolean;
  hasDraft: boolean;
  onState: (state: OnboardingState) => boolean;
  onExit: (state: OnboardingState) => Promise<void>;
}) {
  const reducedMotion = useReducedMotion();
  const nextId = useRef(1);
  const firstScreen: Screen = initial && state.stage === 'welcome' ? 'welcome' : 'resume';
  const [entries, setEntries] = useState<Entry[]>([
    { id: 'message-0', role: 'assistant', screen: firstScreen, state: structuredClone(state) },
  ]);
  const [requestPending, setRequestPending] = useState(false);
  const [welcomeReady, setWelcomeReady] = useState(
    firstScreen !== 'welcome' || Boolean(reducedMotion),
  );
  const [leaving, setLeaving] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [scrolled, setScrolled] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const currentArticle = useRef<HTMLElement>(null);
  const fade = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const currentState = useRef(state);
  currentState.current = state;
  const generation = useRef(0);
  const exitIntent = useRef<
    | {
        generation: number;
        sessionId: string;
        command: 'onboarding:defer' | 'onboarding:complete';
        automatic: boolean;
      }
    | undefined
  >(undefined);
  const exiting = useRef(false);
  const pending = useRef(false);
  const observingHost = useRef(false);
  const intent = useRef<Intent>('detect');
  const followLatest = useRef(true);
  const automaticScroll = useRef(false);
  const userPausedScroll = useRef(false);
  const current = entries.at(-1) as AssistantEntry;
  const enterAfterReply = useRef<() => void>(() => {});
  useEffect(() => {
    if (reducedMotion) setWelcomeReady(true);
  }, [reducedMotion]);

  const present = useCallback((screen: Screen, snapshot: OnboardingState) => {
    const phase =
      screen === 'installing' || screen === 'browserPreparing'
        ? snapshot.operation?.phase
        : undefined;
    setEntries((previous) => {
      const last = previous.at(-1);
      const entry: AssistantEntry = {
        id:
          last?.role === 'assistant' && (last.screen === screen || pendingScreens.has(last.screen))
            ? last.id
            : `message-${nextId.current++}`,
        role: 'assistant',
        screen,
        phase,
        state: structuredClone(snapshot),
      };
      return last?.id === entry.id ? [...previous.slice(0, -1), entry] : [...previous, entry];
    });
  }, []);

  const exitNow = useCallback(
    (snapshot: OnboardingState) => {
      if (exiting.current) return;
      exiting.current = true;
      observingHost.current = false;
      setLeaving(true);
      void onExit(snapshot).catch((error) => {
        exiting.current = false;
        setLeaving(false);
        setRequestError(cleanError(error));
      });
    },
    [onExit],
  );
  const finishRequestedExit = useCallback(
    (snapshot: OnboardingState) => {
      const requested = exitIntent.current;
      if (
        !requested ||
        requested.generation !== generation.current ||
        requested.sessionId !== snapshot.sessionId ||
        snapshot.operation
      )
        return;
      const complete = snapshot.status === 'complete' && snapshot.coreReady;
      const deferred = snapshot.status === 'deferred' || snapshot.status === 'legacy';
      if (requested.command === 'onboarding:complete' ? complete : deferred || complete) {
        exitIntent.current = undefined;
        if (requested.automatic && (!followLatest.current || userPausedScroll.current)) return;
        exitNow(snapshot);
      }
    },
    [exitNow],
  );

  useEffect(() => {
    if (observingHost.current) present(screenForState(state, intent.current), state);
    finishRequestedExit(state);
  }, [state, present, finishRequestedExit]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  const reply = (text: string, layoutId?: string) => {
    followLatest.current = true;
    userPausedScroll.current = false;
    setEntries((previous) => [
      ...previous,
      { id: `reply-${nextId.current++}`, role: 'user', text, layoutId },
    ]);
  };
  const local = (text: string, screen: Screen, layoutId?: string) => {
    if (pending.current || currentState.current.operation) return;
    observingHost.current = false;
    setRequestError('');
    reply(text, layoutId);
    present(screen, currentState.current);
  };

  const run = async <K extends keyof OnboardingCommandPayloads>(
    command: K,
    payload: OnboardingCommandPayloads[K],
    label: string | undefined,
    waiting: Screen,
    nextIntent: Intent,
    layoutId?: string,
    exit = false,
  ) => {
    const interrupt =
      command === 'onboarding:cancel' ||
      command === 'onboarding:defer' ||
      command === 'onboarding:complete' ||
      command === 'onboarding:login/reopen';
    if (exiting.current || (pending.current && !interrupt)) return;
    const ticket = ++generation.current;
    const session = currentState.current.sessionId;
    exitIntent.current =
      exit && (command === 'onboarding:defer' || command === 'onboarding:complete')
        ? { generation: ticket, sessionId: session, command, automatic: label === undefined }
        : undefined;
    pending.current = true;
    setRequestPending(true);
    setRequestError('');
    observingHost.current = true;
    intent.current = nextIntent;
    if (label) reply(label, layoutId);
    present(waiting, currentState.current);
    try {
      const next = await window.workbench.invoke<OnboardingState>(command, payload);
      if (ticket !== generation.current || next.sessionId !== session) return;
      if (!onState(next)) return;
      present(screenForState(next, nextIntent), next);
      finishRequestedExit(next);
    } catch (error) {
      if (ticket === generation.current) {
        observingHost.current = false;
        exitIntent.current = undefined;
        setRequestError(cleanError(error));
        present('error', currentState.current);
      }
    } finally {
      if (ticket === generation.current) {
        pending.current = false;
        setRequestPending(false);
      }
    }
  };

  const goLatest = useCallback(() => {
    const node = scroll.current;
    if (!node) return;
    followLatest.current = true;
    userPausedScroll.current = false;
    setShowLatest(false);
    if (node.scrollHeight - node.clientHeight - node.scrollTop > 1) {
      automaticScroll.current = !reducedMotion;
      node.scrollTo({ top: node.scrollHeight, behavior: reducedMotion ? 'instant' : 'smooth' });
    }
  }, [reducedMotion]);
  const updateFade = useCallback(() => {
    const node = scroll.current;
    const currentNode = currentArticle.current;
    const fadeHeight = fade.current?.getBoundingClientRect().height || 0;
    setScrolled(
      Boolean(
        node &&
        currentNode &&
        node.scrollTop > 4 &&
        currentNode.getBoundingClientRect().top >= node.getBoundingClientRect().top + fadeHeight,
      ),
    );
  }, []);
  useLayoutEffect(() => {
    if (followLatest.current) goLatest();
    updateFade();
  }, [entries, goLatest, updateFade]);
  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const settled = () => {
      automaticScroll.current = false;
      followLatest.current =
        node.scrollHeight - node.scrollTop - node.clientHeight <=
        (userPausedScroll.current ? 2 : 80);
      if (followLatest.current) userPausedScroll.current = false;
      setShowLatest(!followLatest.current);
      updateFade();
    };
    const resized = () => {
      if (followLatest.current && !userPausedScroll.current) goLatest();
      updateFade();
    };
    node.addEventListener('scrollend', settled);
    window.addEventListener('resize', resized);
    return () => {
      node.removeEventListener('scrollend', settled);
      window.removeEventListener('resize', resized);
    };
  }, [updateFade, goLatest]);
  useEffect(() => {
    const active = document.activeElement;
    if (
      followLatest.current &&
      !requestPending &&
      !state.operation &&
      !document.hidden &&
      document.hasFocus() &&
      (!active || active === document.body || active === scroll.current)
    )
      heading.current?.focus({ preventScroll: true });
  }, [current.id, requestPending, state.operation]);
  const stopFollowing = () => {
    automaticScroll.current = false;
    followLatest.current = false;
    userPausedScroll.current = true;
    const node = scroll.current;
    if (node) node.scrollTo({ top: node.scrollTop, behavior: 'instant' });
  };

  const check: Action = {
    label: '重新检查',
    run: (id) => void run('onboarding:refresh', undefined, '重新检查', 'detecting', 'detect', id),
  };
  const chooseFolder: Action = {
    label: '选择项目文件夹',
    run: (id) =>
      void run('onboarding:workspace/pick', undefined, '选择项目文件夹', 'folderWait', 'pick', id),
  };
  const skipFolder: Action = {
    label: '先不选文件夹',
    run: (id) =>
      void run(
        'onboarding:workspace/skip',
        undefined,
        '先不选文件夹',
        'workspaceChecking',
        'personal',
        id,
      ),
  };
  const chooseAgent: Action = {
    label: '换一个 Agent',
    ghost: true,
    run: (id) => local('换一个 Agent', 'agents', id),
  };
  const discover: Action = {
    label: '开始配置',
    run: (id) => void run('onboarding:refresh', undefined, '开始配置', 'detecting', 'discover', id),
  };
  const skipBrowser: Action = {
    label: '以后再说',
    ghost: true,
    interrupt: true,
    disabled: !state.coreReady,
    run: (id) =>
      void run('onboarding:complete', undefined, '以后再说', 'browserPreparing', 'complete', id),
  };
  const actions = (): Action[] => {
    if (state.operation) {
      const result: Action[] = [];
      if (state.operation.kind === 'login' && state.login?.canReopen)
        result.push({
          label: '重新打开登录页',
          ghost: true,
          interrupt: true,
          run: (id) =>
            void run(
              'onboarding:login/reopen',
              undefined,
              '重新打开登录页',
              'loginWait',
              'login',
              id,
            ),
        });
      if (state.operation.cancelable)
        result.push({
          cancel: true,
          label:
            state.operation.kind === 'login'
              ? '取消登录'
              : state.operation.kind === 'install-codex'
                ? '取消安装'
                : '取消这次操作',
          ghost: true,
          interrupt: true,
          run: (id) =>
            void run(
              'onboarding:cancel',
              { operationId: state.operation!.id },
              '先停一下',
              current.screen,
              'cancel',
              id,
            ),
        });
      if (state.operation.kind === 'prepare-browser' && state.coreReady) result.push(skipBrowser);
      return result;
    }
    if (state.selectedAgent && state.selectedAgent !== 'codex' && current.screen === 'missing')
      return [check, chooseAgent];
    switch (current.screen) {
      case 'welcome':
        return [
          discover,
          {
            label: '你能帮我做什么？',
            ghost: true,
            run: (id) => local('你能帮我做什么？', 'about', id),
          },
        ];
      case 'about':
        return [discover];
      case 'connect':
        return [discover];
      case 'agents':
        return [
          ...((state.agents || []).some((agent) => agent.available && agent.supported)
            ? []
            : [
                {
                  label: '准备安装 Codex',
                  run: (id: string) =>
                    void run(
                      'onboarding:plan-install',
                      { kind: 'codex' },
                      '准备安装 Codex',
                      'planLoading',
                      'plan',
                      id,
                    ),
                },
              ]),
          {
            label: '重新检测',
            ghost: true,
            run: (id) =>
              void run('onboarding:refresh', undefined, '重新检测', 'detecting', 'discover', id),
          },
        ];
      case 'resume':
      case 'cancelled':
      case 'error':
        return [check];
      case 'missing':
        return [
          {
            label: '准备安装',
            run: (id) =>
              void run(
                'onboarding:plan-install',
                { kind: 'codex' },
                '准备安装',
                'planLoading',
                'plan',
                id,
              ),
          },
          { ...check, label: '我已安装，重新检查', ghost: true },
        ];
      case 'installPlan':
        return state.plan
          ? [
              {
                label: '下载并安装',
                disabled: state.plan.expiresAt <= Date.now(),
                run: (id) =>
                  void run(
                    'onboarding:install',
                    { planId: state.plan!.id },
                    '下载并安装',
                    state.plan!.kind === 'browser' ? 'browserPreparing' : 'installing',
                    'install',
                    id,
                  ),
              },
              {
                label: '重新获取安装计划',
                ghost: true,
                run: (id) =>
                  void run(
                    'onboarding:plan-install',
                    { kind: state.plan!.kind },
                    '重新获取安装计划',
                    'planLoading',
                    'plan',
                    id,
                  ),
              },
            ]
          : [check];
      case 'connected':
        return [
          skipFolder,
          { ...chooseFolder, ghost: true },
          { label: '查看连接详情', ghost: true, run: (id) => local('查看连接详情', 'details', id) },
        ];
      case 'details':
        return [
          check,
          // Signing in is the user's call; nothing here checks whether it is needed.
          ...(state.selectedAgent && state.selectedAgent !== 'codex'
            ? []
            : [
                {
                  label: '登录 Codex 账号',
                  ghost: true,
                  run: (id: string) =>
                    void run(
                      'onboarding:login/start',
                      undefined,
                      '登录 Codex 账号',
                      'loginWait',
                      'login',
                      id,
                    ),
                },
              ]),
          { label: '返回准备', ghost: true, run: (id) => local('返回准备', 'folder', id) },
        ];
      case 'folder':
        return state.workspace.status === 'ready' && state.coreReady
          ? [
              { label: '使用当前目录', run: (id) => local('使用当前目录', 'browser', id) },
              { ...chooseFolder, label: '换一个文件夹', ghost: true },
            ]
          : [skipFolder, { ...chooseFolder, ghost: true }];
      case 'folderConfirm':
        return state.workspace.candidate
          ? [
              {
                label: '使用这个目录',
                run: (id) =>
                  void run(
                    'onboarding:workspace/confirm',
                    { candidateId: state.workspace.candidate!.id },
                    '使用这个目录',
                    'workspaceChecking',
                    'confirm',
                    id,
                  ),
              },
              { ...chooseFolder, label: '换一个文件夹', ghost: true },
            ]
          : [chooseFolder];
      case 'folderError':
        return [
          { ...chooseFolder, label: '重新选择目录' },
          { ...skipFolder, ghost: true },
          ...(state.workspace.candidate
            ? [
                {
                  label: '重试访问',
                  ghost: true,
                  run: (id: string) =>
                    void run(
                      'onboarding:workspace/confirm',
                      { candidateId: state.workspace.candidate!.id },
                      '重试访问',
                      'workspaceChecking',
                      'confirm',
                      id,
                    ),
                },
              ]
            : []),
        ];
      case 'browser':
      case 'browserError':
        return [
          {
            label: state.browser.status === 'missing' ? '准备安装浏览器' : '准备浏览器',
            run: (id) =>
              state.browser.status === 'missing'
                ? void run(
                    'onboarding:plan-install',
                    { kind: 'browser' },
                    '准备安装浏览器',
                    'planLoading',
                    'plan',
                    id,
                  )
                : void run(
                    'onboarding:browser/prepare',
                    undefined,
                    '准备浏览器',
                    'browserPreparing',
                    'browser',
                    id,
                  ),
          },
          skipBrowser,
        ];
      case 'ready':
      case 'readyWithoutBrowser':
        if (initial) return [];
        return [
          {
            label: '进入 Athena',
            disabled: !state.coreReady,
            run: (id) =>
              state.status === 'complete'
                ? exitNow(state)
                : void run(
                    'onboarding:complete',
                    undefined,
                    '进入 Athena',
                    current.screen,
                    'complete',
                    id,
                    true,
                  ),
          },
        ];
      default:
        return [];
    }
  };
  const viewContext = { hasDraft, existingWorkbench: !initial };
  const currentView = content(current.screen, state, viewContext);
  const currentActions = actions();
  const cancelAction = currentActions.find((action) => action.cancel);
  enterAfterReply.current = () => {
    const snapshot = currentState.current;
    if (pending.current || exiting.current || snapshot.operation || !snapshot.coreReady) return;
    if (!followLatest.current || userPausedScroll.current) return;
    if (snapshot.status === 'complete') exitNow(snapshot);
    else
      void run(
        'onboarding:complete',
        undefined,
        undefined,
        'finishing',
        'complete',
        undefined,
        true,
      );
  };
  useEffect(() => {
    if (
      !initial ||
      !['ready', 'readyWithoutBrowser'].includes(current.screen) ||
      !state.coreReady ||
      state.operation ||
      requestPending ||
      showLatest ||
      leaving
    )
      return;
    // Browser frame renders must not restart the final reply's handoff timing.
    const timer = setTimeout(() => enterAfterReply.current(), reducedMotion ? 0 : 900);
    return () => clearTimeout(timer);
  }, [
    initial,
    current.id,
    current.screen,
    state.status,
    state.coreReady,
    state.operation?.id,
    requestPending,
    showLatest,
    leaving,
    reducedMotion,
  ]);
  const stage = ['welcome', 'about'].includes(current.screen)
    ? 0
    : ['ready', 'readyWithoutBrowser', 'finishing'].includes(current.screen) ||
        (intent.current === 'complete' && state.operation)
      ? 3
      : ['browser', 'browserPreparing', 'browserError'].includes(current.screen) ||
          (current.screen === 'installPlan' && state.plan?.kind === 'browser')
        ? 2
        : 1;
  return (
    <motion.section
      className="onboarding"
      aria-label="首次准备"
      data-scrolled={scrolled}
      data-animate-welcome={initial && firstScreen === 'welcome'}
      data-welcome={current.screen === 'welcome'}
      data-intro-ready={welcomeReady}
      data-leaving={leaving}
      inert={leaving}
      initial={false}
      animate={{ opacity: leaving ? 0 : 1, scale: leaving && !reducedMotion ? 1.025 : 1 }}
      transition={{ duration: reducedMotion ? 0 : 0.55, ease: easing }}
    >
      <header className="onboarding-topbar window-drag">
        <strong>Athena</strong>
        <span>{initial ? '初次见面' : '继续准备'}</span>
        <div className="onboarding-top-progress">
          <span>
            第 {stage + 1} / {setupSteps.length} 步 · {setupSteps[stage]}
          </span>
          <div
            className="onboarding-progress-track"
            role="progressbar"
            aria-label="准备步骤"
            aria-valuemin={1}
            aria-valuemax={setupSteps.length}
            aria-valuenow={stage + 1}
            aria-valuetext={`第 ${stage + 1} 步，共 ${setupSteps.length} 步：${setupSteps[stage]}`}
          >
            {setupSteps.map((label, index) => (
              <span key={label} data-active={index === stage} data-complete={index < stage} />
            ))}
          </div>
        </div>
      </header>
      <motion.div
        layoutScroll
        className="onboarding-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label="准备对话记录"
        onWheel={(event) => {
          if (event.deltaY < 0) stopFollowing();
        }}
        onTouchStart={stopFollowing}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) stopFollowing();
        }}
        onKeyDownCapture={(event) => {
          if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) stopFollowing();
        }}
        onScroll={(event) => {
          const node = event.currentTarget;
          const nearBottom =
            node.scrollHeight - node.scrollTop - node.clientHeight <=
            (userPausedScroll.current ? 2 : 80);
          updateFade();
          if (nearBottom) {
            followLatest.current = true;
            userPausedScroll.current = false;
            automaticScroll.current = false;
          } else if (!automaticScroll.current) followLatest.current = false;
          setShowLatest(!nearBottom && !automaticScroll.current);
        }}
      >
        <LayoutGroup id="onboarding-dialogue">
          <motion.div layout="position" className="onboarding-transcript">
            {entries.map((entry, index) => {
              if (entry.role === 'user')
                return (
                  <motion.article
                    key={entry.id}
                    layoutId={reducedMotion ? undefined : entry.layoutId}
                    className="onboarding-message user"
                    initial={reducedMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: reducedMotion ? 0 : 0.5, ease: easing }}
                    aria-label="你的选择"
                  >
                    <p>{entry.text}</p>
                  </motion.article>
                );
              const active = index === entries.length - 1;
              const entryState = active ? state : entry.state;
              const view = content(entry.screen, entryState, viewContext);
              const activity = view.cards?.find((card) => card.icon === 'pending');
              const cards = view.cards?.filter((card) => card.icon !== 'pending');
              const welcome = entry.screen === 'welcome';
              return (
                <motion.article
                  key={entry.id}
                  layout="position"
                  ref={active ? currentArticle : undefined}
                  className={`onboarding-message assistant ${active ? 'is-current' : 'is-history'} ${welcome ? 'is-welcome' : ''}`}
                  data-screen={entry.screen}
                  data-pending={active && Boolean(state.operation)}
                  initial={welcome || reducedMotion ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.42, ease: easing }}
                >
                  <motion.div layout="position" className="onboarding-message-heading">
                    <motion.img
                      layout
                      src={athenaLogo}
                      alt="Athena"
                      initial={
                        welcome && !reducedMotion ? { opacity: 0, scale: 0.88, y: 18 } : false
                      }
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      transition={{ duration: reducedMotion ? 0 : 0.75, ease: easing }}
                    />
                    <motion.h1
                      ref={active ? heading : undefined}
                      tabIndex={-1}
                      initial={welcome && !reducedMotion ? { opacity: 0, y: 14 } : false}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        duration: 0.65,
                        delay: welcome && !reducedMotion ? 0.4 : 0,
                        ease: easing,
                      }}
                    >
                      {welcome ? (
                        view.title
                      ) : (
                        <MessageText
                          as="span"
                          text={view.title}
                          reveal={active && !reducedMotion}
                          delay={0}
                        />
                      )}
                    </motion.h1>
                  </motion.div>
                  <div className="onboarding-message-body">
                    <motion.div
                      key={welcome ? 'welcome-copy' : entry.screen}
                      initial={welcome && !reducedMotion ? { opacity: 0 } : false}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.3, delay: welcome && !reducedMotion ? 0.9 : 0 }}
                      onAnimationComplete={() => {
                        if (welcome) setWelcomeReady(true);
                      }}
                    >
                      {view.lines.map((line, lineIndex) => (
                        <MessageText
                          key={line}
                          text={line}
                          reveal={active && !welcome && !reducedMotion}
                          delay={0.08 + lineIndex * 0.16}
                        />
                      ))}
                    </motion.div>
                    {activity && (
                      <div className="onboarding-activity" data-active={active}>
                        <div className="onboarding-activity-row">
                          <span className="onboarding-thinking-dots" aria-hidden="true">
                            <i />
                            <i />
                            <i />
                          </span>
                          <span
                            className="onboarding-activity-label"
                            aria-live={active ? 'polite' : 'off'}
                          >
                            {entryState.operation?.phase === 'cancelling'
                              ? '正在停下'
                              : entry.screen === 'workspaceChecking' &&
                                  entryState.operation?.phase !== 'preparing-personal-workspace'
                                ? '检查文件夹'
                                : activityLabels[entry.screen] || activity.title}
                          </span>
                          {active && cancelAction && (
                            <motion.div layoutId={reducedMotion ? undefined : `${entry.id}-cancel`}>
                              <Button
                                className="onboarding-stop"
                                size="sm"
                                variant="ghost"
                                aria-label={cancelAction.label}
                                isDisabled={leaving || cancelAction.disabled}
                                onPress={() => cancelAction.run(`${entry.id}-cancel`)}
                              >
                                停一下
                              </Button>
                            </motion.div>
                          )}
                        </div>
                        {activity.detail && (
                          <span className="onboarding-activity-detail">{activity.detail}</span>
                        )}
                        {entryState.operation && (
                          <details className="onboarding-operation-detail">
                            <summary>查看详情</summary>
                            <p>{entryState.operation.message}</p>
                          </details>
                        )}
                      </div>
                    )}
                    {!!cards?.length && (
                      <div className="onboarding-status-cards">
                        {cards.map((card, cardIndex) => (
                          <Card key={cardIndex} className="onboarding-status-card">
                            <Card.Content className="onboarding-status-row">
                              <span className="onboarding-status-icon">
                                {card.icon === 'pending' ? (
                                  <Icon
                                    icon={Loading02Icon}
                                    size={22}
                                    className={active ? 'spin' : undefined}
                                  />
                                ) : (
                                  <Icon icon={icons[card.icon]} size={22} />
                                )}
                              </span>
                              <div className="onboarding-status-copy">
                                <strong>{card.title}</strong>
                                {card.detail && <span>{card.detail}</span>}
                              </div>
                              {card.label && (
                                <span className="onboarding-status-label">{card.label}</span>
                              )}
                            </Card.Content>
                          </Card>
                        ))}
                      </div>
                    )}
                    {view.plan && (
                      <dl className="onboarding-plan-details">
                        <dt>下载来源</dt>
                        <dd>{view.plan.sourceUrl}</dd>
                        <dt>安装位置</dt>
                        <dd>{view.plan.destination}</dd>
                        <dt>下载大小</dt>
                        <dd>
                          {view.plan.downloadBytes === undefined
                            ? '待服务器确认'
                            : formatBytes(view.plan.downloadBytes)}
                        </dd>
                        <dt>环境变更</dt>
                        <dd>{view.plan.changes.join('；')}</dd>
                        <dt>SHA-256</dt>
                        <dd>{view.plan.sha256}</dd>
                      </dl>
                    )}
                    {view.note && <p className="onboarding-note">{view.note}</p>}
                    {active && requestError && (
                      <p className="onboarding-error" role="alert">
                        {requestError}
                      </p>
                    )}
                    {active && entry.screen === 'agents' && (
                      <div
                        className="onboarding-agent-list"
                        role="group"
                        aria-label="本机 AI Agent"
                      >
                        {(state.agents || [])
                          .filter((agent) => agent.available)
                          .map((agent, agentIndex) => {
                            const id = `${entry.id}-agent-${agent.id}`;
                            return (
                              <motion.div
                                key={agent.id}
                                layoutId={reducedMotion ? undefined : id}
                                initial={reducedMotion ? false : { opacity: 0, y: 12, scale: 0.97 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                transition={{
                                  duration: 0.42,
                                  delay: reducedMotion ? 0 : agentIndex * 0.07,
                                  ease: easing,
                                }}
                              >
                                <Button
                                  className="onboarding-agent-capsule"
                                  variant="secondary"
                                  aria-label={`选择 ${agent.name}`}
                                  isDisabled={
                                    !agent.supported ||
                                    leaving ||
                                    requestPending ||
                                    Boolean(state.operation)
                                  }
                                  onPress={() =>
                                    void run(
                                      'onboarding:agent',
                                      { id: agent.id },
                                      `使用 ${agent.name}`,
                                      'agentConnecting',
                                      'select',
                                      id,
                                    )
                                  }
                                >
                                  <AgentIcon agent={agent.id} size={22} />
                                  <span>{agent.name}</span>
                                  {!agent.supported && <small>暂不支持</small>}
                                </Button>
                              </motion.div>
                            );
                          })}
                      </div>
                    )}
                    {active &&
                      (!welcome || welcomeReady) &&
                      currentActions.some((action) => !activity || !action.cancel) && (
                        <motion.div
                          className="onboarding-actions"
                          initial={reducedMotion ? false : { opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.35, ease: easing }}
                        >
                          {currentActions
                            .filter((action) => !activity || !action.cancel)
                            .map((action, actionIndex) => {
                              const id = `${entry.id}-choice-${actionIndex}`;
                              return (
                                <motion.div
                                  key={id}
                                  layoutId={reducedMotion ? undefined : id}
                                  className="onboarding-choice"
                                >
                                  <Button
                                    variant={action.ghost ? 'ghost' : 'primary'}
                                    isDisabled={
                                      leaving ||
                                      action.disabled ||
                                      (requestPending && !action.interrupt)
                                    }
                                    onPress={() => action.run(id)}
                                  >
                                    {action.label}
                                  </Button>
                                </motion.div>
                              );
                            })}
                        </motion.div>
                      )}
                  </div>
                </motion.article>
              );
            })}
          </motion.div>
        </LayoutGroup>
      </motion.div>
      <div ref={fade} className="onboarding-history-fade" aria-hidden="true" />
      {showLatest && (
        <Button className="onboarding-jump-latest" variant="secondary" onPress={goLatest}>
          <Icon icon={ArrowDown02Icon} size={16} />
          回到最新
        </Button>
      )}
      <footer className="onboarding-footer">
        {welcomeReady && (
          <Button
            className="onboarding-skip-setup"
            variant="secondary"
            isDisabled={leaving || (requestPending && intent.current === 'defer')}
            onPress={() =>
              void run(
                'onboarding:defer',
                undefined,
                '跳过设置',
                current.screen,
                'defer',
                undefined,
                true,
              )
            }
          >
            跳过设置
          </Button>
        )}
      </footer>
      <p className="sr-only" role="status" aria-live="polite">
        {currentView.title}
      </p>
    </motion.section>
  );
}
