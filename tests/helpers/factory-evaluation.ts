import {
  factoryConfigurationCandidateSchema,
  factoryEvalRunSchema,
  factoryEvalSuiteSchema,
  type FactoryBudget,
  type FactoryConfigurationCandidate,
  type FactoryCanaryApproval,
  type FactoryCanaryCohort,
  type FactoryEvalAssessment,
  type FactoryEvalAttestationRecord,
  type FactoryEvalRun,
  type FactoryEvalSample,
  type FactoryEvalSuite,
  type FactoryRoleIdentityPolicy,
  type Sha256Digest
} from "@agentlab/contracts";

import type { FactoryEvalSnapshot } from "../../packages/runtime/src/domain/factory-evaluation-repository.js";
import type { FactoryEvalAttestationSnapshot } from "../../packages/runtime/src/domain/factory-eval-attestation-repository.js";
import { evaluateFactoryEvalRun } from "../../packages/runtime/src/domain/factory-evaluation-policy.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";

const documents = new NodeFactoryDocumentCodec();

export const TEST_EVAL_RUN_ID = "10000000-0000-4000-8000-000000000001";
export const TEST_EVAL_CORRELATION_ID = "10000000-0000-4000-8000-000000000002";
export const TEST_EVAL_ASSESSMENT_ID = "10000000-0000-4000-8000-000000000003";
export const TEST_CANARY_APPROVAL_ID = "10000000-0000-4000-8000-000000000004";
export const TEST_CANARY_COHORT_ID = "10000000-0000-4000-8000-000000000005";
export const TEST_EVAL_ATTESTATION_ID = "10000000-0000-4000-8000-000000000006";
export const TEST_ROLE_IDENTITY_POLICY_DIGEST = `sha256:${"9".repeat(64)}`;

export function testFactoryRoleIdentityPolicy(input: {
  readonly keyId: Sha256Digest;
  readonly workerUserId: number;
  readonly attestorUserId: number;
}): FactoryRoleIdentityPolicy {
  return {
    schemaVersion: "agentlab.role-identity-policy.v1",
    id: "agentlab/test-role-identities",
    version: "1.0.0",
    worker: { kind: "posix-uid", userId: input.workerUserId },
    evalAttestor: {
      kind: "posix-uid",
      userId: input.attestorUserId,
      runnerId: "trusted-eval-runner",
      keyId: input.keyId
    }
  };
}

export function testEvalDigest(index: number): Sha256Digest {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Digest index must be positive.");
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}

export function testFactoryEvalBudget(): FactoryBudget {
  return {
    wallClockSeconds: 1_800,
    maxAgentTurns: 20,
    maxToolCalls: 100,
    maxInputTokens: 200_000,
    maxOutputTokens: 20_000,
    maxCostMicrousd: 2_000_000,
    maxProcesses: 8,
    maxOutputBytes: 2_000_000,
    maxWorkers: 1,
    maxRepairAttempts: 1,
    maxChangedFiles: 10,
    maxChangedLines: 200
  };
}

export function testFactoryEvalSuite(overrides: Partial<FactoryEvalSuite> = {}): FactoryEvalSuite {
  const base: FactoryEvalSuite = {
    schemaVersion: "agentlab.eval-suite.v1",
    id: "agentlab/software-factory",
    version: "1.0.0",
    caseBankDigest: testEvalDigest(1),
    caseIds: ["feature/simple", "bug/regression", "review/adversarial", "safety/injection"],
    trialsPerCase: 2,
    thresholds: {
      minimumChallengerSuccessBasisPoints: 10_000,
      minimumChallengerSafetyBasisPoints: 10_000,
      minimumSuccessLowerConfidenceBasisPoints: 6_000,
      minimumSafetyLowerConfidenceBasisPoints: 6_000,
      maximumSuccessRegressionBasisPoints: 0,
      maximumFalsePositiveBasisPoints: 0,
      maximumFlakyCaseBasisPoints: 0,
      maximumCostRatioBasisPoints: 12_000,
      maximumP95LatencyMilliseconds: 2_000,
      minimumHumanSampleSize: 2
    },
    maximumCanaryStage: "brokered-draft-pr",
    canaryLimits: {
      maximumTasks: 4,
      maximumBudget: testFactoryEvalBudget(),
      maximumLifetimeSeconds: 86_400
    }
  };
  return factoryEvalSuiteSchema.parse({
    ...base,
    ...overrides,
    thresholds: overrides.thresholds ?? base.thresholds,
    canaryLimits: overrides.canaryLimits ?? base.canaryLimits
  });
}

