import type { AgentSession } from "@orchestrator/contracts";

interface AgentTabsProps {
  readonly sessions: readonly AgentSession[];
  readonly selectedName: string | null;
  readonly onSelect: (name: string) => void;
}

export function AgentTabs({ sessions, selectedName, onSelect }: AgentTabsProps) {
  return (
    <nav className="agents" aria-label="Captain and agents">
      {sessions.map((session) => (
        <button
          className={`agent${session.name === selectedName ? " active" : ""}`}
          type="button"
          key={session.name}
          title={`${session.provider} · ${session.status}`}
          aria-current={session.name === selectedName ? "page" : undefined}
          onClick={() => {
            onSelect(session.name);
          }}
        >
          {session.label}
          {session.status === "stopped" ? " — stopped" : ""}
        </button>
      ))}
    </nav>
  );
}
