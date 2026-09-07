import type { WriterLease } from "../domain/writer-lease.js";
import type {
  FactoryAutonomousMergeAdmissionOutcome,
  FactoryAutonomousMergeAdmissionPreflight,
  FactoryAutonomousMergeAdmissionTickReport,
  FactoryAutonomousMergeAdmissionService
} from "./factory-autonomous-merge-admission-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

export interface FactoryAutonomousMergeAdmissionCommandPort {
  preflight(): Promise<FactoryAutonomousMergeAdmissionPreflight>;
  admit(input: unknown): Promise<FactoryAutonomousMergeAdmissionOutcome>;
  tick(input: unknown): Promise<FactoryAutonomousMergeAdmissionTickReport>;
}

export interface LocalFactoryAutonomousMergeAdmissionRuntime {
  readonly commands: FactoryAutonomousMergeAdmissionCommandPort;
  close(): Promise<void>;
}

/** Serializes credentialless merge admission and retains the SQLite writer lease until drained. */
export class LocalFactoryAutonomousMergeAdmissionCoordinator implements LocalFactoryAutonomousMergeAdmissionRuntime {
  public readonly commands: FactoryAutonomousMergeAdmissionCommandPort;
  #closeInFlight: Promise<void> | null = null;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;

  public constructor(
    private readonly dependencies: {
      readonly service: Pick<
        FactoryAutonomousMergeAdmissionService,
        "preflight" | "admit" | "tick"
      >;
      readonly tasks: RuntimeTaskOwner;
      readonly repositories: RuntimeRepositoryOwner;
      readonly writerLease: WriterLease;
    }
  ) {
    this.commands = {
      preflight: () => dependencies.tasks.run(() => dependencies.service.preflight()),
      admit: (input) => dependencies.tasks.run(() => dependencies.service.admit(input)),
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
    this.#closed = this.#repositoriesClosed && this.#leaseClosed;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Autonomous merge admission could not close cleanly.");
    }
  }
}
