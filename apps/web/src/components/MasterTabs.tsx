import type { Conversation } from "@orchestrator/contracts";

interface MasterTabsProps {
  readonly conversations: readonly Conversation[];
  readonly selectedId: string | null;
  readonly onSelect: (conversation: Conversation) => void;
  readonly onCreate: () => void;
  readonly onDelete: (conversation: Conversation) => void;
}

export function MasterTabs({
  conversations,
  selectedId,
  onSelect,
  onCreate,
  onDelete
}: MasterTabsProps) {
  return (
    <nav className="side-tabs master-tabs" aria-label="Masters">
      <header className="side-tabs-header">
        <span>Masters</span>
        <button
          className="side-tabs-add"
          type="button"
          aria-label="New master"
          title="New master"
          onClick={onCreate}
        >
          +
        </button>
      </header>
      <div className="side-tabs-list">
        {conversations.map((conversation) => {
          const selected = conversation.id === selectedId;
          return (
            <div className={`side-tab${selected ? " active" : ""}`} key={conversation.id}>
              <button
                className="side-tab-select"
                type="button"
                aria-label={conversation.title}
                aria-current={selected ? "page" : undefined}
                onClick={() => {
                  onSelect(conversation);
                }}
              >
                <strong>{conversation.title}</strong>
                <small>
                  {conversation.provider}
                  {conversation.model === null ? "" : ` · ${conversation.model}`}
                </small>
              </button>
              {selected ? (
                <button
                  className="side-tab-delete"
                  type="button"
                  aria-label={`Delete ${conversation.title}`}
                  title={`Delete ${conversation.title}`}
                  onClick={() => {
                    onDelete(conversation);
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
