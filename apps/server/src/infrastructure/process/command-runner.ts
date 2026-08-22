import { execFile, spawn } from "node:child_process";

import { terminateProcessTree } from "./process-tree.js";

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_GRACEFUL_SHUTDOWN_MS = 500;
const DEFAULT_FORCED_SHUTDOWN_MS = 2_000;

export interface RunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly maxBufferBytes?: number;
  readonly cleanupProcessTree?: boolean;
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(executable: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

export interface NodeCommandRunnerOptions {
  readonly gracefulShutdownMs?: number;
  readonly forcedShutdownMs?: number;
}

export class NodeCommandRunner implements CommandRunner {
  readonly #gracefulShutdownMs: number;
  readonly #forcedShutdownMs: number;

  public constructor(options: NodeCommandRunnerOptions = {}) {
    this.#gracefulShutdownMs = options.gracefulShutdownMs ?? DEFAULT_GRACEFUL_SHUTDOWN_MS;
    this.#forcedShutdownMs = options.forcedShutdownMs ?? DEFAULT_FORCED_SHUTDOWN_MS;
  }

  public run(
    executable: string,
    args: readonly string[],
    options: RunOptions = {}
  ): Promise<RunResult> {
    if (options.cleanupProcessTree === true) {
      return this.runWithProcessTreeCleanup(executable, args, options);
    }
    return new Promise((resolve, reject) => {
      execFile(
        executable,
        [...args],
        {
          cwd: options.cwd,
          encoding: "utf8",
          env: options.environment,
          maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
          timeout: options.timeoutMs
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            const executionError =
              error instanceof Error ? error : new Error("Command execution failed.");
            reject(
              Object.assign(executionError, {
                stdout,
                stderr
              })
            );
            return;
          }
          resolve({ stdout, stderr });
        }
      );
    });
  }

  private runWithProcessTreeCleanup(
    executable: string,
    args: readonly string[],
    options: RunOptions
  ): Promise<RunResult> {
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0) {
      return Promise.reject(new Error("Command output limit must be a positive integer."));
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      return Promise.reject(new Error("Command timeout must be a positive integer."));
    }

    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        env: options.environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let finishing = false;
      let closed = false;
      let outcomeError: Error | null = null;

      const timeout =
        options.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              void finish(
                new Error(`Command timed out after ${String(options.timeoutMs)} milliseconds.`)
              );
            }, options.timeoutMs);

      const finish = async (commandError: Error | null): Promise<void> => {
        if (commandError !== null && outcomeError === null) outcomeError = commandError;
        if (finishing) return;
        finishing = true;
        if (timeout !== null) clearTimeout(timeout);
        try {
          await terminateProcessTree(child, () => closed, {
            gracefulTimeoutMs: this.#gracefulShutdownMs,
            forcedTimeoutMs: this.#forcedShutdownMs
          });
        } catch (cleanupError: unknown) {
          const detail =
            cleanupError instanceof Error ? cleanupError.message : "Unknown cleanup failure.";
          reject(
            withOutput(
              new Error(
                outcomeError === null
                  ? `Command cleanup failed: ${detail}`
                  : `${outcomeError.message} Cleanup failed: ${detail}`,
                { cause: cleanupError }
              ),
              stdout,
              stderr
            )
          );
          return;
        }
        if (outcomeError === null) resolve({ stdout, stderr });
        else reject(withOutput(outcomeError, stdout, stderr));
      };

      child.stdout.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > maxBufferBytes) {
          void finish(new Error("Command stdout exceeded the size limit."));
          return;
        }
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > maxBufferBytes) {
          void finish(new Error("Command stderr exceeded the size limit."));
          return;
        }
        stderr += chunk;
      });
      child.on("error", (error) => {
        void finish(error);
      });
      child.on("exit", (code, signal) => {
        void finish(
          code === 0
            ? null
            : new Error(
                `Command exited with ${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}.`
              )
        );
      });
      child.on("close", (code, signal) => {
        closed = true;
        if (!finishing) {
          void finish(
            code === 0
              ? null
              : new Error(
                  `Command closed with ${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}.`
                )
          );
        }
      });
    });
  }
}

function withOutput(error: Error, stdout: string, stderr: string): Error {
  return Object.assign(error, { stdout, stderr });
}

export function errorOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const record = error as Record<string, unknown>;
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const message = error instanceof Error ? error.message : "";
  return `${stderr}\n${message}`.trim();
}
