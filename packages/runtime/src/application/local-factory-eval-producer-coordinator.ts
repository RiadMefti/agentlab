import type { FactoryEvalProductionResult, Sha256Digest } from "@agentlab/contracts";

import type { WriterLease } from "../domain/writer-lease.js";
import type { FactoryEvalProductionService } from "./factory-eval-production-service.js";
import type { RuntimeRepositoryOwner } from "./runtime-repository-owner.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

const defaultMaximumQueuedCommands = 2;

export interface FactoryEvalProducerCommandPort {
  preflight(
    job: unknown,
    expectedJobDigest: Sha256Digest
  ): Promise<{ readonly jobId: string; readonly jobDigest: Sha256Digest }>;
  produce(job: unknown, expectedJobDigest: Sha256Digest): Promise<FactoryEvalProductionResult>;
}

export interface LocalFactoryEvalProducerRuntime {
  readonly commands: FactoryEvalProducerCommandPort;
  close(): Promise<void>;
}

export interface LocalFactoryEvalProducerCoordinatorDependencies {
  readonly producer: Pick<FactoryEvalProductionService, "preflight" | "produce">;
  readonly tasks: RuntimeTaskOwner;
  readonly repositories: RuntimeRepositoryOwner;
  readonly writerLease: WriterLease;
  readonly maximumQueuedCommands?: number;
}

/** Serializes one process-bearing eval producer through durable journal and lease cleanup. */
export class LocalFactoryEvalProducerCoordinator implements LocalFactoryEvalProducerRuntime {
  public readonly commands: FactoryEvalProducerCommandPort;
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

  public constructor(dependencies: LocalFactoryEvalProducerCoordinatorDependencies) {
    this.#tasks = dependencies.tasks;
    this.#repositories = dependencies.repositories;
    this.#writerLease = dependencies.writerLease;
    const maximum = dependencies.maximumQueuedCommands ?? defaultMaximumQueuedCommands;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 8) {
      throw new Error("Factory eval producer command queue limit must be between 1 and 8.");
    }
    this.#maximumQueuedCommands = maximum;
    this.commands = {
      preflight: (job, digest) => this.#run(() => dependencies.producer.preflight(job, digest)),
      produce: (job, digest) => this.#run(() => dependencies.producer.produce(job, digest))
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
      return Promise.reject(new Error("Factory eval producer command queue is full."));
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
      throw new AggregateError(
        failures,
        "The local factory eval producer could not close cleanly."
      );
    }
  }
}
