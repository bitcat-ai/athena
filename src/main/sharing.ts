import { createServer, type Server } from 'node:https';
import type { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { BrowserRuntime } from './browser';
import { normalizeBrowserUrl } from './browser';
import { dispatchBrowserAction } from './browser-actions';
import type {
  BrowserActor,
  BrowserFrame,
  BrowserState,
  RecordedStep,
  Recording,
} from '../shared/types';
import { SHARED_PAGE_ACTIONS, type ShareParticipant, type ShareState } from '../shared/share';

const token = () => randomBytes(32).toString('base64url');
const same = (a: unknown, b: string) =>
  typeof a === 'string' &&
  /^[A-Za-z0-9_-]{43}$/.test(a) &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const name = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 40 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new Error('请输入 1–40 字的姓名');
  return value.trim();
};
interface Peer {
  participant: ShareParticipant;
  secret: string;
  socket?: WebSocket;
  disconnectedAt?: number;
  frame?: BrowserFrame;
  pendingFrame?: BrowserFrame;
  acknowledged?: BrowserFrame;
  lastId: number;
  pending: number;
  alive: boolean;
  rateStart: number;
  rateCount: number;
}
export interface SharingOptions {
  browser: BrowserRuntime;
  storageDir: string;
  assetsDir: string;
  onState(state: ShareState): void;
  saveRecording(recording: Recording): void | Promise<void>;
}

/** HTTPS exposes a page-only protocol, never a debugging endpoint or the desktop IPC router. */
export class SharingRuntime {
  private server?: Server;
  private tcpSockets = new Set<Socket>();
  private starting = false;
  private startCancelled = false;
  private sockets?: WebSocketServer;
  private timer?: ReturnType<typeof setInterval>;
  private peers = new Map<string, Peer>();
  private inviteSecret = '';
  private inviteExpires = 0;
  private latestFrame?: BrowserFrame;
  private frameMessages = new WeakMap<BrowserFrame, string>();
  private guardByGeneration = new Map<string, () => void>();
  private state: ShareState = {
    active: false,
    participants: [],
    controllerId: 'host',
    generation: 0,
  };
  private transition: Promise<void> = Promise.resolve();
  private stopping?: Promise<Recording | undefined>;
  private startedAt = 0;
  private connections = 0;
  private address = '';
  private part = 1;
  private rotating?: Promise<Recording | undefined>;
  constructor(private options: SharingOptions) {}

