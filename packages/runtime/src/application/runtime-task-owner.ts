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
