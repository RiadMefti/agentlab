import type { WriterLease } from "../domain/writer-lease.js";
import type {
  FactoryExternalPullRequestReplacementDraftPreflight,
  FactoryExternalPullRequestReplacementDraftService,
  FactoryExternalPullRequestReplacementDraftTickReport
} from "./factory-external-pull-request-replacement-draft-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeResourceOwner } from "./runtime-resource-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

export interface FactoryExternalPullRequestReplacementDraftCommandPort {
  preflight(): Promise<FactoryExternalPullRequestReplacementDraftPreflight>;
  tick(input: unknown): Promise<FactoryExternalPullRequestReplacementDraftTickReport>;
}
export interface LocalFactoryExternalPullRequestReplacementDraftRuntime {
  readonly commands: FactoryExternalPullRequestReplacementDraftCommandPort;
  close(): Promise<void>;
}

/** Owns one serialized, separately credentialed replacement-draft broker. */
export class LocalFactoryExternalPullRequestReplacementDraftCoordinator implements LocalFactoryExternalPullRequestReplacementDraftRuntime {
  public readonly commands: FactoryExternalPullRequestReplacementDraftCommandPort;
  #tail: Promise<void> = Promise.resolve();
  #closeInFlight: Promise<void> | null = null;
  #resourcesClosed = false;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;
  public constructor(
    private readonly dependencies: {
      readonly service: FactoryExternalPullRequestReplacementDraftService;
      readonly tasks: RuntimeTaskOwner;
      readonly resources: RuntimeResourceOwner;
      readonly repositories: RuntimeRepositoryOwner;
      readonly writerLease: WriterLease;
    }
  ) {
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
    return this.dependencies.tasks.run(() => {
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
    await this.dependencies.tasks.stopAndDrain();
    if (!this.#resourcesClosed) {
      try {
        await this.dependencies.resources.closeAll();
        this.#resourcesClosed = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (this.#resourcesClosed && !this.#repositoriesClosed) {
      try {
        this.dependencies.repositories.close();
        this.#repositoriesClosed = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (this.#repositoriesClosed && !this.#leaseClosed) {
      try {
        this.dependencies.writerLease.close();
        this.#leaseClosed = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    this.#closed = this.#resourcesClosed && this.#repositoriesClosed && this.#leaseClosed;
    if (failures.length > 0)
      throw new AggregateError(failures, "Replacement-draft broker could not close cleanly.");
  }
}
