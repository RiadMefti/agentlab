import { describe, expect, it } from "vitest";

import { RuntimeResourceOwner } from "../../packages/runtime/src/application/runtime-resource-owner.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { terminateProcessTree } from "../../packages/runtime/src/infrastructure/process/process-tree.js";

describe("NodeCommandRunner", () => {
  it("writes bounded stdin without constructing a shell command", async () => {
    const runner = new NodeCommandRunner();

    await expect(
      runner.run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
        stdin: "exact input",
        maxInputBytes: 64
      })
    ).resolves.toEqual({ stdout: "exact input", stderr: "" });
    await expect(
      runner.run(process.execPath, ["-e", "process.stdin.resume()"], {
        stdin: "too large",
        maxInputBytes: 3
      })
    ).rejects.toThrow(/stdin exceeded/u);
  });

  it("never retains output beyond the configured cap while terminating an ignored-TERM child", async () => {
    const maximumBytes = 1_024;
    const runner = new NodeCommandRunner({ gracefulShutdownMs: 25, forcedShutdownMs: 1_000 });
    const error = await runner
      .run(
        process.execPath,
        [
          "-e",
          [
            'process.on("SIGTERM", () => undefined);',
            'const chunk = "x".repeat(4096);',
            "setInterval(() => process.stdout.write(chunk), 0);"
          ].join("")
        ],
        { cleanupProcessTree: true, maxBufferBytes: maximumBytes, timeoutMs: 2_000 }
      )
      .catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    const output = error as Error & { readonly stdout?: string; readonly stderr?: string };
    expect(Buffer.byteLength(output.stdout ?? "")).toBeLessThanOrEqual(maximumBytes);
    expect(Buffer.byteLength(output.stderr ?? "")).toBeLessThanOrEqual(maximumBytes);
  });

  it("retains a child for runtime-shutdown retry when command cleanup is ambiguous", async () => {
    const owner = new RuntimeResourceOwner();
    let cleanupAttempts = 0;
    const runner = new NodeCommandRunner({
      gracefulShutdownMs: 25,
      forcedShutdownMs: 1_000,
      resourceOwner: owner,
      processTreeTerminator: async (child, isClosed, options) => {
        cleanupAttempts += 1;
        if (cleanupAttempts === 1) throw new Error("process observation failed");
        await terminateProcessTree(child, isClosed, options);
      }
    });

    await expect(
      runner.run(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
        timeoutMs: 25
      })
    ).rejects.toThrow("Command timed out after 25 milliseconds.");
    expect(cleanupAttempts).toBe(1);

    await expect(owner.closeAll()).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(2);
  });
});
