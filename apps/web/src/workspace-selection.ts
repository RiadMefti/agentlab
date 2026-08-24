import type { AgentSession, Conversation } from "@orchestrator/contracts";

export interface WorkspaceSelection {
  readonly conversationId: string | null;
  readonly sessionNames: Readonly<Record<string, string>>;
}

export const initialWorkspaceSelection: WorkspaceSelection = {
  conversationId: null,
  sessionNames: {}
};

export function selectConversation(
  selection: WorkspaceSelection,
  conversation: Conversation
): WorkspaceSelection {
  return {
    conversationId: conversation.id,
    sessionNames:
      selection.sessionNames[conversation.id] === undefined
        ? { ...selection.sessionNames, [conversation.id]: conversation.captainSessionName }
        : selection.sessionNames
  };
}

export function selectSession(
  selection: WorkspaceSelection,
  conversationId: string,
  sessionName: string
): WorkspaceSelection {
  return {
    conversationId,
    sessionNames: { ...selection.sessionNames, [conversationId]: sessionName }
  };
}

export function removeConversation(
  selection: WorkspaceSelection,
  conversationId: string,
  nextConversation: Conversation | null
): WorkspaceSelection {
  const sessionNames = Object.fromEntries(
    Object.entries(selection.sessionNames).filter(([id]) => id !== conversationId)
  );
  return nextConversation === null
    ? { conversationId: null, sessionNames }
    : selectConversation({ conversationId: nextConversation.id, sessionNames }, nextConversation);
}

export function resolveSession(
  sessions: readonly AgentSession[],
  preferredName: string | null
): AgentSession | null {
  return (
    sessions.find(({ name }) => name === preferredName) ??
    sessions.find(({ role }) => role === "captain") ??
    sessions[0] ??
    null
  );
}
