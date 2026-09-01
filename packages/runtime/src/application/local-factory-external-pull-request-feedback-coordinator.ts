import type { WriterLease } from "../domain/writer-lease.js";
import type {
  FactoryExternalPullRequestFeedbackPreflight,
  FactoryExternalPullRequestFeedbackService,
  FactoryExternalPullRequestFeedbackTickReport
} from "./factory-external-pull-request-feedback-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

export interface FactoryExternalPullRequestFeedbackCommandPort {
  preflight(): Promise<FactoryExternalPullRequestFeedbackPreflight>;
  tick(input: unknown): Promise<FactoryExternalPullRequestFeedbackTickReport>;
}

export interface LocalFactoryExternalPullRequestFeedbackRuntime {
  readonly commands: FactoryExternalPullRequestFeedbackCommandPort;
  close(): Promise<void>;
}

/** Serializes feedback commands and erases the short-lived GitHub credential before shutdown. */
export class LocalFactoryExternalPullRequestFeedbackCoordinator implements LocalFactoryExternalPullRequestFeedbackRuntime {
  public readonly commands: FactoryExternalPullRequestFeedbackCommandPort;
  readonly #tasks: RuntimeTaskOwner;
  readonly #repositories: RuntimeRepositoryOwner;
  readonly #writerLease: WriterLease;
  readonly #tokenSource: { clear(): void };
  #tail: Promise<void> = Promise.resolve();
  #closeInFlight: Promise<void> | null = null;
  #credentialsCleared = false;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;

  public constructor(dependencies: {
    readonly service: FactoryExternalPullRequestFeedbackService;
    readonly tasks: RuntimeTaskOwner;
    readonly repositories: RuntimeRepositoryOwner;
    readonly writerLease: WriterLease;
    readonly tokenSource: { clear(): void };
  }) {
    this.#tasks = dependencies.tasks;
    this.#repositories = dependencies.repositories;
    this.#writerLease = dependencies.writerLease;
    this.#tokenSource = dependencies.tokenSource;
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
      throw new AggregateError(failures, "External PR feedback runtime could not close cleanly.");
    }
  }
}
