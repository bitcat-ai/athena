import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { BrowserRuntime, normalizeBrowserUrl } from './browser';
import { AgentBrowserServer, type AgentBrowserDownload } from './agent-browser-server';
import type { AgentBrowserSession } from './agent-browser-session';
import type { WebFile, WebPage, WebToolResult } from './agent-browser-tools';
import { WebExecution, checkpointTool, planTool } from './web-execution';
import type {
  ApprovalRequest,
  BrowserTool,
  WebExecutorState,
  ToolResult,
  WebExecutionEvent,
} from '../shared/types';

const nativeNames = new Set([
  'tabs',
  'tab_groups',
  'navigate',
  'snapshot',
  'diff',
  'act',
  'download',
  'upload',
  'read',
  'grep',
  'screenshot',
  'pdf',
  'wait',
  'evaluate_in_page',
  'run',
  'request_human_help',
  'await_human_help',
]);
const readonlyNames = new Set([
  'snapshot',
  'diff',
  'read',
  'grep',
  'screenshot',
  'pdf',
  'wait',
  'await_human_help',
]);
const editorNames = new Set([
  'workbench_browser_query',
  'workbench_browser_inspect',
  'workbench_browser_controls',
  'workbench_browser_edit',
  'workbench_browser_undo',
]);
interface Task {
  id: string;
  client: AgentBrowserSession;
  readonly: boolean;
  stopped: boolean;
  help: boolean;
  execution: WebExecution;
  calls: Promise<void>;
  pendingCalls: number;
  interactionRevision: number;
  needsObservation: boolean;
  running?: { signature: string; page?: number; mutating: boolean };
  reconnectClient?: Promise<void>;
}
const plain = (result: WebToolResult) =>
  result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text || '')
    .join('\n\n');
const safeError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [hidden]')
    .replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '[hidden]')
    .slice(0, 1500);

