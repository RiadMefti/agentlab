import type { Conversation } from "@orchestrator/contracts";

interface ConversationReelProps {
  readonly conversations: readonly Conversation[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}

export function ConversationReel({ conversations, selectedId, onSelect }: ConversationReelProps) {
  return (
    <nav className="reel" aria-label="Conversations">
      <div className="reel-label">Conversations</div>
      {conversations.map((conversation, index) => (
        <button
          className={`conversation${conversation.id === selectedId ? " active" : ""}`}
          type="button"
          key={conversation.id}
          aria-current={conversation.id === selectedId ? "page" : undefined}
          onClick={() => {
            onSelect(conversation.id);
          }}
        >
          <span className="number">{String(index + 1).padStart(2, "0")}</span>
          <span className="conversation-copy">
            <strong>{conversation.title}</strong>
            <small>
              {conversation.provider}
              {conversation.model === null ? "" : ` · ${conversation.model}`}
            </small>
          </span>
        </button>
      ))}
    </nav>
  );
}
