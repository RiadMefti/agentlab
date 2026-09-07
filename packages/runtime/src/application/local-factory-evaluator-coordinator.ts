import type { FactoryEvalSnapshot } from "../domain/factory-evaluation-repository.js";
import type { WriterLease } from "../domain/writer-lease.js";
import type { FactoryEvaluationService } from "./factory-evaluation-service.js";
import type {
  FactoryEvalAttestationRecordResult,
  FactoryEvalAttestationService
} from "./factory-eval-attestation-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

const defaultMaximumQueuedCommands = 8;

export interface FactoryEvaluatorCommandPort {
  assess(input: unknown): Promise<FactoryEvalSnapshot>;
  attest(input: unknown): Promise<FactoryEvalAttestationRecordResult>;
  inspect(input: unknown): Promise<FactoryEvalSnapshot>;
}

export interface LocalFactoryEvaluatorRuntime {
  readonly commands: FactoryEvaluatorCommandPort;
  close(): Promise<void>;
}

export interface LocalFactoryEvaluatorCoordinatorDependencies {
  readonly evaluator: Pick<FactoryEvaluationService, "assess" | "inspect">;
  readonly attestations: Pick<FactoryEvalAttestationService, "record">;
  readonly tasks: RuntimeTaskOwner;
  readonly repositories: RuntimeRepositoryOwner;
  readonly writerLease: WriterLease;
  readonly maximumQueuedCommands?: number;
}

/** Serializes immutable eval and attestation admission through exclusive ledger cleanup. */
export class LocalFactoryEvaluatorCoordinator implements LocalFactoryEvaluatorRuntime {
  public readonly commands: FactoryEvaluatorCommandPort;
  readonly #evaluator: Pick<FactoryEvaluationService, "assess" | "inspect">;
  readonly #attestations: Pick<FactoryEvalAttestationService, "record">;
  readonly #tasks: RuntimeTaskOwner;
  readonly #repositories: RuntimeRepositoryOwner;
  readonly #writerLease: WriterLease;
  readonly #maximumQueuedCommands: number;
  #tail: Promise<void> = Promise.resolve();
  #queuedCommands = 0;
  #closeInFlight: Promise<void> | null = null;
  #repositoriesClosed = false;
  #leaseClosed = false;
  #closed = false;

  public constructor(dependencies: LocalFactoryEvaluatorCoordinatorDependencies) {
    this.#evaluator = dependencies.evaluator;
    this.#attestations = dependencies.attestations;
    this.#tasks = dependencies.tasks;
    this.#repositories = dependencies.repositories;
    this.#writerLease = dependencies.writerLease;
    const maximum = dependencies.maximumQueuedCommands ?? defaultMaximumQueuedCommands;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) {
      throw new Error("Factory evaluator command queue limit must be between 1 and 32.");
    }
    this.#maximumQueuedCommands = maximum;
    this.commands = {
      assess: (input) => this.#run(() => this.#evaluator.assess(input)),
      attest: (input) => this.#run(() => this.#attestations.record(input)),
      inspect: (input) => this.#run(() => this.#evaluator.inspect(input))
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
      return Promise.reject(new Error("Factory evaluator command queue is full."));
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
    this.#closed = this.#repositoriesClosed && this.#leaseClosed;
    if (failures.length > 0) {
      throw new AggregateError(failures, "The local factory evaluator could not close cleanly.");
    }
  }
}
