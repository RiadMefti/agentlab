import type { AgentSession } from "@orchestrator/contracts";

interface WorkerTabsProps {
  readonly sessions: readonly AgentSession[];
  readonly selectedName: string | null;
  readonly canCreate: boolean;
  readonly onSelect: (name: string) => void;
  readonly onCreate: () => void;
  readonly onDelete: (session: AgentSession) => void;
}

export function WorkerTabs({
  sessions,
  selectedName,
  canCreate,
  onSelect,
  onCreate,
  onDelete
}: WorkerTabsProps) {
  const workers = sessions.filter((session) => session.role === "worker");

  return (
    <nav className="side-tabs worker-tabs" aria-label="Agents">
      <header className="side-tabs-header">
        <span>Agents</span>
        {canCreate ? (
          <button
            className="side-tabs-add"
            type="button"
            aria-label="New agent"
            title="New agent"
            onClick={onCreate}
          >
            +
          </button>
        ) : null}
      </header>
      <div className="side-tabs-list">
        {workers.map((session) => {
          const selected = session.name === selectedName;
          return (
            <div className={`side-tab${selected ? " active" : ""}`} key={session.name}>
              <button
                className="side-tab-select"
                type="button"
                title={`${session.provider} · ${session.status}`}
                aria-label={session.label}
                aria-current={selected ? "page" : undefined}
                onClick={() => {
                  onSelect(session.name);
                }}
              >
                <strong>{session.label}</strong>
                <small>
                  {session.provider}
                  {session.status === "stopped" ? " · stopped" : ""}
                </small>
              </button>
              {selected ? (
                <button
                  className="side-tab-delete"
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
      </div>
    </nav>
  );
}
