import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { terminalScrollbackBytes, type AgentSession } from "@agentlab/contracts";
import { useKeyboard, useRenderer } from "@opentui/react";
import { maximumTerminalDimension, type SessionTerminal } from "@agentlab/runtime";

import "../terminal/embedded-terminal.js";
import {
  terminalChildMouseInputEnabled,
  type EmbeddedTerminalRenderable
} from "../terminal/embedded-terminal.js";
import { TerminalIngestionPump } from "../terminal/terminal-ingestion-pump.js";
import { useRuntime } from "../runtime-context.js";
import { palette } from "../theme.js";

interface Dimensions {
  readonly columns: number;
  readonly rows: number;
}

interface TerminalTarget {
  readonly conversationId: string;
  readonly session: AgentSession;
}

const RESET_TERMINAL = "\x1bc";

export function boundTerminalDimensions(columns: number, rows: number): Dimensions {
  return {
    columns: Math.min(columns, maximumTerminalDimension),
    rows: Math.min(rows, maximumTerminalDimension)
  };
}

export function TerminalPanel({
  conversationId,
  session,
  active,
  onActivate
}: {
  readonly conversationId: string | null;
  readonly session: AgentSession | null;
  readonly active: boolean;
  readonly onActivate: () => void;
}) {
  const runtime = useRuntime();
  const renderer = useRenderer();
  const terminalRef = useRef<EmbeddedTerminalRenderable>(null);
  const attachmentRef = useRef<SessionTerminal | null>(null);
  const dimensionsRef = useRef<Dimensions | null>(null);
  const layoutReadyRef = useRef(false);
  const [layoutReady, setLayoutReady] = useState(false);
  const requestedTarget = useMemo<TerminalTarget | null>(
    () =>
      conversationId !== null && session?.conversationId === conversationId
        ? { conversationId, session }
        : null,
    [conversationId, session]
  );
  const requestedKey = terminalTargetKey(requestedTarget);
  const [displayedKey, setDisplayedKey] = useState<string | null>(requestedKey);
  const [connection, setConnection] = useState<"idle" | "connecting" | "connected" | "closed">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);
  const targetConversationId = requestedTarget?.conversationId ?? null;
  const targetSession = requestedTarget?.session ?? null;
  const sessionName = targetSession?.name ?? null;
  const switching =
    conversationId !== null && (requestedKey === null || requestedKey !== displayedKey);

  const onResize = useCallback((columns: number, rows: number) => {
    if (columns < 2 || rows < 1) return;
    const bounded = boundTerminalDimensions(columns, rows);
    const previous = dimensionsRef.current;
    if (previous?.columns === bounded.columns && previous.rows === bounded.rows) return;
    dimensionsRef.current = bounded;
    attachmentRef.current?.resize(bounded.columns, bounded.rows);
    if (!layoutReadyRef.current) {
      layoutReadyRef.current = true;
      setLayoutReady(true);
    }
  }, []);

  useEffect(() => {
    if (active && connection === "connected" && !switching) terminalRef.current?.focus();
    else terminalRef.current?.blur();
  }, [active, connection, layoutReady, sessionName, switching]);

  useEffect(() => {
    if (!layoutReady || targetConversationId === null || sessionName === null) return;
    const dimensions = dimensionsRef.current;
    if (dimensions === null) return;
    let current = true;
    let ownedTerminal: SessionTerminal | null = null;
    let exitReported = false;
    const pump = new TerminalIngestionPump({
      write(data) {
        if (current) terminalRef.current?.write(data);
      },
      invalidate() {
        if (current) terminalRef.current?.invalidate();
      },
      onOverrun() {
        if (!current) return;
        current = false;
        ownedTerminal?.close();
        if (attachmentRef.current === ownedTerminal) attachmentRef.current = null;
        setConnection("closed");
        setError(
          "Terminal output outran the renderer; switch away and back to reconnect from tmux."
        );
      }
    });
    setConnection("connecting");
    setError(null);

    void runtime
      .openTerminal({
        conversationId: targetConversationId,
        sessionName,
        columns: dimensions.columns,
        rows: dimensions.rows,
        callbacks: {
          onData(data) {
            if (current) pump.enqueue(data);
          },
          onExit(exitCode) {
            if (!current || exitReported) return;
            exitReported = true;
            pump.enqueue(`\r\n[session client exited ${String(exitCode)}]\r\n`);
            setConnection("closed");
          }
        }
      })
      .then(({ history, terminal, releaseBufferedOutput }) => {
        if (!current) {
          terminal.close();
          return;
        }
        ownedTerminal = terminal;
        attachmentRef.current = terminal;
        const latest = dimensionsRef.current;
        if (
          latest !== null &&
          (latest.columns !== dimensions.columns || latest.rows !== dimensions.rows)
        ) {
          terminal.resize(latest.columns, latest.rows);
        }
        if (!pump.enqueue(RESET_TERMINAL)) return;
        if (history !== "" && !pump.enqueue(normalizeHistory(history))) return;
        if (
          !pump.finishHistory(() => {
            if (!current) return;
            setDisplayedKey(terminalTargetKeyFromParts(targetConversationId, sessionName));
            setConnection(exitReported ? "closed" : "connected");
          })
        ) {
          return;
        }
        // The pump boundary, rather than runtime buffering, now owns history-before-live order.
        // Releasing here puts all captured and future PTY bytes under the same explicit limit.
        const release = releaseBufferedOutput();
        if (release.overrun) {
          pump.cancel();
          current = false;
          terminal.close();
          if (attachmentRef.current === terminal) attachmentRef.current = null;
          setConnection("closed");
          setError(
            "Terminal attach output exceeded its safe buffer; switch away and back to resync from tmux."
          );
        }
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setConnection("closed");
        setError(cause instanceof Error ? cause.message : "Unable to attach terminal.");
      });
    const renderedTerminal = terminalRef.current;

    return () => {
      current = false;
      pump.cancel();
      renderedTerminal?.clearLocalSelection();
      renderedTerminal?.blur();
      ownedTerminal?.close();
      if (attachmentRef.current === ownedTerminal) attachmentRef.current = null;
    };
  }, [layoutReady, runtime, sessionName, targetConversationId]);

  useKeyboard((key) => {
    const copyShortcut =
      (key.ctrl && key.shift && key.name === "c") || (key.meta && key.name === "c");
    if (!active || !copyShortcut) return;
    const selected = terminalRef.current?.getSelectedText() ?? "";
    if (selected !== "") renderer.copyToClipboardOSC52(selected);
    key.preventDefault();
    key.stopPropagation();
  });

  if (conversationId === null) {
    return (
      <box
        flexGrow={1}
        alignItems="center"
        justifyContent="center"
        backgroundColor={palette.terminalBackground}
        onMouseDown={onActivate}
      >
        <box flexDirection="column" alignItems="center">
          <text fg={palette.text} attributes={1}>
            Choose a project
          </text>
          <text fg={palette.muted}>
            Select a saved folder on the left, or press Alt+N to add one.
          </text>
        </box>
      </box>
    );
  }

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      backgroundColor={palette.terminalBackground}
      onMouseDown={onActivate}
    >
      <box
        height={2}
        flexDirection="row"
        paddingX={1}
        alignItems="center"
        justifyContent="space-between"
        border={["bottom"]}
        borderColor={active ? palette.borderActive : palette.border}
        backgroundColor={palette.panel}
      >
        <text fg={palette.text} attributes={1} wrapMode="none" truncate flexShrink={1}>
          {targetSession?.label ?? "Agent"}
          <span fg={palette.muted} attributes={0}>
            {`  /  ${providerLabel(targetSession?.provider)}`}
          </span>
        </text>
        <text fg={connectionColor(connection, switching)} flexShrink={0}>
          {connectionLabel(targetSession ?? undefined, connection, switching)}
        </text>
      </box>
      <agent-terminal
        key={requestedKey ?? "no-terminal-session"}
        ref={terminalRef}
        maxScrollback={terminalScrollbackBytes}
        childMouseInput={terminalChildMouseInputEnabled()}
        onActivate={onActivate}
        sessionConnected={connection === "connected" && !switching}
        selectable
        onData={(data) => {
          attachmentRef.current?.write(data);
        }}
        onTerminalResize={onResize}
        style={{ flexGrow: 1, height: "auto", minHeight: 1, width: "100%" }}
      />
      {error === null ? null : (
        <box height={1} paddingX={1} backgroundColor={palette.panelRaised}>
          <text fg={palette.danger} wrapMode="none" truncate>
            {error}
          </text>
        </box>
      )}
    </box>
  );
}

function normalizeHistory(history: string): string {
  const normalized = history.replace(/\r?\n/gu, "\r\n");
  return normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
}

function providerLabel(provider: AgentSession["provider"] | undefined): string {
  if (provider === "opencode") return "OpenCode";
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  return "Agent";
}

function connectionLabel(
  session: AgentSession | undefined,
  connection: "idle" | "connecting" | "connected" | "closed",
  switching: boolean
): string {
  if (switching && connection !== "closed") return "○ switching";
  if (connection === "connecting") return "○ connecting";
  if (connection === "closed") return "× disconnected";
  if (connection === "connected" && session?.status === "running") return "● live";
  return "○ stopped";
}

function connectionColor(
  connection: "idle" | "connecting" | "connected" | "closed",
  switching: boolean
): string {
  if (connection === "closed") return palette.danger;
  if (switching || connection === "connecting" || connection === "idle") return palette.muted;
  return palette.running;
}

function terminalTargetKey(target: TerminalTarget | null): string | null {
  return target === null
    ? null
    : terminalTargetKeyFromParts(target.conversationId, target.session.name);
}

function terminalTargetKeyFromParts(conversationId: string, sessionName: string): string {
  return `${conversationId}\0${sessionName}`;
}
