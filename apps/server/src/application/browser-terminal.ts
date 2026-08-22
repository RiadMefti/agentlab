export interface BrowserTerminalSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close" | "error", listener: () => void): void;
}

/** Connects the browser to an existing session; captains and workers never use this port. */
export interface BrowserTerminalPort {
  attach(socket: BrowserTerminalSocket, sessionName: string, cwd: string): void;
}
