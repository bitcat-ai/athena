import { TurnIcon } from './HoverIcons';
import { ActionButton, Icon } from './ui';
import { Button, Card, Dropdown, Label, Description, Input, Tabs, Tooltip } from '@heroui/react';
import {
  Sidebar,
  PromptInput,
  PromptSuggestion,
  ChatMessage as ProChatMessage,
  ChatMessageActions,
  TokenFieldValue,
  usePromptInputTokens,
} from '@heroui-pro/react';
import athenaLogo from './assets/brand/athena-profile.png';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Archive01Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowUpRight01Icon,
  ChartNoAxesCombinedIcon,
  CircleIcon,
  CommandIcon,
  CopyIcon,
  Cursor01Icon,
  EarthIcon,
  Folder01Icon,
  FolderOpenIcon,
  Link02Icon,
  Loading02Icon,
  MessageSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  Search01Icon,
  Settings02Icon,
  ShieldCheckIcon,
  TerminalIcon,
  Tick02Icon,
  UnplugIcon,
  XIcon,
} from '@hugeicons-pro/core-stroke-rounded';
import { BrowserPane } from './BrowserPane';
import { ElementInspector } from './ElementInspector';
import { AssistantTurn } from './AssistantTurn';
import { PhaseGlyph } from './PhaseGlyph';
import { ModelPicker } from './ModelPicker';
import { UsagePanel } from './UsagePanel';
import { AgentIcon } from './AgentIcon';
import { WorkbenchNotices, useCodexUpdate } from './WorkbenchNotices';
import { ConversationSearch } from './ConversationSearch';
import { ConversationMenu, DeleteConversationDialog } from './ConversationMenu';
import { UserMenu, WebContextMenu, useAppearance } from './HomeMenus';
import { Onboarding } from './Onboarding';
import type { OnboardingState } from '../shared/onboarding';
import {
  copyableText,
  displayPhase,
  endedOutcome,
  phaseGlyph,
  phaseText,
  replyText,
  requestKey,
  type GlyphKind,
} from '../shared/phase';
import {
  agentModelSelection,
  conversationAgent,
  conversationModelSelection,
  supportsBrowser,
} from '../shared/agents';
import { isArchived } from '../shared/types';
import type {
  ElementMention,
  AgentInfo,
  AppEvent,
  AppSnapshot,
  BrowserFrame,
  BrowserState,
  ChatMessage,
  Conversation,
  CodexConnectionState,
  ElementDetails,
  ElementEdit,
  ElementRef,
  FeishuState,
  PendingAgentRequest,
  RecordedStep,
  Recording,
  Settings,
  NativeNeoState,
} from '../shared/types';

const emptyBrowser: BrowserState = {
  status: 'starting',
  engine: 'browseros',
  tabs: [],
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  recording: false,
  inspecting: false,
};
const emptyFeishu: FeishuState = { status: 'disconnected', paired: false };
type SettingsTab = 'agent' | 'browser' | 'feishu';
/** A conversation's state as the sidebar repeats it. */
interface Echo {
  glyph: GlyphKind;
  still?: boolean;
  label: string;
}
const waitingEchoes = { approval: '等你批准', input: '等你回答', handoff: '等你操作' };
function basename(value: string) {
  return value.split(/[\\/]/).filter(Boolean).pop() || '工作目录';
}
function pageSource(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}
function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    '',
  );
}

function sessionLabel(info?: AgentInfo, connection?: CodexConnectionState) {
  if (!info?.available) return info?.path ? '启动异常' : '未检测到';
  if (info.authentication === 'missing') return '需要登录';
  if (connection?.status === 'starting') return '初始化中';
  if (connection?.status === 'ready') return '已就绪';
  if (connection?.status === 'error') return '连接失败';
  return info.authentication === 'ready' ? '已登录' : '登录待验证';
}

interface DraftEntry {
  text: string;
  field?: TokenFieldValue<ElementMention>;
}
const EMPTY_FIELD = new TokenFieldValue<ElementMention>([]);
const TOKEN_PATTERN = /^\[ele(\d+)\]$/;
function fieldFromText(text: string) {
  if (!text) return EMPTY_FIELD;
  return new TokenFieldValue<ElementMention>([{ type: 'text', text }]).withCaretPosition({
    index: 0,
    offset: text.length,
  });
}
/** Next unused [eleN] label; numbers are never reused within a draft so the agent's replies stay unambiguous. */
function nextToken(field: TokenFieldValue<ElementMention>) {
  const used = field.segments.map((segment) =>
    segment.type === 'token' ? Number(TOKEN_PATTERN.exec(segment.text)?.[1] ?? 0) : 0,
  );
  return `[ele${Math.max(0, ...used) + 1}]`;
}
/** Renders a sent message with its [eleN] tokens shown as element chips. */
function MentionText({ text, mentions }: { text: string; mentions?: ElementMention[] }) {
  if (!mentions?.length) return <>{text}</>;
  return (
    <>
      {text.split(/(\[ele\d+\])/g).map((part, index) => {
        const mention = mentions.find((item) => item.token === part);
        return mention ? (
          <span
            key={index}
            className="element-chip"
            title={`${mention.tag}${mention.role ? ` · ${mention.role}` : ''}`}
          >
            <Icon icon={Cursor01Icon} size={11} aria-hidden />
            {mention.name}
          </span>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        );
      })}
    </>
  );
}

