import type { RuntimeConstructionRepository } from "./local-runtime-construction.js";

/** Owns several synchronous persistence handles and retries only those that failed to close. */
export class RuntimeRepositoryOwner implements RuntimeConstructionRepository {
  readonly #repositories: RuntimeConstructionRepository[] = [];
  #accepting = true;

  public track<Repository extends RuntimeConstructionRepository>(
    repository: Repository
  ): Repository {
    if (!this.#accepting) throw new Error("Runtime repository ownership is already closing.");
    if (this.#repositories.includes(repository)) {
      throw new Error("Runtime repository ownership cannot track one handle twice.");
    }
    this.#repositories.push(repository);
    return repository;
  }

  public close(): void {
    this.#accepting = false;
    const failures: unknown[] = [];
    for (let index = this.#repositories.length - 1; index >= 0; index -= 1) {
      const repository = this.#repositories[index];
      if (repository === undefined) continue;
      try {
        repository.close();
        this.#repositories.splice(index, 1);
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more runtime repositories could not close.");
    }
  }
}
