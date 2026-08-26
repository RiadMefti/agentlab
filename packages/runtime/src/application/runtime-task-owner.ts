import type { OrchestratorCommandPort } from "./orchestrator-commands.js";

const CLOSED_RUNTIME_MESSAGE = "The orchestrator runtime is closing.";

/** Admission gate and drain barrier for application work owned by one runtime. */
export class RuntimeTaskOwner {
  readonly #active = new Set<Promise<unknown>>();
  #accepting = true;
  #drain: Promise<void> | null = null;

  public run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#accepting) return Promise.reject(new Error(CLOSED_RUNTIME_MESSAGE));

    const task = Promise.resolve().then(operation);
    this.#active.add(task);
    void task.then(
      () => this.#active.delete(task),
      () => this.#active.delete(task)
    );
    return task;
  }

  public stopAndDrain(): Promise<void> {
    this.#accepting = false;
    this.#drain ??= this.drainActiveTasks();
    return this.#drain;
  }

  private async drainActiveTasks(): Promise<void> {
    await Promise.allSettled([...this.#active]);
  }
}

/** Applies runtime ownership to every command without coupling domain services to shutdown. */
export function ownOrchestratorCommands(
  commands: OrchestratorCommandPort,
  tasks: RuntimeTaskOwner
): OrchestratorCommandPort {
  return {
    listConversations: () => tasks.run(() => commands.listConversations()),
    inspectWorkspace: (workspacePath) => tasks.run(() => commands.inspectWorkspace(workspacePath)),
    listProviders: (conversationId) => tasks.run(() => commands.listProviders(conversationId)),
    createConversation: (input) => tasks.run(() => commands.createConversation(input)),
    deleteConversation: (conversationId) =>
      tasks.run(() => commands.deleteConversation(conversationId)),
    listSessions: (conversationId) => tasks.run(() => commands.listSessions(conversationId)),
    createWorker: (conversationId, input) =>
      tasks.run(() => commands.createWorker(conversationId, input)),
    deleteWorker: (conversationId, sessionName) =>
      tasks.run(() => commands.deleteWorker(conversationId, sessionName)),
    requireAttachableSession: (conversationId, sessionName) =>
      tasks.run(() => commands.requireAttachableSession(conversationId, sessionName))
  };
}
