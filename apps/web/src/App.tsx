import { lazy, Suspense, useState } from "react";

import type { AgentSession, Conversation } from "@orchestrator/contracts";
import { useQuery } from "@tanstack/react-query";

import { ApiClientError } from "./api/client.js";
import {
  conversationQuery,
  providerQuery,
  sessionQuery,
  useCreateConversation,
  useCreateWorker,
  useDeleteConversation,
  useDeleteWorker
} from "./api/queries.js";
import { AppearancePicker } from "./components/AppearancePicker.js";
import { DeleteMasterDialog } from "./components/DeleteMasterDialog.js";
import { DeleteWorkerDialog } from "./components/DeleteWorkerDialog.js";
import { EmptyState } from "./components/EmptyState.js";
import { MasterTabs } from "./components/MasterTabs.js";
import { NewConversationDialog } from "./components/NewConversationDialog.js";
import { NewWorkerDialog } from "./components/NewWorkerDialog.js";
import { UpdateButton } from "./components/UpdateButton.js";
import { WorkerTabs } from "./components/WorkerTabs.js";

const TerminalPane = lazy(() => import("./components/TerminalPane.js"));

export function App() {
  const providers = useQuery(providerQuery);
  const conversations = useQuery(conversationQuery);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedSessionName, setSelectedSessionName] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [workerDialogOpen, setWorkerDialogOpen] = useState(false);
  const [masterToDelete, setMasterToDelete] = useState<Conversation | null>(null);
  const [workerToDelete, setWorkerToDelete] = useState<AgentSession | null>(null);
  const createConversation = useCreateConversation();
  const createWorker = useCreateWorker();
  const deleteConversation = useDeleteConversation();
  const deleteWorker = useDeleteWorker();

  const conversationList = conversations.data?.conversations ?? [];
  const selectedConversation =
    conversationList.find(({ id }) => id === selectedConversationId) ?? conversationList[0] ?? null;
  const effectiveConversationId = selectedConversation?.id ?? null;
  const sessions = useQuery(sessionQuery(effectiveConversationId));
  const sessionList = sessions.data?.sessions ?? [];
  const selectedSession =
    sessionList.find(({ name }) => name === selectedSessionName) ??
    sessionList.find(({ role }) => role === "captain") ??
    sessionList[0] ??
    null;

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
        <div className="topbar-actions">
          <UpdateButton />
          <AppearancePicker />
        </div>
      </header>

      <div className="workspace">
        <MasterTabs
          conversations={conversationList}
          selectedId={effectiveConversationId}
          onSelect={(conversation) => {
            setSelectedConversationId(conversation.id);
            setSelectedSessionName(conversation.captainSessionName);
          }}
          onCreate={() => {
            setDialogOpen(true);
          }}
          onDelete={(conversation) => {
            deleteConversation.reset();
            setMasterToDelete(conversation);
          }}
        />

        <div className="active-agent">
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
        </div>

        <WorkerTabs
          sessions={sessionList}
          selectedName={selectedSession?.name ?? null}
          canCreate={selectedConversation !== null}
          onSelect={setSelectedSessionName}
          onCreate={() => {
            createWorker.reset();
            setWorkerDialogOpen(true);
          }}
          onDelete={(worker) => {
            deleteWorker.reset();
            setWorkerToDelete(worker);
          }}
        />
      </div>

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

      {workerDialogOpen && selectedConversation !== null ? (
        <NewWorkerDialog
          providers={providers.data?.providers ?? []}
          pending={createWorker.isPending}
          error={
            createWorker.error !== null
              ? errorMessage(createWorker.error)
              : providers.isError
                ? errorMessage(providers.error)
                : null
          }
          onCancel={() => {
            if (!createWorker.isPending) {
              createWorker.reset();
              setWorkerDialogOpen(false);
            }
          }}
          onCreate={(input) => {
            createWorker.mutate(
              { conversationId: selectedConversation.id, input },
              {
                onSuccess: ({ sessionName }) => {
                  setSelectedSessionName(sessionName);
                  setWorkerDialogOpen(false);
                }
              }
            );
          }}
        />
      ) : null}

      {masterToDelete !== null ? (
        <DeleteMasterDialog
          master={masterToDelete}
          pending={deleteConversation.isPending}
          error={deleteConversation.error === null ? null : errorMessage(deleteConversation.error)}
          onCancel={() => {
            if (!deleteConversation.isPending) {
              deleteConversation.reset();
              setMasterToDelete(null);
            }
          }}
          onConfirm={() => {
            const nextMaster = conversationList.find(({ id }) => id !== masterToDelete.id) ?? null;
            deleteConversation.mutate(masterToDelete.id, {
              onSuccess: () => {
                setSelectedConversationId(nextMaster?.id ?? null);
                setSelectedSessionName(nextMaster?.captainSessionName ?? null);
                setMasterToDelete(null);
              }
            });
          }}
        />
      ) : null}

      {workerToDelete !== null && selectedConversation !== null ? (
        <DeleteWorkerDialog
          worker={workerToDelete}
          pending={deleteWorker.isPending}
          error={deleteWorker.error === null ? null : errorMessage(deleteWorker.error)}
          onCancel={() => {
            if (!deleteWorker.isPending) {
              deleteWorker.reset();
              setWorkerToDelete(null);
            }
          }}
          onConfirm={() => {
            deleteWorker.mutate(
              {
                conversationId: selectedConversation.id,
                sessionName: workerToDelete.name
              },
              {
                onSuccess: () => {
                  setSelectedSessionName(selectedConversation.captainSessionName);
                  setWorkerToDelete(null);
                }
              }
            );
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
