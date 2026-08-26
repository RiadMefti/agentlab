import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentSession, Conversation, ProviderCapability } from "@agentlab/contracts";

import { useRuntime } from "./runtime-context.js";

const SESSION_REFRESH_MS = 1_000;
const NO_SESSIONS: readonly AgentSession[] = [];
const NO_PROVIDERS: readonly ProviderCapability[] = [];

interface SessionError {
  readonly conversationId: string;
  readonly message: string;
}

export interface WorkspaceState {
  readonly projects: readonly Conversation[];
  readonly providers: readonly ProviderCapability[];
  readonly sessions: readonly AgentSession[];
  readonly selectedProject: Conversation | null;
  readonly selectedSession: AgentSession | null;
  readonly loading: boolean;
  readonly error: string | null;
  selectProject(id: string): void;
  selectSession(name: string): void;
  refreshProjects(): Promise<void>;
  refreshSessions(): Promise<void>;
}

export function useWorkspace(): WorkspaceState {
  const runtime = useRuntime();
  const [conversations, setConversations] = useState<readonly Conversation[]>([]);
  const [sessionsByConversation, setSessionsByConversation] = useState<
    Readonly<Record<string, readonly AgentSession[]>>
  >({});
  const [providersByConversation, setProvidersByConversation] = useState<
    Readonly<Record<string, readonly ProviderCapability[]>>
  >({});
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [sessionNames, setSessionNames] = useState<Readonly<Record<string, string>>>({});
  const [loading, setLoading] = useState(true);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<SessionError | null>(null);
  const [providerError, setProviderError] = useState<SessionError | null>(null);
  const conversationRequest = useRef(0);
  const sessionRequest = useRef(0);
  const providerRequest = useRef(0);
  const selectedProject =
    conversationId === null
      ? null
      : (conversations.find(({ id }) => id === conversationId) ?? null);
  const selectedConversationId = selectedProject?.id ?? null;
  const visibleSessions =
    selectedConversationId === null
      ? NO_SESSIONS
      : (sessionsByConversation[selectedConversationId] ?? NO_SESSIONS);
  const visibleProviders =
    selectedConversationId === null
      ? NO_PROVIDERS
      : (providersByConversation[selectedConversationId] ?? NO_PROVIDERS);
  const selectedSession = resolveSession(
    visibleSessions,
    selectedProject === null ? null : (sessionNames[selectedProject.id] ?? null)
  );
  const error =
    conversationError ??
    (providerError?.conversationId === selectedConversationId ? providerError.message : null) ??
    (sessionError?.conversationId === selectedConversationId ? sessionError.message : null);

  const refreshConversations = useCallback(async () => {
    const request = ++conversationRequest.current;
    try {
      const next = await runtime.commands.listConversations();
      if (request !== conversationRequest.current) return;
      setConversations(next);
      setConversationError(null);
    } catch (cause: unknown) {
      if (request === conversationRequest.current) {
        setConversationError(errorMessage(cause));
      }
    }
  }, [runtime]);

  const refreshSessions = useCallback(async () => {
    const request = ++sessionRequest.current;
    const id = selectedConversationId;
    if (id === null) return;
    try {
      const next = await runtime.commands.listSessions(id);
      if (request !== sessionRequest.current) return;
      setSessionsByConversation((current) =>
        sameSessions(current[id] ?? NO_SESSIONS, next) ? current : { ...current, [id]: next }
      );
      setSessionError(null);
    } catch (cause: unknown) {
      if (request === sessionRequest.current) {
        setSessionError({ conversationId: id, message: errorMessage(cause) });
      }
    }
  }, [runtime, selectedConversationId]);

  const refreshProviders = useCallback(async () => {
    const request = ++providerRequest.current;
    const id = selectedConversationId;
    if (id === null) return;
    try {
      const next = await runtime.commands.listProviders(id);
      if (request !== providerRequest.current) return;
      setProvidersByConversation((current) => ({ ...current, [id]: next }));
      setProviderError(null);
    } catch (cause: unknown) {
      if (request === providerRequest.current) {
        setProviderError({ conversationId: id, message: errorMessage(cause) });
      }
    }
  }, [runtime, selectedConversationId]);

  useEffect(() => {
    let active = true;
    const initialRefresh = setTimeout(() => {
      void refreshConversations().finally(() => {
        if (active) setLoading(false);
      });
    }, 0);
    return () => {
      active = false;
      clearTimeout(initialRefresh);
      conversationRequest.current += 1;
    };
  }, [refreshConversations]);

  useEffect(() => {
    if (selectedConversationId === null) {
      sessionRequest.current += 1;
      return;
    }

    let cancelled = false;
    let nextRefresh: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<void> => {
      await refreshSessions();
      if (!cancelled) {
        nextRefresh = setTimeout(() => {
          void poll();
        }, SESSION_REFRESH_MS);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      sessionRequest.current += 1;
      if (nextRefresh !== null) clearTimeout(nextRefresh);
    };
  }, [refreshSessions, selectedConversationId]);

  useEffect(() => {
    if (selectedConversationId === null) {
      providerRequest.current += 1;
      return;
    }
    const initialRefresh = setTimeout(() => {
      void refreshProviders();
    }, 0);
    return () => {
      clearTimeout(initialRefresh);
      providerRequest.current += 1;
    };
  }, [refreshProviders, selectedConversationId]);

  return useMemo(
    () => ({
      projects: conversations,
      providers: visibleProviders,
      sessions: visibleSessions,
      selectedProject,
      selectedSession,
      loading,
      error,
      selectProject(id: string) {
        setConversationId(id);
      },
      selectSession(name: string) {
        if (selectedProject === null) return;
        setSessionNames((current) => ({ ...current, [selectedProject.id]: name }));
      },
      refreshProjects: refreshConversations,
      refreshSessions
    }),
    [
      conversations,
      visibleProviders,
      visibleSessions,
      selectedProject,
      selectedSession,
      loading,
      error,
      refreshConversations,
      refreshSessions
    ]
  );
}

function sameSessions(left: readonly AgentSession[], right: readonly AgentSession[]): boolean {
  return (
    left.length === right.length &&
    left.every((session, index) => {
      const candidate = right[index];
      return (
        session.name === candidate?.name &&
        session.status === candidate.status &&
        session.attached === candidate.attached &&
        session.startedAt === candidate.startedAt
      );
    })
  );
}

function resolveSession(
  sessions: readonly AgentSession[],
  requestedName: string | null
): AgentSession | null {
  return (
    sessions.find(({ name }) => name === requestedName) ??
    sessions.find(({ role }) => role === "captain") ??
    sessions[0] ??
    null
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected local error.";
}
