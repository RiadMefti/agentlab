import {
  terminalClientMessageSchema,
  type TerminalClientMessage,
  type TerminalServerMessage
} from "@orchestrator/contracts";

import type {
  BrowserTerminalPort,
  BrowserTerminalSocket
} from "../../application/browser-terminal.js";
import { parseSessionName } from "../../domain/agent-session-name.js";
import { NodeCommandRunner } from "../process/command-runner.js";
import {
  NodePtyTerminalFactory,
  type Disposable,
  type PseudoTerminal,
  type PseudoTerminalFactory
} from "./pseudo-terminal.js";
import { TmuxTerminalHistoryReader, type TerminalHistoryReader } from "./terminal-history.js";

const MAX_PENDING_INPUT_BYTES = 256 * 1024;
const MAX_PENDING_MESSAGES = 1_024;

export class TerminalGateway implements BrowserTerminalPort {
  public constructor(
    private readonly terminals: PseudoTerminalFactory = new NodePtyTerminalFactory(),
    private readonly history: TerminalHistoryReader = new TmuxTerminalHistoryReader(
      new NodeCommandRunner()
    )
  ) {}

  public attach(socket: BrowserTerminalSocket, sessionName: string, cwd: string): void {
    if (parseSessionName(sessionName) === null) {
      send(socket, { type: "error", message: "Invalid session name." });
      socket.close(1008, "Invalid session");
      return;
    }

    let process: PseudoTerminal | null = null;
    let dataSubscription: Disposable | null = null;
    let exitSubscription: Disposable | null = null;
    let disposed = false;
    let pendingBytes = 0;
    let pendingMessageCount = 0;
    let inputRejected = false;
    const pendingMessages: TerminalClientMessage[] = [];

    socket.on("message", (raw) => {
      if (inputRejected) return;
      const message = parseClientMessage(raw);
      if (message === null) {
        send(socket, { type: "error", message: "Invalid terminal message." });
        return;
      }

      if (process === null) {
        pendingBytes += message.type === "input" ? Buffer.byteLength(message.data) : 16;
        pendingMessageCount += 1;
        if (pendingBytes > MAX_PENDING_INPUT_BYTES || pendingMessageCount > MAX_PENDING_MESSAGES) {
          inputRejected = true;
          send(socket, { type: "error", message: "Too much input before attachment." });
          socket.close(1009, "Input buffer exceeded");
          return;
        }
        pendingMessages.push(message);
        return;
      }
      dispatch(process, message);
    });

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      try {
        process?.kill();
      } catch {
        // The PTY may already have exited.
      }
    };
    socket.on("close", dispose);
    socket.on("error", dispose);

    void this.startAttachment({
      socket,
      sessionName,
      cwd,
      isDisposed: () => disposed,
      onStarted: (startedProcess) => {
        process = startedProcess;
        dataSubscription = process.onData((data) => {
          send(socket, { type: "data", data });
        });
        exitSubscription = process.onExit(({ exitCode }) => {
          send(socket, { type: "exit", exitCode });
          socket.close(1000, "Terminal exited");
          dispose();
        });
        for (const message of pendingMessages) {
          dispatch(process, message);
        }
        pendingMessages.length = 0;
      }
    });
  }

  private async startAttachment(input: {
    readonly socket: BrowserTerminalSocket;
    readonly sessionName: string;
    readonly cwd: string;
    readonly isDisposed: () => boolean;
    readonly onStarted: (process: PseudoTerminal) => void;
  }): Promise<void> {
    const history = await this.history.read(input.sessionName).catch(() => "");
    if (input.isDisposed()) return;
    if (history !== "") {
      send(input.socket, {
        type: "data",
        data: `${history.replace(/\r?\n/gu, "\r\n")}\r\n`
      });
    }

    try {
      input.onStarted(this.terminals.attach(input.sessionName, input.cwd));
    } catch (error: unknown) {
      send(input.socket, {
        type: "error",
        message: error instanceof Error ? error.message : "Unable to attach terminal."
      });
      input.socket.close(1011, "Terminal failed");
    }
  }
}

function dispatch(process: PseudoTerminal, message: TerminalClientMessage): void {
  if (message.type === "input") {
    process.write(message.data);
  } else {
    process.resize(message.cols, message.rows);
  }
}

function parseClientMessage(raw: unknown): TerminalClientMessage | null {
  try {
    const serialized =
      typeof raw === "string"
        ? raw
        : raw instanceof Uint8Array
          ? Buffer.from(raw).toString("utf8")
          : String(raw);
    const parsed: unknown = JSON.parse(serialized);
    const result = terminalClientMessageSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function send(socket: BrowserTerminalSocket, message: TerminalServerMessage): void {
  // ws.OPEN is 1. Keeping the boundary structural avoids coupling this module to ws.
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}
