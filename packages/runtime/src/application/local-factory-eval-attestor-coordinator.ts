import type { FactorySignedEvalAttestation } from "@agentlab/contracts";

import type { FactoryEvalAttestorService } from "./factory-eval-attestor-service.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";

const defaultMaximumQueuedCommands = 4;

export interface FactoryEvalAttestorCommandPort {
  sign(input: unknown): Promise<FactorySignedEvalAttestation>;
}

export interface LocalFactoryEvalAttestorRuntime {
  readonly commands: FactoryEvalAttestorCommandPort;
  close(): Promise<void>;
}

export interface LocalFactoryEvalAttestorCoordinatorDependencies {
  readonly attestor: Pick<FactoryEvalAttestorService, "attest">;
  readonly tasks: RuntimeTaskOwner;
  readonly maximumQueuedCommands?: number;
}

/** Bounds signing operations and drains them before the isolated attestor closes. */
export class LocalFactoryEvalAttestorCoordinator implements LocalFactoryEvalAttestorRuntime {
  public readonly commands: FactoryEvalAttestorCommandPort;
  readonly #attestor: Pick<FactoryEvalAttestorService, "attest">;
  readonly #tasks: RuntimeTaskOwner;
  readonly #maximumQueuedCommands: number;
  #tail: Promise<void> = Promise.resolve();
  #queuedCommands = 0;
  #closeInFlight: Promise<void> | null = null;
  #closed = false;

  public constructor(dependencies: LocalFactoryEvalAttestorCoordinatorDependencies) {
    this.#attestor = dependencies.attestor;
    this.#tasks = dependencies.tasks;
    const maximum = dependencies.maximumQueuedCommands ?? defaultMaximumQueuedCommands;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16) {
      throw new Error("Factory eval attestor command queue limit must be between 1 and 16.");
    }
    this.#maximumQueuedCommands = maximum;
    this.commands = { sign: (input) => this.#run(() => this.#attestor.attest(input)) };
  }

  public close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closeInFlight !== null) return this.#closeInFlight;
    const attempt = this.#tasks.stopAndDrain().then(() => {
      this.#closed = true;
    });
    const shared = attempt.finally(() => {
      if (this.#closeInFlight === shared && !this.#closed) this.#closeInFlight = null;
    });
    this.#closeInFlight = shared;
    return shared;
  }

  #run<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.#queuedCommands >= this.#maximumQueuedCommands) {
      return Promise.reject(new Error("Factory eval attestor command queue is full."));
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
}
