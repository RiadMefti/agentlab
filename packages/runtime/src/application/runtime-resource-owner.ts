import type {
  ManagedRuntimeResource,
  ManagedRuntimeResourceOwner
} from "../domain/runtime-resource.js";

const maximumConcurrentResourceCleanup = 8;

/** Owns retryable process, stream, query, and terminal cleanup for one local runtime. */
export class RuntimeResourceOwner implements ManagedRuntimeResourceOwner {
  readonly #resources = new Set<ManagedRuntimeResource>();

  public track(resource: ManagedRuntimeResource): void {
    this.#resources.add(resource);
  }

  public release(resource: ManagedRuntimeResource): void {
    this.#resources.delete(resource);
  }

  public async closeAll(): Promise<void> {
    const resources = [...this.#resources];
    const failures: unknown[] = [];
    let next = 0;
    const workers = Array.from(
      { length: Math.min(maximumConcurrentResourceCleanup, resources.length) },
      async () => {
        while (next < resources.length) {
          const index = next;
          next += 1;
          const resource = resources[index];
          if (resource === undefined) continue;
          try {
            await resource.closeAndWait();
            this.#resources.delete(resource);
          } catch (error: unknown) {
            failures.push(error);
          }
        }
      }
    );
    await Promise.all(workers);
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more runtime resources could not close.");
    }
  }
}
