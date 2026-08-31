import type { WriterLease } from "../domain/writer-lease.js";
import type {
  FactoryIntakeOperator,
  FactoryIntakePreflight,
  FactoryIntakeRegistrationResult
} from "./factory-intake-operator.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeResourceOwner } from "./runtime-resource-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

const defaultMaximumQueuedCommands = 16;

export interface FactoryIntakeCommandPort {
  preflight(): Promise<FactoryIntakePreflight>;
  register(input: unknown): Promise<FactoryIntakeRegistrationResult>;
}

export interface LocalFactoryIntakeRuntime {
  readonly commands: FactoryIntakeCommandPort;
  close(): Promise<void>;
}

export interface LocalFactoryIntakeCoordinatorDependencies {
  readonly operator: Pick<FactoryIntakeOperator, "preflight" | "register">;
  readonly tasks: RuntimeTaskOwner;
  readonly resources: Pick<RuntimeResourceOwner, "closeAll">;
  readonly repositories: RuntimeRepositoryOwner;
  readonly writerLease: WriterLease;
  readonly maximumQueuedCommands?: number;
}

/** Serializes intake identity checks and retains writer authority until process cleanup is proven. */
export class LocalFactoryIntakeCoordinator implements LocalFactoryIntakeRuntime {
  public readonly commands: FactoryIntakeCommandPort;
  readonly #operator: Pick<FactoryIntakeOperator, "preflight" | "register">;
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

  public constructor(dependencies: LocalFactoryIntakeCoordinatorDependencies) {
    this.#operator = dependencies.operator;
    this.#tasks = dependencies.tasks;
    this.#resources = dependencies.resources;
    this.#repositories = dependencies.repositories;
    this.#writerLease = dependencies.writerLease;
    const maximum = dependencies.maximumQueuedCommands ?? defaultMaximumQueuedCommands;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64) {
      throw new Error("Factory intake command queue limit must be between 1 and 64.");
    }
    this.#maximumQueuedCommands = maximum;
    this.commands = {
      preflight: () => this.#run(() => this.#operator.preflight()),
      register: (input) => this.#run(() => this.#operator.register(input))
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
      return Promise.reject(new Error("Factory intake command queue is full."));
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
      throw new AggregateError(failures, "The local factory intake could not close cleanly.");
    }
  }
}