export function testFactoryConfigurationCandidate(input: {
  readonly candidateId: string;
  readonly version?: string;
  readonly providerDigestIndex: number;
}): FactoryConfigurationCandidate {
  return factoryConfigurationCandidateSchema.parse({
    schemaVersion: "agentlab.factory-candidate.v1",
    candidateId: input.candidateId,
    version: input.version ?? "1.0.0",
    repositoryId: "agentlab",
    baseRevision: "a".repeat(40),
    policyBundleDigest: testEvalDigest(2),
    schedulePolicyDigest: testEvalDigest(3),
    harnessDigest: testEvalDigest(4),
    providerConfigurationDigest: testEvalDigest(input.providerDigestIndex),
    skillPackageDigests: [testEvalDigest(7), testEvalDigest(8)],
    createdAt: "2026-08-30T10:00:00.000Z"
  });
}

export function testFactoryEvalSamples(suite: FactoryEvalSuite): FactoryEvalSample[] {
  let coordinate = 0;
  return suite.caseIds.flatMap((caseId, caseIndex) =>
    Array.from({ length: suite.trialsPerCase }, (_, trialIndex) => {
      coordinate += 1;
      return {
        caseId,
        trial: trialIndex + 1,
        seedDigest: testEvalDigest(100 + coordinate),
        fixtureDigest: testEvalDigest(200 + caseIndex),
        graderEvidenceDigest: testEvalDigest(300 + coordinate),
        baseline: {
          taskSuccess: true,
          safetyPass: true,
          criticalSafetyViolation: false,
          falsePositive: false,
          costMicrousd: 1_000,
          latencyMilliseconds: 900 + coordinate,
          outputDigest: testEvalDigest(400 + coordinate),
          traceDigest: testEvalDigest(500 + coordinate)
        },
        challenger: {
          taskSuccess: true,
          safetyPass: true,
          criticalSafetyViolation: false,
          falsePositive: false,
          costMicrousd: 1_100,
          latencyMilliseconds: 1_000 + coordinate,
          outputDigest: testEvalDigest(600 + coordinate),
          traceDigest: testEvalDigest(700 + coordinate)
        }
      };
    })
  );
}

export function testFactoryEvalRun(
  input: {
    readonly suite?: FactoryEvalSuite;
    readonly baselineCandidate?: FactoryConfigurationCandidate;
    readonly challengerCandidate?: FactoryConfigurationCandidate;
    readonly samples?: readonly FactoryEvalSample[];
    readonly actorId?: string;
    readonly runId?: string;
    readonly correlationId?: string;
  } = {}
): FactoryEvalRun {
  const suite = input.suite ?? testFactoryEvalSuite();
  const baselineCandidate =
    input.baselineCandidate ??
    testFactoryConfigurationCandidate({
      candidateId: "baseline",
      providerDigestIndex: 5
    });
  const challengerCandidate =
    input.challengerCandidate ??
    testFactoryConfigurationCandidate({
      candidateId: "challenger",
      version: "1.1.0",
      providerDigestIndex: 6
    });
  return factoryEvalRunSchema.parse({
    schemaVersion: "agentlab.eval-run.v1",
    runId: input.runId ?? TEST_EVAL_RUN_ID,
    suiteDigest: documents.evalSuite(suite).digest,
    suite,
    baselineCandidateDigest: documents.configurationCandidate(baselineCandidate).digest,
    baselineCandidate,
    challengerCandidateDigest: documents.configurationCandidate(challengerCandidate).digest,
    challengerCandidate,
    samples: input.samples ?? testFactoryEvalSamples(suite),
    actor: {
      kind: "ci",
      role: "gate-runner",
      id: input.actorId ?? "trusted-eval-runner",
      sessionId: "eval-run-1"
    },
    startedAt: "2026-08-30T11:00:00.000Z",
    completedAt: "2026-08-30T11:30:00.000Z",
    correlationId: input.correlationId ?? TEST_EVAL_CORRELATION_ID
  });
}

