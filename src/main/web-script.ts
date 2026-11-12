import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

export interface WebScriptResult {
  ok: boolean;
  /** JSON text of the returned value; absent when the script returned undefined. */
  value?: string;
  error?: string;
  logs: string[];
}
export const WEB_SCRIPT_TIMEOUT = 30_000;
const LOG_LIMIT = 200_000;
const MESSAGE_LIMIT = 8_000_000;

// Runs inside the script's own context. Only primitives cross to the outer realm, so the
// script never holds an object whose constructor chain leads back to the runner's globals.
const BOOT = String.raw`(function (host, main) {
  'use strict';
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      try {
        host.call(method, JSON.stringify(params === undefined ? null : params), (ok, payload) => {
          if (!ok) reject(new Error(payload));
          else resolve(payload === undefined || payload === null ? undefined : JSON.parse(payload));
        });
      } catch (error) {
        reject(new Error(String(error && error.message)));
      }
    });
  // A failure inside a host function (a stack overflow, for one) is an outer-realm error.
  const guard = (run) => {
    try {
      return run();
    } catch (error) {
      throw new Error(String(error && error.message));
    }
  };
  const trace = (error) => {
    const lines = String(error.stack || error.message).split('\n');
    return lines.filter((line, index) => index === 0 || !/^\s+at /.test(line) || line.includes('script.js')).join('\n');
  };
  const show = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return trace(value);
    try {
      const text = JSON.stringify(value);
      return text === undefined ? String(value) : text;
    } catch {
      return String(value);
    }
  };
  const log = (level) => (...values) => {
    const text = values.map(show).join(' ');
    guard(() => host.log(level, text));
  };
  globalThis.console = Object.freeze({
    log: log('log'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    debug: log('debug'),
  });
  globalThis.setTimeout = (callback, ms, ...values) => {
    if (typeof callback !== 'function') throw new TypeError('setTimeout needs a function');
    const delay = Number(ms) || 0;
    return guard(() => host.timer(() => callback(...values), delay));
  };
  globalThis.clearTimeout = (id) => {
    const timer = Number(id);
    guard(() => host.clear(timer));
  };
  globalThis.sleep = (ms) => {
    const delay = Number(ms) || 0;
    return new Promise((resolve) => guard(() => host.timer(resolve, delay)));
  };
  const act = (page, kind, extra) => call('act', Object.assign({ page, kind }, extra));
  const wait = (page, kind, value, options) =>
    call('wait', { page, for: kind, value, timeout: options && options.timeout });
  const handle = (id) =>
    Object.freeze({
      id,
      info: () => call('info', { page: id }),
      goto: (url) => call('navigate', { page: id, action: 'url', url }),
      back: () => call('navigate', { page: id, action: 'back' }),
      forward: () => call('navigate', { page: id, action: 'forward' }),
      reload: () => call('navigate', { page: id, action: 'reload' }),
      snapshot: (options) => call('snapshot', Object.assign({ page: id }, options)),
      diff: () => call('diff', { page: id }),
      read: (selector) => call('read', { page: id, selector }),
      grep: (pattern, options) => call('grep', Object.assign({ page: id, pattern }, options)),
      click: (ref, options) => act(id, 'click', Object.assign({ ref }, options)),
      fill: (ref, value) => act(id, 'fill', { ref, value }),
      hover: (ref) => act(id, 'hover', { ref }),
      selectOption: (ref, value) => act(id, 'select', { ref, value }),
      check: (ref) => act(id, 'check', { ref }),
      uncheck: (ref) => act(id, 'uncheck', { ref }),
      focus: (ref) => act(id, 'focus', { ref }),
      drag: (from, to) => act(id, 'drag', { ref: from, targetRef: to }),
      type: (text) => act(id, 'type', { text }),
      press: (key) => act(id, 'press', { key }),
      insertText: (text) => act(id, 'insert_text', { text }),
      scroll: (direction, amount, ref) => act(id, 'scroll', { direction, amount, ref }),
      clickAt: (x, y, options) => act(id, 'click_at', Object.assign({ x, y }, options)),
      typeAt: (x, y, text) => act(id, 'type_at', { x, y, text }),
      hoverAt: (x, y) => act(id, 'hover_at', { x, y }),
      dragAt: (startX, startY, endX, endY) => act(id, 'drag_at', { startX, startY, endX, endY }),
      dialogAccept: (text) => act(id, 'dialog_accept', { text }),
      dialogDismiss: () => act(id, 'dialog_dismiss', {}),
      waitForSelector: (selector, options) => wait(id, 'selector', selector, options),
      waitForText: (text, options) => wait(id, 'text', text, options),
      waitForTime: (ms) => wait(id, 'time', ms),
      evaluateInPage: (fn, arg, options) =>
        call('evaluate', {
          page: id,
          func: typeof fn === 'function' ? fn.toString() : String(fn),
          arg,
          timeout: options && options.timeout,
        }),
      screenshot: (options) => call('screenshot', Object.assign({ page: id }, options)),
      pdf: (options) => call('pdf', Object.assign({ page: id }, options)),
      download: (ref) => call('download', { page: id, ref }),
      upload: (ref, files) =>
        call(
          'upload',
          Array.isArray(ref)
            ? { page: id, files: ref }
            : { page: id, ref, files: typeof files === 'string' ? [files] : files },
        ),
      close: () => call('close', { page: id }),
    });
  globalThis.browser = Object.freeze({
    open: async (url) => handle((await call('open', { url })).pageId),
    page: (id) => handle(id),
    pages: Object.freeze({ list: () => call('pages') }),
    tabGroups: (options) => call('tab_groups', options || {}),
  });
  main().then(
    (value) => {
      let text;
      try {
        text = JSON.stringify(value);
      } catch (error) {
        host.done(false, 'The returned value cannot be serialized: ' + error.message);
        return;
      }
      host.done(true, text);
    },
    (error) => host.done(false, show(error)),
  );
})`;

