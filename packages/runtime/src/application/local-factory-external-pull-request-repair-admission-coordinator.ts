import type { WriterLease } from "../domain/writer-lease.js";
import type {
  FactoryExternalPullRequestRepairAdmissionPreflight,
  FactoryExternalPullRequestRepairAdmissionService,
  FactoryExternalPullRequestRepairAdmissionTickReport
} from "./factory-external-pull-request-repair-admission-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

export interface FactoryExternalPullRequestRepairAdmissionCommandPort {
  preflight(): Promise<FactoryExternalPullRequestRepairAdmissionPreflight>;
  tick(input: unknown): Promise<FactoryExternalPullRequestRepairAdmissionTickReport>;
}

export interface LocalFactoryExternalPullRequestRepairAdmissionRuntime {
  readonly commands: FactoryExternalPullRequestRepairAdmissionCommandPort;
  close(): Promise<void>;
}

/** Serializes deterministic admission decisions and owns no provider or remote credential. */
export class LocalFactoryExternalPullRequestRepairAdmissionCoordinator implements LocalFactoryExternalPullRequestRepairAdmissionRuntime {
  public readonly commands: FactoryExternalPullRequestRepairAdmissionCommandPort;
  readonly #tasks: RuntimeTaskOwner;
  readonly #repositories: RuntimeRepositoryOwner;
  readonly #writerLease: WriterLease;
  #tail: Promise<void> = Promise.resolve();
  #closeInFlight: Promise<void> | null = null;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;

  public constructor(dependencies: {
    readonly service: FactoryExternalPullRequestRepairAdmissionService;
    readonly tasks: RuntimeTaskOwner;
    readonly repositories: RuntimeRepositoryOwner;
    readonly writerLease: WriterLease;
  }) {
    this.#tasks = dependencies.tasks;
    this.#repositories = dependencies.repositories;
    this.#writerLease = dependencies.writerLease;
    this.commands = {
      preflight: () => this.#run(() => dependencies.service.preflight()),
      tick: (input) => this.#run(() => dependencies.service.tick(input))
    };
  }

  public close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closeInFlight !== null) return this.#closeInFlight;
    const attempt = this.#finalize();
    const shared = attempt.finally(() => {
      if (this.#closeInFlight === shared && !this.#closed) this.#closeInFlight = null;
    });
    this.#closeInFlight = shared;
    return shared;
  }

  #run<Value>(operation: () => Promise<Value>): Promise<Value> {
    return this.#tasks.run(() => {
      const current = this.#tail.then(operation);
      this.#tail = current.then(
        () => undefined,
        () => undefined
      );
      return current;
    });
  }

  async #finalize(): Promise<void> {
    const failures: unknown[] = [];
    await this.#tasks.stopAndDrain();
    if (!this.#repositoriesClosed) {
      try {
        this.#repositories.close();
        this.#repositoriesClosed = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (this.#repositoriesClosed && !this.#leaseClosed) {
      try {
        this.#writerLease.close();
        this.#leaseClosed = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    this.#closed = this.#repositoriesClosed && this.#leaseClosed;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "External repair admission runtime could not close cleanly."
      );
    }
  }
}
