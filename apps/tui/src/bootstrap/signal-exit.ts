import { constants as osConstants } from "node:os";

export const rendererExitStatusSignals = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
  "SIGABRT",
  "SIGBUS"
] as const satisfies readonly NodeJS.Signals[];

interface SignalListenerTarget {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export function exitCodeForSignal(signal: string): number {
  const signalNumber = (osConstants.signals as Readonly<Record<string, number | undefined>>)[
    signal
  ];
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}

/** Preserves conventional shell status while OpenTUI owns mode restoration for the signal. */
export function installSignalExitStatusHandlers(
  target: SignalListenerTarget = process,
  setExitCode: (code: number) => void = (code) => {
    process.exitCode = code;
  }
): () => void {
  const registrations = rendererExitStatusSignals.map((signal) => {
    const listener = (): void => {
      setExitCode(exitCodeForSignal(signal));
    };
    target.on(signal, listener);
    return { listener, signal };
  });
  return () => {
    for (const { listener, signal } of registrations) target.off(signal, listener);
  };
}
