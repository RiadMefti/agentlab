import * as pty from "node-pty";

export interface Disposable {
  dispose(): void;
}

export interface PseudoTerminal {
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number }) => void): Disposable;
}

export interface PseudoTerminalFactory {
  attach(sessionName: string, cwd: string): PseudoTerminal;
}

export class NodePtyTerminalFactory implements PseudoTerminalFactory {
  public constructor(private readonly socketPath?: string) {}

  public attach(sessionName: string, cwd: string): PseudoTerminal {
    const args = ["attach-session", "-t", `=${sessionName}`];
    return pty.spawn(
      "tmux",
      this.socketPath === undefined ? args : ["-S", this.socketPath, ...args],
      {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd,
        env: stringEnvironment({
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor"
        })
      }
    );
  }
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}
