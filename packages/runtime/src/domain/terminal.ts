import type { SessionAttachmentTarget } from "./session-runtime.js";
import type { ManagedRuntimeResource } from "./runtime-resource.js";

export interface Disposable {
  dispose(): void;
}

export interface PseudoTerminal {
  write(data: Uint8Array): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): Disposable;
  onExit(listener: (event: { exitCode: number }) => void): Disposable;
}

/** Internal attachment whose process exit can be confirmed before persistence is released. */
export type ManagedTerminalResource = ManagedRuntimeResource;

/** Retains terminal resources across fallible adapter and application setup. */
export interface ManagedTerminalResourceOwner {
  track(resource: ManagedTerminalResource): void;
  release(resource: ManagedTerminalResource): void;
}

/** Internal attachment whose process exit can be confirmed before persistence is released. */
export interface ManagedPseudoTerminal extends PseudoTerminal, ManagedTerminalResource {
  killAndWait(): Promise<void>;
  consumePendingOutputOverrun?(): number | null;
}

export interface TerminalDimensions {
  readonly columns: number;
  readonly rows: number;
}

export interface PseudoTerminalFactory {
  attach(sessionName: string, cwd: string, dimensions: TerminalDimensions): PseudoTerminal;
}

export interface ManagedPseudoTerminalFactory {
  attach(
    target: SessionAttachmentTarget,
    cwd: string,
    dimensions: TerminalDimensions,
    owner: ManagedTerminalResourceOwner
  ): ManagedPseudoTerminal;
}

export interface TerminalHistoryReader {
  read(sessionName: string): Promise<string>;
}

export interface ManagedTerminalHistoryReader {
  read(target: SessionAttachmentTarget): Promise<string>;
}