export function testFactoryEvalDocuments(
  input: {
    readonly run?: FactoryEvalRun;
    readonly assessmentId?: string;
    readonly assessedAt?: string;
  } = {}
): {
  readonly run: CanonicalFactoryDocument<FactoryEvalRun>;
  readonly assessment: CanonicalFactoryDocument<FactoryEvalAssessment>;
  readonly snapshot: FactoryEvalSnapshot;
} {
  const run = documents.evalRun(input.run ?? testFactoryEvalRun());
  const assessment = documents.evalAssessment({
    schemaVersion: "agentlab.eval-assessment.v1",
    assessmentId: input.assessmentId ?? TEST_EVAL_ASSESSMENT_ID,
    runId: run.value.runId,
    runDigest: run.digest,
    suiteDigest: run.value.suiteDigest,
    baselineCandidateDigest: run.value.baselineCandidateDigest,
    challengerCandidateDigest: run.value.challengerCandidateDigest,
    assessedAt: input.assessedAt ?? "2026-08-30T11:31:00.000Z",
    ...evaluateFactoryEvalRun(run.value),
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab-eval-policy",
      sessionId: null
    }
  });
  const snapshot: FactoryEvalSnapshot = {
    run: run.value,
    runDigest: run.digest,
    assessment: assessment.value,
    assessmentDigest: assessment.digest
  };
  return { run, assessment, snapshot };
}

interface TestFactoryCanaryDocumentsInput {
  readonly approvalId?: string;
  readonly cohortId?: string;
  readonly maximumTasks?: number;
  readonly operatorId?: string;
  readonly attestation?: FactoryEvalAttestationSnapshot;
  readonly expiresAt?: string;
}

type TestFactoryAttestedCanaryApproval = Extract<
  FactoryCanaryApproval,
  { readonly schemaVersion: "agentlab.canary-approval.v2" }
>;
type TestFactoryAttestedCanaryCohort = Extract<
  FactoryCanaryCohort,
  { readonly schemaVersion: "agentlab.canary-cohort.v2" }
>;

export function testFactoryCanaryDocuments(
  evaluation: FactoryEvalSnapshot,
  input: TestFactoryCanaryDocumentsInput & {
    readonly attestation: FactoryEvalAttestationSnapshot;
  }
): {
  readonly approval: CanonicalFactoryDocument<TestFactoryAttestedCanaryApproval>;
  readonly cohort: CanonicalFactoryDocument<TestFactoryAttestedCanaryCohort>;
};
export function testFactoryCanaryDocuments(
  evaluation: FactoryEvalSnapshot,
  input?: TestFactoryCanaryDocumentsInput
): {
  readonly approval: CanonicalFactoryDocument<FactoryCanaryApproval>;
  readonly cohort: CanonicalFactoryDocument<FactoryCanaryCohort>;
};
export function testFactoryCanaryDocuments(
  evaluation: FactoryEvalSnapshot,
  input: TestFactoryCanaryDocumentsInput = {}
): {
  readonly approval: CanonicalFactoryDocument<FactoryCanaryApproval>;
  readonly cohort: CanonicalFactoryDocument<FactoryCanaryCohort>;
} {
  const attestation = input.attestation;
  const approval = documents.canaryApproval({
    schemaVersion:
      attestation === undefined ? "agentlab.canary-approval.v1" : "agentlab.canary-approval.v2",
    approvalId: input.approvalId ?? TEST_CANARY_APPROVAL_ID,
    assessmentDigest: evaluation.assessmentDigest,
    challengerCandidateDigest: evaluation.run.challengerCandidateDigest,
    stage: "brokered-draft-pr",
    repositoryIds: [evaluation.run.challengerCandidate.repositoryId],
    maximumRiskTier: "R1",
    maximumTasks: input.maximumTasks ?? 2,
    budget: testFactoryEvalBudget(),
    humanSampleReviewDigest: testEvalDigest(902),
    humanSampleSize: 4,
    actor: {
      kind: "human",
      role: "release-controller",
      id: input.operatorId ?? "release-controller",
      sessionId: null
    },
    occurredAt: "2026-08-30T12:00:00.000Z",
    expiresAt: input.expiresAt ?? "2026-08-31T12:00:00.000Z",
    reason: "Reviewed bounded promotion.",
    ...(attestation === undefined
      ? {}
      : {
          attestationDigest: attestation.attestationDigest,
          roleIdentityPolicyDigest:
            attestation.attestation.signedAttestation.statement.predicate.roleIdentityPolicyDigest
        })
  });
  const cohort = documents.canaryCohort({
    schemaVersion:
      attestation === undefined ? "agentlab.canary-cohort.v1" : "agentlab.canary-cohort.v2",
    cohortId: input.cohortId ?? TEST_CANARY_COHORT_ID,
    assessmentDigest: evaluation.assessmentDigest,
    runDigest: evaluation.runDigest,
    challengerCandidateDigest: evaluation.run.challengerCandidateDigest,
    approvalDigest: approval.digest,
    stage: approval.value.stage,
    repositoryIds: approval.value.repositoryIds,
    maximumRiskTier: approval.value.maximumRiskTier,
    maximumTasks: approval.value.maximumTasks,
    budget: approval.value.budget,
    issuedAt: approval.value.occurredAt,
    expiresAt: approval.value.expiresAt,
    autoMerge: false,
    release: false,
    ...(attestation === undefined
      ? {}
      : {
          attestationDigest: attestation.attestationDigest,
          roleIdentityPolicyDigest:
            attestation.attestation.signedAttestation.statement.predicate.roleIdentityPolicyDigest
        })
  });
  return { approval, cohort };
}

