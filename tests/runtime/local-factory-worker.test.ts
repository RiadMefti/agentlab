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
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testEvalDigest, testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
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
      "runCanaryPullRequestRepairTick",
      "runScheduledTick",
      "runTask"
    ]);
    await expect(runtime.commands.preflight()).resolves.toMatchObject({
      schemaVersion: "agentlab.worker-preflight.v3",
      status: "blocked",
      schedulePolicyDigest: null,
      roleIdentityPolicyDigest: null,
      schedulerEnabled: false,
      costPolicyConfigured: true,
      hostReady: false,
      configuredProviders: ["codex"],
      gateIds: ["architecture", "build", "format", "lint", "secret-scan", "test", "typecheck"],
      reasonCodes: [
        "role-identity-policy-unconfigured",
        "schedule-policy-unconfigured",
        "scheduler-disabled"
      ]
    });
    await expect(runtime.commands.runScheduledTick({})).rejects.toThrow(
      /scheduler policy is not configured/u
    );
    await expect(runtime.commands.runCanaryPullRequestRepairTick({})).rejects.toThrow(
      /repair consumer policy is not configured/u
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

  it("blocks legacy scheduled config and wrong worker identity before persistence", () => {
    const fixture = workerOptions();
    expect(() =>
      createConfiguredLocalFactoryWorker({
        ...fixture.options,
        schemaVersion: "agentlab.local-factory-worker.v2",
        costPolicyPath: "/private/agentlab/cost-policy.json",
        schedulePolicyPath: "/private/agentlab/schedule-policy.json",
        schedulePolicy: testFactorySchedulePolicy()
      } as unknown as LocalFactoryWorkerConfig)
    ).toThrow(/without enforced role identity/u);

    const wrongWorkerUserId = process.getuid?.() === 1 ? 2 : 1;
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testEvalDigest(901),
      workerUserId: wrongWorkerUserId,
      attestorUserId: wrongWorkerUserId === 2 ? 3 : 2
    });
    const expectedRoleIdentityPolicyDigest = new NodeFactoryDocumentCodec().roleIdentityPolicy(
      roleIdentityPolicy
    ).digest;
    expect(() =>
      createLocalFactoryWorker({
        ...fixture.options,
        schedulePolicy: testFactorySchedulePolicy(),
        roleIdentityPolicy,
        expectedRoleIdentityPolicyDigest
      })
    ).toThrow(/process identity/u);
    expect(existsSync(`${fixture.options.databasePath}.agentlab-writer-lock.sqlite`)).toBe(false);
  });

  it("allows an identity-bound v3 manual worker without enabling a scheduler", async () => {
    const processUserId = process.getuid?.();
    if (processUserId === undefined || processUserId < 1) {
      throw new Error("This identity-bound composition test requires a non-root POSIX user.");
    }
    const fixture = workerOptions();
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testEvalDigest(901),
      workerUserId: processUserId,
      attestorUserId: processUserId === 1 ? 2 : 1
    });
    const expectedRoleIdentityPolicyDigest = new NodeFactoryDocumentCodec().roleIdentityPolicy(
      roleIdentityPolicy
    ).digest;
    const runtime = createConfiguredLocalFactoryWorker({
      ...fixture.options,
      schemaVersion: "agentlab.local-factory-worker.v3",
      costPolicyPath: "/private/agentlab/cost-policy.json",
      roleIdentityPolicyPath: "/private/agentlab/role-identities.json",
      expectedRoleIdentityPolicyDigest,
      roleIdentityPolicy
    } as LocalFactoryWorkerConfig);

    await expect(runtime.commands.preflight()).resolves.toMatchObject({
      roleIdentityPolicyDigest: expectedRoleIdentityPolicyDigest,
      reasonCodes: ["schedule-policy-unconfigured", "scheduler-disabled"]
    });
    await runtime.close();
  });

  it("composes the canary repair consumer only with exact v3 schedule and role policies", async () => {
    const processUserId = process.getuid?.();
    if (processUserId === undefined || processUserId < 1) {
      throw new Error("This identity-bound composition test requires a non-root POSIX user.");
    }
    const fixture = workerOptions();
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testEvalDigest(902),
      workerUserId: processUserId,
      attestorUserId: processUserId === 1 ? 2 : 1
    });
    const expectedRoleIdentityPolicyDigest = new NodeFactoryDocumentCodec().roleIdentityPolicy(
      roleIdentityPolicy
    ).digest;
    const runtime = createLocalFactoryWorker({
      ...fixture.options,
      schedulePolicy: testFactorySchedulePolicy(),
      roleIdentityPolicy,
      expectedRoleIdentityPolicyDigest
    });
    const preflight = await runtime.commands.preflight();
    if (preflight.schedulePolicyDigest === null || preflight.roleIdentityPolicyDigest === null) {
      throw new Error("Scheduled worker preflight lost its exact policy identities.");
    }

    await expect(
      runtime.commands.runCanaryPullRequestRepairTick({
        expectedSchedulePolicyDigest: preflight.schedulePolicyDigest,
        expectedRoleIdentityPolicyDigest: preflight.roleIdentityPolicyDigest,
        expectedFactoryPolicyBundleDigest: preflight.policyBundleDigest
      })
    ).resolves.toMatchObject({
      schemaVersion: "agentlab.canary-pull-request-repair-tick-result.v1",
      status: "blocked",
      candidatesInspected: 0,
      reasonCodes: ["scheduler-disabled"]
    });
    await runtime.close();
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
