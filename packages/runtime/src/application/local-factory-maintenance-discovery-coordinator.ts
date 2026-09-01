import type { WriterLease } from "../domain/writer-lease.js";
import type {
  FactoryMaintenanceDiscoveryService,
  FactoryMaintenanceDiscoveryPreflight,
  FactoryMaintenanceDiscoveryTickReport
} from "./factory-maintenance-discovery-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeResourceOwner } from "./runtime-resource-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

export interface FactoryMaintenanceDiscoveryCommandPort {
  preflight(): Promise<FactoryMaintenanceDiscoveryPreflight>;
  tick(input: unknown): Promise<FactoryMaintenanceDiscoveryTickReport>;
}

export interface LocalFactoryMaintenanceDiscoveryRuntime {
  readonly commands: FactoryMaintenanceDiscoveryCommandPort;
  close(): Promise<void>;
}

export interface LocalFactoryMaintenanceDiscoveryCoordinatorDependencies {
  readonly discovery: Pick<FactoryMaintenanceDiscoveryService, "preflight" | "tick">;
  readonly tasks: RuntimeTaskOwner;
  readonly resources: Pick<RuntimeResourceOwner, "closeAll">;
  readonly repositories: RuntimeRepositoryOwner;
  readonly writerLease: WriterLease;
  readonly maximumQueuedCommands?: number;
}

/** Serializes discovery writes and retains resources plus writer authority through cleanup. */
export class LocalFactoryMaintenanceDiscoveryCoordinator implements LocalFactoryMaintenanceDiscoveryRuntime {
  public readonly commands: FactoryMaintenanceDiscoveryCommandPort;
  readonly #tasks: RuntimeTaskOwner;
  readonly #resources: Pick<RuntimeResourceOwner, "closeAll">;
  readonly #repositories: RuntimeRepositoryOwner;
  readonly #writerLease: WriterLease;
  readonly #maximumQueuedCommands: number;
  #tail: Promise<void> = Promise.resolve();
  #queuedCommands = 0;
  #closeInFlight: Promise<void> | null = null;
  #resourcesClosed = false;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;

  public constructor(dependencies: LocalFactoryMaintenanceDiscoveryCoordinatorDependencies) {
    this.#tasks = dependencies.tasks;
    this.#resources = dependencies.resources;
    this.#repositories = dependencies.repositories;
    this.#writerLease = dependencies.writerLease;
    const maximum = dependencies.maximumQueuedCommands ?? 4;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16) {
      throw new Error("Maintenance discovery command queue limit must be between 1 and 16.");
    }
    this.#maximumQueuedCommands = maximum;
    this.commands = {
      preflight: () => this.#run(() => dependencies.discovery.preflight()),
      tick: (input) => this.#run(() => dependencies.discovery.tick(input))
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
      return Promise.reject(new Error("Maintenance discovery command queue is full."));
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
      throw new AggregateError(failures, "Maintenance discovery runtime could not close cleanly.");
    }
  }
}
