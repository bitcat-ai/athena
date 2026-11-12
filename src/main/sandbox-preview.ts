import { randomUUID } from 'node:crypto';
import { BrowserWindow, session } from 'electron';
import type { SandboxPreviewState } from '../shared/sandbox';

export interface PreviewTarget {
  workspaceId: string;
  slug: string;
  name: string;
  url: string;
  /** The preview never navigates outside this origin. */
  origin: string;
  /** Coder session for Coder-served apps; loopback forwards need none. */
  token?: string;
}

const VIEWPORT = { width: 1024, height: 640 };
const THUMB_WIDTH = 480;
const FRAME_INTERVAL_MS = 400;

/**
 * Renders one sandbox page offscreen and streams small JPEG frames to the UI. It only
 * repaints when the page changes, so an idle preview sends nothing.
 */
export class SandboxPreview {
  private readonly partition = 'sandbox-preview-' + randomUUID();
  private window?: BrowserWindow;
  private target?: PreviewTarget;
  private lastFrameAt = 0;
  private pendingFrame?: NodeJS.Timeout;
  private generation = 0;

  constructor(private readonly emit: (state: SandboxPreviewState | undefined) => void) {}

  get current() {
    return this.target;
  }

  async start(target: PreviewTarget) {
    if (
      this.target?.workspaceId === target.workspaceId &&
      this.target.slug === target.slug &&
      this.target.url === target.url &&
      this.window &&
      !this.window.isDestroyed()
    )
      return;
    this.stop();
    const generation = ++this.generation;
    this.target = target;
    const publish = (patch: Partial<SandboxPreviewState>) => {
      if (generation !== this.generation) return;
      this.state = { ...this.state!, ...patch, at: Date.now() };
      this.emit(this.state);
    };
    this.state = {
      workspaceId: target.workspaceId,
      slug: target.slug,
      name: target.name,
      status: 'loading',
      at: Date.now(),
    };
    this.emit(this.state);

    const preview = session.fromPartition(this.partition);
    preview.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    if (target.token)
      await preview.cookies.set({
        url: target.origin,
        name: 'coder_session_token',
        value: target.token,
        httpOnly: true,
        secure: target.origin.startsWith('https:'),
        sameSite: 'lax',
      });
    if (generation !== this.generation) return;

    const window = new BrowserWindow({
      ...VIEWPORT,
      show: false,
      webPreferences: {
        offscreen: true,
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.window = window;
    const contents = window.webContents;
    contents.setAudioMuted(true);
    contents.setFrameRate(5);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const sameOrigin = (url: string) => {
      try {
        return new URL(url).origin === target.origin;
      } catch {
        return false;
      }
    };
    contents.on('will-navigate', (details) => {
      if (!sameOrigin(details.url)) details.preventDefault();
    });
    contents.on('will-redirect', (details) => {
      if (!sameOrigin(details.url)) details.preventDefault();
    });
    contents.on('did-navigate', (_event, url) => {
      if (new URL(url).pathname.startsWith('/login'))
        publish({ status: 'error', message: 'Coder 要求重新登录，请更新 Coder 令牌' });
    });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3)
        publish({ status: 'error', message: `页面无法打开：${description}` });
    });
    contents.on('page-title-updated', (_event, title) => publish({ title: title.slice(0, 200) }));
    contents.on('render-process-gone', () =>
      publish({ status: 'error', message: '预览页面已崩溃' }),
    );
    contents.on('paint', () => this.scheduleFrame(generation, publish));
    try {
      await window.loadURL(target.url);
    } catch {
      /* did-fail-load reports the reason */
    }
  }

  private state?: SandboxPreviewState;

  private scheduleFrame(
    generation: number,
    publish: (patch: Partial<SandboxPreviewState>) => void,
  ) {
    if (this.pendingFrame || generation !== this.generation) return;
    const wait = Math.max(0, this.lastFrameAt + FRAME_INTERVAL_MS - Date.now());
    this.pendingFrame = setTimeout(async () => {
      this.pendingFrame = undefined;
      const window = this.window;
      if (generation !== this.generation || !window || window.isDestroyed()) return;
      try {
        const image = await window.webContents.capturePage();
        if (generation !== this.generation || image.isEmpty()) return;
        this.lastFrameAt = Date.now();
        const thumb = image.resize({ width: THUMB_WIDTH, quality: 'good' });
        publish({
          status: this.state?.status === 'error' ? 'error' : 'live',
          frame: `data:image/jpeg;base64,${thumb.toJPEG(72).toString('base64')}`,
          width: VIEWPORT.width,
          height: VIEWPORT.height,
        });
      } catch {
        /* the window closed while capturing */
      }
    }, wait);
  }

  stop() {
    this.generation++;
    clearTimeout(this.pendingFrame);
    this.pendingFrame = undefined;
    const window = this.window;
    this.window = undefined;
    const had = this.target;
    this.target = undefined;
    this.state = undefined;
    if (window && !window.isDestroyed()) window.destroy();
    void session
      .fromPartition(this.partition)
      .clearStorageData()
      .catch(() => {});
    if (had) this.emit(undefined);
  }
}