  static addresses(): Array<{ address: string; label: string }> {
    return Object.entries(networkInterfaces())
      .flatMap(([label, entries]) =>
        (entries || [])
          .filter((a) => a.family === 'IPv4' && !a.internal)
          .map((a) => ({ address: a.address, label })),
      )
      .concat({ address: '127.0.0.1', label: '仅本机测试' });
  }
  get active(): boolean {
    return this.state.active;
  }
  getState(): ShareState {
    return structuredClone({
      ...this.state,
      participants: [
        { id: 'host', name: this.host.name, role: 'host', status: 'connected' },
        ...[...this.peers.values()].map((p) => p.participant),
      ],
    });
  }
  private host: BrowserActor = { id: 'host', name: '主持人' };
  private publicState(peer: Peer): ShareState {
    const { invite: _, fingerprint: __, address: ___, ...state } = this.getState();
    if (peer.participant.status === 'pending') {
      state.participants = state.participants.filter(
        (p) => p.id === 'host' || p.id === peer.participant.id,
      );
      state.title = undefined;
      state.tabId = undefined;
    }
    return state;
  }
  private pageState(): BrowserState | undefined {
    const state = this.options.browser.getState();
    if (state.activeTabId !== this.state.tabId) return undefined;
    const { binaryPath: _, ...safe } = state;
    return { ...safe, tabs: state.tabs.filter((t) => t.id === this.state.tabId) };
  }
  private send(peer: Peer, message: unknown): boolean {
    const socket = peer.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 2_500_000) {
      socket.terminate();
      return false;
    }
    socket.send(typeof message === 'string' ? message : JSON.stringify(message));
    return true;
  }
  private changed(): void {
    this.options.onState(this.getState());
    for (const peer of this.peers.values())
      this.send(peer, {
        type: 'state',
        state: this.publicState(peer),
        ...(peer.participant.status === 'connected' ? { browser: this.pageState() } : {}),
      });
  }
  onBrowserState(state: BrowserState): void {
    if (!this.active) return;
    if (state.status !== 'ready' || state.activeTabId !== this.state.tabId) {
      void this.stop().catch(() => {});
      return;
    }
    this.state.title = state.title;
    this.changed();
  }
  onFrame(frame: BrowserFrame): void {
    if (!this.active || frame.tabId !== this.state.tabId || !frame.data) return;
    this.latestFrame = frame;
    for (const peer of this.peers.values()) {
      if (peer.participant.status !== 'connected') continue;
      if (peer.frame) peer.pendingFrame = frame;
      else this.sendFrame(peer, frame);
    }
  }
  private sendFrame(peer: Peer, frame: BrowserFrame): void {
    let wire = this.frameMessages.get(frame);
    if (!wire) {
      wire = JSON.stringify({ type: 'frame', frame });
      this.frameMessages.set(frame, wire);
    }
    if (this.send(peer, wire)) peer.frame = frame;
  }
  onStep(step: RecordedStep): void {
    if (!this.active || step.tabId !== this.state.tabId) return;
    for (const peer of this.peers.values())
      if (peer.participant.status === 'connected') this.send(peer, { type: 'step', step });
    const recording = this.options.browser.getRecording();
    if (recording) {
      void Promise.resolve(this.options.saveRecording(recording)).catch(() => {
        this.state.error = '操作记录保存失败，请停止共享并检查磁盘';
        this.changed();
      });
      if (recording.steps.length >= 1800 && !this.rotating) {
        const sessionId = this.state.sessionId;
        this.rotating = Promise.resolve()
          .then(async () => {
            if (this.active && this.options.browser.getState().recording) {
              const completed = await this.options.browser.stopRecording();
              await Promise.resolve(this.options.saveRecording(completed)).catch(() => {
                this.state.error = '操作记录保存失败，请停止共享并检查磁盘';
                this.changed();
              });
              if (this.active && this.state.sessionId === sessionId)
                this.options.browser.withActor(this.host, undefined, () =>
                  this.options.browser.startRecording(sessionId, ++this.part),
                );
              return completed;
            }
          })
          .catch(() => {
            this.state.error = '操作记录保存失败，请停止共享并检查磁盘';
            this.changed();
            return undefined;
          })
          .finally(() => {
            this.rotating = undefined;
          });
      }
    }
  }
  async start(value: { address: string; name: string }): Promise<ShareState> {
    if (this.starting || this.stopping) throw new Error('共享正在启动或结束，请稍候');
    this.starting = true;
    this.startCancelled = false;
    try {
      return await this.startInternal(value);
    } finally {
      this.starting = false;
    }
  }
  private async startInternal(value: { address: string; name: string }): Promise<ShareState> {
    if (this.active || this.server) throw new Error('共享已开启');
    if (!SharingRuntime.addresses().some((a) => a.address === value.address))
      throw new Error('请选择本机网络地址');
    const browser = this.options.browser;
    const current = browser.getState();
    if (current.status !== 'ready' || !current.activeTabId) throw new Error('请先打开要共享的页面');
    normalizeBrowserUrl(current.url);
    if (current.recording) throw new Error('请先结束当前录制，再开始共享');
    this.host = { id: 'host', name: name(value.name) };
    await mkdir(this.options.storageDir, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(path.join(this.options.storageDir, 'certificate-'));
    try {
      const config = `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Athena Shared Page\n[ext]\nsubjectAltName=IP:${value.address},IP:127.0.0.1\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`;
      await writeFile(path.join(temp, 'openssl.cnf'), config, { mode: 0o600 });
      await promisify(execFile)('/usr/bin/openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(temp, 'key.pem'),
        '-out',
        path.join(temp, 'cert.pem'),
        '-days',
        '2',
        '-config',
        path.join(temp, 'openssl.cnf'),
      ]);
      const [key, cert] = await Promise.all([
        readFile(path.join(temp, 'key.pem')),
        readFile(path.join(temp, 'cert.pem')),
      ]);
      if (this.startCancelled) throw new Error('已取消开启共享');
      const server = createServer(
        { key, cert, minVersion: 'TLSv1.2', handshakeTimeout: 5000 },
        (req, res) => {
          let pathname: string;
          try {
            pathname = new URL(req.url || '/', 'https://localhost').pathname;
          } catch {
            res.writeHead(400).end();
            return;
          }
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Referrer-Policy', 'no-referrer');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('X-Frame-Options', 'DENY');
          res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          );
          if (req.headers.host !== new URL(this.address || `https://${value.address}`).host) {
            res.writeHead(403).end();
            return;
          }
          const relative =
            pathname === '/'
              ? 'share.html'
              : /^\/assets\/[\w.-]+\.(js|css|svg|png|woff2?)$/.test(pathname)
                ? pathname.slice(1)
                : '';
          if (req.method !== 'GET' || !relative) {
            res.writeHead(404).end();
            return;
          }
          void readFile(path.join(this.options.assetsDir, relative)).then(
            (data) => {
              res.setHeader(
                'Content-Type',
                relative.endsWith('.html')
                  ? 'text/html; charset=utf-8'
                  : relative.endsWith('.js')
                    ? 'text/javascript; charset=utf-8'
                    : relative.endsWith('.css')
                      ? 'text/css; charset=utf-8'
                      : relative.endsWith('.svg')
                        ? 'image/svg+xml'
                        : relative.endsWith('.png')
                          ? 'image/png'
                          : 'font/woff2',
              );
              res.end(data);
            },
            () => res.writeHead(404).end(),
          );
        },
      );
      this.server = server;
      server.on('connection', (socket) => {
        this.tcpSockets.add(socket);
        socket.once('close', () => this.tcpSockets.delete(socket));
      });
      server.maxConnections = 24;
      server.headersTimeout = 5000;
      server.requestTimeout = 5000;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, value.address, resolve);
      });
      if (this.startCancelled) throw new Error('已取消开启共享');
      this.address = `https://${value.address}:${(server.address() as { port: number }).port}`;
      this.sockets = new WebSocketServer({
        noServer: true,
        maxPayload: 96_000,
        perMessageDeflate: false,
      });
      server.on('upgrade', (req, socket, head) => {
        if (
          !this.active ||
          req.url !== '/connect' ||
          req.headers.origin !== this.address ||
          req.headers.host !== new URL(this.address).host ||
          this.connections >= 16
        ) {
          socket.destroy();
          return;
        }
        this.sockets!.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
      });
      this.state = {
        active: true,
        sessionId: randomUUID(),
        tabId: current.activeTabId,
        title: current.title,
        address: this.address,
        fingerprint: new X509Certificate(cert).fingerprint256,
        participants: [],
        controllerId: 'host',
        generation: this.state.generation + 1,
      };
      this.startedAt = Date.now();
      await browser.setSharedTab(current.activeTabId);
      if (this.startCancelled) throw new Error('已取消开启共享');
      this.part = 1;
      browser.withActor(this.host, undefined, () =>
        browser.startRecording(this.state.sessionId, this.part),
      );
      this.renewInvite();
      this.timer = setInterval(() => this.heartbeat(), 15_000);
      this.changed();
      return this.getState();
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  renewInvite(): ShareState {
    if (!this.active) throw new Error('共享未开启');
    this.inviteSecret = token();
    this.inviteExpires = Date.now() + 10 * 60_000;
    this.state.invite = {
      url: `${this.address}/#invite=${this.inviteSecret}`,
      expiresAt: this.inviteExpires,
    };
    this.changed();
    return this.getState();
  }
  revokeInvite(): ShareState {
    this.inviteSecret = '';
    this.inviteExpires = 0;
    this.state.invite = undefined;
    for (const [id, peer] of this.peers) if (peer.participant.status === 'pending') this.remove(id);
    this.changed();
    return this.getState();
  }
  private connect(socket: WebSocket): void {
    this.connections++;
    let peer: Peer | undefined;
    const authTimeout = setTimeout(() => socket.terminate(), 5000);
    socket.on('pong', () => {
      if (peer) peer.alive = true;
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(authTimeout);
      this.connections--;
      if (!peer || peer.socket !== socket) return;
      peer.socket = undefined;
      peer.frame = peer.pendingFrame = peer.acknowledged = undefined;
      peer.disconnectedAt = Date.now();
      if (peer.participant.status !== 'pending') peer.participant.status = 'disconnected';
      if (this.state.controllerId === peer.participant.id)
        void this.changeControl('host', { id: 'system', name: '系统' }).catch(() => {});
      this.changed();
    });
    socket.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error('不支持的消息格式');
        const message = JSON.parse(raw.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message))
          throw new Error('消息格式无效');
        if (!peer) {
          if (message.type !== 'join') throw new Error('请先加入共享');
          const existing = [...this.peers.values()].find((p) => same(message.resume, p.secret));
          if (existing) {
            peer = existing;
            if (peer.disconnectedAt && Date.now() - peer.disconnectedAt > 10 * 60_000) {
              this.remove(peer.participant.id);
              throw new Error('重连凭据已过期，请重新请求加入');
            }
            if (peer.socket?.readyState === WebSocket.OPEN)
              throw new Error('该身份已在另一个窗口连接');
            // A closing transport may not have emitted close yet; invalidate its queued input now.
            if (this.state.controllerId === peer.participant.id)
              void this.changeControl('host', { id: 'system', name: '系统' }).catch(() => {});
            if (peer.participant.status !== 'pending') peer.participant.status = 'connected';
          } else {
            if (
              !this.inviteSecret ||
              Date.now() >= this.inviteExpires ||
              !same(message.invite, this.inviteSecret)
            )
              throw new Error('邀请已过期或撤销，请向主持人索取新邀请');
            if (this.peers.size >= 8) throw new Error('参与人数已达上限');
            const label = name(message.name);
            if (
              label === this.host.name ||
              [...this.peers.values()].some((p) => p.participant.name === label)
            )
              throw new Error('该姓名已被使用，请添加可区分的称呼');
            peer = {
              participant: { id: randomUUID(), name: label, role: 'viewer', status: 'pending' },
              secret: token(),
              lastId: 0,
              pending: 0,
              alive: true,
              rateStart: Date.now(),
              rateCount: 0,
            };
            this.peers.set(peer.participant.id, peer);
          }
          clearTimeout(authTimeout);
          peer.socket = socket;
          peer.alive = true;
          peer.disconnectedAt = undefined;
          peer.lastId = 0;
          peer.frame = peer.pendingFrame = peer.acknowledged = undefined;
          this.send(peer, {
            type: 'welcome',
            participantId: peer.participant.id,
            resume: peer.secret,
          });
          this.changed();
          if (peer.participant.status === 'connected') {
            this.send(peer, {
              type: 'state',
              state: this.publicState(peer),
              browser: this.pageState(),
              steps: this.options.browser.getRecording()?.steps ?? [],
            });
            if (this.latestFrame) this.sendFrame(peer, this.latestFrame);
          }
          return;
        }
        if (peer.socket !== socket || !this.peers.has(peer.participant.id))
          throw new Error('身份已失效');
        if (Date.now() - peer.rateStart > 1000) {
          peer.rateStart = Date.now();
          peer.rateCount = 0;
        }
        if (++peer.rateCount > 500) throw new Error('消息过于频繁');
        if (message.type === 'ack') {
          if (
            peer.frame &&
            peer.frame.sequence === message.sequence &&
            peer.frame.epoch === message.epoch
          ) {
            peer.acknowledged = peer.frame;
            peer.frame = undefined;
            const pending = peer.pendingFrame;
            peer.pendingFrame = undefined;
            if (pending) this.sendFrame(peer, pending);
          }
          return;
        }
        if (
          message.type !== 'command' ||
          !Number.isSafeInteger(message.id) ||
          message.id <= peer.lastId
        )
          throw new Error('操作序号无效');
        peer.lastId = message.id;
        if (peer.pending >= 64) {
          this.send(peer, {
            type: 'result',
            id: message.id,
            error: '输入队列已满，请等待页面响应',
          });
          return;
        }
        peer.pending++;
        const current = peer;
        void this.command(current, message)
          .then(
            (value) =>
              current.socket === socket &&
              this.send(current, { type: 'result', id: message.id, value }),
            (error) =>
              current.socket === socket &&
              this.send(current, {
                type: 'result',
                id: message.id,
                error: error instanceof Error ? error.message : '操作失败',
              }),
          )
          .finally(() => {
            current.pending--;
          });
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: 'error',
            error: error instanceof Error ? error.message : '无法加入共享',
          }),
        );
        socket.close(1008);
      }
    });
  }
  private guard(id: string): () => void {
    const generation = this.state.generation,
      key = `${generation}/${id}`;
    let guard = this.guardByGeneration.get(key);
    if (!guard) {
      guard = () => {
        const peer = this.peers.get(id);
        if (
          !this.active ||
          this.state.changingControl ||
          generation !== this.state.generation ||
          this.state.controllerId !== id ||
          (id !== 'host' &&
            (!peer ||
              peer.participant.status !== 'connected' ||
              peer.participant.role !== 'editor'))
        )
          throw new Error('操作权限已变化，请重新取得控制权');
        if (this.options.browser.getSurfaceViewport().tabId !== this.state.tabId)
          throw new Error('共享页面已关闭');
      };
      this.guardByGeneration.set(key, guard);
    }
    return guard;
  }
  private async command(peer: Peer, message: any): Promise<unknown> {
    if (message.action === 'share:leave') {
      this.remove(peer.participant.id, peer.participant);
      return true;
    }
    if (peer.participant.status !== 'connected') throw new Error('等待主持人确认加入');
    if (message.action === 'share:request-control') {
      if (peer.participant.role !== 'editor') throw new Error('当前为仅查看权限');
      if (!peer.participant.requestedControl)
        this.options.browser.recordCollaboration(peer.participant, '请求操作页面');
      peer.participant.requestedControl = true;
      this.changed();
      return true;
    }
    if (message.action === 'share:release-control') {
      if (this.state.controllerId === peer.participant.id)
        await this.changeControl('host', peer.participant);
      return true;
    }
    if (!SHARED_PAGE_ACTIONS.has(message.action)) throw new Error('此操作不在共享页面权限内');
    const guard = this.guard(peer.participant.id);
    guard();
    const frame = peer.acknowledged;
    const viewport = this.options.browser.getSurfaceViewport();
    if (
      !frame ||
      message.frame?.sequence !== frame.sequence ||
      message.frame?.epoch !== frame.epoch ||
      frame.epoch !== this.options.browser.getSurfaceEpoch() ||
      frame.width !== viewport.width ||
      frame.height !== viewport.height ||
      (frame.sequence !== this.latestFrame?.sequence &&
        Date.now() - (frame.capturedAt || 0) > 2000) ||
      viewport.loading
    )
      throw new Error('画面已过期，请等待新画面后重试');
    if (message.generation !== this.state.generation) throw new Error('控制权已变化');
    if (message.action === 'browser:input' && message.payload?.type === 'resize')
      throw new Error('页面尺寸由主持人设置');
    const epoch = frame.epoch;
    // The stable lease guard lets BrowserRuntime coalesce wheels without crossing operators.
    const result = this.options.browser.withActor(
      peer.participant,
      guard,
      () => dispatchBrowserAction(this.options.browser, message.action, message.payload),
      epoch,
    );
    await result;
    if (epoch !== this.options.browser.getSurfaceEpoch() && message.action === 'browser:input')
      return true;
    return result;
  }
  hostAction(action: string, payload?: unknown): Promise<unknown> {
    if (!this.active) return dispatchBrowserAction(this.options.browser, action, payload);
    if (['browser:new-tab', 'browser:switch-tab', 'browser:close-tab'].includes(action))
      return Promise.reject(new Error('请先停止共享再切换标签页'));
    const readOnly = [
      'browser:resize',
      'browser:tabs',
      'browser:query',
      'browser:element-details',
      'browser:snapshot',
      'browser:diagnostics',
      'browser:start',
    ].includes(action);
    const guard = readOnly ? undefined : this.guard('host');
    guard?.();
    return this.options.browser.withActor(this.host, guard, () =>
      dispatchBrowserAction(this.options.browser, action, payload),
    );
  }
  async approve(id: string, role: 'viewer' | 'editor'): Promise<ShareState> {
    const peer = this.peers.get(id);
    if (!peer || !['viewer', 'editor'].includes(role)) throw new Error('参与者或权限无效');
    if (this.state.controllerId === id && role !== 'editor') await this.changeControl('host');
    const wasPending = peer.participant.status === 'pending';
    peer.participant.role = role;
    this.options.browser.recordCollaboration(
      this.host,
      `${wasPending ? '允许加入' : '更改权限'}：${peer.participant.name}（${role === 'editor' ? '可操作' : '仅查看'}）`,
    );
    peer.participant.status =
      peer.socket?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
    this.changed();
    this.send(peer, {
      type: 'state',
      state: this.publicState(peer),
      browser: this.pageState(),
      steps: this.options.browser.getRecording()?.steps ?? [],
    });
    if (this.latestFrame && !peer.frame) this.sendFrame(peer, this.latestFrame);
    return this.getState();
  }
  changeControl(id: string, initiatedBy: BrowserActor = this.host): Promise<void> {
    if (!this.active) return Promise.reject(new Error('共享已结束'));
    const peer = this.peers.get(id);
    if (
      id !== 'host' &&
      (!peer || peer.participant.status !== 'connected' || peer.participant.role !== 'editor')
    )
      return Promise.reject(new Error('参与者当前不能操作'));
    this.state.generation++;
    this.guardByGeneration.clear();
    this.state.changingControl = true;
    this.state.controllerId = id;
    for (const p of this.peers.values()) p.participant.requestedControl = false;
    this.changed();
    const generation = this.state.generation;
    this.transition = this.transition
      .catch(() => {})
      .then(async () => {
        if (!this.active || generation !== this.state.generation)
          throw new Error('控制权交接已取消');
        try {
          await this.options.browser.withActor(
            id === 'host' ? this.host : peer!.participant,
            undefined,
            () => this.options.browser.resetHumanInput(),
          );
        } catch {
          if (this.active) await this.stop().catch(() => {});
          throw new Error('控制权交接失败，共享已停止，请检查页面后重新邀请');
        }
        if (generation === this.state.generation) {
          this.options.browser.recordCollaboration(
            initiatedBy,
            `将页面控制权交给${id === 'host' ? this.host.name : peer!.participant.name}`,
          );
          this.state.changingControl = false;
          this.changed();
        }
      });
    return this.transition;
  }
  remove(id: string, initiatedBy: BrowserActor = this.host): ShareState {
    const peer = this.peers.get(id);
    if (!peer) return this.getState();
    this.peers.delete(id);
    this.options.browser.recordCollaboration(initiatedBy, `结束参与：${peer.participant.name}`);
    if (this.state.controllerId === id)
      void this.changeControl('host', initiatedBy).catch(() => {});
    peer.socket?.close(4001, '已退出共享');
    this.changed();
    return this.getState();
  }
  private heartbeat(): void {
    if (Date.now() - this.startedAt > 8 * 60 * 60_000) {
      void this.stop().catch(() => {});
      return;
    }
    if (this.inviteSecret && Date.now() >= this.inviteExpires) {
      this.inviteSecret = '';
      this.state.invite = undefined;
      this.changed();
    }
    for (const [id, peer] of this.peers) {
      if (peer.disconnectedAt && Date.now() - peer.disconnectedAt > 10 * 60_000) {
        this.remove(id);
        continue;
      }
      if (peer.socket) {
        if (!peer.alive) peer.socket.terminate();
        else {
          peer.alive = false;
          peer.socket.ping();
        }
      }
    }
  }
  stop(): Promise<Recording | undefined> {
    this.startCancelled = true;
    if (this.stopping) return this.stopping;
    this.stopping = this.stopInternal().finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  private async stopInternal(): Promise<Recording | undefined> {
    const wasActive = this.active;
    this.state.active = false;
    this.state.generation++;
    this.guardByGeneration.clear();
    this.inviteSecret = '';
    this.state.invite = undefined;
    clearInterval(this.timer);
    if (wasActive)
      await this.options.browser
        .withActor(this.host, undefined, () => this.options.browser.resetHumanInput())
        .catch(() => {});
    let recording: Recording | undefined = await this.rotating;
    let saveError: unknown;
    if (wasActive && this.options.browser.getState().recording) {
      try {
        recording = await this.options.browser.stopRecording();
      } catch (error) {
        saveError = error;
        recording = this.options.browser.getRecording();
      }
    }
    if (recording)
      await Promise.resolve(this.options.saveRecording(recording)).catch((error) => {
        saveError = error;
      });
    for (const peer of this.peers.values()) {
      this.send(peer, {
        type: 'ended',
        ...(peer.participant.status !== 'pending' ? { recording } : {}),
      });
      peer.socket?.close(1000, '共享已结束');
    }
    this.peers.clear();
    this.latestFrame = undefined;
    const closing = [...(this.sockets?.clients ?? [])];
    await Promise.race([
      Promise.all(
        closing.map((s) =>
          s.readyState === WebSocket.CLOSED
            ? Promise.resolve()
            : new Promise<void>((resolve) => s.once('close', resolve)),
        ),
      ),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        timer.unref();
      }),
    ]);
    closing.forEach((s) => s.terminate());
    this.sockets?.close();
    this.sockets = undefined;
    const server = this.server;
    this.server = undefined;
    if (server) {
      for (const socket of this.tcpSockets) socket.destroy();
      this.tcpSockets.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.options.browser.setSharedTab().catch(() => {});
    this.state = {
      active: false,
      participants: [],
      controllerId: 'host',
      generation: this.state.generation,
    };
    if (saveError) this.state.error = '共享已停止，但记录保存失败，请检查磁盘并导出记录';
    this.changed();
    if (saveError) throw new Error(this.state.error);
    return recording;
  }
}
