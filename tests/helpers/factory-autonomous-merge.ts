import {
  factoryAutonomousMergeAuthorizationSchema,
  factoryAutonomousMergePolicySchema,
  factoryAutonomousMergeRecordSchema,
  factoryAutonomousMergeRunSchema,
  type FactoryAutonomousMergeAuthorization,
  type FactoryAutonomousMergePolicy,
  type FactoryAutonomousMergeRecord,
  type FactoryAutonomousMergeRun,
  type Sha256Digest
} from "@agentlab/contracts";

import { TEST_FACTORY_CORRELATION_ID, TEST_FACTORY_TASK_ID, testDigest } from "./factory.js";

export const TEST_MERGE_REPOSITORY_ID = "riadmefti/agentlab";
export const TEST_MERGE_BASE_REVISION = "a".repeat(40);
export const TEST_MERGE_HEAD_REVISION = "b".repeat(40);

export function testFactoryAutonomousMergePolicy(
  overrides: Partial<FactoryAutonomousMergePolicy> = {}
): FactoryAutonomousMergePolicy {
  return factoryAutonomousMergePolicySchema.parse({
    schemaVersion: "agentlab.autonomous-merge-policy.v1",
    id: "agentlab/r1-scheduled-merge-queue",
    version: "1.0.0",
    repositoryId: TEST_MERGE_REPOSITORY_ID,
    mergerId: "github-app/agentlab-merger",
    mergerUserId: 2_001,
    prBrokerUserId: 2_002,
    schedulePolicyDigest: testDigest("1"),
    dailyQuotaPolicyDigest: testDigest("2"),
    roleIdentityPolicyDigest: testDigest("3"),
    requiredStatusChecks: [
      { context: "verify", producerId: "github-app/verify" },
      { context: "factory-sandbox", producerId: "github-app/factory-sandbox" }
    ],
    minimumIndependentReviews: 1,
    maximumObservationAgeSeconds: 300,
    authorizationLifetimeSeconds: 300,
    operationDeadlineSeconds: 600,
    maximumCandidatesPerTick: 2,
    maximumMergesPerUtcDay: 2,
    maximumRiskTier: "R1",
    allowedTrigger: "scheduled",
    deliveryMode: "merge-queue",
    markReadyForReview: true,
    directMerge: false,
    autonomousMerge: true,
    release: false,
    ...overrides
  });
}

export function testFactoryAutonomousMergeAuthorization(
  overrides: Partial<FactoryAutonomousMergeAuthorization> = {}
): FactoryAutonomousMergeAuthorization {
  return factoryAutonomousMergeAuthorizationSchema.parse({
    schemaVersion: "agentlab.autonomous-merge-authorization.v1",
    authorizationId: "51000000-0000-4000-8000-000000000001",
    taskId: TEST_FACTORY_TASK_ID,
    contractDigest: testDigest("4"),
    policyBundleDigest: testDigest("5"),
    mergePolicyDigest: testDigest("6"),
    observationDigest: testDigest("7"),
    observationEvidenceBundleDigest: testDigest("8"),
    policyEvaluationDigest: testDigest("9"),
    policyEvidenceBundleDigest: testDigest("a"),
    proposalDigest: testDigest("b"),
    pullRequestRecordDigest: testDigest("c"),
    repositoryId: TEST_MERGE_REPOSITORY_ID,
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/RiadMefti/agentlab/pull/42",
    branchName: `agentlab/${"d".repeat(64)}`,
    expectedBaseRevision: TEST_MERGE_BASE_REVISION,
    expectedHeadRevision: TEST_MERGE_HEAD_REVISION,
    canaryReservationDigest: testDigest("d"),
    schedulePolicyDigest: testDigest("1"),
    dailyQuotaPolicyDigest: testDigest("2"),
    roleIdentityPolicyDigest: testDigest("3"),
    riskTier: "R1",
    trigger: "scheduled",
    deliveryMode: "merge-queue",
    markReadyForReview: true,
    directMerge: false,
    release: false,
    issuedAt: "2026-09-01T12:00:00.000Z",
    expiresAt: "2026-09-01T12:05:00.000Z",
    correlationId: TEST_FACTORY_CORRELATION_ID,
    ...overrides
  });
}

export function testFactoryAutonomousMergeRun(input: {
  readonly policy: FactoryAutonomousMergePolicy;
  readonly policyDigest: Sha256Digest;
  readonly authorization: FactoryAutonomousMergeAuthorization;
  readonly authorizationDigest: Sha256Digest;
  readonly contractDigest?: Sha256Digest;
}): FactoryAutonomousMergeRun {
  return factoryAutonomousMergeRunSchema.parse({
    schemaVersion: "agentlab.autonomous-merge-run.v1",
    mergeRunId: "52000000-0000-4000-8000-000000000002",
    authorizationId: input.authorization.authorizationId,
    authorizationDigest: input.authorizationDigest,
    taskId: input.authorization.taskId,
    contractDigest: input.contractDigest ?? input.authorization.contractDigest,
    repositoryId: input.authorization.repositoryId,
    pullRequestNumber: input.authorization.pullRequestNumber,
    pullRequestUrl: input.authorization.pullRequestUrl,
    expectedBaseRevision: input.authorization.expectedBaseRevision,
    expectedHeadRevision: input.authorization.expectedHeadRevision,
    mergePolicyDigest: input.policyDigest,
    mergePolicy: input.policy,
    createdAt: "2026-09-01T12:00:01.000Z",
    deadlineAt: "2026-09-01T12:05:00.000Z",
    correlationId: input.authorization.correlationId
  });
}

export function testFactoryAutonomousMergeRecord(input: {
  readonly run: FactoryAutonomousMergeRun;
  readonly runDigest: Sha256Digest;
  readonly authorizationDigest: Sha256Digest;
}): FactoryAutonomousMergeRecord {
  return factoryAutonomousMergeRecordSchema.parse({
    schemaVersion: "agentlab.autonomous-merge-record.v1",
    mergeRunId: input.run.mergeRunId,
    runDigest: input.runDigest,
    authorizationDigest: input.authorizationDigest,
    taskId: input.run.taskId,
    contractDigest: input.run.contractDigest,
    repositoryId: input.run.repositoryId,
    pullRequestNumber: input.run.pullRequestNumber,
    pullRequestUrl: input.run.pullRequestUrl,
    expectedHeadRevision: input.run.expectedHeadRevision,
    mergedRevision: "e".repeat(40),
    mergerId: input.run.mergePolicy.mergerId,
    mergeQueueEntryId: "MQE_123",
    mergedAt: "2026-09-01T12:02:00.000Z",
    recordedAt: "2026-09-01T12:02:01.000Z"
  });
}
