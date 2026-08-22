import { useEffect, useRef, useState } from "react";

import {
  sessionHistoryLimit,
  terminalServerMessageSchema,
  type AgentSession
} from "@orchestrator/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

interface TerminalPaneProps {
  readonly conversationId: string;
  readonly session: AgentSession;
}

export function TerminalPane({ conversationId, session }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "connected" | "closed">("connecting");

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    let active = true;
    setConnection("connecting");
    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: sessionHistoryLimit,
      theme: {
        background: "#fafafa",
        foreground: "#292929",
        cursor: "#171717",
        cursorAccent: "#fafafa",
        selectionBackground: "#dedede",
        black: "#171717",
        brightBlack: "#777777",
        white: "#d7d7d7",
        brightWhite: "#ffffff"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const path = `/api/conversations/${encodeURIComponent(conversationId)}/sessions/${encodeURIComponent(session.name)}/terminal`;
    const socket = new WebSocket(`${protocol}//${window.location.host}${path}`);

    const resize = (): void => {
      if (!active) return;
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);

    socket.addEventListener("open", () => {
      if (!active) return;
      setConnection("connected");
      resize();
      terminal.focus();
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(event.data);
      } catch {
        return;
      }
      const result = terminalServerMessageSchema.safeParse(decoded);
      if (!result.success) return;
      if (result.data.type === "data") terminal.write(result.data.data);
      if (result.data.type === "error") {
        terminal.writeln(`\r\n${result.data.message}`);
      }
    });
    socket.addEventListener("close", () => {
      if (active) setConnection("closed");
    });
    socket.addEventListener("error", () => {
      if (active) setConnection("closed");
    });

    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    return () => {
      active = false;
      input.dispose();
      observer.disconnect();
      socket.close();
      terminal.dispose();
    };
  }, [attempt, conversationId, session.name]);

  return (
    <main className="terminal-main">
      <section className="terminal-shell" aria-label={`${session.label} terminal`}>
        <div className="session-heading">
          <h1>{session.label}</h1>
          <p>
            {session.provider} · {session.status}
            {connection === "connecting" ? " · connecting" : ""}
          </p>
        </div>
        <div className="terminal-mount" ref={containerRef} />
        {connection === "closed" ? (
          <button
            type="button"
            className="reconnect"
            onClick={() => {
              setAttempt((value) => value + 1);
            }}
          >
            Reconnect
          </button>
        ) : null}
      </section>
    </main>
  );
}

export default TerminalPane;
