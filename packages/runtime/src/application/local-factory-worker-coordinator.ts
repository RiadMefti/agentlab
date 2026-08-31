import type { FactoryPreparationSnapshot } from "../domain/factory-preparation-repository.js";
import type { WriterLease } from "../domain/writer-lease.js";
import type { FactoryExecutionAdmissionOutcome } from "./factory-execution-admission-service.js";
import type { FactoryExecutionRecoveryOutcome } from "./factory-execution-recovery-service.js";
import type { FactoryExecutionOutcome } from "./factory-execution-service.js";
import type { FactoryPreparationMaterializationResult } from "./factory-preparation-materializer.js";
import type { FactoryWorkerOperator, FactoryWorkerPreflight } from "./factory-worker-operator.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeResourceOwner } from "./runtime-resource-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

const defaultMaximumQueuedCommands = 32;

export interface FactoryWorkerCommandPort {
  preflight(): Promise<FactoryWorkerPreflight>;
  advancePreparation(input: unknown): Promise<FactoryPreparationSnapshot>;
  recoverPreparation(input: unknown): Promise<FactoryPreparationSnapshot>;
  materializePreparation(input: unknown): Promise<FactoryPreparationMaterializationResult>;
  admitExecution(input: unknown): Promise<FactoryExecutionAdmissionOutcome>;
  execute(input: unknown): Promise<FactoryExecutionOutcome>;
  recoverExecution(input: unknown): Promise<FactoryExecutionRecoveryOutcome>;
}

export interface LocalFactoryWorkerRuntime {
  readonly commands: FactoryWorkerCommandPort;
  close(): Promise<void>;
}

export interface LocalFactoryWorkerCoordinatorDependencies {
  readonly operator: FactoryWorkerOperator;
  readonly tasks: RuntimeTaskOwner;
  readonly resources: Pick<RuntimeResourceOwner, "closeAll">;
  readonly repositories: RuntimeRepositoryOwner;
  readonly writerLease: WriterLease;
  readonly maximumQueuedCommands?: number;
}

/** Serializes SQLite/process work and retains the writer lease until cleanup is conclusive. */
export class LocalFactoryWorkerCoordinator implements LocalFactoryWorkerRuntime {
  public readonly commands: FactoryWorkerCommandPort;
  readonly #operator: FactoryWorkerOperator;
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

  public constructor(dependencies: LocalFactoryWorkerCoordinatorDependencies) {
    this.#operator = dependencies.operator;
    this.#tasks = dependencies.tasks;
    this.#resources = dependencies.resources;
    this.#repositories = dependencies.repositories;
    this.#writerLease = dependencies.writerLease;
    const maximum = dependencies.maximumQueuedCommands ?? defaultMaximumQueuedCommands;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128) {
      throw new Error("Factory worker command queue limit must be between 1 and 128.");
    }
    this.#maximumQueuedCommands = maximum;
    this.commands = {
      preflight: () => this.#run(() => this.#operator.preflight()),
      advancePreparation: (input) => this.#run(() => this.#operator.advancePreparation(input)),
      recoverPreparation: (input) => this.#run(() => this.#operator.recoverPreparation(input)),
      materializePreparation: (input) =>
        this.#run(() => this.#operator.materializePreparation(input)),
      admitExecution: (input) => this.#run(() => this.#operator.admitExecution(input)),
      execute: (input) => this.#run(() => this.#operator.execute(input)),
      recoverExecution: (input) => this.#run(() => this.#operator.recoverExecution(input))
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
      return Promise.reject(new Error("Factory worker command queue is full."));
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
      throw new AggregateError(failures, "The local factory worker could not close cleanly.");
    }
  }
}
