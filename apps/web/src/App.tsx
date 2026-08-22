import { lazy, Suspense, useState } from "react";

import { useQuery } from "@tanstack/react-query";

import { ApiClientError } from "./api/client.js";
import {
  conversationQuery,
  providerQuery,
  sessionQuery,
  useCreateConversation
} from "./api/queries.js";
import { AgentTabs } from "./components/AgentTabs.js";
import { AppearancePicker } from "./components/AppearancePicker.js";
import { ConversationReel } from "./components/ConversationReel.js";
import { EmptyState } from "./components/EmptyState.js";
import { NewConversationDialog } from "./components/NewConversationDialog.js";

const TerminalPane = lazy(() => import("./components/TerminalPane.js"));

export function App() {
  const providers = useQuery(providerQuery);
  const conversations = useQuery(conversationQuery);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedSessionName, setSelectedSessionName] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const createConversation = useCreateConversation();

  const conversationList = conversations.data?.conversations ?? [];
  const selectedConversation =
    conversationList.find(({ id }) => id === selectedConversationId) ?? conversationList[0] ?? null;
  const effectiveConversationId = selectedConversation?.id ?? null;
  const sessions = useQuery(sessionQuery(effectiveConversationId));
  const sessionList = sessions.data?.sessions ?? [];
  const selectedSession =
    sessionList.find(({ name }) => name === selectedSessionName) ?? sessionList[0] ?? null;

  if (conversations.isError) {
    return (
      <div className="app app-empty">
        <EmptyState error={errorMessage(conversations.error)} onCreate={() => undefined} />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">orchestrator</div>
        <div className="current">{selectedConversation?.title ?? ""}</div>
        <AgentTabs
          sessions={sessionList}
          selectedName={selectedSession?.name ?? null}
          onSelect={setSelectedSessionName}
        />
        <AppearancePicker />
        <button
          className="new"
          type="button"
          aria-label="New conversation"
          title="New conversation"
          onClick={() => {
            setDialogOpen(true);
          }}
        >
          +
        </button>
      </header>

      {sessions.isError ? (
        <EmptyState error={errorMessage(sessions.error)} onCreate={() => undefined} />
      ) : selectedConversation !== null && selectedSession !== null ? (
        <Suspense fallback={<TerminalPlaceholder label={selectedSession.label} />}>
          <TerminalPane conversationId={selectedConversation.id} session={selectedSession} />
        </Suspense>
      ) : (
        <EmptyState
          onCreate={() => {
            setDialogOpen(true);
          }}
        />
      )}

      <ConversationReel
        conversations={conversationList}
        selectedId={effectiveConversationId}
        onSelect={(id) => {
          setSelectedConversationId(id);
          setSelectedSessionName(null);
        }}
      />

      {dialogOpen ? (
        <NewConversationDialog
          providers={providers.data?.providers ?? []}
          pending={createConversation.isPending}
          error={
            createConversation.error !== null
              ? errorMessage(createConversation.error)
              : providers.isError
                ? errorMessage(providers.error)
                : null
          }
          onCancel={() => {
            if (!createConversation.isPending) {
              createConversation.reset();
              setDialogOpen(false);
            }
          }}
          onCreate={(input) => {
            createConversation.mutate(input, {
              onSuccess: (conversation) => {
                setSelectedConversationId(conversation.id);
                setSelectedSessionName(conversation.captainSessionName);
                setDialogOpen(false);
              }
            });
          }}
        />
      ) : null}
    </div>
  );
}

function TerminalPlaceholder({ label }: { readonly label: string }) {
  return (
    <main className="terminal-main">
      <section className="terminal-shell">
        <div className="session-heading">
          <h1>{label}</h1>
          <p>Loading terminal…</p>
        </div>
      </section>
    </main>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError || error instanceof Error) return error.message;
  return "Unexpected local error.";
}
