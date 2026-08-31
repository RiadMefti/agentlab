import type { WriterLease } from "../domain/writer-lease.js";
import type {
  FactoryAuthorityInspection,
  FactoryAuthorityOperator,
  FactoryBrokerAuthorityChange,
  FactorySchedulerAuthorityChange
} from "./factory-authority-operator.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

export interface FactoryAuthorityCommandPort {
  inspect(): Promise<FactoryAuthorityInspection>;
  setBrokerAuthority(input: unknown): Promise<FactoryBrokerAuthorityChange>;
  setSchedulerAuthority(input: unknown): Promise<FactorySchedulerAuthorityChange>;
}

export interface LocalFactoryAuthorityRuntime {
  readonly commands: FactoryAuthorityCommandPort;
  close(): Promise<void>;
}

export interface LocalFactoryAuthorityCoordinatorDependencies {
  readonly operator: FactoryAuthorityOperator;
  readonly tasks: RuntimeTaskOwner;
  readonly repositories: RuntimeRepositoryOwner;
  readonly writerLease: WriterLease;
}

/** Drains local human-control work before closing persistence and its exclusive writer lease. */
export class LocalFactoryAuthorityCoordinator implements LocalFactoryAuthorityRuntime {
  public readonly commands: FactoryAuthorityCommandPort;
  readonly #tasks: RuntimeTaskOwner;
  readonly #repositories: RuntimeRepositoryOwner;
  readonly #writerLease: WriterLease;
  #closeInFlight: Promise<void> | null = null;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;

  public constructor(dependencies: LocalFactoryAuthorityCoordinatorDependencies) {
    this.#tasks = dependencies.tasks;
    this.#repositories = dependencies.repositories;
    this.#writerLease = dependencies.writerLease;
    this.commands = {
      inspect: () => this.#tasks.run(() => dependencies.operator.inspect()),
      setBrokerAuthority: (input) =>
        this.#tasks.run(() => dependencies.operator.setBrokerAuthority(input)),
      setSchedulerAuthority: (input) =>
        this.#tasks.run(() => dependencies.operator.setSchedulerAuthority(input))
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
      throw new AggregateError(failures, "The local factory authority runtime could not close.");
    }
  }
}
