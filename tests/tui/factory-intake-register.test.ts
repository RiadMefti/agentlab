import type { FactoryIntakeSubmission } from "@agentlab/contracts";
import type {
  FactoryIntakePreflight,
  FactoryIntakeRegistrationResult,
  LocalFactoryIntakeConfig,
  LocalFactoryIntakeRuntime
} from "@agentlab/runtime/factory-intake";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryIntakeRegister,
  type FactoryIntakeRegisterRunnerDependencies
} from "../../apps/tui/src/run-factory-intake-register.js";
import { testFactoryIntakePolicyFixture } from "../helpers/factory-intake.js";

const configPath = "/private/agentlab/intake.json";
const requestPath = "/private/agentlab/request.json";
const policyBundleDigest = `sha256:${"c".repeat(64)}` as const;

describe("factory intake registration CLI runner", () => {
  it("rejects malformed intent before loading owner-controlled files", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(config()));
    const loadSubmission = vi.fn(() => Promise.resolve(submission()));
    const dependencies = runnerDependencies(
      intakeRuntime(Promise.resolve(preflight()), () => Promise.resolve(result())),
      vi.fn(),
      loadConfig,
      loadSubmission
    );

    await expect(
      runFactoryIntakeRegister(
        "intake.json",
        requestPath,
        policyBundleDigest,
        "register-request",
        dependencies
      )
    ).rejects.toThrow(/absolute config path/u);
    await expect(
      runFactoryIntakeRegister(
        configPath,
        requestPath,
        "sha256:short",
        "register-request",
        dependencies
      )
    ).rejects.toThrow(/policy digest is invalid/u);
    await expect(
      runFactoryIntakeRegister(configPath, requestPath, policyBundleDigest, "no", dependencies)
    ).rejects.toThrow(/explicit registration confirmation/u);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(loadSubmission).not.toHaveBeenCalled();
  });

  it("registers only after ready preflight and closes before reporting", async () => {
    const events: string[] = [];
    const writes: string[] = [];
    const register = vi.fn(() => Promise.resolve(result()));
    const runtime = intakeRuntime(Promise.resolve(preflight()), register, () =>
      Promise.resolve(events.push("closed")).then(() => undefined)
    );

    await expect(
      runFactoryIntakeRegister(
        configPath,
        requestPath,
        policyBundleDigest,
        "register-request",
        runnerDependencies(runtime, (message) => {
          events.push("written");
          writes.push(message);
        })
      )
    ).resolves.toBe(0);

    expect(register).toHaveBeenCalledWith({
      submission: submission(),
      expectedPolicyBundleDigest: policyBundleDigest,
      confirmation: "register-request"
    });
    expect(events).toEqual(["closed", "written"]);
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "registered",
      reasonCodes: [],
      registration: { taskId: result().taskId, requestKind: "feature" }
    });
    expect(writes[0]).not.toContain(submission().body);
  });

  it("does not register when readiness or the operator policy pin is blocked", async () => {
    const register = vi.fn(() => Promise.resolve(result()));
    const writes: string[] = [];
    const runtime = intakeRuntime(
      Promise.resolve({
        ...preflight(),
        status: "blocked",
        reasonCodes: ["cost-policy-incomplete"]
      }),
      register
    );

    await expect(
      runFactoryIntakeRegister(
        configPath,
        requestPath,
        `sha256:${"d".repeat(64)}`,
        "register-request",
        runnerDependencies(runtime, (message) => writes.push(message))
      )
    ).resolves.toBe(2);

    expect(register).not.toHaveBeenCalled();
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "blocked",
      reasonCodes: ["cost-policy-incomplete", "policy-bundle-digest-mismatch"],
      registration: null
    });
  });
});

function runnerDependencies(
  runtime: LocalFactoryIntakeRuntime,
  write: (message: string) => void,
  loadConfig: () => Promise<LocalFactoryIntakeConfig> = () => Promise.resolve(config()),
  loadSubmission: () => Promise<FactoryIntakeSubmission> = () => Promise.resolve(submission())
): FactoryIntakeRegisterRunnerDependencies {
  return { loadConfig, loadSubmission, createRuntime: () => runtime, write };
}

function intakeRuntime(
  preflightResult: Promise<FactoryIntakePreflight>,
  register: (input: unknown) => Promise<FactoryIntakeRegistrationResult>,
  close: () => Promise<void> = () => Promise.resolve()
): LocalFactoryIntakeRuntime {
  return { commands: { preflight: () => preflightResult, register }, close };
}

function preflight(): FactoryIntakePreflight {
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
    skillPackages: [],
    reasonCodes: []
  };
}

function result(): FactoryIntakeRegistrationResult {
  return {
    schemaVersion: "agentlab.intake-registration-result.v1",
    status: "registered",
    taskId: "10000000-0000-4000-8000-000000000001",
    state: "registered",
    requestKind: "feature",
    conversationId: "0198f005-4ec4-7000-8000-000000000001",
    repository: { repositoryId: "riadmefti/agentlab", baseRevision: "a".repeat(40) },
    policyBundleDigest,
    deduplicationKey: `sha256:${"d".repeat(64)}`,
    requestDigest: `sha256:${"e".repeat(64)}`,
    authorityDigest: `sha256:${"f".repeat(64)}`,
    skillPackageDigests: [`sha256:${"a".repeat(64)}`]
  };
}

function submission(): FactoryIntakeSubmission {
  return {
    schemaVersion: "agentlab.intake-submission.v1",
    kind: "feature",
    sourceRef: "local/feature-1",
    title: "Add governed intake",
    body: "Register immutable report inputs without granting execution authority."
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
