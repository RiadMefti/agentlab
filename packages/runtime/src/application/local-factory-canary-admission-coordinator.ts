import type { WriterLease } from "../domain/writer-lease.js";
import type {
  FactoryCanaryAdmissionResult,
  FactoryCanaryAdmissionService
} from "./factory-canary-admission-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

const defaultMaximumQueuedCommands = 16;

export interface FactoryCanaryAdmissionCommandPort {
  reserve(input: unknown): Promise<FactoryCanaryAdmissionResult>;
}

export interface LocalFactoryCanaryAdmissionRuntime {
  readonly commands: FactoryCanaryAdmissionCommandPort;
  close(): Promise<void>;
}

export interface LocalFactoryCanaryAdmissionCoordinatorDependencies {
  readonly admission: Pick<FactoryCanaryAdmissionService, "reserve">;
  readonly tasks: RuntimeTaskOwner;
  readonly repositories: RuntimeRepositoryOwner;
  readonly writerLease: WriterLease;
  readonly maximumQueuedCommands?: number;
}

/** Serializes reservation writes and retains the single-writer lease through cleanup. */
export class LocalFactoryCanaryAdmissionCoordinator implements LocalFactoryCanaryAdmissionRuntime {
  public readonly commands: FactoryCanaryAdmissionCommandPort;
  readonly #admission: Pick<FactoryCanaryAdmissionService, "reserve">;
  readonly #tasks: RuntimeTaskOwner;
  readonly #repositories: RuntimeRepositoryOwner;
  readonly #writerLease: WriterLease;
  readonly #maximumQueuedCommands: number;
  #tail: Promise<void> = Promise.resolve();
  #queuedCommands = 0;
  #closeInFlight: Promise<void> | null = null;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;

  public constructor(dependencies: LocalFactoryCanaryAdmissionCoordinatorDependencies) {
    this.#admission = dependencies.admission;
    this.#tasks = dependencies.tasks;
    this.#repositories = dependencies.repositories;
    this.#writerLease = dependencies.writerLease;
    const maximum = dependencies.maximumQueuedCommands ?? defaultMaximumQueuedCommands;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) {
      throw new Error("Factory canary admission command queue limit must be between 1 and 32.");
    }
    this.#maximumQueuedCommands = maximum;
    this.commands = {
      reserve: (input) => this.#run(() => this.#admission.reserve(input))
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
    if (this.#queuedCommands >= this.#maximumQueuedCommands) {
      return Promise.reject(new Error("Factory canary admission command queue is full."));
    }
    this.#queuedCommands += 1;
    const scheduled = this.#tasks.run(() => {
      const current = this.#tail.then(operation);
      this.#tail = current.then(
        () => undefined,
        () => undefined
      );
      return current;
    });
    return scheduled.finally(() => {
      this.#queuedCommands -= 1;
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
        "The local factory canary admission runtime could not close cleanly."
      );
    }
  }
}
