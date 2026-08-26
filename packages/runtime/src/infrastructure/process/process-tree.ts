import type { ChildProcess } from "node:child_process";

export interface ProcessTreeShutdownOptions {
  readonly gracefulTimeoutMs: number;
  readonly forcedTimeoutMs: number;
}

/** Terminates a detached process group and waits for its host and descendants. */
export async function terminateProcessTree(
  child: ChildProcess,
  isClosed: () => boolean,
  options: ProcessTreeShutdownOptions
): Promise<void> {
  if (processTreeClosed(child, isClosed)) return;

  const terminated = signalProcessTree(child, isClosed, "SIGTERM");
  if (!terminated) {
    if (await waitForProcessTreeClose(child, isClosed, options.gracefulTimeoutMs)) return;
    throw new Error("Failed to send SIGTERM to the provider process tree.");
  }
  if (await waitForProcessTreeClose(child, isClosed, options.gracefulTimeoutMs)) return;

  const killed = signalProcessTree(child, isClosed, "SIGKILL");
  if (!killed) {
    if (await waitForProcessTreeClose(child, isClosed, options.forcedTimeoutMs)) return;
    throw new Error("Failed to send SIGKILL to the provider process tree.");
  }
  if (await waitForProcessTreeClose(child, isClosed, options.forcedTimeoutMs)) return;
  throw new Error("Provider process tree did not close after SIGKILL.");
}

function signalProcessTree(
  child: ChildProcess,
  isClosed: () => boolean,
  signal: NodeJS.Signals
): boolean {
  if (child.pid === undefined) return isClosed();
  if (process.platform !== "win32") {
    try {
      return process.kill(-child.pid, signal);
    } catch (error: unknown) {
      if (!isNoSuchProcess(error)) throw error;
      if (isClosed() || hasExited(child)) return true;
    }
  } else if (isClosed() || hasExited(child)) {
    return true;
  }
  try {
    return child.kill(signal);
  } catch (error: unknown) {
    if (isNoSuchProcess(error)) return true;
    throw error;
  }
}

function waitForProcessTreeClose(
  child: ChildProcess,
  isClosed: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  if (processTreeClosed(child, isClosed)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let finished = false;
    const finish = (closed: boolean): void => {
      if (finished) return;
      finished = true;
      clearInterval(interval);
      clearTimeout(timeout);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = (): void => {
      if (processTreeClosed(child, isClosed)) finish(true);
    };
    const interval = setInterval(() => {
      if (processTreeClosed(child, isClosed)) finish(true);
    }, 10);
    const timeout = setTimeout(() => {
      finish(processTreeClosed(child, isClosed));
    }, timeoutMs);
    child.once("close", onClose);
    if (processTreeClosed(child, isClosed)) finish(true);
  });
}

function processTreeClosed(child: ChildProcess, isClosed: () => boolean): boolean {
  if (child.pid === undefined) return true;
  if (!isClosed()) return false;
  if (process.platform === "win32") return true;
  return !processGroupExists(child.pid);
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    return !isNoSuchProcess(error);
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ESRCH"
  );
}