export default function App() {
  const [appearance, setAppearance] = useAppearance();
  const [loaded, setLoaded] = useState(false);
  const [startupError, setStartupError] = useState('');
  const [onboardingState, setOnboardingState] = useState<OnboardingState>();
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  const [initialOnboarding, setInitialOnboarding] = useState(true);
  const [openingOnboarding, setOpeningOnboarding] = useState(false);
  const [workbenchMounted, setWorkbenchMounted] = useState(false);
  const [onboardingTransition, setOnboardingTransition] = useState(false);
  const onboardingStateRef = useRef<OnboardingState | undefined>(undefined);
  const [localUserName, setLocalUserName] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [settings, setSettings] = useState<Settings>({ workspace: '', agent: 'codex' });
  const workspaceLabel =
    settings.workspaceMode === 'personal' ? '不绑定文件夹' : basename(settings.workspace);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [codexConnection, setCodexConnection] = useState<CodexConnectionState>({ status: 'idle' });
  const [browser, setBrowser] = useState<BrowserState>(emptyBrowser);
  const [neo, setNeo] = useState<NativeNeoState>({ status: 'stopped' });
  const [nativeRecordId, setNativeRecordId] = useState<string>();
  const [feishu, setFeishu] = useState<FeishuState>(emptyFeishu);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setConversationId] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Conversation>();
  const [deleting, setDeleting] = useState(false);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [liveSteps, setLiveSteps] = useState<RecordedStep[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftEntry>>({});
  const [sidebar, setSidebar] = useState(true);
  const [browserVisible, setBrowserVisible] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const editingElement = inspectorOpen && browserVisible;
  const [browserWidth, setBrowserWidth] = useState<number>();
  const [panelWidth, setPanelWidth] = useState(1100);
  const [resizingBrowser, setResizingBrowser] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [agentMenu, setAgentMenu] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<PendingAgentRequest[]>([]);
  const [toast, setToast] = useState<{ text: string; error: boolean; copiedMessageId?: string }>();
  const [refreshing, setRefreshing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [manualAppId, setManualAppId] = useState('');
  const [manualSecret, setManualSecret] = useState('');
  const composer = useRef<HTMLDivElement>(null);
  const panels = useRef<HTMLDivElement>(null);
  const resizeStart = useRef<{ x: number; width: number } | undefined>(undefined);
  const revealBrowserOnTool = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastFrame = useRef<BrowserFrame | undefined>(undefined);
  const activeBrowserTab = useRef<string | undefined>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const workspaceConversations = conversations.filter(
    (item) => !item.workspace || item.workspace === settings.workspace,
  );
  const openConversations = workspaceConversations.filter((item) => !isArchived(item));
  const archivedConversations = workspaceConversations.filter(isArchived);
  // 没有已归档的对话时回到对话列表，之后再归档也不会被带进归档列表。
  if (showArchived && !archivedConversations.length) setShowArchived(false);
  const conversation = workspaceConversations.find((item) => item.id === selectedId);
  const conversationId = conversation?.id;
  const archived = Boolean(conversation && isArchived(conversation));
  const conversationRequests = pendingRequests.filter(
    (item) => item.conversationId === conversationId,
  );
  const draftKey = JSON.stringify([settings.workspace, conversationId]);
  const draftEntry = drafts[draftKey];
  const draft = draftEntry?.text ?? '';
  // Before the first send there is no host ID. Keep that draft reachable after navigation.
  const sidebarConversations = showArchived
    ? archivedConversations
    : drafts[JSON.stringify([settings.workspace, null])]?.text
      ? [{ id: undefined, title: '未发送草稿', messages: [] }, ...openConversations]
      : openConversations;
  const field = draftEntry?.field ?? EMPTY_FIELD;
  const storeField = (next: TokenFieldValue<ElementMention>) =>
    setDrafts((previous) => ({ ...previous, [draftKey]: { text: next.toString(), field: next } }));
  // Page elements live in the draft as inline [eleN] tokens; no trigger characters are needed.
  const tokens = usePromptInputTokens<ElementMention>({
    triggers: [],
    value: field,
    onChange: storeField,
  });
  const focusComposer = () => tokens.inputRef.current?.focus();
  const setDraft = (text: string) => storeField(fieldFromText(text));
  /** Elements referenced by tokens in the current draft, in order of appearance. */
  const mentions = field.segments.flatMap((segment) =>
    segment.type === 'token' && segment.value ? [segment.value] : [],
  );
  /**
   * Embeds a page element in the draft as an inline token at the caret. Picking the same element
   * again reuses its token, and an inspector edit attaches to that token instead of adding one.
   */
  const insertMention = (element: ElementRef, edit?: ElementEdit, surround?: [string, string]) => {
    const index = field.segments.findIndex(
      (segment) => segment.type === 'token' && segment.value?.ref === element.ref,
    );
    const current = index >= 0 ? field.segments[index] : undefined;
    const previousEdit = current?.type === 'token' ? current.value?.edit : undefined;
    const token = current?.text ?? nextToken(field);
    const carried = edit ?? previousEdit;
    const mention: ElementMention = {
      token,
      ref: element.ref,
      tag: element.tag,
      name: element.name || element.tag,
      role: element.role,
      ...(carried ? { edit: carried } : {}),
    };
    let next: TokenFieldValue<ElementMention>;
    if (current) {
      next = field.replaceRangeWithSegments(
        { index, offset: 0 },
        { index, offset: current.text.length },
        [{ type: 'token', text: token, value: mention }],
        false,
      );
    } else if (surround && !field.toString().trim()) {
      next = new TokenFieldValue<ElementMention>([
        { type: 'text', text: surround[0] },
        { type: 'token', text: token, value: mention },
        { type: 'text', text: surround[1] },
      ]).withCaretPosition({ index: 2, offset: surround[1].length });
    } else {
      const at = field.caretPosition;
      next = field.replaceRangeWithSegments(
        at,
        at,
        [
          { type: 'token', text: token, value: mention },
          { type: 'text', text: ' ' },
        ],
        false,
      );
      const inserted = next.segments.findIndex(
        (segment) => segment.type === 'token' && segment.value === mention,
      );
      if (inserted >= 0) next = next.withCaretPosition({ index: inserted + 1, offset: 1 });
    }
    storeField(next);
    focusComposer();
  };
  const insertMentionRef = useRef(insertMention);
  insertMentionRef.current = insertMention;
  const currentView = {
    id: conversationId,
    workspace: settings.workspace,
    draftKey,
    hasDraft: !!draft,
  };
  const viewedConversation = useRef(currentView);
  viewedConversation.current = currentView;
  const messages = conversation?.messages || [];
  const isHome = !messages.length && !browserVisible && !editingElement;
  const setupRequired = Boolean(
    onboardingState?.requiresSetup && onboardingState.workspace.status !== 'ready',
  );
  const busy = conversations.some((item) =>
    item.messages.some((message) => message.status === 'streaming'),
  );
  const currentBusy = messages.some((message) => message.status === 'streaming');
  /** Phase of the turn a conversation is on, read by every surface outside the message list. */
  const turnPhase = (item: { id?: string; messages: ChatMessage[] }) => {
    const requests = pendingRequests.filter((pending) => pending.conversationId === item.id);
    // An open request points at its own turn; otherwise the latest turn speaks for the conversation.
    const message =
      item.messages.find((message) => message.id === requests[0]?.messageId) ??
      item.messages.at(-1);
    if (message?.role !== 'assistant') return undefined;
    return displayPhase(
      message,
      requests.filter((pending) => pending.messageId === message.id),
    );
  };
  const currentPhase = conversation && turnPhase(conversation);
  const runningConversation = conversations.find((item) => {
    const phase = turnPhase(item);
    return phase && phase.kind !== 'ended';
  });
  const runningPhase = runningConversation && {
    phase: turnPhase(runningConversation)!,
    agent: conversationAgent(runningConversation),
  };
  /** What the sidebar says about a conversation: nothing unless it is running or needs a look. */
  const conversationEcho = (item: {
    id?: string;
    messages: ChatMessage[];
    agent?: Conversation['agent'];
  }): Echo | undefined => {
    const phase = turnPhase(item);
    if (!phase) return undefined;
    if (phase.kind === 'waiting')
      return { glyph: 'wait', still: true, label: waitingEchoes[phase.request] };
    if (phase.kind !== 'ended')
      return { glyph: phaseGlyph(phase, conversationAgent(item)), label: '运行中' };
    return phase.outcome === 'blocked'
      ? { glyph: 'warn', still: true, label: '待核对' }
      : undefined;
  };
  const currentAgentId = conversation ? conversationAgent(conversation) : settings.agent;
  const currentAgent = agents.find((item) => item.id === currentAgentId);
  const defaultAgent = agents.find((item) => item.id === settings.agent);
  const currentSelection = conversation
    ? conversationModelSelection(settings, conversation)
    : agentModelSelection(settings, currentAgentId);
  const conversationSettings: Settings = {
    ...settings,
    agent: currentAgentId,
    modelSelections: { ...settings.modelSelections, [currentAgentId]: currentSelection },
  };
  const codexInfo = agents.find((item) => item.id === 'codex');
  const {
    update: codexUpdate,
    installedVersion,
    refresh: refreshCodexUpdate,
  } = useCodexUpdate(codexInfo, workbenchMounted && !onboardingVisible);
  const currentConnection =
    codexConnection.conversationId === conversationId ? codexConnection : undefined;
  const defaultConnection = currentAgentId === settings.agent ? currentConnection : undefined;
  const agentStatus = sessionLabel(currentAgent, currentConnection);
  const connected = feishu.status === 'connected' && feishu.paired;
  const minDrawerWidth = 390;
  const maxDrawerWidth = Math.max(minDrawerWidth, panelWidth - 420);
  const clampDrawerWidth = (width: number) =>
    Math.round(Math.min(maxDrawerWidth, Math.max(minDrawerWidth, width)));
  const drawerWidth = clampDrawerWidth(browserWidth ?? Math.min(620, panelWidth / 2));

  const showToast = useCallback((text: string, error = false, copiedMessageId?: string) => {
    setToast({ text, error, copiedMessageId });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), error ? 6500 : 3200);
  }, []);
  const acceptOnboardingState = useCallback((next: OnboardingState) => {
    const previous = onboardingStateRef.current;
    if (previous && (previous.sessionId !== next.sessionId || next.revision < previous.revision))
      return false;
    onboardingStateRef.current = next;
    setOnboardingState(next);
    if (next.selectedAgent)
      setSettings((previous) => ({ ...previous, agent: next.selectedAgent! }));
    return true;
  }, []);
  const action = useCallback(
    async <T = unknown,>(name: string, payload?: unknown): Promise<T> => {
      try {
        return await window.workbench.invoke<T>(name, payload);
      } catch (error) {
        showToast(errorText(error), true);
        return undefined as T;
      }
    },
    [showToast],
  );
  /** 只复制消息正文；页面上下文、工具事件和执行记录不进入剪贴板。 */
  const copyMessage = useCallback(
    async (message: ChatMessage) => {
      const label = message.role === 'user' ? '消息' : '回答';
      try {
        const copied = await window.workbench.invoke<boolean>('app:copy', { text: message.text });
        if (copied !== true) throw new Error('没有收到复制结果，请重试');
        showToast(`已复制${label}`, false, message.id);
      } catch (error) {
        showToast(`复制${label}失败：${errorText(error)}`, true);
      }
    },
    [showToast],
  );
  const upsert = useCallback((next: Conversation) => {
    setConversations((previous) =>
      [next, ...previous.filter((item) => item.id !== next.id)].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      ),
    );
    const view = viewedConversation.current;
    // A host-created conversation must not take over an unsent first draft.
    if (
      !isArchived(next) &&
      !view.hasDraft &&
      (!next.workspace || next.workspace === view.workspace)
    )
      setConversationId((previous) => previous ?? next.id);
  }, []);
  useEffect(() => {
    if (!window.workbench) {
      showToast('请在 Athena 桌面应用中打开这个工作区', true);
      return;
    }
    let disposed = false;
    let browserUpdated = false;
    let neoUpdated = false;
    let feishuUpdated = false;
    type RequestChange = (previous: PendingAgentRequest[]) => PendingAgentRequest[];
    let beforeSnapshot: RequestChange[] | undefined = [];
    const changeRequests = (change: RequestChange) => {
      beforeSnapshot?.push(change);
      setPendingRequests(change);
    };
    let codexUpdated = false;
    const handle = (event: AppEvent) => {
      if (event.type === 'onboarding:state') {
        acceptOnboardingState(event.state);
      } else if (event.type === 'codex:state') {
        if (
          event.state.conversationId &&
          viewedConversation.current.id &&
          event.state.conversationId !== viewedConversation.current.id
        )
          return;
        codexUpdated = true;
        setCodexConnection(event.state);
      } else if (event.type === 'neo:state') {
        neoUpdated = true;
        setNeo(event.state);
      } else if (event.type === 'browser:frame') {
        if (!event.frame.tabId || event.frame.tabId === activeBrowserTab.current)
          lastFrame.current = event.frame;
      } else if (event.type === 'browser:state') {
        browserUpdated = true;
        activeBrowserTab.current = event.state.activeTabId;
        setBrowser((previous) => {
          if (event.state.recording && !previous.recording) setLiveSteps([]);
          return event.state;
        });
      } else if (event.type === 'browser:step')
        setLiveSteps((previous) => {
          const index = previous.findIndex((step) => step.id === event.step.id);
          return index < 0
            ? [...previous, event.step]
            : previous.map((step) => (step.id === event.step.id ? event.step : step));
        });
      else if (event.type === 'browser:selected') {
        // Picking embeds the element in the draft; edits and undos only re-report it.
        if (event.reason !== 'edit') insertMentionRef.current(event.element);
      } else if (event.type === 'recording:saved')
        setRecordings((previous) => [
          event.recording,
          ...previous.filter((item) => item.id !== event.recording.id),
        ]);
      else if (event.type === 'feishu:state') {
        feishuUpdated = true;
        setFeishu(event.state);
        if (event.state.status !== 'configuring') setConnecting(false);
      } else if (event.type === 'conversation:updated') upsert(event.conversation);
      else if (event.type === 'notice') showToast(event.message, event.level === 'error');
      else if (event.type === 'agent:event') {
        const agentEvent = event.event;
        if (agentEvent.type === 'status' && agentEvent.status === 'starting')
          revealBrowserOnTool.current = true;
        if (
          agentEvent.type === 'tool' &&
          (agentEvent.call.name.startsWith('workbench_browser_') ||
            agentEvent.call.name.startsWith('neo_')) &&
          revealBrowserOnTool.current
        ) {
          setBrowserVisible(true);
          revealBrowserOnTool.current = false;
        }
        if (agentEvent.type === 'approval' || agentEvent.type === 'user-input') {
          const pending: PendingAgentRequest =
            agentEvent.type === 'approval'
              ? {
                  conversationId: event.conversationId,
                  messageId: event.messageId,
                  kind: 'approval',
                  request: agentEvent.request,
                }
              : {
                  conversationId: event.conversationId,
                  messageId: event.messageId,
                  kind: 'input',
                  request: agentEvent.request,
                };
          changeRequests((previous) => {
            const key = requestKey(pending);
            const index = previous.findIndex((item) => requestKey(item) === key);
            return index < 0
              ? [...previous, pending]
              : previous.map((item, i) => (i === index ? pending : item));
          });
        }
        if (
          agentEvent.type === 'request-resolved' ||
          agentEvent.type === 'complete' ||
          agentEvent.type === 'error'
        ) {
          changeRequests((previous) =>
            previous.filter(
              (item) =>
                item.conversationId !== event.conversationId ||
                item.messageId !== event.messageId ||
                (agentEvent.type === 'request-resolved' && item.request.id !== agentEvent.id),
            ),
          );
        }
        setConversations((previous) =>
          previous.map((item) => {
            if (item.id !== event.conversationId) return item;
            const updated = [...item.messages];
            const index = updated.findIndex((message) => message.id === event.messageId);
            if (index < 0) return item;
            const message = {
              ...updated[index],
              tools: [...(updated[index].tools || [])],
              execution: [...(updated[index].execution || [])],
            };
            if (agentEvent.type === 'delta') message.text += agentEvent.text;
            if (agentEvent.type === 'run-started' || agentEvent.type === 'model')
              message.model = agentEvent.model;
            if (agentEvent.type === 'plan') message.plan = agentEvent.steps;
            if (agentEvent.type === 'web-execution') {
              message.execution ??= [];
              message.execution.push(agentEvent.event);
              if (agentEvent.event.kind === 'plan') message.plan = agentEvent.event.plan;
            }
            if (agentEvent.type === 'tool') {
              const ti = message.tools.findIndex((tool) => tool.id === agentEvent.call.id);
              if (ti < 0) message.tools.push(agentEvent.call);
              else message.tools[ti] = agentEvent.call;
            }
            if (agentEvent.type === 'status' && agentEvent.phase) message.phase = agentEvent.phase;
            if (agentEvent.type === 'request-resolved' && agentEvent.resolved)
              message.requests = [...(message.requests ?? []), agentEvent.resolved];
            if (agentEvent.type === 'complete') {
              message.status = 'done';
              if (!message.text && agentEvent.text) message.text = agentEvent.text;
            }
            if (agentEvent.type === 'error') {
              message.status = 'error';
              message.failure = agentEvent.message;
              if (!message.text) message.text = agentEvent.message;
            }
            if (agentEvent.type === 'complete' || agentEvent.type === 'error') {
              // The host settles the outcome; without one the turn is judged from its own record.
              message.phase = agentEvent.phase ?? {
                kind: 'ended',
                outcome: endedOutcome(message, message.phase?.kind === 'stopping'),
              };
              message.endedAt = Date.now();
            }
            updated[index] = message;
            return { ...item, messages: updated };
          }),
        );
      }
    };
    const unsubscribe = window.workbench.onEvent(handle);
    void window.workbench
      .invoke<AppSnapshot>('app:snapshot')
      .then((snapshot) => {
        if (disposed) return;
        lastFrame.current ??= snapshot.browserFrame;
        setSettings(snapshot.settings);
        setLocalUserName(snapshot.localUser?.name || '');
        if (!neoUpdated) setNeo(snapshot.neo ?? { status: 'stopped' });
        setAgents(snapshot.agents);
        if (!codexUpdated) setCodexConnection(snapshot.codexConnection ?? { status: 'idle' });
        if (!browserUpdated) {
          activeBrowserTab.current = snapshot.browser.activeTabId;
          setBrowser(snapshot.browser);
        }
        if (!feishuUpdated) setFeishu(snapshot.feishu);
        // Events can arrive while the initial snapshot is in flight.
        setPendingRequests(
          (beforeSnapshot ?? []).reduce(
            (items, change) => change(items),
            snapshot.pendingRequests ?? [],
          ),
        );
        beforeSnapshot = undefined;
        setConversations(snapshot.conversations);
        setRecordings(snapshot.recordings);
        const scoped = snapshot.conversations.filter(
          (item) =>
            !isArchived(item) &&
            (!item.workspace || item.workspace === snapshot.settings.workspace),
        );
        setConversationId(
          scoped.find((item) => item.id === snapshot.codexConnection?.conversationId)?.id ??
            scoped[0]?.id,
        );
        if (snapshot.onboarding) acceptOnboardingState(snapshot.onboarding);
        const setup = onboardingStateRef.current;
        const firstUse = Boolean(
          setup?.requiresSetup && (setup.status === 'new' || setup.status === 'in-progress'),
        );
        setOnboardingVisible(firstUse);
        setWorkbenchMounted(!firstUse);
        setInitialOnboarding(true);
        setLoaded(true);
      })
      .catch((error) => setStartupError(errorText(error)));
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [showToast, upsert, acceptOnboardingState]);
  useEffect(() => {
    if (
      !loaded ||
      !workbenchMounted ||
      onboardingVisible ||
      !conversationId ||
      archived ||
      !currentAgent?.supported
    )
      return;
    let disposed = false;
    void window.workbench
      .invoke<CodexConnectionState>('conversation:prepare', { conversationId })
      .then((state) => {
        if (!disposed) setCodexConnection(state);
      })
      .catch((error) => {
        if (!disposed)
          setCodexConnection({ status: 'error', conversationId, message: errorText(error) });
      });
    return () => {
      disposed = true;
    };
  }, [
    loaded,
    workbenchMounted,
    onboardingVisible,
    conversationId,
    archived,
    currentAgentId,
    currentAgent?.supported,
    settings.workspace,
    currentSelection?.model,
    currentSelection?.effort,
  ]);
  useEffect(() => {
    // 打开一段未归档的对话时，侧栏回到对话列表。
    if (conversationId && !archived) setShowArchived(false);
  }, [conversationId, archived]);
  useEffect(() => {
    if (!onboardingVisible && !settingsTab && !showUsage && stickToBottom.current)
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'instant' });
  }, [messages, currentBusy, onboardingVisible, settingsTab, showUsage]);

  useEffect(() => {
    if (!browserVisible && browser.inspecting) void action('browser:inspect', { enabled: false });
  }, [browserVisible, browser.inspecting, action]);
  useEffect(() => {
    if (!panels.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setPanelWidth(entry.contentRect.width);
    });
    observer.observe(panels.current);
    return () => observer.disconnect();
  }, [workbenchMounted]);

  // Picking an element keeps the conversation in front; the 元素 tab is opened on purpose.
  useEffect(() => {
    if (browser.selectedElement?.ref) setBrowserVisible(true);
  }, [browser.selectedElement?.ref]);
  useEffect(() => {
    if (browser.elementControls?.revision) {
      setInspectorOpen(true);
      setBrowserVisible(true);
    }
  }, [browser.elementControls?.revision]);
  const requestSource = (element: ElementDetails, changes?: ElementEdit) => {
    setInspectorOpen(false);
    insertMention(
      element,
      changes,
      changes
        ? ['请将 ', ' 的页面预览改动应用到当前项目源码，并验证页面。']
        : ['请在当前项目源码中定位 ', ' ，先说明对应组件和可修改的位置。'],
    );
  };
  const newConversation = useCallback(async () => {
    setShowUsage(false);
    setSettingsTab(null);
    const item = await action<Conversation>('conversation:new');
    if (item) {
      upsert(item);
      setConversationId(item.id);
      setInspectorOpen(false);
      stickToBottom.current = true;
      focusComposer();
    }
  }, [action, upsert]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (!workbenchMounted || onboardingVisible) {
        if (['n', 'l', 't', 'w', 'k', 'b'].includes(event.key.toLowerCase())) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        setShowUsage(false);
        setSettingsTab(null);
        setBrowserVisible(true);
        document.querySelector<HTMLButtonElement>('button[aria-label="新建标签页"]')?.click();
        return;
      }
      if (event.key.toLowerCase() === 'w' && browserVisible && browser.activeTabId) {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>('.browser-tab.is-active .tab-close')?.click();
        return;
      }
      if (
        (event.target as HTMLElement)?.classList.contains('browser-keyboard') &&
        event.key.toLowerCase() !== 'l'
      )
        return;
      if (event.key === 'n') {
        event.preventDefault();
        void newConversation();
      }
      if (event.key === 'b') {
        event.preventDefault();
        setSidebar((value) => !value);
      }
      if (event.key === 'l') {
        event.preventDefault();
        setShowUsage(false);
        setSettingsTab(null);
        setBrowserVisible(true);
        setTimeout(
          () => document.querySelector<HTMLInputElement>('input[aria-label="网页地址"]')?.focus(),
          30,
        );
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [
    newConversation,
    action,
    browserVisible,
    browser.activeTabId,
    workbenchMounted,
    onboardingVisible,
  ]);
  const send = async () => {
    if (
      !draft.trim() ||
      busy ||
      !loaded ||
      setupRequired ||
      !currentAgent?.available ||
      !currentAgent.supported ||
      currentAgent.authentication === 'missing'
    )
      return;
    setInspectorOpen(false);
    // The host resolves each token against the live page and builds the element context.
    const result = await action<{ conversationId: string }>('conversation:send', {
      id: conversationId,
      text: draft.trim(),
      context: mentions.length ? `当前页面：${pageSource(browser.url)}` : undefined,
      mentions: mentions.length
        ? mentions.map(({ token, ref, edit }) => ({ token, ref, ...(edit ? { edit } : {}) }))
        : undefined,
    });
    if (!result?.conversationId) return;
    setDrafts((previous) => {
      const remaining = previous[draftKey];
      if (!remaining || (conversationId && remaining !== draftEntry)) return previous;
      const next = { ...previous };
      delete next[draftKey];
      // While the host assigns the first conversation ID, typing may already have resumed.
      if (remaining !== draftEntry) {
        const assignedKey = JSON.stringify([settings.workspace, result.conversationId]);
        if (next[assignedKey]) return previous;
        next[assignedKey] = remaining;
      }
      return next;
    });
    if (viewedConversation.current.draftKey === draftKey) {
      setConversationId(result.conversationId);
      stickToBottom.current = true;
    }
  };
  const analyze = async (id: string) => {
    const result = await action<{ conversationId: string }>('recording:analyze', { id });
    if (result) {
      setConversationId(result.conversationId);
      stickToBottom.current = true;
    }
  };
  const refreshAgents = async () => {
    setRefreshing(true);
    const result = await action<AgentInfo[]>('agents:refresh');
    if (result) {
      setAgents(result);
      refreshCodexUpdate();
    }
    setRefreshing(false);
  };
  const workspace = async () => {
    const result = await action<Settings>('settings:workspace');
    if (result) {
      if (result.workspace !== settings.workspace) setDraft('');
      setSettings(result);
      await newConversation();
    }
  };
  const setupFeishu = async () => {
    setConnecting(true);
    const result = await action<FeishuState>('feishu:setup');
    if (result) setFeishu(result);
    setConnecting(false);
  };
  const selectBrowser = async () => {
    const result = await action<Settings>('settings:browser');
    if (result) setSettings(result);
  };
  const selectAgent = async (id: string) => {
    if (id === currentAgentId) {
      setAgentMenu(false);
      return;
    }
    const result =
      conversation && !conversation.messages.length && !conversation.agentSessionId
        ? await action<Conversation>('conversation:agent', {
            conversationId: conversation.id,
            agent: id,
          })
        : await action<Conversation>('conversation:new', { agent: id });
    if (result) {
      upsert(result);
      setConversationId(result.id);
      setInspectorOpen(false);
    }
    setAgentMenu(false);
  };
  const selectDefaultAgent = async (id: string) => {
    const result = await action<Settings>('settings:agent', { id });
    if (result) setSettings(result);
  };
  const openOnboarding = async () => {
    if (openingOnboarding) return;
    setOpeningOnboarding(true);
    const next = await action<OnboardingState>('onboarding:open');
    if (next) {
      acceptOnboardingState(next);
      setSearchOpen(false);
      setAgentMenu(false);
      setInitialOnboarding(false);
      setOnboardingVisible(true);
    }
    setOpeningOnboarding(false);
  };
  const exitOnboarding = async (next: OnboardingState) => {
    acceptOnboardingState(next);
    let workspacePath = next.workspace.path;
    try {
      const snapshot = await window.workbench.invoke<AppSnapshot>('app:snapshot');
      workspacePath = snapshot.settings.workspace;
      setSettings(snapshot.settings);
      setAgents(snapshot.agents);
      setBrowser(snapshot.browser);
      setNeo(snapshot.neo ?? { status: 'stopped' });
      lastFrame.current = snapshot.browserFrame ?? lastFrame.current;
      if (snapshot.onboarding) acceptOnboardingState(snapshot.onboarding);
    } catch (error) {
      setSettings((previous) => ({
        ...previous,
        workspace: workspacePath,
        workspaceMode: next.workspace.mode,
      }));
      showToast(errorText(error), true);
    }
    if (workspacePath !== settings.workspace) {
      setConversationId(
        conversations.find(
          (item) => !isArchived(item) && (!item.workspace || item.workspace === workspacePath),
        )?.id,
      );
      setDraft('');
      setInspectorOpen(false);
    }
    setWorkbenchMounted(true);
    if (initialOnboarding) {
      setSettingsTab(null);
      setShowUsage(false);
      setBrowserVisible(next.status === 'complete' && next.browser.status === 'ready');
      if (next.status === 'complete') {
        setOnboardingTransition(true);
        if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches)
          await new Promise((resolve) => setTimeout(resolve, 650));
      }
    }
    setOnboardingVisible(false);
    setOnboardingTransition(false);
  };
  const openSettings = (tab: SettingsTab) => {
    setShowUsage(false);
    setSettingsTab(tab);
  };
  const openUsage = () => {
    setSettingsTab(null);
    setShowUsage(true);
  };
  const selectConversation = (id: string | undefined) => {
    setShowUsage(false);
    setSettingsTab(null);
    setConversationId(id);
    stickToBottom.current = true;
  };
  const rowKey = (item: { id?: string }) => item.id ?? 'unsent-draft';
  /** 这一行离开列表后接手键盘焦点的相邻对话：优先下一行，其次上一行。 */
  const neighborKey = (id: string) => {
    const index = sidebarConversations.findIndex((item) => item.id === id);
    const neighbor = sidebarConversations[index + 1] ?? sidebarConversations[index - 1];
    return neighbor && rowKey(neighbor);
  };
  /** 被操作的那一行消失后焦点会落到页面之外：交给相邻的对话，没有就交给“新对话”。 */
  const focusConversationRow = (key?: string) => {
    if (document.activeElement !== document.body) return;
    const nav = document.querySelector<HTMLElement>('.athena-sidebar');
    const row = key
      ? nav?.querySelector<HTMLElement>(
          `.conversation-row[data-conversation="${CSS.escape(key)}"] .conversation-link`,
        )
      : undefined;
    (
      row ??
      nav?.querySelector<HTMLElement>('.conversation-link') ??
      nav?.querySelector<HTMLElement>('.new-conversation')
    )?.focus();
  };
  /** 归档或恢复一段对话，以宿主保存后的结果为准。 */
  const setArchived = async (item: Conversation, archive: boolean) => {
    const next = neighborKey(item.id);
    const result = await action<Conversation>('conversation:archive', {
      conversationId: item.id,
      archived: archive,
    });
    if (!result) return;
    flushSync(() => {
      upsert(result);
      if (archive) setConversationId((previous) => (previous === item.id ? undefined : previous));
      else {
        setShowArchived(false);
        selectConversation(result.id);
      }
    });
    if (archive) focusConversationRow(next);
    else focusComposer();
    showToast(archive ? '已归档对话' : '已恢复对话');
  };
  /** 确认后才删除 Athena 保存的这段记录；宿主拒绝时这一行原样保留。 */
  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    const { id } = deleteTarget;
    const next = neighborKey(id);
    setDeleting(true);
    const deleted = await action<boolean>('conversation:delete', { conversationId: id });
    flushSync(() => {
      setDeleting(false);
      setDeleteTarget(undefined);
      if (!deleted) return;
      setConversations((previous) => previous.filter((item) => item.id !== id));
      setConversationId((previous) => (previous === id ? undefined : previous));
    });
    if (!deleted) return;
    focusConversationRow(next);
    showToast('已删除对话');
  };
  const showCurrentPage = () => {
    if (!draft.trim()) setDraft('检查当前页面的主要内容和可交互元素。');
    setBrowserVisible(true);
    focusComposer();
  };
  const selectPageElement = () => {
    setBrowserVisible(true);
    void action('browser:inspect', { enabled: true });
  };
  const recordPage = () => {
    setBrowserVisible(true);
    void action('recording:start');
  };
  const openLink = (url: string) => void action('shell:openExternal', { url });

  const settingsWorkspace = settingsTab ? (
    <section className="settings-workspace" aria-label="设置与连接">
      <Tabs
        variant="secondary"
        orientation={panelWidth < 600 ? 'horizontal' : 'vertical'}
        align="start"
        selectedKey={settingsTab || 'agent'}
        onSelectionChange={(key) => setSettingsTab(key as SettingsTab)}
        className="settings-tab-layout"
      >
        <Tabs.List aria-label="设置分类" className="settings-tabs">
          <Tabs.Tab id="agent">
            <Icon icon={TerminalIcon} size={15} />
            本机 Agent
          </Tabs.Tab>
          <Tabs.Tab id="browser">
            <Icon icon={EarthIcon} size={15} />
            浏览器
          </Tabs.Tab>
          <Tabs.Tab id="feishu">
            <Icon icon={Link02Icon} size={15} />
            飞书
          </Tabs.Tab>
        </Tabs.List>
        <div className="settings-body">
          {settingsTab === 'agent' && (
            <Tabs.Panel id="agent">
              <div className="settings-section-heading">
                <div>
                  <h3>使用你已有的 Agent</h3>
                  <p>Athena 使用本机 CLI 的登录与配置。</p>
                </div>
                <ActionButton
                  className="icon-button"
                  aria-label="刷新 Agent 列表"
                  title="刷新"
                  isDisabled={refreshing}
                  onPress={() => void refreshAgents()}
                >
                  <Icon icon={RefreshCwIcon} size={16} className={refreshing ? 'spin' : ''} />
                </ActionButton>
              </div>
              <Card className="agent-connection-card">
                <Card.Content>
                  <div className="agent-connection-heading">
                    <AgentIcon agent={settings.agent} size={24} />
                    <h4>{defaultAgent?.name || settings.agent}</h4>
                    <span className="small-badge">
                      {sessionLabel(defaultAgent, defaultConnection)}
                    </span>
                  </div>
                  <div className="settings-value-row">
                    <span>登录方式</span>
                    <strong>复用本机已有登录</strong>
                  </div>
                  <div className="settings-value-row">
                    <span>任务模型与推理强度</span>
                    <ModelPicker
                      settings={settings}
                      busy={busy}
                      connectionReady={defaultConnection?.status === 'ready'}
                      onChange={setSettings}
                    />
                  </div>
                  {defaultAgent?.version && (
                    <div className="settings-value-row">
                      <span>版本</span>
                      <div className="cli-version-value">
                        <span>
                          {settings.agent === 'codex' && installedVersion
                            ? `codex-cli ${installedVersion}`
                            : defaultAgent.version}
                        </span>
                        {settings.agent === 'codex' && codexUpdate && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onPress={() => openLink(codexUpdate.releaseUrl)}
                          >
                            <span>查看更新说明</span>
                            <Icon icon={ArrowUpRight01Icon} size={13} />
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                  {defaultAgent?.path && (
                    <p className="settings-agent-path" title={defaultAgent.path}>
                      {defaultAgent.path}
                    </p>
                  )}
                  {defaultAgent?.detail && (
                    <p className="settings-agent-detail">{defaultAgent.detail}</p>
                  )}
                  {defaultConnection?.status === 'error' && defaultConnection.message && (
                    <div className="inline-error" role="alert">
                      {defaultConnection.message}
                    </div>
                  )}
                  <p className="settings-card-caption">
                    默认 CLI 用于新对话，已有对话保持原 CLI。登录与服务配置由本机 CLI 管理。
                  </p>
                </Card.Content>
              </Card>
              <h4 className="settings-subheading">选择新对话默认 CLI</h4>
              <div className="agent-settings-list">
                {agents.map((agent) => (
                  <div className="agent-setting-row" key={agent.id}>
                    <div className="integration-icon agent-brand-tile">
                      <AgentIcon agent={agent.id} size={25} />
                    </div>
                    <div>
                      <strong>{agent.name}</strong>
                      <p>{agent.path ? agent.version || '已找到可执行文件' : '未检测到安装'}</p>
                      {agent.path && <small title={agent.path}>{agent.path}</small>}
                      {agent.detail && <p className="agent-detail">{agent.detail}</p>}
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      isDisabled={
                        busy ||
                        !agent.available ||
                        !agent.supported ||
                        agent.authentication === 'missing' ||
                        agent.id === settings.agent
                      }
                      onPress={() => void selectDefaultAgent(agent.id)}
                    >
                      {agent.id === settings.agent ? '默认 CLI' : '设为默认'}
                    </Button>
                    <span
                      className={`small-badge ${agent.available && agent.supported ? 'success' : ''}`}
                    >
                      {agent.available
                        ? agent.supported
                          ? agent.authentication === 'missing'
                            ? '需要登录'
                            : agent.authentication === 'unknown'
                              ? '登录待验证'
                              : '可使用'
                          : '已检测'
                        : agent.path
                          ? '启动异常'
                          : '未安装'}
                    </span>
                  </div>
                ))}
              </div>
              <div className="settings-note">
                使用本机 CLI
                已有的登录与模型服务配置。未安装或需要登录时，请在终端完成后刷新；不会自动改用其他
                CLI。
              </div>
              <Card className="settings-workspace-card">
                <Card.Content>
                  <Icon icon={Folder01Icon} size={20} />
                  <div>
                    <span>项目文件夹（可选）</span>
                    <strong>
                      {settings.workspaceMode === 'personal'
                        ? '未绑定项目文件夹'
                        : settings.workspace || '尚未选择工作目录'}
                    </strong>
                  </div>
                  <ActionButton variant="secondary" onPress={() => void workspace()}>
                    {settings.workspaceMode === 'personal' ? '选择项目文件夹' : '更换工作目录'}
                  </ActionButton>
                </Card.Content>
              </Card>
              <ActionButton
                className="text-button onboarding-reopen"
                isDisabled={openingOnboarding}
                onPress={() => void openOnboarding()}
              >
                {setupRequired ? '继续首次准备' : '重新查看引导'}
              </ActionButton>
            </Tabs.Panel>
          )}
          {settingsTab === 'browser' && (
            <Tabs.Panel id="browser" className="integration-settings-panel">
              <div className="integration-heading">
                <div className="integration-icon large">
                  <Icon icon={EarthIcon} size={24} />
                </div>
                <div>
                  <h3>BrowserOS neo</h3>
                  <p>在当前工作区中浏览、操作和记录网页。</p>
                </div>
                <span className={`small-badge ${browser.status === 'ready' ? 'success' : ''}`}>
                  {browser.status === 'ready'
                    ? '已连接'
                    : browser.status === 'starting'
                      ? '连接中'
                      : '未连接'}
                </span>
              </div>
              <div className="setting-detail">
                <label>应用位置</label>
                <p className="file-path">
                  {browser.binaryPath || settings.browserPath || '尚未选择 BrowserOS neo'}
                </p>
                <ActionButton className="secondary-button" onPress={() => void selectBrowser()}>
                  <Icon icon={FolderOpenIcon} size={14} />
                  选择 BrowserOS neo
                </ActionButton>
              </div>
              {browser.error && <div className="inline-error">{browser.error}</div>}
              <div className="settings-note">
                网页使用独立的浏览器配置，不会导入日常浏览器中的账号。需要访问受保护页面时，可以在侧边浏览器中自行登录。
              </div>
              <ActionButton
                className="text-button"
                onPress={() => openLink('https://browseros.com/')}
              >
                <Icon icon={ArrowUpRight01Icon} size={14} />
                下载 BrowserOS neo
              </ActionButton>
            </Tabs.Panel>
          )}
          {settingsTab === 'feishu' && (
            <Tabs.Panel id="feishu" className="integration-settings-panel">
              <div className="integration-heading">
                <div className="integration-icon large">
                  <Icon icon={Link02Icon} size={24} />
                </div>
                <div>
                  <h3>把任务带到飞书</h3>
                  <p>私聊专用机器人，查看结果或继续当前任务。</p>
                </div>
                <span className={`small-badge ${connected ? 'success' : ''}`}>
                  {connected
                    ? '已配对'
                    : feishu.status === 'connected'
                      ? '等待配对'
                      : feishu.status === 'connecting'
                        ? '连接中'
                        : feishu.status === 'restoring'
                          ? '恢复中'
                          : '未连接'}
                </span>
              </div>
              {feishu.status === 'restoring' ? (
                <div className="feishu-paired">
                  <Icon icon={Loading02Icon} size={26} className="spin" />
                  <h4>正在恢复飞书连接</h4>
                  <p>如果 macOS 显示钥匙串授权提示，请核对应用名称后完成确认。</p>
                </div>
              ) : feishu.status === 'error' && feishu.restoreFailed ? (
                <div className="feishu-paired">
                  <Icon icon={ShieldCheckIcon} size={28} />
                  <h4>暂时无法读取飞书配置</h4>
                  <p>原有配置不会被覆盖。检查系统授权和存储目录后，可以重试恢复。</p>
                  <ActionButton
                    className="primary-button"
                    onPress={() => void action('feishu:restore')}
                  >
                    <Icon icon={RefreshCwIcon} size={14} />
                    重试恢复连接
                  </ActionButton>
                </div>
              ) : feishu.status === 'configuring' || feishu.setupQr ? (
                <div className="feishu-setup">
                  {feishu.setupQr ? (
                    <img src={feishu.setupQr} alt="飞书应用授权二维码" />
                  ) : (
                    <Icon icon={Loading02Icon} size={32} className="spin" />
                  )}
                  <div>
                    <strong>使用飞书扫码</strong>
                    <p>选择已有机器人，并确认接收私聊与回复消息的权限。已有应用配置可能发生变化，请核对授权页后确认。</p>
                    <div className="button-row flex-wrap">
                      {feishu.setupUrl && (
                        <ActionButton
                          className="text-button"
                          onPress={() => openLink(feishu.setupUrl!)}
                        >
                          在浏览器中打开
                          <Icon icon={ArrowUpRight01Icon} size={13} />
                        </ActionButton>
                      )}
                      <ActionButton
                        className="text-button cancel-setup"
                        onPress={() => void action('feishu:disconnect')}
                      >
                        取消授权
                      </ActionButton>
                    </div>
                  </div>
                </div>
              ) : feishu.status === 'connected' ? (
                <div className="feishu-paired">
                  <div className="connected-check">
                    <Icon icon={Tick02Icon} size={21} />
                  </div>
                  <h4>{feishu.paired ? '飞书已准备好' : '连接已建立，再完成一次配对'}</h4>
                  {feishu.paired ? (
                    <p>
                      可在私聊中发起任务。桌面和飞书任务结束、失败或需要你回答、审核时，
                      机器人会通知你。请保持 Mac 在线；回答与审批在 Athena 中完成。
                    </p>
                  ) : (
                    <>
                      <p>向已连接的机器人私聊发送下面这条消息：</p>
                      <ActionButton
                        className="pairing-code"
                        onPress={async () => {
                          const copied = await action<boolean>('app:copy', {
                            text: `绑定 ${feishu.pairingCode}`,
                          });
                          if (copied) showToast('已复制配对消息');
                        }}
                      >
                        <code>绑定 {feishu.pairingCode}</code>
                        <Icon icon={CopyIcon} size={15} />
                      </ActionButton>
                      <small>配对后，仅接受你的任务指令。</small>
                      {feishu.appId && (
                        <ActionButton
                          className="text-button"
                          onPress={() =>
                            openLink(
                              `https://applink.feishu.cn/client/bot/open?appId=${encodeURIComponent(feishu.appId!)}`,
                            )
                          }
                        >
                          打开飞书机器人
                          <Icon icon={ArrowUpRight01Icon} size={13} />
                        </ActionButton>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <div className="feishu-intro">
                  <div className="connection-path">
                    <Icon icon={MessageSquareIcon} size={20} />
                    <span />
                    <Icon icon={CommandIcon} size={20} />
                  </div>
                  <p>
                    {feishu.appId
                      ? '连接已保存的机器人，继续从飞书发起任务。'
                      : '授权并选择已有机器人，从飞书发起网页任务。'}
                  </p>
                  <ActionButton
                    className="primary-button"
                    isDisabled={connecting || feishu.status === 'connecting'}
                    onPress={() => void (feishu.appId ? action('feishu:connect') : setupFeishu())}
                  >
                    {connecting ? (
                      <Icon icon={Loading02Icon} size={15} className="spin" />
                    ) : feishu.appId ? (
                      <Icon icon={Link02Icon} size={15} />
                    ) : (
                      <Icon icon={PlusIcon} size={15} />
                    )}
                    {feishu.appId ? '连接已保存的机器人' : '授权并选择机器人'}
                  </ActionButton>
                  {feishu.appId && (
                    <ActionButton className="text-button" onPress={() => void setupFeishu()}>
                      授权其他机器人
                    </ActionButton>
                  )}
                </div>
              )}
              {feishu.error && <div className="inline-error">{feishu.error}</div>}
              {feishu.appId && (
                <div className="connection-details">
                  <span>{feishu.botName || '应用 ID'}</span>
                  <code>{feishu.appId}</code>
                  {feishu.status === 'connected' && (
                    <ActionButton
                      className="text-button"
                      onPress={() => void action('feishu:disconnect')}
                    >
                      <Icon icon={UnplugIcon} size={13} />
                      断开连接
                    </ActionButton>
                  )}
                </div>
              )}
              {feishu.status !== 'connected' &&
                feishu.status !== 'restoring' &&
                !feishu.restoreFailed &&
                !feishu.hasSavedCredentials && (
                  <details className="manual-connection">
                    <summary>
                      使用已有应用凭据
                      <Icon icon={ArrowDown01Icon} size={14} />
                    </summary>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void action<FeishuState>('feishu:configure', {
                          appId: manualAppId.trim(),
                          appSecret: manualSecret.trim(),
                        }).then((result) => {
                          if (result) {
                            setFeishu(result);
                            setManualSecret('');
                            void action('feishu:connect');
                          }
                        });
                      }}
                    >
                      <label>
                        App ID
                        <Input
                          value={manualAppId}
                          onChange={(event) => setManualAppId(event.target.value)}
                          autoComplete="off"
                          placeholder="cli_…"
                          required
                        />
                      </label>
                      <label>
                        App Secret
                        <Input
                          type="password"
                          value={manualSecret}
                          onChange={(event) => setManualSecret(event.target.value)}
                          autoComplete="new-password"
                          required
                        />
                      </label>
                      <ActionButton className="secondary-button" type="submit">
                        保存并连接
                      </ActionButton>
                    </form>
                  </details>
                )}
            </Tabs.Panel>
          )}
        </div>
      </Tabs>
    </section>
  ) : null;

  if (!loaded)
    return (
      <div className="onboarding-loading">
        {startupError ? (
          <div role="alert">
            <p>{startupError}</p>
            <Button variant="secondary" onPress={() => window.location.reload()}>
              重新打开工作区
            </Button>
          </div>
        ) : (
          <span role="status">正在打开工作区…</span>
        )}
      </div>
    );

  return (
    <>
      {workbenchMounted && (
        <div
          className="app-workbench"
          hidden={onboardingVisible && !onboardingTransition}
          data-onboarding-enter={onboardingTransition}
          inert={onboardingVisible}
          aria-hidden={onboardingVisible || undefined}
        >
          <Sidebar.Provider
            open={sidebar}
            onOpenChange={setSidebar}
            collapsible="offcanvas"
            toggleShortcut={false}
            className={`app-shell ${sidebar ? '' : 'sidebar-collapsed'} ${browserVisible ? '' : 'browser-collapsed'}`}
          >
            <Sidebar
              className="athena-sidebar"
              aria-label="主导航"
              aria-hidden={!sidebar}
              inert={!sidebar}
            >
              <div className="window-drag sidebar-top">
                <ActionButton
                  className="icon-button"
                  title="收起侧栏 · ⌘ B"
                  aria-label="收起侧栏"
                  onPress={() => setSidebar(false)}
                >
                  <Icon icon={PanelLeftCloseIcon} size={17} />
                </ActionButton>
              </div>
              <Sidebar.Header className="brand">
                <img className="brand-mark" src={athenaLogo} alt="" />
                <span>Athena</span>
              </Sidebar.Header>
              <ActionButton
                className="new-conversation"
                variant="secondary"
                onPress={() => void newConversation()}
              >
                {({ isHovered }) => (
                  <>
                    <TurnIcon kind="plus" size={17} hovered={isHovered} />
                    <span>新对话</span>
                    <kbd>⌘ N</kbd>
                  </>
                )}
              </ActionButton>
              <ActionButton className="search-conversation" onPress={() => setSearchOpen(true)}>
                <Icon icon={Search01Icon} size={17} />
                <span>搜索对话</span>
                <kbd>⌘ K</kbd>
              </ActionButton>
              <ActionButton
                className="workspace-selector"
                onPress={() => void workspace()}
                title={
                  settings.workspaceMode === 'personal' ? '选择项目文件夹' : settings.workspace
                }
              >
                <Icon icon={Folder01Icon} size={16} />
                <span>{workspaceLabel}</span>
                <Icon icon={ArrowDown01Icon} size={13} />
              </ActionButton>
              <div className="sidebar-section-row">
                <div className="sidebar-section-label">{showArchived ? '已归档' : '对话'}</div>
                {archivedConversations.length > 0 && (
                  <ActionButton
                    className="archived-toggle"
                    onPress={() => setShowArchived((value) => !value)}
                  >
                    <Icon icon={showArchived ? ArrowLeft01Icon : Archive01Icon} size={14} />
                    <span>{showArchived ? '返回对话列表' : '已归档'}</span>
                  </ActionButton>
                )}
              </div>
              <Sidebar.Content
                className="conversation-list"
                aria-label={showArchived ? '已归档的对话' : '对话列表'}
              >
                {sidebarConversations.length ? (
                  sidebarConversations.map((item) => {
                    const current = item.id === conversationId && !showUsage && !settingsTab;
                    const running = item.messages.some((message) => message.status === 'streaming');
                    const echo = conversationEcho(item);
                    return (
                      <div
                        key={rowKey(item)}
                        className={`conversation-row ${current ? 'is-current' : ''}`}
                        data-conversation={rowKey(item)}
                      >
                        <ActionButton
                          className={`conversation-link ${current ? 'active' : ''}`}
                          aria-current={current ? 'page' : undefined}
                          onPress={() => selectConversation(item.id)}
                          title={item.title}
                        >
                          {echo && <PhaseGlyph kind={echo.glyph} still={echo.still} />}
                          <span>{item.title}</span>
                          {echo && <em>{echo.label}</em>}
                        </ActionButton>
                        {item.id && (
                          <ConversationMenu
                            title={item.title}
                            archived={isArchived(item)}
                            running={running}
                            onArchive={() => void setArchived(item, !isArchived(item))}
                            onDelete={() => setDeleteTarget(item)}
                          />
                        )}
                      </div>
                    );
                  })
                ) : (
                  <p className="sidebar-empty">新的对话会保存在这里</p>
                )}
              </Sidebar.Content>
              <Sidebar.Footer className="sidebar-bottom">
                <ActionButton
                  className={`sidebar-usage ${showUsage ? 'active' : ''}`}
                  aria-current={showUsage ? 'page' : undefined}
                  onPress={openUsage}
                >
                  <Icon icon={ChartNoAxesCombinedIcon} size={16} />
                  <span>用量</span>
                </ActionButton>
                <ActionButton
                  className={`sidebar-settings ${settingsTab ? 'active' : ''}`}
                  onPress={() => openSettings('agent')}
                >
                  <Icon icon={Settings02Icon} size={16} />
                  <span>设置与连接</span>
                </ActionButton>
                <UserMenu
                  name={localUserName}
                  appearance={appearance}
                  onAppearanceChange={setAppearance}
                  onSettings={() => openSettings('agent')}
                  onUsage={openUsage}
                  onWorkspace={() => void workspace()}
                />
              </Sidebar.Footer>
            </Sidebar>
            <main
              ref={panels}
              className={`workspace-panels ${resizingBrowser ? 'is-resizing' : ''}`}
              style={{ '--browser-drawer-width': `${drawerWidth}px` } as React.CSSProperties}
            >
              <div className="work-area">
                <header className="topbar window-drag">
                  <div className={`topbar-title ${sidebar ? '' : 'with-traffic-lights'}`}>
                    {!sidebar && (
                      <ActionButton
                        className="icon-button"
                        aria-label="展开侧栏"
                        onPress={() => setSidebar(true)}
                      >
                        <Icon icon={PanelLeftOpenIcon} size={17} />
                      </ActionButton>
                    )}
                    <span>
                      {settingsTab
                        ? '设置与连接'
                        : showUsage
                          ? '用量'
                          : conversation?.title || '新对话'}
                    </span>
                  </div>
                  <div className="topbar-actions">
                    {settingsTab ? (
                      <ActionButton className="text-button" onPress={() => setSettingsTab(null)}>
                        返回对话
                      </ActionButton>
                    ) : (
                      <>
                        {!isHome && (
                          <ActionButton
                            className="connection-button local-agent-status"
                            onPress={() => openSettings('agent')}
                            title={
                              currentConnection?.status === 'error'
                                ? currentConnection.message
                                : undefined
                            }
                          >
                            <AgentIcon agent={currentAgentId} size={15} />
                            {currentConnection?.status === 'starting' ? (
                              <Icon icon={Loading02Icon} size={12} className="spin" />
                            ) : (
                              <span
                                className={`status-dot ${agentStatus === '已就绪' ? 'online' : ''}`}
                              />
                            )}
                            <span>{currentAgent?.name || '本机 Agent'}</span>
                            <span className="agent-status-caption">{agentStatus}</span>
                          </ActionButton>
                        )}
                        <ActionButton
                          variant="secondary"
                          className={`browser-toggle ${browserVisible ? 'is-on' : ''}`}
                          aria-label={browserVisible ? '收起浏览器' : '展开浏览器'}
                          onPress={() => {
                            setShowUsage(false);
                            setBrowserVisible((value) => !value);
                            if (browserVisible) focusComposer();
                          }}
                        >
                          <Icon icon={PanelRightOpenIcon} size={16} />
                          <span>{browserVisible ? '收起浏览器' : '打开浏览器'}</span>
                        </ActionButton>
                      </>
                    )}
                  </div>
                </header>
                <WorkbenchNotices update={codexUpdate} onShowRelease={openLink} />
                {settingsWorkspace}
                {showUsage && !settingsTab && <UsagePanel />}
                <div className="conversation-column" hidden={showUsage || Boolean(settingsTab)}>
                  <Tabs
                    variant="primary"
                    selectedKey={editingElement ? 'element' : 'conversation'}
                    onSelectionChange={(key) => {
                      setInspectorOpen(key === 'element');
                      if (key === 'element') setBrowserVisible(true);
                    }}
                    className={`chat-panel ${editingElement ? 'is-editing' : ''} ${isHome ? 'is-home' : ''}`}
                    aria-label="AI 工作区"
                  >
                    <Tabs.ListContainer className="workspace-view-tabs">
                      <Tabs.List aria-label="工作区视图">
                        <Tabs.Tab id="conversation">
                          <Icon icon={MessageSquareIcon} size={14} />
                          对话
                          <Tabs.Indicator />
                        </Tabs.Tab>
                        <Tabs.Tab id="element" isDisabled={browser.status !== 'ready'}>
                          <Icon icon={Settings02Icon} size={14} />
                          元素
                          <Tabs.Indicator />
                        </Tabs.Tab>
                      </Tabs.List>
                    </Tabs.ListContainer>
                    <Tabs.Panel
                      id="conversation"
                      shouldForceMount
                      hidden={editingElement}
                      className="chat-scroll"
                      ref={scroll}
                      onScroll={() => {
                        const node = scroll.current;
                        if (node)
                          stickToBottom.current =
                            node.scrollHeight - node.scrollTop - node.clientHeight < 120;
                      }}
                    >
                      {!messages.length ? (
                        <div className="welcome">
                          <img className="welcome-symbol" src={athenaLogo} alt="Athena" />
                          <h1>今天想完成什么？</h1>
                          <p>打开网页、调整界面，或把任务交给 Athena。</p>
                        </div>
                      ) : (
                        <div className="messages">
                          {messages.map((message) => (
                            <article
                              key={message.id}
                              className={`message ${message.role} ${message.status === 'error' ? 'message-error' : ''}`}
                            >
                              {message.role === 'user' ? (
                                <ProChatMessage.User>
                                  <ProChatMessage.Bubble className="user-message-text">
                                    <MentionText text={message.text} mentions={message.mentions} />
                                  </ProChatMessage.Bubble>
                                  {message.source === 'feishu' && (
                                    <div className="message-source">
                                      <Icon icon={Link02Icon} size={11} />
                                      来自飞书
                                    </div>
                                  )}
                                  {message.context && message.source !== 'feishu' && (
                                    <div className="message-context">
                                      <Icon icon={Cursor01Icon} size={11} />
                                      已附加页面上下文
                                    </div>
                                  )}
                                  {message.text && (
                                    <ChatMessageActions>
                                      <Tooltip delay={500}>
                                        <ChatMessageActions.Copy
                                          aria-label="复制消息"
                                          isCopied={toast?.copiedMessageId === message.id}
                                          onPress={() => copyMessage(message)}
                                        />
                                        <Tooltip.Content>复制消息</Tooltip.Content>
                                      </Tooltip>
                                    </ChatMessageActions>
                                  )}
                                </ProChatMessage.User>
                              ) : (
                                <ProChatMessage.Assistant>
                                  <ProChatMessage.Body>
                                    <div className="assistant-label">
                                      <ProChatMessage.Avatar src={athenaLogo} alt="" />
                                      <span>Athena</span>
                                    </div>
                                    <AssistantTurn
                                      message={message}
                                      conversationId={conversationId!}
                                      agent={currentAgentId}
                                      requests={conversationRequests.filter(
                                        (pending) => pending.messageId === message.id,
                                      )}
                                      last={message === messages.at(-1)}
                                      readOnly={archived}
                                      busy={busy}
                                      onAction={action}
                                      onShowBrowser={() => setBrowserVisible(true)}
                                      actions={
                                        message.status !== 'streaming' &&
                                        (copyableText(message, message === messages.at(-1)) ||
                                          message.neoSessionId) && (
                                          <ChatMessageActions>
                                            {copyableText(message, message === messages.at(-1)) && (
                                              <Tooltip delay={500}>
                                                <ChatMessageActions.Copy
                                                  aria-label="复制回答"
                                                  isCopied={toast?.copiedMessageId === message.id}
                                                  onPress={() => copyMessage(message)}
                                                />
                                                <Tooltip.Content>复制回答</Tooltip.Content>
                                              </Tooltip>
                                            )}
                                            {message.neoSessionId && (
                                              <ProChatMessage.Action
                                                isIconOnly={false}
                                                onPress={() => {
                                                  setNativeRecordId(message.neoSessionId);
                                                  setBrowserVisible(true);
                                                }}
                                              >
                                                查看网页执行过程
                                              </ProChatMessage.Action>
                                            )}
                                          </ChatMessageActions>
                                        )
                                      }
                                    >
                                      {replyText(message) && (
                                        <ProChatMessage.Content className="markdown">
                                          <Markdown
                                            remarkPlugins={[remarkGfm]}
                                            components={{
                                              img: () => null,
                                              a: ({ href, children }) => (
                                                <a
                                                  href={href}
                                                  onClick={(event) => {
                                                    event.preventDefault();
                                                    if (href) openLink(href);
                                                  }}
                                                >
                                                  {children}
                                                </a>
                                              ),
                                            }}
                                          >
                                            {replyText(message)}
                                          </Markdown>
                                        </ProChatMessage.Content>
                                      )}
                                    </AssistantTurn>
                                  </ProChatMessage.Body>
                                </ProChatMessage.Assistant>
                              )}
                            </article>
                          ))}
                        </div>
                      )}
                    </Tabs.Panel>
                    <Tabs.Panel
                      id="element"
                      shouldForceMount
                      className="element-workspace"
                      hidden={!editingElement}
                    >
                      <ElementInspector
                        hidden={!editingElement}
                        selected={browser.selectedElement}
                        tabId={browser.activeTabId}
                        previews={browser.previewEdits ?? []}
                        controlSurface={browser.elementControls}
                        onAction={action}
                        onClose={() => {
                          setInspectorOpen(false);
                          focusComposer();
                        }}
                        onSourceRequest={requestSource}
                      />
                    </Tabs.Panel>
                    <div className="composer-area">
                      {archived && conversation && (
                        <div className="archived-notice">
                          <Icon icon={Archive01Icon} size={16} />
                          <span>这段对话已归档，恢复后可以继续。</span>
                          <ActionButton
                            variant="secondary"
                            onPress={() => void setArchived(conversation, false)}
                          >
                            恢复对话
                          </ActionButton>
                        </div>
                      )}
                      <PromptInput
                        ref={composer}
                        hidden={archived}
                        className={`composer ${busy ? 'is-busy' : ''}`}
                        status={busy ? 'streaming' : 'ready'}
                        lockInputOnRun={false}
                        maxHeight={160}
                        onSubmit={() => void send()}
                        onStop={() => void action('conversation:stop')}
                      >
                        <PromptInput.Shell>
                          <PromptInput.Content>
                            <PromptInput.TokenInput
                              tokens={tokens}
                              aria-label="发送给 Agent 的任务"
                              placeholder={
                                mentions.length
                                  ? '想对这些元素做什么？'
                                  : '描述任务，或在页面中选取元素…'
                              }
                            >
                              {(segment) => (
                                <PromptInput.Token className="element-token">
                                  <span
                                    className="element-token-body"
                                    title={
                                      segment.value
                                        ? `${segment.value.tag}${segment.value.role ? ` · ${segment.value.role}` : ''}`
                                        : undefined
                                    }
                                  >
                                    <Icon icon={Cursor01Icon} size={11} aria-hidden />
                                    <span>{segment.value?.name ?? segment.text}</span>
                                    <small>{segment.text.slice(1, -1)}</small>
                                  </span>
                                </PromptInput.Token>
                              )}
                            </PromptInput.TokenInput>
                          </PromptInput.Content>
                          <PromptInput.Toolbar className="composer-controls">
                            <PromptInput.ToolbarStart>
                              <WebContextMenu
                                ready={
                                  browser.status === 'ready' && supportsBrowser(currentAgentId)
                                }
                                recording={browser.recording}
                                onPage={showCurrentPage}
                                onSelect={selectPageElement}
                                onRecord={recordPage}
                              />
                              <Dropdown isOpen={agentMenu} onOpenChange={setAgentMenu}>
                                <ActionButton
                                  className="agent-picker"
                                  variant="ghost"
                                  size="md"
                                  aria-label="选择 Agent"
                                  aria-describedby="composer-agent-name"
                                  title={currentAgent?.name || currentAgentId}
                                >
                                  <AgentIcon agent={currentAgentId} size={18} />
                                  <span id="composer-agent-name" className="sr-only">
                                    {currentAgent?.name || currentAgentId}
                                  </span>
                                  <Icon
                                    icon={ArrowDown01Icon}
                                    className="picker-chevron"
                                    aria-hidden
                                    size={12}
                                  />
                                </ActionButton>
                                <Dropdown.Popover placement="top start" className="agent-menu">
                                  <Dropdown.Menu
                                    aria-label="本机 Agent"
                                    onAction={(key) => {
                                      if (key === 'manage') {
                                        setAgentMenu(false);
                                        openSettings('agent');
                                      } else void selectAgent(key as Settings['agent']);
                                    }}
                                  >
                                    <Dropdown.Section>
                                      {agents.map((agent) => (
                                        <Dropdown.Item
                                          key={agent.id}
                                          id={agent.id}
                                          textValue={agent.name}
                                          isDisabled={!agent.available || !agent.supported || busy}
                                        >
                                          <AgentIcon agent={agent.id} size={22} />
                                          <div className="agent-option-copy">
                                            <Label>{agent.name}</Label>
                                            <Description>
                                              {agent.available
                                                ? agent.supported
                                                  ? agent.version || '已安装'
                                                  : '已检测，暂未接入'
                                                : '未检测到'}
                                            </Description>
                                          </div>
                                          {agent.id === currentAgentId && (
                                            <Icon
                                              icon={Tick02Icon}
                                              size={14}
                                              className="agent-selected"
                                            />
                                          )}
                                        </Dropdown.Item>
                                      ))}
                                    </Dropdown.Section>
                                    <Dropdown.Item id="manage" textValue="管理本机 Agent">
                                      <Icon icon={Settings02Icon} size={15} />
                                      <Label>管理本机 Agent</Label>
                                    </Dropdown.Item>
                                  </Dropdown.Menu>
                                </Dropdown.Popover>
                              </Dropdown>
                              <ModelPicker
                                settings={conversationSettings}
                                conversationId={conversationId}
                                busy={busy}
                                connectionReady={currentConnection?.status === 'ready'}
                                onChange={setSettings}
                              />
                            </PromptInput.ToolbarStart>
                            <PromptInput.ToolbarEnd className="composer-right">
                              {currentPhase?.kind === 'waiting' ? (
                                <span className="composer-hint is-waiting">
                                  <PhaseGlyph kind="wait" still />
                                  Athena 在等你处理上面的请求
                                </span>
                              ) : (
                                <span className="composer-hint">
                                  {busy && !currentBusy ? '另一任务进行中' : '↵ 发送'}
                                </span>
                              )}
                              <PromptInput.Send
                                aria-label={busy ? '停止任务' : '发送任务'}
                                isDisabled={
                                  !busy &&
                                  (!loaded ||
                                    setupRequired ||
                                    !draft.trim() ||
                                    !currentAgent?.available ||
                                    !currentAgent.supported ||
                                    currentAgent.authentication === 'missing')
                                }
                              />
                            </PromptInput.ToolbarEnd>
                          </PromptInput.Toolbar>
                        </PromptInput.Shell>
                      </PromptInput>
                      {archived ? null : !loaded ? (
                        <p className="composer-availability" role="status">
                          <Icon icon={Loading02Icon} size={14} className="spin" />
                          正在读取本机配置…
                        </p>
                      ) : setupRequired ? (
                        <div className="composer-availability" role="status">
                          <span>准备好连接和工作目录，就可以开始任务。</span>
                          <ActionButton
                            className="text-button"
                            isDisabled={openingOnboarding}
                            onPress={() => void openOnboarding()}
                          >
                            继续准备
                          </ActionButton>
                        </div>
                      ) : (
                        (!currentAgent?.available || currentAgent.authentication === 'missing') && (
                          <div className="composer-availability" role="status">
                            <span>
                              {currentAgent?.authentication === 'missing'
                                ? `请先在终端登录 ${currentAgent.name}，再刷新连接。`
                                : '当前 Agent 尚不可用。'}
                            </span>
                            <ActionButton
                              className="text-button"
                              onPress={() => openSettings('agent')}
                            >
                              管理 Agent
                            </ActionButton>
                          </div>
                        )
                      )}
                      {!archived &&
                        loaded &&
                        currentAgent?.available &&
                        currentAgent.authentication !== 'missing' &&
                        currentConnection?.status === 'error' && (
                          <div className="composer-availability" role="alert">
                            <span>
                              {currentConnection.message ||
                                '本机 Agent 连接失败，请检查连接后重试。'}
                            </span>
                            <ActionButton
                              className="text-button"
                              onPress={() => openSettings('agent')}
                            >
                              检查连接
                            </ActionButton>
                          </div>
                        )}
                      {isHome && !archived && (
                        <PromptSuggestion className="mt-7">
                          <PromptSuggestion.Items className="welcome-suggestions">
                            <PromptSuggestion.Item onPress={showCurrentPage}>
                              <span>
                                查看当前页面
                                <PromptSuggestion.ItemMeta className="block">
                                  理解页面内容与结构
                                </PromptSuggestion.ItemMeta>
                              </span>
                            </PromptSuggestion.Item>
                            <PromptSuggestion.Item
                              isDisabled={browser.status !== 'ready'}
                              onPress={selectPageElement}
                            >
                              <span>
                                选取并修改元素
                                <PromptSuggestion.ItemMeta className="block">
                                  在网页中直接预览调整
                                </PromptSuggestion.ItemMeta>
                              </span>
                            </PromptSuggestion.Item>
                            <PromptSuggestion.Item
                              isDisabled={browser.status !== 'ready' || browser.recording}
                              onPress={recordPage}
                            >
                              <span>
                                录制一段操作
                                <PromptSuggestion.ItemMeta className="block">
                                  保存步骤，交给 Agent 分析
                                </PromptSuggestion.ItemMeta>
                              </span>
                            </PromptSuggestion.Item>
                          </PromptSuggestion.Items>
                        </PromptSuggestion>
                      )}
                    </div>
                    <div className="composer-footer">
                      <Icon icon={Folder01Icon} size={14} />
                      <ActionButton
                        onPress={() => void workspace()}
                        title={
                          settings.workspaceMode === 'personal'
                            ? '选择项目文件夹'
                            : settings.workspace
                        }
                      >
                        {workspaceLabel}
                      </ActionButton>
                      <span>· 本机工作区</span>
                      {browser.recording && (
                        <span className="composer-recording">
                          <span className="record-dot" />
                          录制中
                        </span>
                      )}
                    </div>
                  </Tabs>
                </div>
              </div>
              <aside
                hidden={showUsage || Boolean(settingsTab)}
                className={`browser-drawer t-resize ${browserVisible ? 'is-open' : ''}`}
                aria-label="浏览器侧栏"
                aria-hidden={!browserVisible}
                inert={!browserVisible}
              >
                <div
                  className="browser-resizer"
                  role="separator"
                  aria-label="调整浏览器宽度"
                  aria-orientation="vertical"
                  aria-valuemin={minDrawerWidth}
                  aria-valuemax={maxDrawerWidth}
                  aria-valuenow={drawerWidth}
                  tabIndex={browserVisible ? 0 : -1}
                  onPointerDown={(event) => {
                    resizeStart.current = { x: event.clientX, width: drawerWidth };
                    setResizingBrowser(true);
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    if (resizeStart.current)
                      setBrowserWidth(
                        clampDrawerWidth(
                          resizeStart.current.width + resizeStart.current.x - event.clientX,
                        ),
                      );
                  }}
                  onPointerUp={(event) => {
                    resizeStart.current = undefined;
                    setResizingBrowser(false);
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }}
                  onPointerCancel={() => {
                    resizeStart.current = undefined;
                    setResizingBrowser(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                      event.preventDefault();
                      setBrowserWidth(
                        clampDrawerWidth(drawerWidth + (event.key === 'ArrowLeft' ? 30 : -30)),
                      );
                    }
                  }}
                />
                <BrowserPane
                  state={browser}
                  neo={neo}
                  nativeRecordId={nativeRecordId}
                  recordings={recordings}
                  liveSteps={liveSteps}
                  initialFrame={lastFrame.current}
                  agentStatus={
                    runningPhase && {
                      text: phaseText(runningPhase.phase, runningPhase.agent),
                      glyph: phaseGlyph(runningPhase.phase, runningPhase.agent),
                    }
                  }
                  onAction={action}
                  onOpenSettings={() => openSettings('browser')}
                  onAnalyze={(id) => void analyze(id)}
                  onClose={() => {
                    setBrowserVisible(false);
                    focusComposer();
                  }}
                  inspectorOpen={editingElement}
                  onToggleInspector={() => setInspectorOpen((value) => !value)}
                />
              </aside>
            </main>
            <ConversationSearch
              open={searchOpen}
              loaded={loaded}
              workspace={settings.workspace}
              conversations={conversations}
              onOpenChange={setSearchOpen}
              onSelect={selectConversation}
              onNew={() => void newConversation()}
            />
            {deleteTarget && (
              <DeleteConversationDialog
                title={deleteTarget.title}
                pending={deleting}
                onCancel={() => setDeleteTarget(undefined)}
                onConfirm={() => void confirmDelete()}
              />
            )}
            {toast && (
              <div
                className={`app-toast ${toast.error ? 'error' : ''}`}
                role={toast.error ? 'alert' : 'status'}
              >
                {toast.error ? (
                  <Icon icon={CircleIcon} size={14} />
                ) : (
                  <Icon icon={Tick02Icon} size={14} />
                )}
                <span>{toast.text}</span>
                <ActionButton aria-label="关闭提示" onPress={() => setToast(undefined)}>
                  <Icon icon={XIcon} size={13} />
                </ActionButton>
              </div>
            )}
          </Sidebar.Provider>
        </div>
      )}
      {onboardingVisible && onboardingState && (
        <Onboarding
          state={onboardingState}
          initial={initialOnboarding}
          hasDraft={Boolean(draft.trim())}
          onState={acceptOnboardingState}
          onExit={exitOnboarding}
        />
      )}
    </>
  );
}
