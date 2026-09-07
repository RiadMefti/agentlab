import type { WriterLease } from "../domain/writer-lease.js";
import type {
  FactoryExternalPullRequestReviewPreflight,
  FactoryExternalPullRequestReviewService,
  FactoryExternalPullRequestReviewTickReport
} from "./factory-external-pull-request-review-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeResourceOwner } from "./runtime-resource-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

export interface FactoryExternalPullRequestReviewCommandPort {
  preflight(): Promise<FactoryExternalPullRequestReviewPreflight>;
  tick(input: unknown): Promise<FactoryExternalPullRequestReviewTickReport>;
}

export interface LocalFactoryExternalPullRequestReviewRuntime {
  readonly commands: FactoryExternalPullRequestReviewCommandPort;
  close(): Promise<void>;
}

/** Owns one serialized, credentialless external-review process and all of its local resources. */
export class LocalFactoryExternalPullRequestReviewCoordinator implements LocalFactoryExternalPullRequestReviewRuntime {
  public readonly commands: FactoryExternalPullRequestReviewCommandPort;
  readonly #tasks: RuntimeTaskOwner;
  readonly #resources: RuntimeResourceOwner;
  readonly #repositories: RuntimeRepositoryOwner;
  readonly #writerLease: WriterLease;
  #tail: Promise<void> = Promise.resolve();
  #closeInFlight: Promise<void> | null = null;
  #resourcesClosed = false;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;

  public constructor(dependencies: {
    readonly service: FactoryExternalPullRequestReviewService;
    readonly tasks: RuntimeTaskOwner;
    readonly resources: RuntimeResourceOwner;
    readonly repositories: RuntimeRepositoryOwner;
    readonly writerLease: WriterLease;
  }) {
    this.#tasks = dependencies.tasks;
    this.#resources = dependencies.resources;
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
    if (!this.#resourcesClosed) {
      try {
        await this.#resources.closeAll();
        this.#resourcesClosed = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (this.#resourcesClosed && !this.#repositoriesClosed) {
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
    this.#closed = this.#resourcesClosed && this.#repositoriesClosed && this.#leaseClosed;
    if (failures.length > 0) {
      throw new AggregateError(failures, "External PR review runtime could not close cleanly.");
    }
  }
}
