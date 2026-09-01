import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactoryEvalSubjectRequest, Sha256Digest } from "@agentlab/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FactoryEvalSandbox } from "../../packages/runtime/src/domain/factory-eval-harness.js";
import type { FactoryProcessIsolator } from "../../packages/runtime/src/domain/factory-process-isolation.js";
import { pinnedLocalExecutableDigest } from "../../packages/runtime/src/infrastructure/filesystem/pinned-local-executable.js";
import type { CommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { LocalFactoryEvalHarnessExecutor } from "../../packages/runtime/src/infrastructure/process/local-factory-eval-harness-executor.js";
import {
  testFactoryEvalInvocationBudget,
  testFactoryEvalIsolation,
  testFactoryEvalUsage
} from "../helpers/factory-eval-production.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalFactoryEvalHarnessExecutor", () => {
  it("runs a fixed protocol with private files, bounded clean environment, and exact cleanup", async () => {
    const root = temporaryRoot();
    const request = subjectRequest();
    const executableDigest = await pinnedLocalExecutableDigest("/usr/bin/true", "test executable");
    const run = vi.fn<CommandRunner["run"]>((_executable, args, options) => {
      const runOptions = options ?? fail("Missing command options.");
      expect(args).toEqual(["subject"]);
      expect(runOptions.environment).toEqual(expect.objectContaining({ CI: "true", LC_ALL: "C" }));
      expect(runOptions.environment).not.toHaveProperty("OPENAI_API_KEY");
      expect(runOptions.stdin).toBe(JSON.stringify(request));
      writePrivate(join(runOptions.cwd ?? fail("Missing cwd."), "output"), "subject-output");
      writePrivate(join(runOptions.cwd ?? fail("Missing cwd."), "trace"), "subject-trace");
      return Promise.resolve({
        stdout: JSON.stringify({
          schemaVersion: "agentlab.eval-subject-response.v1",
          status: "succeeded",
          usage: { ...testFactoryEvalUsage(), outputBytes: 10_000 },
          usageComplete: true,
          reasonCode: null
        }),
        stderr: ""
      });
    });
    const executor = new LocalFactoryEvalHarnessExecutor(
      { run },
      identitySandbox(),
      identityIsolator(request.executionId),
      { workspaceRoot: root, now: timestamps() }
    );

    const result = await executor.executeSubject({
      request,
      requestJson: JSON.stringify(request),
      binding: {
        descriptorDigest: request.harnessDigest,
        executable: "/usr/bin/true",
        executableDigest,
        version: "1.0.0"
      },
      fixture: new TextEncoder().encode("fixture"),
      budget: { ...testFactoryEvalInvocationBudget(), maxOutputBytes: 20_000 },
      resourceLimits: requestLimits(),
      deadlineAt: "2026-09-01T10:10:00.000Z",
      maximumOutputBytes: 1_024,
      maximumTraceBytes: 1_024
    });

    expect(result).toMatchObject({
      status: "succeeded",
      latencyMilliseconds: 1_000,
      errorCode: null,
      response: { status: "succeeded", usageComplete: true }
    });
    expect(new TextDecoder().decode(result.output ?? fail("Missing output."))).toBe(
      "subject-output"
    );
    expect(new TextDecoder().decode(result.trace ?? fail("Missing trace."))).toBe("subject-trace");
    expect(readdirSync(root)).toEqual([]);
  });

  it("rejects a symlinked harness output without reading outside the sandbox", async () => {
    const root = temporaryRoot();
    const request = subjectRequest();
    const executableDigest = await pinnedLocalExecutableDigest("/usr/bin/true", "test executable");
    const runner: CommandRunner = {
      run: (_executable, _args, options) => {
        const cwd = options?.cwd ?? fail("Missing cwd.");
        symlinkSync("/etc/passwd", join(cwd, "output"));
        writePrivate(join(cwd, "trace"), "trace");
        return Promise.resolve({
          stdout: JSON.stringify({
            schemaVersion: "agentlab.eval-subject-response.v1",
            status: "succeeded",
            usage: { ...testFactoryEvalUsage(), outputBytes: 10_000 },
            usageComplete: true,
            reasonCode: null
          }),
          stderr: ""
        });
      }
    };
    const executor = new LocalFactoryEvalHarnessExecutor(
      runner,
      identitySandbox(),
      identityIsolator(request.executionId),
      { workspaceRoot: root, now: timestamps() }
    );

    await expect(
      executor.executeSubject({
        request,
        requestJson: JSON.stringify(request),
        binding: {
          descriptorDigest: request.harnessDigest,
          executable: "/usr/bin/true",
          executableDigest,
          version: "1.0.0"
        },
        fixture: new TextEncoder().encode("fixture"),
        budget: { ...testFactoryEvalInvocationBudget(), maxOutputBytes: 20_000 },
        resourceLimits: requestLimits(),
        deadlineAt: "2026-09-01T10:10:00.000Z",
        maximumOutputBytes: 1_024,
        maximumTraceBytes: 1_024
      })
    ).rejects.toThrow(/private regular file/u);
    expect(readdirSync(root)).toEqual([]);
  });

  it("preserves the workspace when process-tree cleanup cannot be proven", async () => {
    const root = temporaryRoot();
    const request = subjectRequest();
    const executableDigest = await pinnedLocalExecutableDigest("/usr/bin/true", "test executable");
    const executor = new LocalFactoryEvalHarnessExecutor(
      { run: () => Promise.reject(new Error("unknown runner failure")) },
      identitySandbox(),
      identityIsolator(request.executionId),
      { workspaceRoot: root, now: timestamps() }
    );

    await expect(
      executor.executeSubject({
        request,
        requestJson: JSON.stringify(request),
        binding: {
          descriptorDigest: request.harnessDigest,
          executable: "/usr/bin/true",
          executableDigest,
          version: "1.0.0"
        },
        fixture: new TextEncoder().encode("fixture"),
        budget: { ...testFactoryEvalInvocationBudget(), maxOutputBytes: 20_000 },
        resourceLimits: requestLimits(),
        deadlineAt: "2026-09-01T10:10:00.000Z",
        maximumOutputBytes: 1_024,
        maximumTraceBytes: 1_024
      })
    ).rejects.toThrow(/cleanup could not be confirmed/u);
    expect(readdirSync(root)).toHaveLength(1);
  });
});

