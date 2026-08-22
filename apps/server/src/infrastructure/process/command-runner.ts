import { execFile } from "node:child_process";

export interface RunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly maxBufferBytes?: number;
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(executable: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
}

export class NodeCommandRunner implements CommandRunner {
  public run(
    executable: string,
    args: readonly string[],
    options: RunOptions = {}
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      execFile(
        executable,
        [...args],
        {
          cwd: options.cwd,
          encoding: "utf8",
          env: options.environment,
          maxBuffer: options.maxBufferBytes ?? 1024 * 1024,
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
}

export function errorOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const record = error as Record<string, unknown>;
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const message = error instanceof Error ? error.message : "";
  return `${stderr}\n${message}`.trim();
}
