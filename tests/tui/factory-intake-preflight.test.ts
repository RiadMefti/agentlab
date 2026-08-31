import type {
  FactoryIntakePreflight,
  LocalFactoryIntakeConfig,
  LocalFactoryIntakeRuntime
} from "@agentlab/runtime/factory-intake";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryIntakePreflight,
  type FactoryIntakePreflightRunnerDependencies
} from "../../apps/tui/src/run-factory-intake-preflight.js";
import { testFactoryIntakePolicyFixture } from "../helpers/factory-intake.js";

const configPath = "/private/agentlab/intake.json";
const policyBundleDigest = `sha256:${"c".repeat(64)}` as const;

describe("factory intake preflight CLI runner", () => {
  it("prints one deterministic non-secret report after clean shutdown", async () => {
    const events: string[] = [];
    const writes: string[] = [];
    const runtime = intakeRuntime(Promise.resolve(report()), () =>
      Promise.resolve(events.push("closed")).then(() => undefined)
    );

    await expect(
      runFactoryIntakePreflight(
        configPath,
        dependencies(runtime, (message) => {
          events.push("written");
          writes.push(message);
        })
      )
    ).resolves.toBe(0);

    expect(events).toEqual(["closed", "written"]);
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      schemaVersion: "agentlab.intake-preflight.v1",
      status: "ready",
      policyBundleDigest,
      reasonCodes: []
    });
    expect(writes[0]).not.toContain("/private/agentlab");
  });

  it("closes on inspection failure and suppresses output after cleanup failure", async () => {
    const inspectionFailure = new Error("inspection failed");
    const cleanupFailure = new Error("cleanup failed");
    const writes: string[] = [];
    const runtime = intakeRuntime(Promise.reject(inspectionFailure), () =>
      Promise.reject(cleanupFailure)
    );

    await expect(
      runFactoryIntakePreflight(
        configPath,
        dependencies(runtime, (message) => writes.push(message))
      )
    ).rejects.toEqual(
      expect.objectContaining({
        name: "AggregateError",
        errors: [inspectionFailure, cleanupFailure]
      })
    );
    expect(writes).toEqual([]);
  });
});

function dependencies(
  runtime: LocalFactoryIntakeRuntime,
  write: (message: string) => void
): FactoryIntakePreflightRunnerDependencies {
  return {
    loadConfig: vi.fn(() => Promise.resolve(config())),
    createRuntime: vi.fn(() => runtime),
    write
  };
}

function intakeRuntime(
  preflight: Promise<FactoryIntakePreflight>,
  close: () => Promise<void>
): LocalFactoryIntakeRuntime {
  return {
    commands: {
      preflight: () => preflight,
      register: () => Promise.resolve(undefined as never)
    },
    close
  };
}

function report(): FactoryIntakePreflight {
  return {
    schemaVersion: "agentlab.intake-preflight.v1",
    status: "ready",
    repository: { repositoryId: "riadmefti/agentlab", baseRevision: "a".repeat(40) },
    conversation: {
      conversationId: "0198f005-4ec4-7000-8000-000000000001",
      active: true,
      workspaceMatches: true
    },
    policyBundleDigest,
    authority: {
      authorityId: "local/repository-policy",
      version: "1.0.0",
      maximumRiskTier: "R1",
      lifetimeSeconds: 3_600
    },
    skillPackages: [
      { id: "preparation/specify", packageDigest: `sha256:${"b".repeat(64)}` },
      { id: "preparation/qualify", packageDigest: `sha256:${"a".repeat(64)}` }
    ],
    reasonCodes: []
  };
}

function config(): LocalFactoryIntakeConfig {
  const fixture = testFactoryIntakePolicyFixture();
  return {
    schemaVersion: "agentlab.local-factory-intake.v1",
    databasePath: "/private/agentlab/agentlab.sqlite",
    artifactRoot: "/private/agentlab/artifacts",
    repositoryRoot: "/work/agentlab",
    repositoryId: "riadmefti/agentlab",
    conversationId: "0198f005-4ec4-7000-8000-000000000001",
    operatorId: "maintainer/riad",
    gitExecutable: "/usr/bin/git",
    flockExecutable: "/usr/bin/flock",
    costPolicyPath: "/private/agentlab/cost-policy.json",
    preparationGrantPath: "/private/agentlab/grant.json",
    skillPackagePaths: fixture.packages.map(
      (_, index) => `/private/agentlab/skill-${String(index)}.json`
    ),
    authorityLifetimeSeconds: 3_600,
    costPolicy: fixture.costPolicy,
    preparationGrant: fixture.grant,
    skillPackages: fixture.packages
  };
}
