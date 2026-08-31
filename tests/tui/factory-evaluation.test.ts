import type { FactoryCanaryRequest, FactorySignedEvalAttestation } from "@agentlab/contracts";
import type {
  LocalFactoryEvalAttestorConfig,
  LocalFactoryEvalAttestorRuntime
} from "@agentlab/runtime/factory-eval-attestor";
import type {
  LocalFactoryCanaryAuthorityConfig,
  LocalFactoryCanaryAuthorityRuntime
} from "@agentlab/runtime/factory-canary-authority";
import type {
  FactoryEvalAttestationRecordResult,
  LocalFactoryEvaluatorConfig,
  LocalFactoryEvaluatorRuntime
} from "@agentlab/runtime/factory-evaluator";
import { describe, expect, it, vi } from "vitest";

import { runFactoryCanaryAuthorize } from "../../apps/tui/src/run-factory-canary-authority.js";
import { runFactoryEvalSign } from "../../apps/tui/src/run-factory-eval-attestor.js";
import {
  runFactoryEvalAttest,
  runFactoryEvalAssess,
  runFactoryEvalInspect
} from "../../apps/tui/src/run-factory-evaluator.js";
import {
  testFactoryCanaryDocuments,
  testFactoryEvalDocuments,
  testFactoryEvalRun
} from "../helpers/factory-evaluation.js";

describe("factory evaluation CLI runners", () => {
  it("emits a portable signed artifact from the isolated attestor runner", async () => {
    const run = testFactoryEvalRun();
    const signed = {
      schemaVersion: "agentlab.signed-eval-attestation.v1",
      statementDigest: testFactoryEvalDocuments().run.digest
    } as unknown as FactorySignedEvalAttestation;
    const sign = vi.fn(() => Promise.resolve(signed));
    const close = vi.fn(() => Promise.resolve());
    const write = vi.fn();
    const runtime: LocalFactoryEvalAttestorRuntime = { commands: { sign }, close };

    await expect(
      runFactoryEvalSign("/private/attestor.json", "/private/eval-run.json", "sign-eval", {
        loadConfig: () => Promise.resolve(attestorConfig()),
        loadRun: () => Promise.resolve(run),
        createRuntime: () => runtime,
        write
      })
    ).resolves.toBe(0);

    expect(sign).toHaveBeenCalledWith(run);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual(signed);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("assesses and inspects one run while emitting only compact non-secret evidence", async () => {
    const evaluation = testFactoryEvalDocuments().snapshot;
    const assess = vi.fn(() => Promise.resolve(evaluation));
    const attest = vi.fn(() => Promise.reject(new Error("Unexpected attestation.")));
    const inspect = vi.fn(() => Promise.resolve(evaluation));
    const close = vi.fn(() => Promise.resolve());
    const write = vi.fn();
    const runtime: LocalFactoryEvaluatorRuntime = {
      commands: { assess, attest, inspect },
      close
    };
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

  it("records a signed artifact while emitting only compact verification coordinates", async () => {
    const evaluation = testFactoryEvalDocuments().snapshot;
    const signed = {
      schemaVersion: "agentlab.signed-eval-attestation.v1"
    } as unknown as FactorySignedEvalAttestation;
    const result = {
      schemaVersion: "agentlab.eval-attestation-result.v1",
      status: "recorded",
      attestationDigest: testFactoryEvalDocuments().run.digest,
      attestation: {
        attestationId: "10000000-0000-4000-8000-000000000006",
        assessmentDigest: evaluation.assessmentDigest,
        runId: evaluation.run.runId,
        runDigest: evaluation.runDigest,
        keyId: testFactoryEvalDocuments().assessment.digest,
        verifiedAt: "2026-08-30T11:32:00.000Z",
        signedAttestation: {
          statement: {
            predicate: {
              issuedAt: "2026-08-30T11:31:00.000Z",
              expiresAt: "2026-08-30T12:31:00.000Z"
            }
          }
        }
      }
    } as unknown as FactoryEvalAttestationRecordResult;
    const attest = vi.fn(() => Promise.resolve(result));
    const close = vi.fn(() => Promise.resolve());
    const write = vi.fn();
    const runtime: LocalFactoryEvaluatorRuntime = {
      commands: {
        assess: () => Promise.reject(new Error("Unexpected assessment.")),
        attest,
        inspect: () => Promise.reject(new Error("Unexpected inspection."))
      },
      close
    };

    await expect(
      runFactoryEvalAttest(
        "/private/evaluator.json",
        evaluation.assessmentDigest,
        "/private/signed-attestation.json",
        "attest-eval",
        {
          loadConfig: () => Promise.resolve(evaluatorConfig()),
          loadAttestation: () => Promise.resolve(signed),
          createRuntime: () => runtime,
          write
        }
      )
    ).resolves.toBe(0);

    expect(attest).toHaveBeenCalledWith({
      assessmentDigest: evaluation.assessmentDigest,
      signedAttestation: signed
    });
    const output = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(output).toMatchObject({
      schemaVersion: "agentlab.eval-attestation-command-result.v1",
      status: "recorded",
      assessmentDigest: evaluation.assessmentDigest,
      runDigest: evaluation.runDigest
    });
    expect(JSON.stringify(output)).not.toContain("signature");
    expect(close).toHaveBeenCalledTimes(1);
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
    schemaVersion: "agentlab.local-factory-evaluator.v2",
    databasePath: "/private/agentlab.sqlite",
    runnerId: "trusted-eval-runner",
    trustedPublicKeyPath: "/private/eval-public.pem",
    trustedKeyId: `sha256:${"a".repeat(64)}`,
    maximumIssuanceDelaySeconds: 300,
    maximumAttestationLifetimeSeconds: 3_600
  };
}

function attestorConfig(): LocalFactoryEvalAttestorConfig {
  return {
    schemaVersion: "agentlab.local-factory-eval-attestor.v1",
    runnerId: "trusted-eval-runner",
    privateKeyPath: "/private/eval-private.pem",
    keyId: `sha256:${"a".repeat(64)}`,
    attestationLifetimeSeconds: 3_600,
    maximumIssuanceDelaySeconds: 300
  };
}

function canaryConfig(): LocalFactoryCanaryAuthorityConfig {
  return {
    schemaVersion: "agentlab.local-factory-canary-authority.v1",
    databasePath: "/private/agentlab.sqlite",
    operatorId: "release-controller"
  };
}