/** Application scope and task lifecycle around the web executor's tools. */
export class WebRuntime {
  readonly server: AgentBrowserServer;
  private current?: Task;
  private starting?: Promise<void>;
  private endpoint = '';
  constructor(
    private browser: BrowserRuntime,
    private options: {
      directory: string;
      download?: AgentBrowserDownload;
      onState: (state: WebExecutorState) => void;
      onDisconnect: () => void;
      approve: (request: Omit<ApprovalRequest, 'id' | 'kind'>) => Promise<boolean>;
      onExecution?: (event: WebExecutionEvent) => void;
      onSession?: (taskId: string, sessionId: string) => void;
    },
  ) {
    this.server = new AgentBrowserServer(browser, {
      directory: options.directory,
      download: options.download,
      onState: options.onState,
      onDisconnect: () => {
        if (this.current) this.current.stopped = true;
        options.onDisconnect();
      },
    });
  }
  getState() {
    return this.server.getState();
  }
  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (
      this.browser.getState().status === 'ready' &&
      this.getState().status === 'ready' &&
      this.browser.getNativeConnection().endpoint === this.endpoint
    )
      return Promise.resolve();
    this.starting = (async () => {
      await this.browser.start();
      const connection = this.browser.getNativeConnection();
      if (this.endpoint && this.endpoint !== connection.endpoint) await this.server.stop();
      this.endpoint = connection.endpoint;
      await this.server.start(connection.endpoint);
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  getTools(): BrowserTool[] {
    const tools: BrowserTool[] = [
      {
        name: 'web_status',
        description: '查看网页执行器的连接状态。未连接时不能声称网页操作成功。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ];
    if (this.getState().status === 'ready') {
      tools.push(planTool, checkpointTool);
      for (const tool of this.server.tools) {
        if (!nativeNames.has(tool.name)) continue;
        let prefix = '';
        if (tool.name === 'run' || tool.name === 'evaluate_in_page')
          prefix =
            '高级脚本需要用户在 Athena 确认；普通网页操作优先用 web_act（整表 fields 批量填写）、web_read 和 web_wait。\n';
        if (tool.name === 'upload') prefix = '上传本机文件前需要用户在 Athena 确认。\n';
        tools.push({
          name: `web_${tool.name}`,
          description: prefix + tool.description,
          inputSchema: structuredClone(tool.inputSchema),
        });
      }
      tools.push({
        name: 'web_focus_page',
        description: '把指定页面显示到 Athena 当前浏览器面板；page 来自 web_tabs。',
        inputSchema: {
          type: 'object',
          properties: { page: { type: 'integer', minimum: 1 } },
          required: ['page'],
          additionalProperties: false,
        },
      });
    }
    return [...tools, ...this.browser.getTools().filter((tool) => editorNames.has(tool.name))];
  }
  isReadOnly(name: string, args: Record<string, unknown>): boolean {
    if (['workbench_browser_query', 'workbench_browser_inspect'].includes(name)) return true;
    if (['web_status', 'web_plan', 'web_checkpoint'].includes(name)) return true;
    const native = name.slice(4);
    return (
      name.startsWith('web_') &&
      (readonlyNames.has(native) ||
        (native === 'tabs' && ['list', 'active'].includes(String(args.action))))
    );
  }
  private check(task: Task) {
    if (this.current !== task || task.stopped) throw new Error('网页任务已停止，不能继续操作');
  }
  async beginTask(id: string, readonly = false): Promise<{ sessionId: string; context: string }> {
    if (this.current) throw new Error('上一个网页任务尚未结束');
    const client = await this.server.newSession();
    const task: Task = {
      id,
      client,
      readonly,
      stopped: false,
      help: false,
      calls: Promise.resolve(),
      pendingCalls: 0,
      interactionRevision: 0,
      needsObservation: false,
      execution: new WebExecution(id, (event) => this.options.onExecution?.(event)),
    };
    this.current = task;
    try {
      const pages = await client.pages();
      this.check(task);
      const current = pages.find((page) => page.isActive);
      if (!current) throw new Error('当前可见页面尚未就绪，请重试连接');
      if (!readonly) await this.browser.setNativeAgentActive(true);
      return {
        sessionId: client.id,
        context: `<web_browser_context>\n${JSON.stringify({ engine: 'agent-browser', currentPage: current, pages, sessionId: client.id }).replace(/</g, '\\u003c')}\n你与用户操作同一个可见网页。先使用当前页；需要新页面时用 web_tabs，并用 web_focus_page 将结果显示在右侧。网页观察、点击、填写、滚动、导航使用 web_* 工具。创建或调整页面元素时使用 workbench_browser_query/inspect/edit/undo；edit 的 insert 可创建嵌套元素，返回新 ref，后续可继续修改并撤销。创建后先观察真实结果再给出结论；DOM 预览不代表源码已保存。web_* 的 pageId/元素引用与 workbench_browser_* 的 ref 各有作用域，不能混用；新建元素后用 web_snapshot 获取新的操作引用。\n</web_browser_context>`,
      };
    } catch (error) {
      if (this.current === task) this.current = undefined;
      task.execution.emit({ kind: 'finished', status: 'failed' });
      await this.server.cancel(client.id).catch(() => {});
      await client.close();
      throw error;
    }
  }
  private async page(task: Task, id: unknown): Promise<WebPage> {
    if (!Number.isInteger(id) || Number(id) < 1) throw new Error('需要当前页面编号');
    const pages = await task.client.pages();
    this.check(task);
    const page = pages.find((item) => item.pageId === id);
    if (!page || !this.browser.getState().tabs.some((tab) => tab.id === page.targetId))
      throw new Error('页面引用已变化，请重新读取标签页');
    return page;
  }
  private async confirm(
    task: Task,
    action: ApprovalRequest['action'],
    title: string,
    detail: string,
  ) {
    this.check(task);
    const approved = await this.options.approve({ action, title, detail });
    this.check(task);
    if (!approved) throw new Error('用户未允许这次操作');
  }
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name === 'web_status') return { text: JSON.stringify(this.getState()) };
    const task = this.current;
    if (!task && name === 'workbench_browser_edit' && args.insert !== undefined)
      return { text: '网页任务尚未建立，请重新连接浏览器后创建元素。', isError: true };
    if (!task)
      return name.startsWith('workbench_browser_')
        ? this.browser.callTool(name, args)
        : { text: '网页任务尚未建立', isError: true };
    const revision = task.interactionRevision;
    // Serialize validation as well as dispatch: a queued mutation must see the prior failure.
    task.pendingCalls++;
    const result = task.calls
      .then(() => this.callInternal(task, name, args, revision))
      .finally(() => {
        task.pendingCalls--;
      });
    task.calls = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async callInternal(
    task: Task,
    name: string,
    args: Record<string, unknown>,
    revision: number,
  ): Promise<ToolResult> {
    const started = Date.now();
    const operationId = randomUUID();
    let dispatched = false;
    let mutating = false;
    let pageId = typeof args.page === 'number' ? args.page : undefined;
    const ordered = (value: any): any =>
      Array.isArray(value)
        ? value.map(ordered)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, ordered(value[key])]),
            )
          : value;
    const signature = name + JSON.stringify(ordered(args));
    const event = (status: WebExecutionEvent['status']) =>
      task.execution.emit({
        kind: 'operation',
        operationId,
        tool: name,
        page: pageId,
        status,
        ...(status === 'running' ? {} : { durationMs: Date.now() - started }),
      });
    event('running');
    try {
      this.check(task);
      const checkInteraction = () => {
        this.check(task);
        if (revision !== task.interactionRevision)
          throw new Error(
            '用户已操作页面，本次旧操作或观察已失效。请重新读取页面后继续，不要重放未核对的动作。',
          );
      };
      if (task.readonly && !this.isReadOnly(name, args))
        throw new Error('本轮只允许读取，不能操作网页');
      if (name === 'web_plan') {
        const text = task.execution.plan(args.steps);
        event('succeeded');
        return { text, isError: false };
      }
      if (name === 'web_checkpoint') {
        const text = task.execution.checkpoint(args);
        if (!task.needsObservation && !task.execution.needsRecovery && !task.readonly)
          this.browser.allowAgentControl();
        event('succeeded');
        return { text, isError: false };
      }
      checkInteraction();
      if (task.reconnectClient) {
        await task.reconnectClient;
        checkInteraction();
        const client = await this.server.newSession();
        try {
          checkInteraction();
          task.client = client;
          task.reconnectClient = undefined;
          this.options.onSession?.(task.id, client.id);
        } catch (error) {
          await client.close();
          throw error;
        }
      }
      if (name.startsWith('workbench_browser_')) {
        const readOnly = ['workbench_browser_query', 'workbench_browser_inspect'].includes(name);
        const currentPage = (await task.client.pages()).find((page) => page.isActive);
        checkInteraction();
        if (!currentPage) throw new Error('当前可见页面尚未就绪，请重新读取页面');
        pageId = currentPage.pageId;
        if (!readOnly) {
          if (task.needsObservation) throw new Error('用户已操作页面，请先重新读取当前页面。');
          task.execution.assertCanMutate(signature);
        }
        mutating = !readOnly;
        if (mutating) task.execution.mutate();
        dispatched = true;
        task.running = { signature, page: pageId, mutating };
        let result: ToolResult;
        try {
          result = await this.browser.callTool(name, args);
        } finally {
          task.running = undefined;
        }
        checkInteraction();
        if (result.isError && mutating) task.execution.requireRecovery(signature, pageId);
        // A lost MCP reply must not allow the same insertion to create a duplicate tree.
        if (!result.isError && name === 'workbench_browser_edit' && args.insert !== undefined)
          task.execution.confirmMutation(signature);
        if (readOnly && !result.isError) {
          const observationId = task.execution.observe(result.text, pageId);
          result = {
            ...result,
            text: JSON.stringify({ ...JSON.parse(result.text), observationId }),
          };
          task.needsObservation = false;
          if (!task.readonly && !task.execution.needsRecovery) this.browser.allowAgentControl();
        }
        event(result.isError ? 'failed' : 'succeeded');
        return result;
      }
      const native = name.slice(4);
      if (!name.startsWith('web_') || (!nativeNames.has(native) && native !== 'focus_page'))
        throw new Error('未开放的网页操作');
      if (task.needsObservation && !this.isReadOnly(name, args))
        throw new Error(
          '用户已操作页面，请先用 snapshot/read/grep 重新观察当前状态，再继续网页任务。',
        );
      if (args.url !== undefined && args.url !== null && args.url !== 'about:blank') {
        if (typeof args.url !== 'string') throw new Error('网页地址格式无效');
        normalizeBrowserUrl(args.url);
      }
      const page = args.page == null ? undefined : await this.page(task, args.page);
      if (native === 'focus_page') {
        await this.browser.followNativeTarget(page!.targetId);
        event('succeeded');
        return { text: '已显示目标页面，请使用当前页面编号继续。', isError: false };
      }
      if (native === 'request_human_help') {
        const result = await this.humanHelp(task, page!, args);
        task.execution.requireRecovery('', pageId);
        event('succeeded');
        return result;
      }
      // A separate receipt page can resolve an unknown submission without replaying it.
      const recoveryInspection =
        task.execution.needsRecovery && native === 'tabs' && args.action === 'new';
      mutating = !this.isReadOnly(name, args) && !recoveryInspection;
      if (mutating) task.execution.assertCanMutate(signature);
      if (native === 'run' || native === 'evaluate_in_page')
        await this.confirm(
          task,
          'browser-script',
          '运行浏览器脚本',
          `${native === 'run' ? '脚本在隔离环境中运行，可以读取和操作 Athena 浏览器里的页面，也可以下载文件和上传脚本里写明路径的本机文件。' : '这段代码会在当前页面内执行，可以读取和修改该页面。'}请确认它符合你的任务。\n\n${JSON.stringify(args, null, 2)}`,
        );
      if (native === 'upload') {
        await this.confirm(
          task,
          'browser-upload',
          '上传文件到网页',
          `目标：${page ? new URL(page.url).origin : '当前网页'}\n请确认要上传的文件：\n${JSON.stringify(args, null, 2)}`,
        );
        const current = await this.page(task, args.page);
        if (current.url !== page?.url || current.targetId !== page.targetId)
          throw new Error('确认期间上传目标已变化，请重新观察并确认上传');
      }
      checkInteraction();
      const result = await this.browser.performNative(
        page?.targetId,
        async () => {
          checkInteraction();
          if (mutating) task.execution.mutate();
          dispatched = true;
          task.running = { signature, page: pageId, mutating };
          try {
            return await task.client.call(native, args);
          } finally {
            task.running = undefined;
          }
        },
        this.isReadOnly(name, args),
      );
      checkInteraction();
      let text = plain(result) || JSON.stringify(result.structuredContent ?? {});
      if (!task.readonly && native === 'tabs' && args.action === 'new' && !result.isError) {
        const id =
          result.structuredContent?.page?.pageId ?? Number(text.match(/^opened page (\d+)/)?.[1]);
        if (id) await this.browser.followNativeTarget((await this.page(task, id)).targetId);
      }
      const unmatched =
        native === 'wait' &&
        (result.structuredContent?.matched === false ||
          /^timed out after [\d.]+ms waiting for /i.test(text) ||
          /"matched"\s*:\s*false/.test(text));
      const failed = Boolean(result.isError || result.structuredContent?.ok === false || unmatched);
      if (failed && (mutating || unmatched))
        task.execution.requireRecovery(mutating ? signature : '', pageId);
      if (unmatched)
        text += '\n等待条件未匹配，不能据此认定完成。请重新读取页面核对状态，再记录检查点。';
      const files: WebFile[] = Array.isArray(result.structuredContent?.files)
        ? result.structuredContent.files
        : [];
      if (!failed && native === 'download' && !files.length)
        throw new Error('下载工具未返回可核对的文件路径；先检查下载记录，不要重复下载');
      // A reported file counts only after Athena has found and hashed it itself.
      for (const saved of files) {
        const file = await realpath(String(saved.path));
        const directory = await realpath(this.browser.getDownloadDirectory());
        if (!file.startsWith(directory + path.sep))
          throw new Error('下载文件不在 Athena 下载目录内，请人工检查');
        const metadata = await stat(file);
        if (!metadata.isFile()) throw new Error('下载结果不是普通文件');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        this.check(task);
        const artifact = { path: file, bytes: metadata.size, sha256: hash.digest('hex') };
        task.execution.emit({
          kind: 'artifact',
          status: 'succeeded',
          page: pageId,
          operationId,
          artifact,
        });
        text += `\nAthena verified artifact: ${JSON.stringify(artifact)}`;
      }
      if (!failed && ['snapshot', 'read', 'grep'].includes(native) && args.sensitive !== true) {
        const observationId = task.execution.observe(text, pageId);
        task.needsObservation = false;
        if (!task.execution.needsRecovery && !task.readonly) {
          this.browser.allowAgentControl();
          await this.browser.setNativeAgentActive(true);
        }
        text += `\n\nAthena observationId: ${observationId}（web_checkpoint 可引用本次原文作为证据）`;
      }
      const images = result.content
        .filter(
          (item) =>
            item.type === 'image' &&
            item.data &&
            /^image\/(png|jpeg|webp)$/.test(item.mimeType || ''),
        )
        .map((item) => `data:${item.mimeType};base64,${item.data}`);
      event(failed ? 'failed' : 'succeeded');
      return { text, ...(images.length ? { images } : {}), isError: failed };
    } catch (error) {
      if (dispatched && mutating && !task.stopped)
        task.execution.requireRecovery(signature, pageId);
      event('failed');
      return { text: safeError(error), isError: true };
    }
  }
  private async humanHelp(
    task: Task,
    page: WebPage,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    await this.browser.followNativeTarget(page.targetId);
    task.help = true;
    task.execution.emit({ kind: 'human-help', status: 'blocked', page: page.pageId });
    // The request waits for the human; never hold the browser input queue while it waits.
    const pending = task.client.call('request_human_help', args).catch(() => undefined);
    try {
      const approved = await this.options.approve({
        action: 'browser-help',
        title: '请在网页完成操作',
        detail: `${String(args.reason || '请完成页面操作')}\n${String(args.details || '')}\n完成后点击“已完成，继续”。`,
      });
      this.check(task);
      if (!approved) {
        await this.cancelTask();
        throw new Error('用户停止了网页处理');
      }
      const deadline = Date.now() + 5000;
      let resolved = false;
      while (Date.now() < deadline) {
        this.check(task);
        if ((await this.server.resolveHelp(task.client.id)).resolved) {
          resolved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      if (!resolved) throw new Error('人工协作请求未建立，请重新获取页面状态');
      const result = await pending;
      if (result?.isError) throw new Error(plain(result));
      this.check(task);
      this.browser.allowAgentControl();
      task.execution.emit({ kind: 'human-help', status: 'succeeded', page: page.pageId });
      return {
        text: '用户已完成网页处理并交回控制权。请重新 snapshot 获取当前状态与新的元素引用，再验证目标结果。',
        isError: false,
      };
    } finally {
      task.help = false;
    }
  }
  isHandingOver() {
    return this.current?.help === true;
  }
  onHumanInteraction(): void {
    const task = this.current;
    if (!task || task.stopped || task.help) return;
    task.interactionRevision++;
    task.needsObservation = true;
    task.execution.mutate();
    if (task.running && !task.reconnectClient) {
      if (task.running.mutating)
        task.execution.requireRecovery(task.running.signature, task.running.page);
      const client = task.client;
      // Release the input queue even for long reads; only writes need result reconciliation.
      task.reconnectClient = this.server
        .cancel(client.id)
        .then(() => client.close())
        .catch(async () => {
          task.stopped = true;
          await this.server.stop();
          throw new Error('无法确认网页操作已停止，请重新连接浏览器');
        });
      void task.reconnectClient.catch(() => {});
    }
  }
  unresolvedResult(id: string): string | undefined {
    const task = this.current;
    if (!task || task.id !== id) return;
    if (task.stopped) return '网页任务已停止，不能确认后续操作完成。';
    if (task.execution.needsRecovery)
      return '网页操作结果尚未核对；请检查实际页面或回执后再继续，不能重复提交。';
  }
  async cancelTask(): Promise<void> {
    const task = this.current;
    if (!task || task.stopped) return;
    task.stopped = true;
    task.execution.emit({ kind: 'cancelled', status: 'failed' });
    await this.browser.setNativeAgentActive(false);
    try {
      await this.server.cancel(task.client.id);
    } catch {
      // A worker that cannot be stopped cannot be trusted to stop future script steps.
      await this.server.stop();
    }
  }
  async finishTask(id: string, successful = true): Promise<void> {
    const task = this.current;
    if (!task || task.id !== id) return;
    if (task.pendingCalls) await this.cancelTask();
    this.current = undefined;
    task.execution.emit({
      kind: 'finished',
      status:
        task.stopped || !successful
          ? 'failed'
          : task.execution.needsRecovery
            ? 'blocked'
            : 'succeeded',
    });
    await this.browser.setNativeAgentActive(false);
    // Only a task that ended normally hands its worker to the next one.
    await task.client.close(successful && !task.stopped && !task.execution.needsRecovery);
  }
  async stop(): Promise<void> {
    await this.cancelTask();
    if (this.current) await this.finishTask(this.current.id);
    await this.server.stop();
  }
}
