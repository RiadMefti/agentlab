import { useRef, useState } from "react";

import type {
  AgentSession,
  Conversation,
  CreateConversationInput,
  CreateWorkerInput
} from "@orchestrator/contracts";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";

import { AgentList } from "./components/agent-list.js";
import { ConfirmDeleteModal } from "./components/confirm-delete-modal.js";
import { NewProjectModal } from "./components/new-project-modal.js";
import { NewWorkerModal } from "./components/new-worker-modal.js";
import { ProjectList } from "./components/project-list.js";
import { TerminalPanel } from "./components/terminal-panel.js";
import { useRuntime } from "./runtime-context.js";
import { palette } from "./theme.js";
import { errorMessage, useWorkspace } from "./use-workspace.js";

type Pane = "projects" | "terminal" | "agents";
const MINIMUM_TERMINAL_WIDTH = 90;
const MINIMUM_TERMINAL_HEIGHT = 18;
type Modal =
  | { readonly kind: "new-project" }
  | { readonly kind: "new-worker" }
  | { readonly kind: "remove-project"; readonly project: Conversation }
  | { readonly kind: "delete-worker"; readonly session: AgentSession };

export function App() {
  const runtime = useRuntime();
  const renderer = useRenderer();
  const terminalDimensions = useTerminalDimensions();
  const workspace = useWorkspace();
  const [pane, setPane] = useState<Pane>("terminal");
  const [modal, setModal] = useState<Modal | null>(null);
  const [pending, setPending] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const mutationInFlight = useRef(false);
  const shutdownInFlight = useRef(false);

  const requestShutdown = (): void => {
    if (shutdownInFlight.current) return;
    shutdownInFlight.current = true;
    setShuttingDown(true);
    void runtime.close().then(
      () => {
        renderer.destroy();
      },
      () => {
        renderer.destroy();
      }
    );
  };

  const closeModal = (): void => {
    if (mutationInFlight.current) return;
    setMutationError(null);
    setModal(null);
  };

  const openModal = (next: Modal): void => {
    setMutationError(null);
    setModal(next);
  };

  const selectRelativeProject = (delta: number): void => {
    if (workspace.projects.length === 0) return;
    const current = workspace.projects.findIndex(({ id }) => id === workspace.selectedProject?.id);
    const next =
      current < 0
        ? delta > 0
          ? 0
          : workspace.projects.length - 1
        : cycle(current, delta, workspace.projects.length);
    const project = workspace.projects[next];
    if (project !== undefined) workspace.selectProject(project.id);
  };

  const selectRelativeSession = (delta: number): void => {
    if (workspace.sessions.length === 0) return;
    const current = Math.max(
      0,
      workspace.sessions.findIndex(({ name }) => name === workspace.selectedSession?.name)
    );
    const next = cycle(current, delta, workspace.sessions.length);
    const session = workspace.sessions[next];
    if (session !== undefined) workspace.selectSession(session.name);
  };

  useKeyboard((key) => {
    const terminalOwnsControlKeys = pane === "terminal" && workspace.selectedSession !== null;
    if (
      (key.meta && key.name === "q") ||
      (!terminalOwnsControlKeys && key.ctrl && key.name === "q")
    ) {
      key.preventDefault();
      requestShutdown();
      return;
    }
    if (modal !== null) return;
    if (key.meta && ["1", "2", "3"].includes(key.name)) {
      key.preventDefault();
      setPane(key.name === "1" ? "projects" : key.name === "2" ? "terminal" : "agents");
      return;
    }
    if (key.meta && key.name === "n") {
      key.preventDefault();
      openModal({ kind: "new-project" });
      return;
    }
    if (key.meta && key.name === "w") {
      key.preventDefault();
      if (workspace.selectedProject !== null) openModal({ kind: "new-worker" });
      return;
    }
    if (!terminalOwnsControlKeys && key.ctrl && key.name === "n") {
      key.preventDefault();
      openModal(
        key.shift && workspace.selectedProject !== null
          ? { kind: "new-worker" }
          : { kind: "new-project" }
      );
      return;
    }
    if (pane === "terminal") return;
    if (key.name === "tab") {
      key.preventDefault();
      setPane(pane === "projects" ? "agents" : "projects");
      return;
    }
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      const delta = key.name === "up" ? -1 : 1;
      if (pane === "projects") selectRelativeProject(delta);
      else selectRelativeSession(delta);
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      setPane("terminal");
      return;
    }
    if (key.name !== "delete") return;
    key.preventDefault();
    if (pane === "projects" && workspace.selectedProject !== null) {
      openModal({ kind: "remove-project", project: workspace.selectedProject });
    } else if (pane === "agents" && workspace.selectedSession?.role === "worker") {
      openModal({ kind: "delete-worker", session: workspace.selectedSession });
    }
  });

  const runMutation = (operation: () => Promise<void>): void => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setPending(true);
    setMutationError(null);
    void operation()
      .catch((cause: unknown) => {
        setMutationError(errorMessage(cause));
      })
      .finally(() => {
        mutationInFlight.current = false;
        setPending(false);
      });
  };

  const createProject = (input: CreateConversationInput): void => {
    runMutation(async () => {
      const project = await runtime.commands.createConversation(input);
      await workspace.refreshProjects();
      workspace.selectProject(project.id);
      setModal(null);
      setPane("terminal");
    });
  };

  const createWorker = (input: CreateWorkerInput): void => {
    const project = workspace.selectedProject;
    if (project === null) return;
    runMutation(async () => {
      const sessionName = await runtime.commands.createWorker(project.id, input);
      await workspace.refreshSessions();
      workspace.selectSession(sessionName);
      setModal(null);
      setPane("terminal");
    });
  };

  const removeProject = (project: Conversation): void => {
    runMutation(async () => {
      await runtime.commands.deleteConversation(project.id);
      await workspace.refreshProjects();
      setModal(null);
    });
  };

  const deleteWorker = (session: AgentSession): void => {
    runMutation(async () => {
      await runtime.commands.deleteWorker(session.conversationId, session.name);
      const project = workspace.projects.find(({ id }) => id === session.conversationId);
      if (project !== undefined) {
        workspace.selectSession(project.captainSessionName);
      }
      await workspace.refreshSessions();
      setModal(null);
    });
  };

  if (
    terminalDimensions.width < MINIMUM_TERMINAL_WIDTH ||
    terminalDimensions.height < MINIMUM_TERMINAL_HEIGHT
  ) {
    return (
      <box
        width="100%"
        height="100%"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        backgroundColor={palette.background}
      >
        <text fg={palette.accent} attributes={1}>
          orchestrator
        </text>
        <text fg={palette.text}>Terminal too small for the three-pane workspace.</text>
        <text fg={palette.muted}>
          Resize to at least {MINIMUM_TERMINAL_WIDTH}×{MINIMUM_TERMINAL_HEIGHT} · currently{" "}
          {terminalDimensions.width}×{terminalDimensions.height}
        </text>
      </box>
    );
  }

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={palette.background}>
      <box
        height={2}
        flexDirection="row"
        paddingX={1}
        alignItems="center"
        justifyContent="space-between"
        border={["bottom"]}
        borderColor={palette.border}
        backgroundColor={palette.panel}
      >
        <text fg={palette.accent} attributes={1}>
          orchestrator
        </text>
        <text
          fg={workspace.error === null ? palette.muted : palette.danger}
          wrapMode="none"
          truncate
          flexShrink={1}
        >
          {workspace.loading
            ? "loading local workspace…"
            : (workspace.error ?? workspace.selectedProject?.title ?? "Choose a project")}
        </text>
      </box>

      <box flexGrow={1} flexDirection="row">
        <ProjectList
          projects={workspace.projects}
          selectedId={workspace.selectedProject?.id ?? null}
          active={pane === "projects"}
          onSelect={(id) => {
            workspace.selectProject(id);
            setPane("projects");
          }}
          onCreate={() => {
            openModal({ kind: "new-project" });
          }}
        />
        <TerminalPanel
          conversationId={workspace.selectedProject?.id ?? null}
          session={workspace.selectedSession}
          active={pane === "terminal" && modal === null}
          onActivate={() => {
            setPane("terminal");
          }}
        />
        <AgentList
          sessions={workspace.sessions}
          selectedName={workspace.selectedSession?.name ?? null}
          active={pane === "agents"}
          canCreate={workspace.selectedProject !== null}
          onSelect={(name) => {
            workspace.selectSession(name);
            setPane("agents");
          }}
          onCreate={() => {
            openModal({ kind: "new-worker" });
          }}
        />
      </box>

      <box
        height={1}
        flexDirection="row"
        paddingX={1}
        justifyContent="space-between"
        backgroundColor={palette.panel}
      >
        <text fg={palette.muted}>Alt+1/2/3 Focus</text>
        <text fg={shuttingDown ? palette.warning : palette.muted}>
          {shuttingDown
            ? "finishing current operation…"
            : "Alt+N Project · Alt+W Worker · Alt+Q Quit"}
        </text>
      </box>

      {modal?.kind === "new-project" ? (
        <NewProjectModal
          pending={pending}
          error={mutationError}
          onCancel={closeModal}
          onInspect={(path) => runtime.commands.inspectWorkspace(path)}
          onCreate={createProject}
        />
      ) : null}
      {modal?.kind === "new-worker" ? (
        <NewWorkerModal
          providers={workspace.providers}
          pending={pending}
          error={mutationError}
          onCancel={closeModal}
          onCreate={createWorker}
        />
      ) : null}
      {modal?.kind === "remove-project" ? (
        <ConfirmDeleteModal
          title={`Remove ${modal.project.title}?`}
          message="This stops its captain and workers, then removes it from Orchestrator. The folder and its files are never deleted."
          pending={pending}
          error={mutationError}
          onCancel={closeModal}
          onConfirm={() => {
            removeProject(modal.project);
          }}
        />
      ) : null}
      {modal?.kind === "delete-worker" ? (
        <ConfirmDeleteModal
          title={`Delete ${modal.session.label}?`}
          message="This stops the worker and removes its session."
          pending={pending}
          error={mutationError}
          onCancel={closeModal}
          onConfirm={() => {
            deleteWorker(modal.session);
          }}
        />
      ) : null}
    </box>
  );
}

function cycle(current: number, delta: number, length: number): number {
  return length === 0 ? 0 : (current + delta + length) % length;
}
