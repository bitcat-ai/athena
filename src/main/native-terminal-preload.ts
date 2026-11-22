import { contextBridge, ipcRenderer } from 'electron';
import type { NativeTerminalBridge } from '../shared/native-terminal';
const bridge: NativeTerminalBridge = {
  start: (size) => ipcRenderer.invoke('terminal:start', size),
  write: (data) => ipcRenderer.send('terminal:input', data),
  resize: (size) => ipcRenderer.send('terminal:resize', size),
  acknowledge: (count) => ipcRenderer.send('terminal:ack', count),
  onData(callback) {
    const handle = (_: Electron.IpcRendererEvent, data: string) => callback(data);
    ipcRenderer.on('terminal:data', handle);
    return () => ipcRenderer.removeListener('terminal:data', handle);
  },
  onExit(callback) {
    const handle = (_: Electron.IpcRendererEvent, code: number) => callback(code);
    ipcRenderer.on('terminal:exit', handle);
    return () => ipcRenderer.removeListener('terminal:exit', handle);
  },
};
contextBridge.exposeInMainWorld('nativeTerminal', bridge);
