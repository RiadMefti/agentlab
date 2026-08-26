import { useEffect, useRef } from "react";

import type { AgentSession } from "@agentlab/contracts";
import type { ScrollBoxRenderable } from "@opentui/core";

import { palette } from "../theme.js";

export function AgentList({
  sessions,
  selectedName,
  active,
  canCreate,
  onSelect,
  onCreate
}: {
  readonly sessions: readonly AgentSession[];
  readonly selectedName: string | null;
  readonly active: boolean;
  readonly canCreate: boolean;
  readonly onSelect: (name: string) => void;
  readonly onCreate: () => void;
}) {
  const captain = sessions.find(({ role }) => role === "captain") ?? null;
  const workers = sessions.filter(({ role }) => role === "worker");
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    if (selectedName === captain?.name) scrollRef.current?.scrollTo(0);
    else if (selectedName !== null)
      scrollRef.current?.scrollChildIntoView(agentRowId(selectedName));
  }, [captain?.name, selectedName, sessions]);

  return (
    <box
      flexDirection="column"
      width="22%"
      minWidth={24}
      maxWidth={34}
      border={["left"]}
      borderColor={active ? palette.borderActive : palette.border}
      backgroundColor={palette.panel}
    >
      <box
        height={2}
        flexDirection="row"
        paddingX={1}
        alignItems="center"
        justifyContent="space-between"
        border={["bottom"]}
        borderColor={palette.border}
        backgroundColor={active ? palette.panelRaised : palette.panel}
      >
        <text fg={active ? palette.accent : palette.text} attributes={1}>
          Agents · {sessions.length}
        </text>
        {canCreate ? (
          <text
            fg={palette.accent}
            onMouseDown={() => {
              onCreate();
            }}
          >
            + New
          </text>
        ) : null}
      </box>

      {captain === null ? null : (
        <box flexDirection="column" border={["bottom"]} borderColor={palette.border}>
          <text fg={palette.muted} attributes={1} marginLeft={1}>
            Captain
          </text>
          <AgentRow
            session={captain}
            selected={captain.name === selectedName}
            onSelect={onSelect}
          />
        </box>
      )}

      <box height={2} paddingX={1} alignItems="center">
        <text fg={palette.muted} attributes={1}>
          Workers · {workers.length}
        </text>
      </box>
      <scrollbox ref={scrollRef} flexGrow={1} focused={active}>
        {workers.length === 0 ? (
          <box paddingX={1} paddingTop={1}>
            <text fg={palette.muted}>No workers.</text>
          </box>
        ) : (
          workers.map((session) => (
            <AgentRow
              key={session.name}
              session={session}
              selected={session.name === selectedName}
              onSelect={onSelect}
            />
          ))
        )}
      </scrollbox>
    </box>
  );
}

function AgentRow({
  session,
  selected,
  onSelect
}: {
  readonly session: AgentSession;
  readonly selected: boolean;
  readonly onSelect: (name: string) => void;
}) {
  return (
    <box
      id={agentRowId(session.name)}
      flexDirection="column"
      paddingX={1}
      minHeight={2}
      backgroundColor={selected ? palette.selection : palette.panel}
      onMouseDown={() => {
        onSelect(session.name);
      }}
    >
      <text
        fg={selected ? palette.text : palette.muted}
        attributes={selected ? 1 : 0}
        wrapMode="none"
        truncate
      >
        <span fg={selected ? palette.accent : palette.muted}>{selected ? "› " : "  "}</span>
        {session.label}
      </text>
      <text
        fg={session.status === "running" ? palette.running : palette.stopped}
        wrapMode="none"
        truncate
      >
        {"  "}
        {session.status === "running" ? "●" : "○"} {session.provider} · {session.status}
      </text>
    </box>
  );
}

function agentRowId(sessionName: string): string {
  return `agent-row-${sessionName}`;
}
