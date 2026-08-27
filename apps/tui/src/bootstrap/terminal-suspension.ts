export interface SuspendableTerminalRenderer {
  resume(): void;
  suspend(): void;
}

export interface TerminalSuspendHandlers {
  readonly onContinue: () => void;
  readonly onSuspend: () => void;
}

/** Ensures process handlers and terminal modes are restored when mounting fails synchronously. */
export function renderWithTerminalCleanup(
  render: () => void,
  removeHandlers: () => void,
  destroyRenderer: () => void
): void {
  try {
    render();
  } catch (error: unknown) {
    removeHandlers();
    try {
      destroyRenderer();
    } catch (destroyError: unknown) {
      throw new AggregateError([error, destroyError], "Render and renderer cleanup both failed.");
    }
    throw error;
  }
}

/** Restores terminal modes before the OS stops the renderer, then repaints after SIGCONT. */
export function createTerminalSuspendHandlers(
  renderer: SuspendableTerminalRenderer,
  stopProcess: () => void,
  reportFailure: (message: string) => void
): TerminalSuspendHandlers {
  let suspended = false;
  return {
    onSuspend() {
      if (suspended) return;
      suspended = true;
      try {
        renderer.suspend();
      } catch (error: unknown) {
        reportFailure(`Terminal suspend failed: ${String(error)}`);
      } finally {
        stopProcess();
      }
    },
    onContinue() {
      if (!suspended) return;
      suspended = false;
      try {
        renderer.resume();
      } catch (error: unknown) {
        reportFailure(`Terminal resume failed: ${String(error)}`);
      }
    }
  };
}
