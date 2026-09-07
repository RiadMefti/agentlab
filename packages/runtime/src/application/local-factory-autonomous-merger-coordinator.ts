import type { WriterLease } from "../domain/writer-lease.js";
import type {
  FactoryAutonomousMergePreflight,
  FactoryAutonomousMergeService,
  FactoryAutonomousMergeTickReport
} from "./factory-autonomous-merge-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

export interface FactoryAutonomousMergerCommandPort {
  preflight(): Promise<FactoryAutonomousMergePreflight>;
  tick(input: unknown): Promise<FactoryAutonomousMergeTickReport>;
}

export interface LocalFactoryAutonomousMergerRuntime {
  readonly commands: FactoryAutonomousMergerCommandPort;
  close(): Promise<void>;
}

/** Owns one merger credential cache, serial command admission, repositories, and writer lease. */
export class LocalFactoryAutonomousMergerCoordinator implements LocalFactoryAutonomousMergerRuntime {
  public readonly commands: FactoryAutonomousMergerCommandPort;
  #closeInFlight: Promise<void> | null = null;
  #credentialsCleared = false;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;

  public constructor(
    private readonly dependencies: {
      readonly service: Pick<FactoryAutonomousMergeService, "preflight" | "tick">;
      readonly tasks: RuntimeTaskOwner;
      readonly repositories: RuntimeRepositoryOwner;
      readonly writerLease: WriterLease;
      readonly tokenSource: { clear(): void };
    }
  ) {
    this.commands = {
      preflight: () => dependencies.tasks.run(() => dependencies.service.preflight()),
      tick: (input) => dependencies.tasks.run(() => dependencies.service.tick(input))
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
    await this.dependencies.tasks.stopAndDrain();
    if (!this.#credentialsCleared) {
      try {
        this.dependencies.tokenSource.clear();
        this.#credentialsCleared = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (!this.#repositoriesClosed) {
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
    this.#closed = this.#credentialsCleared && this.#repositoriesClosed && this.#leaseClosed;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Autonomous merger could not close cleanly.");
    }
  }
}
