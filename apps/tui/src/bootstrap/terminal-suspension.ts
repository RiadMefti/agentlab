export interface SuspendableTerminalRenderer {
  resume(): void;
  suspend(): void;
}

export interface TerminalSuspendHandlers {
  readonly onContinue: () => void;
  readonly onSuspend: () => void;
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
