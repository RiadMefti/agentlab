import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import type { FactoryOperationsHealthSource } from "../domain/factory-operations-health-source.js";
import type { FactoryOperationsHealthReport } from "@agentlab/contracts";

import type { RuntimeTaskOwner } from "./runtime-task-owner.js";
import type { FactoryOperationsHealthService } from "./factory-operations-health-service.js";

export interface FactoryOperationsHealthCommandPort {
  inspect(): Promise<CanonicalFactoryDocument<FactoryOperationsHealthReport>>;
}

export interface LocalFactoryOperationsHealthRuntime {
  readonly commands: FactoryOperationsHealthCommandPort;
  close(): Promise<void>;
}

export interface LocalFactoryOperationsHealthCoordinatorDependencies {
  readonly service: Pick<FactoryOperationsHealthService, "inspect">;
  readonly tasks: RuntimeTaskOwner;
  readonly source: Pick<FactoryOperationsHealthSource, "close">;
}

/** Owns one credentialless read-only health projection and closes after in-flight reads drain. */
export class LocalFactoryOperationsHealthCoordinator implements LocalFactoryOperationsHealthRuntime {
  public readonly commands: FactoryOperationsHealthCommandPort;
  readonly #tasks: RuntimeTaskOwner;
  readonly #source: Pick<FactoryOperationsHealthSource, "close">;
  #closeInFlight: Promise<void> | null = null;
  #sourceClosed = false;
  #closed = false;

  public constructor(dependencies: LocalFactoryOperationsHealthCoordinatorDependencies) {
    this.#tasks = dependencies.tasks;
    this.#source = dependencies.source;
    this.commands = {
      inspect: () => this.#tasks.run(() => dependencies.service.inspect())
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
    await this.#tasks.stopAndDrain();
    if (!this.#sourceClosed) {
      this.#source.close();
      this.#sourceClosed = true;
    }
    this.#closed = this.#sourceClosed;
  }
}
