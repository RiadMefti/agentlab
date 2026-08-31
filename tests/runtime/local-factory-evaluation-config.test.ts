import { chmod, link, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryCanaryAuthorityConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-canary-authority-config.js";
import { loadLocalFactoryCanaryRequest } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-canary-request.js";
import { loadLocalFactoryEvalRun } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-eval-run.js";
import { loadLocalFactoryEvalAttestorConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-eval-attestor-config.js";
import { loadLocalFactoryEvaluatorConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-evaluator-config.js";
import {
  testEvalDigest,
  testFactoryEvalBudget,
  testFactoryEvalRun
} from "../helpers/factory-evaluation.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory evaluation file boundaries", () => {
  it("loads only exact owner-only evaluator and canary authority configs", async () => {
    const root = await temporaryRoot();
    const evaluatorPath = join(root, "evaluator.json");
    const canaryPath = join(root, "canary-authority.json");
    const evaluator = {
      schemaVersion: "agentlab.local-factory-evaluator.v2",
      databasePath: join(root, "agentlab.sqlite"),
      runnerId: "trusted-eval-runner",
      trustedPublicKeyPath: join(root, "eval-public.pem"),
      trustedKeyId: testEvalDigest(901),
      maximumIssuanceDelaySeconds: 300,
      maximumAttestationLifetimeSeconds: 3_600
    } as const;
    const attestorPath = join(root, "attestor.json");
    const attestor = {
      schemaVersion: "agentlab.local-factory-eval-attestor.v1",
      runnerId: "trusted-eval-runner",
      privateKeyPath: join(root, "eval-private.pem"),
      keyId: testEvalDigest(901),
      attestationLifetimeSeconds: 3_600,
      maximumIssuanceDelaySeconds: 300
    } as const;
    const canary = {
      schemaVersion: "agentlab.local-factory-canary-authority.v1",
      databasePath: join(root, "agentlab.sqlite"),
      operatorId: "release-controller"
    } as const;
    await writePrivateJson(evaluatorPath, evaluator);
    await writePrivateJson(attestorPath, attestor);
    await writePrivateJson(canaryPath, canary);

    await expect(loadLocalFactoryEvaluatorConfig(evaluatorPath)).resolves.toEqual(evaluator);
    await expect(loadLocalFactoryEvalAttestorConfig(attestorPath)).resolves.toEqual(attestor);
    await expect(loadLocalFactoryCanaryAuthorityConfig(canaryPath)).resolves.toEqual(canary);

    await writePrivateJson(evaluatorPath, { ...evaluator, githubToken: "forbidden" });
    await expect(loadLocalFactoryEvaluatorConfig(evaluatorPath)).rejects.toThrow();
    await writePrivateJson(canaryPath, { ...canary, databasePath: "relative.sqlite" });
    await expect(loadLocalFactoryCanaryAuthorityConfig(canaryPath)).rejects.toThrow(
      /absolute path/u
    );
  });

  it("loads strict self-describing eval reports and canary requests", async () => {
    const root = await temporaryRoot();
    const runPath = join(root, "run.json");
    const requestPath = join(root, "request.json");
    const run = testFactoryEvalRun();
    const request = {
      schemaVersion: "agentlab.canary-request.v1",
      stage: "brokered-draft-pr",
      repositoryIds: ["agentlab"],
      maximumRiskTier: "R1",
      maximumTasks: 2,
      budget: testFactoryEvalBudget(),
      humanSampleReviewDigest: testEvalDigest(902),
      humanSampleSize: 4,
      expiresAt: "2026-08-31T12:00:00.000Z",
      reason: "Reviewed bounded promotion."
    } as const;
    await writePrivateJson(runPath, run);
    await writePrivateJson(requestPath, request);

    await expect(loadLocalFactoryEvalRun(runPath)).resolves.toEqual(run);
    await expect(loadLocalFactoryCanaryRequest(requestPath)).resolves.toEqual(request);

    await writePrivateJson(runPath, { ...run, githubToken: "forbidden" });
    await expect(loadLocalFactoryEvalRun(runPath)).rejects.toThrow();
    await writePrivateJson(requestPath, { ...request, autoMerge: true });
    await expect(loadLocalFactoryCanaryRequest(requestPath)).rejects.toThrow();
  });

  it("rejects public, symlinked, and hard-linked authority input", async () => {
    const root = await temporaryRoot();
    const path = join(root, "evaluator.json");
    await writePrivateJson(path, {
      schemaVersion: "agentlab.local-factory-evaluator.v2",
      databasePath: join(root, "agentlab.sqlite"),
      runnerId: "trusted-eval-runner",
      trustedPublicKeyPath: join(root, "eval-public.pem"),
      trustedKeyId: testEvalDigest(901),
      maximumIssuanceDelaySeconds: 300,
      maximumAttestationLifetimeSeconds: 3_600
    });
    await chmod(path, 0o644);
    await expect(loadLocalFactoryEvaluatorConfig(path)).rejects.toThrow(/owner-only/u);

    await chmod(path, 0o600);
    const linked = join(root, "linked.json");
    await link(path, linked);
    await expect(loadLocalFactoryEvaluatorConfig(path)).rejects.toThrow(/owner-only/u);
    await rm(linked);

    const symbolic = join(root, "symbolic.json");
    await symlink(path, symbolic);
    await expect(loadLocalFactoryEvaluatorConfig(symbolic)).rejects.toThrow();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-evaluation-config-")));
  temporaryRoots.push(root);
  return root;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await chmod(path, 0o600);
}
