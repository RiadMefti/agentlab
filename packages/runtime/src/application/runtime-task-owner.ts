import type { AgentLabCommandPort } from "./agentlab-commands.js";
import type { AsyncOperationOwner } from "../domain/async-operation-owner.js";

const CLOSED_RUNTIME_MESSAGE = "The agentlab runtime is closing.";

/** Admission gate and drain barrier for application work owned by one runtime. */
export class RuntimeTaskOwner implements AsyncOperationOwner {
  readonly #active = new Set<Promise<unknown>>();
  #accepting = true;
  #drain: Promise<void> | null = null;
  #readiness: Promise<void> = Promise.resolve();
  #initializationStarted = false;

  public initialize(operation: () => Promise<void>): Promise<void> {
    if (this.#initializationStarted) throw new Error("Runtime initialization already started.");
    if (!this.#accepting) throw new Error(CLOSED_RUNTIME_MESSAGE);
    this.#initializationStarted = true;
    this.#readiness = this.own(Promise.resolve().then(operation));
    return this.#readiness;
  }

  public run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#accepting) return Promise.reject(new Error(CLOSED_RUNTIME_MESSAGE));
    return this.own(this.#readiness.then(operation));
  }

  public stopAndDrain(): Promise<void> {
    this.#accepting = false;
    this.#drain ??= this.drainActiveTasks();
    return this.#drain;
  }

  private async drainActiveTasks(): Promise<void> {
    while (this.#active.size > 0) await Promise.allSettled([...this.#active]);
  }

  public own<T>(task: Promise<T>): Promise<T> {
    this.#active.add(task);
    void task.then(
      () => this.#active.delete(task),
      () => this.#active.delete(task)
    );
    return task;
  }
}

/** Applies runtime ownership to every command without coupling domain services to shutdown. */
export function ownAgentLabCommands(
  commands: AgentLabCommandPort,
  tasks: RuntimeTaskOwner
): AgentLabCommandPort {
  return {
    listConversations: () => tasks.run(() => commands.listConversations()),
    inspectWorkspace: (workspacePath) => tasks.run(() => commands.inspectWorkspace(workspacePath)),
    prepareWorkspace: (workspacePath) => tasks.run(() => commands.prepareWorkspace(workspacePath)),
    discoverWorkspaceProviders: (workspacePath) =>
      tasks.run(() => commands.discoverWorkspaceProviders(workspacePath)),
    completeFolders: (input) => tasks.run(() => commands.completeFolders(input)),
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
