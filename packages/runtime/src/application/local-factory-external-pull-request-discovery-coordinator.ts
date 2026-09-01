import type { WriterLease } from "../domain/writer-lease.js";
import type {
  FactoryExternalPullRequestDiscoveryPreflight,
  FactoryExternalPullRequestDiscoveryService,
  FactoryExternalPullRequestDiscoveryTickReport
} from "./factory-external-pull-request-discovery-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

export interface FactoryExternalPullRequestDiscoveryCommandPort {
  preflight(): Promise<FactoryExternalPullRequestDiscoveryPreflight>;
  tick(input: unknown): Promise<FactoryExternalPullRequestDiscoveryTickReport>;
}

export interface LocalFactoryExternalPullRequestDiscoveryRuntime {
  readonly commands: FactoryExternalPullRequestDiscoveryCommandPort;
  close(): Promise<void>;
}

export interface LocalFactoryExternalPullRequestDiscoveryCoordinatorDependencies {
  readonly service: FactoryExternalPullRequestDiscoveryService;
  readonly tasks: RuntimeTaskOwner;
  readonly repositories: RuntimeRepositoryOwner;
  readonly writerLease: WriterLease;
  readonly tokenSource: { clear(): void };
}

/** Owns the read credential, journal connections, in-flight commands, and writer lease. */
export class LocalFactoryExternalPullRequestDiscoveryCoordinator implements LocalFactoryExternalPullRequestDiscoveryRuntime {
  public readonly commands: FactoryExternalPullRequestDiscoveryCommandPort;
  readonly #tasks: RuntimeTaskOwner;
  readonly #repositories: RuntimeRepositoryOwner;
  readonly #writerLease: WriterLease;
  readonly #tokenSource: { clear(): void };
  #closeInFlight: Promise<void> | null = null;
  #credentialsCleared = false;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;

  public constructor(
    dependencies: LocalFactoryExternalPullRequestDiscoveryCoordinatorDependencies
  ) {
    this.#tasks = dependencies.tasks;
    this.#repositories = dependencies.repositories;
    this.#writerLease = dependencies.writerLease;
    this.#tokenSource = dependencies.tokenSource;
    this.commands = {
      preflight: () => this.#tasks.run(() => dependencies.service.preflight()),
      tick: (input) => this.#tasks.run(() => dependencies.service.tick(input))
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
      throw new AggregateError(failures, "External PR discovery runtime could not close cleanly.");
    }
  }
}