const RUNNER = String.raw`'use strict';
const vm = require('node:vm');
const pending = new Map();
const timers = new Map();
let sequence = 0;
let timerSequence = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
process.on('uncaughtException', (error) => send({ type: 'log', level: 'error', text: 'Uncaught: ' + String(error && error.message) }));
process.on('unhandledRejection', (error) => send({ type: 'log', level: 'error', text: 'Unhandled rejection: ' + String(error && error.message) }));
const host = {
  call: (method, params, done) => {
    const id = ++sequence;
    pending.set(id, done);
    send({ type: 'call', id, method: String(method), params: String(params) });
  },
  log: (level, text) => send({ type: 'log', level: String(level), text: String(text).slice(0, 20000) }),
  timer: (callback, ms) => {
    const id = ++timerSequence;
    timers.set(id, setTimeout(() => { timers.delete(id); callback(); }, Math.min(Math.max(0, ms), 60000)));
    return id;
  },
  clear: (id) => { clearTimeout(timers.get(id)); timers.delete(id); },
  done: (ok, payload) => send({ type: 'done', ok: ok === true, payload: payload === undefined ? undefined : String(payload) }),
};
const start = (message) => {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  let main;
  try {
    main = vm.runInContext('(async function () {\n' + message.code + '\n})', context, { filename: 'script.js', lineOffset: -1 });
  } catch (error) {
    host.done(false, String(error && (error.stack || error.message)).split('\n    at ')[0]);
    return;
  }
  vm.runInContext(message.boot, context, { filename: 'sdk.js' })(host, main);
};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.type === 'start') start(message);
    else {
      const done = pending.get(message.id);
      pending.delete(message.id);
      if (done) done(message.ok === true, message.payload);
    }
  }
});
`;

const quote = (value: string) => `"${value.replace(/[\\"]/g, '\\$&')}"`;

