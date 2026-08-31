import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalFactoryCanaryAuthority } from "../../packages/runtime/src/local-factory-canary-authority.js";
import { createLocalFactoryEvaluator } from "../../packages/runtime/src/local-factory-evaluator.js";
import {
  TEST_CANARY_APPROVAL_ID,
  TEST_CANARY_COHORT_ID,
  TEST_EVAL_ASSESSMENT_ID,
  testEvalDigest,
  testFactoryEvalBudget,
  testFactoryEvalRun
} from "../helpers/factory-evaluation.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("local factory evaluation compositions", () => {
  it("assesses credentiallessly, closes, then issues a separate human non-release cohort", async () => {
    const databasePath = temporaryDatabase();
    const evaluator = createLocalFactoryEvaluator({
      databasePath,
      runnerId: "trusted-eval-runner",
      now: () => "2026-08-30T11:31:00.000Z",
      createId: () => TEST_EVAL_ASSESSMENT_ID
    });
    expect(Object.keys(evaluator.commands).sort()).toEqual(["assess", "inspect"]);
    const evaluation = await evaluator.commands.assess(testFactoryEvalRun());
    await expect(
      evaluator.commands.inspect({ assessmentDigest: evaluation.assessmentDigest })
    ).resolves.toEqual(evaluation);
    await evaluator.close();
    await expect(evaluator.commands.assess(testFactoryEvalRun())).rejects.toThrow(
      /runtime is closing/u
    );

    const ids = [TEST_CANARY_APPROVAL_ID, TEST_CANARY_COHORT_ID];
    const authority = createLocalFactoryCanaryAuthority({
      databasePath,
      operatorId: "release-controller",
      now: () => "2026-08-30T12:00:00.000Z",
      createId: () => ids.shift() ?? "10000000-0000-4000-8000-000000000099"
    });
    expect(Object.keys(authority.commands)).toEqual(["authorize"]);
    const result = await authority.commands.authorize({
      assessmentDigest: evaluation.assessmentDigest,
      request: {
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
      },
      confirmation: "authorize-canary"
    });

    expect(result).toMatchObject({
      status: "authorized",
      approval: {
        actor: { kind: "human", role: "release-controller", id: "release-controller" }
      },
      cohort: {
        stage: "brokered-draft-pr",
        maximumRiskTier: "R1",
        autoMerge: false,
        release: false
      }
    });
    await authority.close();
    await expect(authority.close()).resolves.toBeUndefined();
  });

  it("refuses ephemeral databases for both authority-bearing compositions", () => {
    expect(() =>
      createLocalFactoryEvaluator({
        databasePath: ":memory:",
        runnerId: "trusted-eval-runner"
      })
    ).toThrow(/durable SQLite/u);
    expect(() =>
      createLocalFactoryCanaryAuthority({
        databasePath: ":memory:",
        operatorId: "release-controller"
      })
    ).toThrow(/durable SQLite/u);
  });
});

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-local-evaluation-"));
  temporaryRoots.push(root);
  return join(root, "agentlab.sqlite");
}
