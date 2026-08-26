export interface Disposable {
  dispose(): void;
}

export interface PseudoTerminal {
  write(data: Uint8Array): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number }) => void): Disposable;
}

export interface TerminalDimensions {
  readonly columns: number;
  readonly rows: number;
}

export interface PseudoTerminalFactory {
  attach(sessionName: string, cwd: string, dimensions: TerminalDimensions): PseudoTerminal;
}

export interface TerminalHistoryReader {
  read(sessionName: string): Promise<string>;
}
