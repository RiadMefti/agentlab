import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createConfiguredLocalFactoryWorker,
  createLocalFactoryWorker,
  type LocalFactoryWorkerConfig,
  type LocalFactoryWorkerOptions
} from "../../packages/runtime/src/local-factory-worker.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";

const executableContent =
  "#!/bin/sh\nif [ \"$1\" = \"--user\" ]; then printf '261\\n'; else printf 'systemd 261\\n'; fi\n";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local factory worker composition", () => {
  it("exposes only a credentialless default-off worker command surface", async () => {
    const fixture = workerOptions();
    const runtime = createLocalFactoryWorker(fixture.options);

    expect(Object.keys(runtime.commands).sort()).toEqual([
      "admitExecution",
      "advancePreparation",
      "execute",
      "executePullRequestRepair",
      "materializePreparation",
      "preflight",
      "recoverExecution",
      "recoverPreparation",
      "recoverPullRequestRepair",
      "runScheduledTick",
      "runTask"
    ]);
    await expect(runtime.commands.preflight()).resolves.toMatchObject({
      schemaVersion: "agentlab.worker-preflight.v2",
      status: "blocked",
      schedulePolicyDigest: null,
      schedulerEnabled: false,
      costPolicyConfigured: true,
      hostReady: true,
      configuredProviders: ["codex"],
      gateIds: ["architecture", "build", "format", "lint", "secret-scan", "test", "typecheck"],
      reasonCodes: ["schedule-policy-unconfigured", "scheduler-disabled"]
    });
    await expect(runtime.commands.runScheduledTick({})).rejects.toThrow(
      /scheduler policy is not configured/u
    );
    await runtime.close();

    const reopened = createLocalFactoryWorker(fixture.options);
    await reopened.close();
  });

  it("refuses an in-memory ledger for autonomous work", () => {
    const fixture = workerOptions();
    expect(() =>
      createLocalFactoryWorker({ ...fixture.options, databasePath: ":memory:" })
    ).toThrow(/durable SQLite database/u);
  });

  it("does not let a forged v1 configured runtime attach scheduler policy", () => {
    const fixture = workerOptions();
    expect(() =>
      createConfiguredLocalFactoryWorker({
        ...fixture.options,
        schemaVersion: "agentlab.local-factory-worker.v1",
        costPolicyPath: "/private/agentlab/cost-policy.json",
        schedulePolicy: testFactorySchedulePolicy()
      } as unknown as LocalFactoryWorkerConfig)
    ).toThrow(/v1 configuration cannot attach/u);
  });

  it("rejects overlapping owned roots before acquiring persistence authority", () => {
    const fixture = workerOptions();
    expect(() =>
      createLocalFactoryWorker({
        ...fixture.options,
        workspaceRoot: join(fixture.options.artifactRoot, "worktrees")
      })
    ).toThrow(/must not overlap/u);
    expect(existsSync(`${fixture.options.databasePath}.agentlab-writer-lock.sqlite`)).toBe(false);
  });

  it("releases construction-time persistence ownership after fail-closed host setup", async () => {
    const fixture = workerOptions();
    expect(() => createLocalFactoryWorker({ ...fixture.options, hostEnvironment: {} })).toThrow(
      /XDG_RUNTIME_DIR/u
    );

    const recovered = createLocalFactoryWorker(fixture.options);
    await recovered.close();
  });
});

function workerOptions(): { readonly options: LocalFactoryWorkerOptions } {
  const root = mkdtempSync(join(tmpdir(), "agentlab-local-worker-"));
  temporaryRoots.push(root);
  const executable = join(root, "tool");
  writeFileSync(executable, executableContent, { mode: 0o700 });
  chmodSync(executable, 0o700);
  const runtimeRoot = join(root, "runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  const artifactRoot = join(root, "artifacts");
  const workspaceRoot = join(root, "worktrees");
  mkdirSync(artifactRoot, { mode: 0o700 });
  mkdirSync(workspaceRoot, { mode: 0o700 });
  const evidenceKinds = {
    format: "test",
    architecture: "test",
    typecheck: "test",
    lint: "test",
    test: "test",
    build: "build",
    "secret-scan": "security"
  } as const;
  return {
    options: {
      databasePath: join(root, "agentlab.sqlite"),
      artifactRoot,
      workspaceRoot,
      gitExecutable: executable,
      flockExecutable: executable,
      systemd: {
        runExecutable: executable,
        controlExecutable: executable,
        environmentExecutable: executable,
        version: "systemd 261"
      },
      sandbox: { bubblewrapExecutable: executable, runtimeRoots: [runtimeRoot] },
      providers: [
        {
          provider: "codex",
          executable,
          executableDigest: `sha256:${createHash("sha256")
            .update(executableContent)
            .digest("hex")}`,
          version: "systemd 261"
        }
      ],
      gates: Object.entries(evidenceKinds).map(([id, evidenceKind]) => ({
        id,
        evidenceKind,
        command: { executable, args: ["--version"] },
        timeoutMs: 5_000,
        maximumOutputBytes: 4_096
      })),
      costPolicy: {
        schemaVersion: "agentlab.cost-policy.v1",
        id: "agentlab/test-costs",
        version: "1.0.0",
        rules: [
          {
            provider: "codex",
            model: "gpt-5.4",
            accounting: {
              mode: "token-rate",
              inputMicrousdPerMillionTokens: 1_000_000,
              outputMicrousdPerMillionTokens: 2_000_000
            }
          }
        ]
      },
      hostEnvironment: {
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
      }
    }
  };
}
