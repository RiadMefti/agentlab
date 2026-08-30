import type {
  Disposable,
  ManagedPseudoTerminal,
  ManagedPseudoTerminalFactory,
  ManagedTerminalHistoryReader,
  PseudoTerminal,
  PseudoTerminalFactory,
  TerminalHistoryReader
} from "../../domain/terminal.js";
import { withTimeout } from "../process/promise-timeout.js";

const DEFAULT_EXIT_CONFIRMATION_TIMEOUT_MS = 2_500;

export interface LegacyTerminalAdapterOptions {
  readonly exitConfirmationTimeoutMs?: number;
}

/** Preserves the original public terminal seam while enforcing confirmed internal shutdown. */
export function adaptLegacyTerminalFactory(
  factory: PseudoTerminalFactory,
  options: LegacyTerminalAdapterOptions = {}
): ManagedPseudoTerminalFactory {
  const exitConfirmationTimeoutMs =
    options.exitConfirmationTimeoutMs ?? DEFAULT_EXIT_CONFIRMATION_TIMEOUT_MS;
  return {
    attach(target, cwd, dimensions, owner) {
      if (target.ownership.mode !== "legacy-name") {
        throw new Error(
          "A name-only terminal factory cannot attach a nonce-owned managed session."
        );
      }
      const terminal = new ExitConfirmingPseudoTerminal(
        factory.attach(target.sessionName, cwd, dimensions),
        exitConfirmationTimeoutMs
      );
      owner.track(terminal);
      terminal.startExitObservation();
      return terminal;
    }
  };
}

/** Adapts the original name-based history seam at the trusted composition boundary. */
export function adaptLegacyTerminalHistoryReader(
  history: TerminalHistoryReader
): ManagedTerminalHistoryReader {
  return {
    read(target) {
      if (target.ownership.mode !== "legacy-name") {
        return Promise.reject(
          new Error("A name-only history reader cannot read a nonce-owned managed session.")
        );
      }
      return history.read(target.sessionName);
    }
  };
}

class ExitConfirmingPseudoTerminal implements ManagedPseudoTerminal {
  readonly #terminal: PseudoTerminal;
  readonly #exitConfirmationTimeoutMs: number;
  readonly #exit: Promise<void>;
  readonly #resolveExit: () => void;
  readonly #exitListeners = new Set<(event: { exitCode: number }) => void>();
  #exitSubscription: Disposable | null = null;
  #exitEvent: { readonly exitCode: number } | null = null;
  #killInFlight: Promise<void> | null = null;

  public constructor(terminal: PseudoTerminal, exitConfirmationTimeoutMs: number) {
    this.#terminal = terminal;
    this.#exitConfirmationTimeoutMs = exitConfirmationTimeoutMs;
    let resolveExit = (): void => undefined;
    this.#exit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    this.#resolveExit = resolveExit;
  }

  public write(data: Uint8Array): void {
    this.#terminal.write(data);
  }

  public resize(columns: number, rows: number): void {
    this.#terminal.resize(columns, rows);
  }

  public kill(): void {
    void this.killAndWait().catch(() => undefined);
  }

  public closeAndWait(): Promise<void> {
    return this.killAndWait();
  }

  public killAndWait(): Promise<void> {
    if (this.#exitEvent !== null) return Promise.resolve();
    if (this.#killInFlight !== null) return this.#killInFlight;
    try {
      this.ensureExitSubscription();
      this.#terminal.kill();
    } catch (error: unknown) {
      return Promise.reject(asError(error));
    }
    const attempt = withTimeout(this.#exit, {
      timeoutMs: this.#exitConfirmationTimeoutMs,
      message: "The custom terminal did not confirm process exit."
    }).then(() => undefined);
    const shared = attempt.finally(() => {
      if (this.#killInFlight === shared && this.#exitEvent === null) this.#killInFlight = null;
    });
    this.#killInFlight = shared;
    return shared;
  }

  public onData(listener: (data: string) => void): Disposable {
    return this.#terminal.onData(listener);
  }

  public startExitObservation(): void {
    this.ensureExitSubscription();
  }

  public onExit(listener: (event: { exitCode: number }) => void): Disposable {
    this.#exitListeners.add(listener);
    try {
      if (this.#exitEvent === null) this.ensureExitSubscription();
      else listener(this.#exitEvent);
    } catch (error: unknown) {
      this.#exitListeners.delete(listener);
      throw error;
    }
    return disposable(() => this.#exitListeners.delete(listener));
  }

  private ensureExitSubscription(): void {
    if (this.#exitEvent !== null || this.#exitSubscription !== null) return;
    const subscription = this.#terminal.onExit((event) => {
      this.confirmExit(event);
    });
    if (this.hasConfirmedExit()) subscription.dispose();
    else this.#exitSubscription = subscription;
  }

  private hasConfirmedExit(): boolean {
    return this.#exitEvent !== null;
  }

  private confirmExit(event: { readonly exitCode: number }): void {
    if (this.#exitEvent !== null) return;
    this.#exitEvent = event;
    this.#exitSubscription?.dispose();
    this.#exitSubscription = null;
    this.#resolveExit();
    for (const listener of this.#exitListeners) listener(event);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error("The custom terminal operation failed.", { cause: error });
}

function disposable(dispose: () => void): Disposable {
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      dispose();
    }
  };
}
