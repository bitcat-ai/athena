export interface TerminalSize {
  cols: number;
  rows: number;
}
export interface NativeTerminalBridge {
  start(size: TerminalSize): Promise<{ name: string; workspace: string }>;
  write(data: string): void;
  resize(size: TerminalSize): void;
  acknowledge(count: number): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (code: number) => void): () => void;
}
declare global {
  interface Window {
    nativeTerminal: NativeTerminalBridge;
  }
}
