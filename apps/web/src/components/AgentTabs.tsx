import type { AgentSession } from "@orchestrator/contracts";

interface AgentTabsProps {
  readonly sessions: readonly AgentSession[];
  readonly selectedName: string | null;
  readonly canCreate: boolean;
  readonly onSelect: (name: string) => void;
  readonly onCreate: () => void;
  readonly onDelete: (session: AgentSession) => void;
}

export function AgentTabs({
  sessions,
  selectedName,
  canCreate,
  onSelect,
  onCreate,
  onDelete
}: AgentTabsProps) {
  return (
    <nav className="agents" aria-label="Captain and agents">
      {sessions.map((session) => {
        const selected = session.name === selectedName;
        return (
          <div className="agent-tab" key={session.name}>
            <button
              className={`agent${selected ? " active" : ""}`}
              type="button"
              title={`${session.provider} · ${session.status}`}
              aria-current={selected ? "page" : undefined}
              onClick={() => {
                onSelect(session.name);
              }}
            >
              {session.label}
              {session.status === "stopped" ? " — stopped" : ""}
            </button>
            {selected && session.role === "worker" ? (
              <button
                className="agent-delete"
                type="button"
                aria-label={`Delete ${session.label}`}
                title={`Delete ${session.label}`}
                onClick={() => {
                  onDelete(session);
                }}
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
      {canCreate ? (
        <button
          className="agent-add"
          type="button"
          aria-label="New agent"
          title="New agent"
          onClick={onCreate}
        >
          +
        </button>
      ) : null}
    </nav>
  );
}