/** Seatbelt rules for the script process: no network, no writes, no child processes, no user files. */
export async function webScriptProfile(): Promise<string> {
  const binary = await realpath(process.execPath);
  const bundle = binary.match(/^(.*?\.app)\/Contents\//)?.[1];
  const home = await realpath(homedir());
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    '(deny process-fork)',
    `(deny file-read* (subpath ${quote(home)}) (subpath "/Volumes"))`,
    // The runtime must still load itself when it is installed below the home directory.
    `(allow file-read* (subpath ${quote(bundle ?? path.dirname(path.dirname(binary)))}))`,
    `(allow file-read-metadata (subpath ${quote(home)}))`,
  ].join('\n');
}

/**
 * Runs model-written code in a separate, confined process. `vm` only shapes the globals;
 * the boundary is the process: Seatbelt, the Node permission model, an empty environment
 * and a hard kill at the deadline. Every browser effect goes through `call`.
 */
export async function runWebScript(
  code: string,
  options: {
    timeout?: number;
    call: (method: string, params: any) => Promise<unknown>;
    signal?: AbortSignal;
  },
): Promise<WebScriptResult> {
  if (process.platform !== 'darwin') throw new Error('当前系统不支持隔离运行网页脚本');
  const timeout = Math.min(WEB_SCRIPT_TIMEOUT, Math.max(1, options.timeout ?? WEB_SCRIPT_TIMEOUT));
  const directory = await mkdtemp(path.join(tmpdir(), 'athena-script-'));
  const logs: string[] = [];
  let logged = 0;
  // Bridge calls run one at a time, in the order the script issued them.
  let queue: Promise<void> = Promise.resolve();
  let finished = false;
  try {
    options.signal?.throwIfAborted();
    const child = spawn(
      '/usr/bin/sandbox-exec',
      [
        '-p',
        await webScriptProfile(),
        process.execPath,
        '--permission',
        '--max-old-space-size=256',
        '-e',
        RUNNER,
      ],
      {
        cwd: directory,
        env: { ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    const result = await new Promise<WebScriptResult>((resolve) => {
      const finish = (value: Omit<WebScriptResult, 'logs'>) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', aborted);
        child.kill('SIGKILL');
        resolve({ ...value, logs });
      };
      const aborted = () => finish({ ok: false, error: '脚本已停止' });
      const timer = setTimeout(
        () => finish({ ok: false, error: `脚本在 ${timeout} ms 内没有完成，已终止` }),
        timeout,
      );
      options.signal?.addEventListener('abort', aborted, { once: true });
      const reply = (id: unknown, ok: boolean, payload?: string) => {
        if (!finished && child.stdin.writable)
          child.stdin.write(JSON.stringify({ id, ok, payload }) + '\n');
      };
      const handle = (message: any) => {
        if (message.type === 'log') {
          const text = `[${String(message.level)}] ${String(message.text)}`;
          if (logged < LOG_LIMIT) logs.push(text);
          logged += text.length;
        } else if (message.type === 'done')
          finish(
            message.ok === true
              ? { ok: true, value: message.payload }
              : { ok: false, error: String(message.payload ?? '脚本失败') },
          );
        else if (message.type === 'call')
          queue = queue.then(async () => {
            if (finished) return;
            try {
              const value = await options.call(String(message.method), JSON.parse(message.params));
              reply(message.id, true, value === undefined ? undefined : JSON.stringify(value));
            } catch (error) {
              reply(message.id, false, error instanceof Error ? error.message : String(error));
            }
          });
      };
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > MESSAGE_LIMIT) {
          finish({ ok: false, error: '脚本输出过大，已终止' });
          return;
        }
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            handle(JSON.parse(line));
          } catch {
            finish({ ok: false, error: '脚本进程返回了无效数据，已终止' });
          }
        }
      });
      child.stdin.on('error', () => {});
      child.once('error', (error) => finish({ ok: false, error: error.message }));
      child.once('exit', () => finish({ ok: false, error: '脚本进程意外退出' }));
      child.stdin.write(JSON.stringify({ type: 'start', code, boot: BOOT }) + '\n');
    });
    // An operation the script already started still owns the browser until it returns.
    await queue;
    return result;
  } finally {
    finished = true;
    await rm(directory, { recursive: true, force: true });
  }
}
