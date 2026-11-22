import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import type {} from '../shared/native-terminal';

const root = document.querySelector<HTMLElement>('#terminal')!;
const status = document.querySelector<HTMLElement>('#status')!;
const terminal = new Terminal({
  cursorBlink: true,
  screenReaderMode: true,
  scrollback: 4000,
  fontFamily: '"SF Mono", Menlo, monospace',
  fontSize: 13,
  theme: { background: '#151517', foreground: '#eeeeef' },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(root);
fit.fit();
const bridge = window.nativeTerminal;
const size = () => ({ cols: terminal.cols, rows: terminal.rows });
let running = false,
  ended = false;
bridge.onData((data) => terminal.write(data, () => bridge.acknowledge(data.length)));
bridge.onExit((code) => {
  running = false;
  ended = true;
  status.textContent = `已退出 · ${code}`;
});
terminal.onData((data) => {
  if (!running) return;
  for (let offset = 0; offset < data.length;) {
    let end = Math.min(offset + 16000, data.length);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
    bridge.write(data.slice(offset, end));
    offset = end;
  }
});
terminal.onResize(() => {
  if (running) bridge.resize(size());
});
new ResizeObserver(() => fit.fit()).observe(root);
bridge
  .start(size())
  .then(({ name, workspace }) => {
    document.querySelector('#name')!.textContent = name + ' · 原生会话';
    document.querySelector('#workspace')!.textContent = workspace;
    if (!ended) {
      running = true;
      status.textContent = '';
      bridge.resize(size());
      terminal.focus();
    }
  })
  .catch(() => {
    status.textContent = '无法启动，请检查本机 CLI 安装和工作目录';
  });
