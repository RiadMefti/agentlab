import type {
  FactoryBudget,
  FactoryBudgetUsage,
  FactoryEvalCaseBank,
  FactoryEvalGraderDescriptor,
  FactoryEvalHarnessDescriptor,
  FactoryEvalProductionJob,
  FactoryProcessIsolation,
  Sha256Digest
} from "@agentlab/contracts";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import {
  testEvalDigest,
  testFactoryConfigurationCandidate,
  testFactoryEvalSuite
} from "./factory-evaluation.js";

const documents = new NodeFactoryDocumentCodec();

export const TEST_EVAL_PRODUCTION_JOB_ID = "20000000-0000-4000-8000-000000000001";
export const TEST_EVAL_PRODUCTION_CORRELATION_ID = "20000000-0000-4000-8000-000000000002";

export function testFactoryEvalHarness(
  id: string,
  executableIndex: number
): FactoryEvalHarnessDescriptor {
  return {
    schemaVersion: "agentlab.eval-harness.v1",
    id,
    version: "1.0.0",
    executableDigest: testEvalDigest(executableIndex),
    protocolVersion: "agentlab.eval-harness-protocol.v1",
    network: "off",
    secrets: false
  };
}

export function testFactoryEvalGrader(): FactoryEvalGraderDescriptor {
  return {
    schemaVersion: "agentlab.eval-grader.v1",
    id: "deterministic-grader",
    version: "1.0.0",
    executableDigest: testEvalDigest(903),
    protocolVersion: "agentlab.eval-harness-protocol.v1",
    network: "off",
    secrets: false
  };
}

export function testFactoryEvalInvocationBudget(): FactoryBudget {
  return {
    wallClockSeconds: 10,
    maxAgentTurns: 1,
    maxToolCalls: 1,
    maxInputTokens: 1,
    maxOutputTokens: 1,
    maxCostMicrousd: 100,
    maxProcesses: 2,
    maxOutputBytes: 10_000,
    maxWorkers: 1,
    maxRepairAttempts: 0,
    maxChangedFiles: 0,
    maxChangedLines: 0
  };
}

export function testFactoryEvalAggregateBudget(caseCount = 4, trials = 2): FactoryBudget {
  const invocations = caseCount * trials * 3;
  const one = testFactoryEvalInvocationBudget();
  return {
    wallClockSeconds: one.wallClockSeconds * invocations,
    maxAgentTurns: one.maxAgentTurns * invocations,
    maxToolCalls: one.maxToolCalls * invocations,
    maxInputTokens: one.maxInputTokens * invocations,
    maxOutputTokens: one.maxOutputTokens * invocations,
    maxCostMicrousd: one.maxCostMicrousd * invocations,
    maxProcesses: one.maxProcesses * invocations,
    maxOutputBytes: one.maxOutputBytes * invocations,
    maxWorkers: 1,
    maxRepairAttempts: 0,
    maxChangedFiles: 0,
    maxChangedLines: 0
  };
}

export function testFactoryEvalCaseBank(): FactoryEvalCaseBank {
  const budget = testFactoryEvalInvocationBudget();
  return {
    schemaVersion: "agentlab.eval-case-bank.v1",
    id: "agentlab/software-factory",
    version: "1.0.0",
    cases: ["feature/simple", "bug/regression", "review/adversarial", "safety/injection"].map(
      (caseId, index) => ({
        caseId,
        fixture: {
          digest: testEvalDigest(1_000 + index),
          mediaType: "application/json",
          sizeBytes: 8
        },
        seedDigests: [testEvalDigest(1_100 + index * 2), testEvalDigest(1_101 + index * 2)],
        subjectBudgetCeiling: budget,
        graderBudgetCeiling: budget,
        maximumSubjectOutputBytes: 1_024,
        maximumTraceBytes: 1_024,
        maximumGraderEvidenceBytes: 1_024
      })
    )
  };
}

export function testFactoryEvalProductionJob(
  overrides: Partial<FactoryEvalProductionJob> = {}
): FactoryEvalProductionJob {
  const bank = testFactoryEvalCaseBank();
  const caseBankDigest = documents.evalCaseBank(bank).digest;
  const suite = testFactoryEvalSuite({ caseBankDigest });
  const baselineHarness = testFactoryEvalHarness("baseline-harness", 901);
  const challengerHarness = testFactoryEvalHarness("challenger-harness", 902);
  const baselineHarnessDigest = documents.evalHarnessDescriptor(baselineHarness).digest;
  const challengerHarnessDigest = documents.evalHarnessDescriptor(challengerHarness).digest;
  const baselineCandidate = testFactoryConfigurationCandidate({
    candidateId: "baseline",
    providerDigestIndex: 5,
    harnessDigest: baselineHarnessDigest,
    createdAt: "2026-09-01T09:00:00.000Z"
  });
  const challengerCandidate = testFactoryConfigurationCandidate({
    candidateId: "challenger",
    version: "1.1.0",
    providerDigestIndex: 6,
    harnessDigest: challengerHarnessDigest,
    createdAt: "2026-09-01T09:00:00.000Z"
  });
  const grader = testFactoryEvalGrader();
  return {
    schemaVersion: "agentlab.eval-production-job.v1",
    jobId: TEST_EVAL_PRODUCTION_JOB_ID,
    runnerId: "trusted-eval-runner",
    suiteDigest: documents.evalSuite(suite).digest,
    suite,
    caseBankDigest,
    caseBank: bank,
    baselineCandidateDigest: documents.configurationCandidate(baselineCandidate).digest,
    baselineCandidate,
    baselineHarnessDigest,
    baselineHarness,
    challengerCandidateDigest: documents.configurationCandidate(challengerCandidate).digest,
    challengerCandidate,
    challengerHarnessDigest,
    challengerHarness,
    graderDigest: documents.evalGraderDescriptor(grader).digest,
    grader,
    aggregateBudget: testFactoryEvalAggregateBudget(),
    resourceLimits: {
      maxProcesses: 4,
      maxMemoryBytes: 256 * 1_024 * 1_024,
      cpuQuotaPercent: 100
    },
    createdAt: "2026-09-01T10:00:00.000Z",
    deadlineAt: "2026-09-01T12:00:00.000Z",
    correlationId: TEST_EVAL_PRODUCTION_CORRELATION_ID,
    ...overrides
  };
}

export function testFactoryEvalUsage(costMicrousd = 10): FactoryBudgetUsage {
  return {
    wallClockSeconds: 1,
    agentTurns: 1,
    toolCalls: 1,
    inputTokens: 1,
    outputTokens: 1,
    costMicrousd,
    processes: 1,
    outputBytes: 256,
    workers: 1,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0
  };
}

export function testFactoryEvalIsolation(executionId: string): FactoryProcessIsolation {
  return {
    isolationId: executionId,
    mechanism: { id: "linux/systemd-user-scope", version: "257" },
    scopeName: `agentlab-factory-${executionId.replaceAll("-", "")}.scope`,
    limits: {
      maxProcesses: 4,
      maxMemoryBytes: 256 * 1_024 * 1_024,
      cpuQuotaPercent: 100
    }
  };
}

export function testDescriptorDigests(job: FactoryEvalProductionJob): readonly Sha256Digest[] {
  return [job.baselineHarnessDigest, job.challengerHarnessDigest, job.graderDigest];
}
