import type { ChildProcess } from "node:child_process";

import type { ManagedRuntimeResource } from "../../domain/runtime-resource.js";
import { terminateProcessTree, type ProcessTreeShutdownOptions } from "./process-tree.js";

export type ProcessTreeTerminator = (
  child: ChildProcess,
  isClosed: () => boolean,
  options: ProcessTreeShutdownOptions
) => Promise<void>;

/** Retains retryable ownership of one child process until its whole process tree is confirmed gone. */
export class ManagedChildProcess implements ManagedRuntimeResource {
  readonly #child: ChildProcess;
  readonly #isClosed: () => boolean;
  readonly #options: ProcessTreeShutdownOptions;
  readonly #terminate: ProcessTreeTerminator;
  #confirmedClosed = false;
  #closeInFlight: Promise<void> | null = null;

  public constructor(
    child: ChildProcess,
    isClosed: () => boolean,
    options: ProcessTreeShutdownOptions,
    terminate: ProcessTreeTerminator = terminateProcessTree
  ) {
    this.#child = child;
    this.#isClosed = isClosed;
    this.#options = options;
    this.#terminate = terminate;
  }

  public closeAndWait(): Promise<void> {
    if (this.#confirmedClosed) return Promise.resolve();
    if (this.#closeInFlight !== null) return this.#closeInFlight;
    const attempt = Promise.resolve()
      .then(() => this.#terminate(this.#child, this.#isClosed, this.#options))
      .then(() => {
        this.#confirmedClosed = true;
      });
    const shared = attempt.finally(() => {
      if (this.#closeInFlight === shared && !this.#confirmedClosed) this.#closeInFlight = null;
    });
    this.#closeInFlight = shared;
    return shared;
  }
}