function subjectRequest(): FactoryEvalSubjectRequest {
  const descriptorDigest = testDigest(1);
  return {
    schemaVersion: "agentlab.eval-subject-request.v1",
    jobId: "50000000-0000-4000-8000-000000000001",
    jobDigest: testDigest(2),
    executionId: "50000000-0000-4000-8000-000000000002",
    candidateRole: "baseline",
    candidateDigest: testDigest(3),
    candidate: {
      schemaVersion: "agentlab.factory-candidate.v1",
      candidateId: "baseline",
      version: "1.0.0",
      repositoryId: "agentlab",
      baseRevision: "a".repeat(40),
      policyBundleDigest: testDigest(4),
      schedulePolicyDigest: testDigest(5),
      harnessDigest: descriptorDigest,
      providerConfigurationDigest: testDigest(6),
      skillPackageDigests: [],
      createdAt: "2026-09-01T09:00:00.000Z"
    },
    harnessDigest: descriptorDigest,
    harness: {
      schemaVersion: "agentlab.eval-harness.v1",
      id: "test-harness",
      version: "1.0.0",
      executableDigest: testDigest(7),
      protocolVersion: "agentlab.eval-harness-protocol.v1",
      network: "off",
      secrets: false
    },
    caseId: "feature/simple",
    trial: 1,
    seedDigest: testDigest(8),
    fixture: { digest: testDigest(9), mediaType: "application/json", sizeBytes: 7 },
    fixturePath: "/workspace/fixture",
    outputPath: "/workspace/output",
    tracePath: "/workspace/trace"
  };
}

function identitySandbox(): FactoryEvalSandbox {
  return { wrap: (command) => Promise.resolve(command) };
}

function identityIsolator(executionId: string): FactoryProcessIsolator {
  return {
    isolate: (input) =>
      Promise.resolve({
        command: input.command,
        controllerEnvironment: {},
        isolation: testFactoryEvalIsolation(executionId)
      })
  };
}

function requestLimits() {
  return {
    maxProcesses: 4,
    maxMemoryBytes: 256 * 1_024 * 1_024,
    cpuQuotaPercent: 100
  };
}

function timestamps(): () => string {
  const values = ["2026-09-01T10:00:00.000Z", "2026-09-01T10:00:01.000Z"];
  return () => values.shift() ?? "2026-09-01T10:00:01.000Z";
}

function writePrivate(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-eval-harness-"));
  roots.push(root);
  return root;
}

function testDigest(index: number): Sha256Digest {
  return `sha256:${createHash("sha256").update(String(index)).digest("hex")}`;
}

function fail(message: string): never {
  throw new Error(message);
}