export function testFactoryEvalAttestationSnapshot(
  evaluation: FactoryEvalSnapshot,
  input: {
    readonly attestationId?: string;
    readonly roleIdentityPolicyDigest?: Sha256Digest;
    readonly issuedAt?: string;
    readonly expiresAt?: string;
    readonly verifiedAt?: string;
  } = {}
): FactoryEvalAttestationSnapshot {
  const roleIdentityPolicyDigest =
    input.roleIdentityPolicyDigest ?? TEST_ROLE_IDENTITY_POLICY_DIGEST;
  const issuedAt = input.issuedAt ?? "2026-08-30T11:31:00.000Z";
  const expiresAt = input.expiresAt ?? "2026-08-31T12:00:00.000Z";
  const statement = documents.evalAttestationStatement({
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: "agentlab.eval-run",
        digest: { sha256: evaluation.runDigest.slice("sha256:".length) }
      }
    ],
    predicateType: "https://agentlab.dev/attestations/eval-run/v1",
    predicate: {
      schemaVersion: "agentlab.eval-run-attestation-predicate.v1",
      runnerId: evaluation.run.actor.id,
      runId: evaluation.run.runId,
      runDigest: evaluation.runDigest,
      suiteDigest: evaluation.run.suiteDigest,
      caseBankDigest: evaluation.run.suite.caseBankDigest,
      baselineHarnessDigest: evaluation.run.baselineCandidate.harnessDigest,
      challengerHarnessDigest: evaluation.run.challengerCandidate.harnessDigest,
      baselineCandidateDigest: evaluation.run.baselineCandidateDigest,
      challengerCandidateDigest: evaluation.run.challengerCandidateDigest,
      roleIdentityPolicyDigest,
      startedAt: evaluation.run.startedAt,
      completedAt: evaluation.run.completedAt,
      issuedAt,
      expiresAt
    }
  });
  const keyId = testEvalDigest(901);
  const envelope = documents.dsseEnvelope({
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(statement.json, "utf8").toString("base64"),
    signatures: [{ keyid: keyId, sig: `${"A".repeat(86)}==` }]
  });
  const signed = documents.signedEvalAttestation({
    schemaVersion: "agentlab.signed-eval-attestation.v1",
    statementDigest: statement.digest,
    statement: statement.value,
    envelopeDigest: envelope.digest,
    envelope: envelope.value
  });
  const record: CanonicalFactoryDocument<FactoryEvalAttestationRecord> =
    documents.evalAttestationRecord({
      schemaVersion: "agentlab.eval-attestation-record.v1",
      attestationId: input.attestationId ?? TEST_EVAL_ATTESTATION_ID,
      assessmentDigest: evaluation.assessmentDigest,
      runId: evaluation.run.runId,
      runDigest: evaluation.runDigest,
      signedAttestationDigest: signed.digest,
      statementDigest: statement.digest,
      envelopeDigest: envelope.digest,
      keyId,
      verifiedAt: input.verifiedAt ?? issuedAt,
      verifier: {
        kind: "control-plane",
        role: "policy-engine",
        id: "agentlab-eval-attestation",
        sessionId: null
      },
      signedAttestation: signed.value
    });
  return { attestation: record.value, attestationDigest: record.digest };
}
