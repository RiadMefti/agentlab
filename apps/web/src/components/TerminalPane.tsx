import { useLayoutEffect, useRef, useState } from "react";

import {
  sessionHistoryLimit,
  terminalServerMessageSchema,
  type AgentSession
} from "@orchestrator/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { terminalThemeFor } from "../theme/theme-palette.js";
import { useTheme } from "../theme/use-theme.js";

interface TerminalPaneProps {
  readonly conversationId: string;
  readonly session: AgentSession;
}

const initialDimensionsFallbackMs = 500;

export function TerminalPane({ conversationId, session }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const { resolvedTheme } = useTheme();
  const resolvedThemeRef = useRef(resolvedTheme);
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "connected" | "closed">("connecting");

  useLayoutEffect(() => {
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
      minimumContrastRatio: 4.5,
      scrollback: sessionHistoryLimit,
      theme: terminalThemeFor(resolvedThemeRef.current)
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const path = `/api/conversations/${encodeURIComponent(conversationId)}/sessions/${encodeURIComponent(session.name)}/terminal`;
    const socket = new WebSocket(`${protocol}//${window.location.host}${path}`);
    let fallbackTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastSentDimensions: string | null = null;

    const applyDimensions = (cols: number, rows: number): boolean => {
      if (!active || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1) {
        return false;
      }
      const boundedCols = Math.min(cols, 1_000);
      const boundedRows = Math.min(rows, 1_000);
      if (terminal.cols !== boundedCols || terminal.rows !== boundedRows) {
        terminal.resize(boundedCols, boundedRows);
      }
      if (socket.readyState !== WebSocket.OPEN) return false;

      const dimensions = `${String(boundedCols)}x${String(boundedRows)}`;
      if (dimensions !== lastSentDimensions) {
        socket.send(JSON.stringify({ type: "resize", cols: boundedCols, rows: boundedRows }));
        lastSentDimensions = dimensions;
      }
      if (fallbackTimeout !== null) {
        clearTimeout(fallbackTimeout);
        fallbackTimeout = null;
      }
      return true;
    };
    const resize = (): boolean => {
      const dimensions = fit.proposeDimensions();
      return dimensions === undefined ? false : applyDimensions(dimensions.cols, dimensions.rows);
    };
    const observer = new ResizeObserver(() => {
      resize();
    });
    observer.observe(container);

    socket.addEventListener("open", () => {
      if (!active) return;
      setConnection("connected");
      if (!resize()) {
        fallbackTimeout = setTimeout(() => {
          applyDimensions(terminal.cols, terminal.rows);
        }, initialDimensionsFallbackMs);
      }
      terminal.focus();
    });
    socket.addEventListener("message", (event) => {
      if (!active) return;
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
      if (fallbackTimeout !== null) clearTimeout(fallbackTimeout);
      input.dispose();
      observer.disconnect();
      socket.close();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [attempt, conversationId, session.name]);

  useLayoutEffect(() => {
    resolvedThemeRef.current = resolvedTheme;
    const terminal = terminalRef.current;
    if (terminal !== null) terminal.options.theme = terminalThemeFor(resolvedTheme);
  }, [resolvedTheme]);

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
