import type { FactoryCanaryRequest } from "@agentlab/contracts";
import type {
  LocalFactoryCanaryAuthorityConfig,
  LocalFactoryCanaryAuthorityRuntime
} from "@agentlab/runtime/factory-canary-authority";
import type {
  LocalFactoryEvaluatorConfig,
  LocalFactoryEvaluatorRuntime
} from "@agentlab/runtime/factory-evaluator";
import { describe, expect, it, vi } from "vitest";

import { runFactoryCanaryAuthorize } from "../../apps/tui/src/run-factory-canary-authority.js";
import {
  runFactoryEvalAssess,
  runFactoryEvalInspect
} from "../../apps/tui/src/run-factory-evaluator.js";
import {
  testFactoryCanaryDocuments,
  testFactoryEvalDocuments,
  testFactoryEvalRun
} from "../helpers/factory-evaluation.js";

describe("factory evaluation CLI runners", () => {
  it("assesses and inspects one run while emitting only compact non-secret evidence", async () => {
    const evaluation = testFactoryEvalDocuments().snapshot;
    const assess = vi.fn(() => Promise.resolve(evaluation));
    const inspect = vi.fn(() => Promise.resolve(evaluation));
    const close = vi.fn(() => Promise.resolve());
    const write = vi.fn();
    const runtime: LocalFactoryEvaluatorRuntime = { commands: { assess, inspect }, close };
    const dependencies = {
      loadConfig: () => Promise.resolve(evaluatorConfig()),
      loadRun: () => Promise.resolve(testFactoryEvalRun()),
      createRuntime: () => runtime,
      write
    };

    await expect(
      runFactoryEvalAssess(
        "/private/evaluator.json",
        "/private/eval-run.json",
        "assess-eval",
        dependencies
      )
    ).resolves.toBe(0);
    const assessed = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(assessed).toMatchObject({
      schemaVersion: "agentlab.eval-command-result.v1",
      status: "assessed",
      run: { sampleCount: 8 },
      assessment: { decision: "pass", maximumEligibleStage: "brokered-draft-pr" }
    });
    expect(JSON.stringify(assessed)).not.toContain("samples");
    expect(JSON.stringify(assessed)).not.toContain("traceDigest");
    expect(close).toHaveBeenCalledTimes(1);

    write.mockClear();
    await expect(
      runFactoryEvalInspect("/private/evaluator.json", evaluation.assessmentDigest, {
        loadConfig: dependencies.loadConfig,
        createRuntime: dependencies.createRuntime,
        write
      })
    ).resolves.toBe(0);
    expect(inspect).toHaveBeenCalledWith({ assessmentDigest: evaluation.assessmentDigest });
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({ status: "inspected" });
  });

  it("rejects malformed paths and missing confirmation before reading files", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(evaluatorConfig()));
    const loadRun = vi.fn(() => Promise.resolve(testFactoryEvalRun()));
    const dependencies = {
      loadConfig,
      loadRun,
      createRuntime: vi.fn(),
      write: vi.fn()
    };

    await expect(
      runFactoryEvalAssess("relative.json", "/private/run.json", "assess-eval", dependencies)
    ).rejects.toThrow(/absolute config/u);
    await expect(
      runFactoryEvalAssess("/private/evaluator.json", "/private/run.json", "missing", dependencies)
    ).rejects.toThrow(/explicit confirmation/u);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(loadRun).not.toHaveBeenCalled();
  });
});

describe("factory canary authority CLI runner", () => {
  it("passes an exact owner-authored request and emits structural non-release facts", async () => {
    const evaluation = testFactoryEvalDocuments().snapshot;
    const authority = testFactoryCanaryDocuments(evaluation);
    const result = {
      schemaVersion: "agentlab.canary-authority-result.v1" as const,
      status: "authorized" as const,
      approval: authority.approval.value,
      approvalDigest: authority.approval.digest,
      cohort: authority.cohort.value,
      cohortDigest: authority.cohort.digest
    };
    const authorize = vi.fn(() => Promise.resolve(result));
    const close = vi.fn(() => Promise.resolve());
    const write = vi.fn();
    const runtime: LocalFactoryCanaryAuthorityRuntime = {
      commands: { authorize },
      close
    };
    const request: FactoryCanaryRequest = {
      schemaVersion: "agentlab.canary-request.v1",
      stage: authority.approval.value.stage,
      repositoryIds: authority.approval.value.repositoryIds,
      maximumRiskTier: authority.approval.value.maximumRiskTier,
      maximumTasks: authority.approval.value.maximumTasks,
      budget: authority.approval.value.budget,
      humanSampleReviewDigest: authority.approval.value.humanSampleReviewDigest,
      humanSampleSize: authority.approval.value.humanSampleSize,
      expiresAt: authority.approval.value.expiresAt,
      reason: authority.approval.value.reason
    };

    await expect(
      runFactoryCanaryAuthorize(
        "/private/canary.json",
        evaluation.assessmentDigest,
        "/private/canary-request.json",
        "authorize-canary",
        {
          loadConfig: () => Promise.resolve(canaryConfig()),
          loadRequest: () => Promise.resolve(request),
          createRuntime: () => runtime,
          write
        }
      )
    ).resolves.toBe(0);

    expect(authorize).toHaveBeenCalledWith({
      assessmentDigest: evaluation.assessmentDigest,
      request,
      confirmation: "authorize-canary"
    });
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      schemaVersion: "agentlab.canary-authority-command-result.v1",
      status: "authorized",
      cohort: { autoMerge: false, release: false }
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});

function evaluatorConfig(): LocalFactoryEvaluatorConfig {
  return {
    schemaVersion: "agentlab.local-factory-evaluator.v1",
    databasePath: "/private/agentlab.sqlite",
    runnerId: "trusted-eval-runner"
  };
}

function canaryConfig(): LocalFactoryCanaryAuthorityConfig {
  return {
    schemaVersion: "agentlab.local-factory-canary-authority.v1",
    databasePath: "/private/agentlab.sqlite",
    operatorId: "release-controller"
  };
}
