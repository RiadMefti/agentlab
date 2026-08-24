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
import {
  initialWorkspaceSelection,
  removeConversation,
  resolveSession,
  selectConversation,
  selectSession
} from "./workspace-selection.js";

const TerminalPane = lazy(() => import("./components/TerminalPane.js"));

export function App() {
  const providers = useQuery(providerQuery);
  const conversations = useQuery(conversationQuery);
  const [selection, setSelection] = useState(initialWorkspaceSelection);
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
    conversationList.find(({ id }) => id === selection.conversationId) ??
    conversationList[0] ??
    null;
  const effectiveConversationId = selectedConversation?.id ?? null;
  const sessions = useQuery(sessionQuery(effectiveConversationId));
  const sessionList = sessions.data?.sessions ?? [];
  const selectedSession = resolveSession(
    sessionList,
    effectiveConversationId === null
      ? null
      : (selection.sessionNames[effectiveConversationId] ?? null)
  );

  if (conversations.isError && conversations.data === undefined) {
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
            setSelection((current) => selectConversation(current, conversation));
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
          {conversations.isPending ? (
            <TerminalPlaceholder label="Orchestrator" message="Loading conversations…" />
          ) : sessions.isError && sessions.data === undefined ? (
            <EmptyState error={errorMessage(sessions.error)} onCreate={() => undefined} />
          ) : selectedConversation !== null && sessions.isPending ? (
            <TerminalPlaceholder
              label={selectedConversation.title}
              message="Loading conversation…"
            />
          ) : selectedConversation !== null && selectedSession !== null ? (
            <Suspense fallback={<TerminalPlaceholder label={selectedSession.label} />}>
              <TerminalPane
                key={`${selectedConversation.id}:${selectedSession.name}`}
                conversationId={selectedConversation.id}
                session={selectedSession}
              />
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
          onSelect={(sessionName) => {
            if (effectiveConversationId !== null) {
              setSelection((current) =>
                selectSession(current, effectiveConversationId, sessionName)
              );
            }
          }}
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
                setSelection((current) => selectConversation(current, conversation));
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
                  setSelection((current) =>
                    selectSession(current, selectedConversation.id, sessionName)
                  );
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
                setSelection((current) =>
                  removeConversation(current, masterToDelete.id, nextMaster)
                );
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
                  setSelection((current) =>
                    selectSession(
                      current,
                      selectedConversation.id,
                      selectedConversation.captainSessionName
                    )
                  );
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

function TerminalPlaceholder({
  label,
  message = "Loading terminal…"
}: {
  readonly label: string;
  readonly message?: string;
}) {
  return (
    <main className="terminal-main">
      <section className="terminal-shell">
        <div className="session-heading">
          <h1>{label}</h1>
          <p>{message}</p>
        </div>
      </section>
    </main>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError || error instanceof Error) return error.message;
  return "Unexpected local error.";
}
