import type { WriterLease } from "../domain/writer-lease.js";
import type { FactoryBrokerOperator, FactoryBrokerPreflight } from "./factory-broker-operator.js";
import type { FactoryPullRequestOutcome } from "./factory-pull-request-service.js";
import type { FactoryPullRequestObservationOutcome } from "./factory-pull-request-observation-service.js";
import type { FactoryPullRequestRepairAdmissionOutcome } from "./factory-pull-request-repair-admission-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

export interface FactoryBrokerCommandPort {
  preflight(): Promise<FactoryBrokerPreflight>;
  openDraft(input: unknown): Promise<FactoryPullRequestOutcome>;
  observePullRequest(input: unknown): Promise<FactoryPullRequestObservationOutcome>;
  admitPullRequestRepair(input: unknown): Promise<FactoryPullRequestRepairAdmissionOutcome>;
}

export interface LocalFactoryBrokerRuntime {
  readonly commands: FactoryBrokerCommandPort;
  close(): Promise<void>;
}

export interface LocalFactoryBrokerCoordinatorDependencies {
  readonly operator: FactoryBrokerOperator;
  readonly tasks: RuntimeTaskOwner;
  readonly repositories: RuntimeRepositoryOwner;
  readonly writerLease: WriterLease;
  readonly tokenSource: { clear(): void };
}

/** Owns admission, credential disposal, persistence closure, and the single-writer lease. */
export class LocalFactoryBrokerCoordinator implements LocalFactoryBrokerRuntime {
  public readonly commands: FactoryBrokerCommandPort;
  readonly #tasks: RuntimeTaskOwner;
  readonly #repositories: RuntimeRepositoryOwner;
  readonly #writerLease: WriterLease;
  readonly #tokenSource: { clear(): void };
  #closeInFlight: Promise<void> | null = null;
  #credentialsCleared = false;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;

  public constructor(dependencies: LocalFactoryBrokerCoordinatorDependencies) {
    this.#tasks = dependencies.tasks;
    this.#repositories = dependencies.repositories;
    this.#writerLease = dependencies.writerLease;
    this.#tokenSource = dependencies.tokenSource;
    this.commands = {
      preflight: () => this.#tasks.run(() => dependencies.operator.preflight()),
      openDraft: (input) => this.#tasks.run(() => dependencies.operator.openDraft(input)),
      observePullRequest: (input) =>
        this.#tasks.run(() => dependencies.operator.observePullRequest(input)),
      admitPullRequestRepair: (input) =>
        this.#tasks.run(() => dependencies.operator.admitPullRequestRepair(input))
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
    if (!this.#credentialsCleared) {
      try {
        this.#tokenSource.clear();
        this.#credentialsCleared = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
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
    this.#closed = this.#credentialsCleared && this.#repositoriesClosed && this.#leaseClosed;
    if (failures.length > 0) {
      throw new AggregateError(failures, "The local factory broker could not close cleanly.");
    }
  }
}
