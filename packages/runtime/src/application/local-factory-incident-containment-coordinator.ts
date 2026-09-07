import type { WriterLease } from "../domain/writer-lease.js";
import type {
  FactoryIncidentContainmentResult,
  FactoryIncidentContainmentService
} from "./factory-incident-containment-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

export interface FactoryIncidentContainmentCommandPort {
  containIfCritical(): Promise<FactoryIncidentContainmentResult>;
}

export interface LocalFactoryIncidentContainmentRuntime {
  readonly commands: FactoryIncidentContainmentCommandPort;
  close(): Promise<void>;
}

/** Serializes containment and retains exclusive writer authority until all handles close. */
export class LocalFactoryIncidentContainmentCoordinator implements LocalFactoryIncidentContainmentRuntime {
  public readonly commands: FactoryIncidentContainmentCommandPort;
  #tail: Promise<void> = Promise.resolve();
  #closeInFlight: Promise<void> | null = null;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;

  public constructor(
    private readonly dependencies: {
      readonly service: Pick<FactoryIncidentContainmentService, "containIfCritical">;
      readonly tasks: RuntimeTaskOwner;
      readonly repositories: RuntimeRepositoryOwner;
      readonly writerLease: WriterLease;
    }
  ) {
    this.commands = {
      containIfCritical: () => this.#run(() => dependencies.service.containIfCritical())
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
      throw new AggregateError(failures, "Incident controller could not close cleanly.");
    }
  }
}
