import {
  factoryExternalPullRequestRepairExecutionPolicySchema,
  factorySkillPackageSchema,
  type FactoryBudget,
  type FactoryCapabilityGrant,
  type FactoryExternalPullRequestRepairExecutionEvent,
  type FactoryExternalPullRequestRepairExecutionPolicy,
  type FactoryExternalPullRequestRepairAuthorization,
  type FactoryExternalPullRequestRepairDecision,
  type FactoryExternalPullRequestRepairExecutionRun,
  type FactorySkillPackage,
  type Sha256Digest
} from "@agentlab/contracts";

import { assessExternalPullRequestRepairAdmission } from "../../packages/runtime/src/domain/factory-external-pull-request-repair-admission-policy.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../packages/runtime/src/domain/factory-documents.js";
import type { FactoryExternalPullRequestRepairExecutionCandidate } from "../../packages/runtime/src/domain/factory-external-pull-request-repair-execution-repository.js";
import { factoryTimestampAddSeconds } from "../../packages/runtime/src/domain/factory-timestamp.js";
import { testDigest } from "./factory.js";
import {
  testExternalPullRequestRepairAdmissionFixture,
  type ExternalPullRequestRepairAdmissionFixture
} from "./factory-external-pull-request-repair-admission.js";

export const TEST_EXTERNAL_PR_REPAIR_RUN_ID = "95000000-0000-4000-8000-000000000001";
export const TEST_EXTERNAL_PR_REPAIR_WORKSPACE_ID = "95000000-0000-4000-8000-000000000002";

export interface ExternalPullRequestRepairExecutionFixture {
  readonly admission: ExternalPullRequestRepairAdmissionFixture;
  readonly documents: FactoryDocumentCodec;
  readonly skillPackage: FactorySkillPackage;
  readonly skillDocument: CanonicalFactoryDocument<FactorySkillPackage>;
  readonly executionPolicy: FactoryExternalPullRequestRepairExecutionPolicy;
  readonly executionPolicyDocument: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionPolicy>;
  readonly decision: CanonicalFactoryDocument<FactoryExternalPullRequestRepairDecision>;
  readonly authorization: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAuthorization>;
  readonly candidate: FactoryExternalPullRequestRepairExecutionCandidate;
}

export function testExternalPullRequestRepairExecutionFixture(
  options: {
    readonly costPolicyDigest?: Sha256Digest;
    readonly roleIdentityPolicyDigest?: Sha256Digest;
    readonly gateProfileDigest?: Sha256Digest;
    readonly qualificationPolicyDigest?: Sha256Digest;
  } = {}
): ExternalPullRequestRepairExecutionFixture {
  const initial = testExternalPullRequestRepairAdmissionFixture();
  const capabilities = repairCapabilities();
  const repairBudget = budget();
  const skillPackage = factorySkillPackageSchema.parse({
    schemaVersion: "agentlab.skill-package.v1",
    manifest: {
      schemaVersion: "agentlab.skill-manifest.v1",
      id: "repair/external-r1",
      version: "1.0.0",
      instructionPath: "SKILL.md",
      description: "Repair selected authenticated external pull-request review findings.",
      roles: ["repairer"],
      triggers: ["scheduled"],
      inputSchemaDigest: null,
      outputSchemaDigest: null,
      requestedCapabilities: capabilities,
      riskCeiling: "R1",
      allowedFromStates: ["repairing"],
      allowedToStates: ["verifying"],
      providerCompatibility: { mode: "allowlist", providers: ["codex"] },
      budgetCeiling: repairBudget,
      requiredEvidence: ["patch"],
      dependencyDigests: []
    },
    files: { "SKILL.md": "Make the smallest correct patch for every selected finding." }
  });
  const skillDocument = initial.feedback.review.documents.skillPackage(skillPackage);
  const costPolicyDigest = options.costPolicyDigest ?? testDigest("4");
  const roleIdentityPolicyDigest = options.roleIdentityPolicyDigest ?? testDigest("5");
  const gateProfileDigest = options.gateProfileDigest ?? testDigest("6");
  const qualificationPolicyDigest = options.qualificationPolicyDigest ?? testDigest("7");
  const executionPolicy = factoryExternalPullRequestRepairExecutionPolicySchema.parse({
    schemaVersion: "agentlab.external-pull-request-repair-execution-policy.v1",
    id: "agentlab/external-pull-request-repair-execution",
    version: "1.0.0",
    repositoryId: initial.feedback.policy.repositoryId,
    costPolicyDigest,
    roleIdentityPolicyDigest,
    gateProfileDigest,
    qualificationPolicyDigest,
    repairerProfile: {
      id: "external-r1-repairer",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "high",
      skillDigests: [skillDocument.digest],
      capabilities,
      budget: repairBudget
    },
    protectedPaths: [".github/**", "docs/architecture/**"],
    maximumChangedFiles: 10,
    maximumChangedLines: 300,
    maximumPatchBytes: 1_048_576,
    maximumPromptBytes: 1_048_576,
    operationDeadlineSeconds: 600,
    maximumCandidatesPerTick: 3,
    resourceLimits: {
      maxProcesses: 4,
      maxMemoryBytes: 1_073_741_824,
      cpuQuotaPercent: 200
    },
    maximumRecoveryAttempts: 1,
    maximumRiskTier: "R1",
    maximumRepairAttempts: 1,
    publicationMode: "replacement-draft",
    remoteWrite: false,
    autoMerge: false,
    release: false
  });
  const executionPolicyDocument =
    initial.feedback.review.documents.externalPullRequestRepairExecutionPolicy(executionPolicy);
  const admission = testExternalPullRequestRepairAdmissionFixture({
    repairExecutionPolicyDigest: executionPolicyDocument.digest,
    costPolicyDigest,
    roleIdentityPolicyDigest,
    gateProfileDigest,
    skillPackageDigests: [skillDocument.digest]
  });
  const createdAt = "2026-09-01T12:24:00.000Z";
  const evaluation = assessExternalPullRequestRepairAdmission(
    admission.candidate,
    admission.policy,
    createdAt
  );
  if (evaluation.status !== "authorized") throw new Error("Expected authorized repair fixture.");
  const authorizationId = "95000000-0000-4000-8000-000000000003";
  const correlationId = "95000000-0000-4000-8000-000000000004";
  const feedbackRun = admission.candidate.feedbackRun;
  const candidate = feedbackRun.value.reviewRun.candidate;
  const authorization = admission.feedback.review.documents.externalPullRequestRepairAuthorization({
    schemaVersion: "agentlab.external-pull-request-repair-authorization.v1",
    authorizationId,
    repositoryId: feedbackRun.value.repositoryId,
    pullRequestNumber: feedbackRun.value.pullRequestNumber,
    reviewRunId: feedbackRun.value.reviewRunId,
    reviewRunDigest: feedbackRun.value.reviewRunDigest,
    bundleDigest: feedbackRun.value.bundleDigest,
    feedbackPublicationRunId: feedbackRun.value.publicationRunId,
    feedbackPublicationRunDigest: feedbackRun.digest,
    feedbackRecordDigest: admission.candidate.feedbackRecord.digest,
    reviewPolicyDigest: admission.policy.reviewPolicyDigest,
    feedbackPolicyDigest: admission.policy.feedbackPolicyDigest,
    admissionPolicyDigest: admission.policyDocument.digest,
    repairExecutionPolicyDigest: executionPolicyDocument.digest,
    costPolicyDigest,
    roleIdentityPolicyDigest,
    gateProfileDigest,
    skillPackageDigests: [skillDocument.digest],
    expectedBaseRevision: feedbackRun.value.expectedBaseRevision,
    expectedHeadRevision: feedbackRun.value.expectedHeadRevision,
    patchDigest: feedbackRun.value.bundle.patchDigest,
    fromFork: candidate.fromFork,
    headRepositoryId: candidate.head.repositoryId,
    headBranchName: candidate.head.branchName,
    selectedFindings: evaluation.selectedFindings,
    repairAttempt: 1,
    publicationMode: "replacement-draft",
    remoteWrite: false,
    autoMerge: false,
    release: false,
    createdAt,
    expiresAt: factoryTimestampAddSeconds(createdAt, admission.policy.authorizationTtlSeconds),
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: admission.policy.id,
      sessionId: authorizationId
    },
    correlationId
  });
  const decisionId = "95000000-0000-4000-8000-000000000005";
  const decision = admission.feedback.review.documents.externalPullRequestRepairDecision({
    schemaVersion: "agentlab.external-pull-request-repair-decision.v1",
    decisionId,
    repositoryId: feedbackRun.value.repositoryId,
    pullRequestNumber: feedbackRun.value.pullRequestNumber,
    reviewRunId: feedbackRun.value.reviewRunId,
    reviewRunDigest: feedbackRun.value.reviewRunDigest,
    bundleDigest: feedbackRun.value.bundleDigest,
    feedbackPublicationRunId: feedbackRun.value.publicationRunId,
    feedbackPublicationRunDigest: feedbackRun.digest,
    feedbackRecordDigest: admission.candidate.feedbackRecord.digest,
    admissionPolicyDigest: admission.policyDocument.digest,
    status: "authorized",
    reasonCodes: evaluation.reasonCodes,
    authorizationDigest: authorization.digest,
    selectedFindingCount: evaluation.selectedFindings.length,
    createdAt,
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: admission.policy.id,
      sessionId: decisionId
    },
    correlationId
  });
  const executionCandidate: FactoryExternalPullRequestRepairExecutionCandidate = {
    decision,
    authorization,
    feedbackRun,
    feedbackRecord: admission.candidate.feedbackRecord
  };
  return {
    admission,
    documents: admission.feedback.review.documents,
    skillPackage,
    skillDocument,
    executionPolicy,
    executionPolicyDocument,
    decision,
    authorization,
    candidate: executionCandidate
  };
}

export function externalPullRequestRepairExecutionRun(
  fixture: ReturnType<typeof testExternalPullRequestRepairExecutionFixture>
): CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun> {
  return fixture.documents.externalPullRequestRepairExecutionRun({
    schemaVersion: "agentlab.external-pull-request-repair-execution-run.v1",
    runId: TEST_EXTERNAL_PR_REPAIR_RUN_ID,
    repositoryId: fixture.authorization.value.repositoryId,
    pullRequestNumber: fixture.authorization.value.pullRequestNumber,
    authorizationId: fixture.authorization.value.authorizationId,
    authorizationDigest: fixture.authorization.digest,
    admissionDecisionDigest: fixture.decision.digest,
    feedbackPublicationRunDigest: fixture.candidate.feedbackRun.digest,
    feedbackRecordDigest: fixture.candidate.feedbackRecord.digest,
    reviewRunDigest: fixture.authorization.value.reviewRunDigest,
    reviewBundleDigest: fixture.authorization.value.bundleDigest,
    admissionPolicyDigest: fixture.admission.policyDocument.digest,
    repairExecutionPolicyDigest: fixture.executionPolicyDocument.digest,
    repairExecutionPolicy: fixture.executionPolicy,
    expectedBaseRevision: fixture.authorization.value.expectedBaseRevision,
    expectedHeadRevision: fixture.authorization.value.expectedHeadRevision,
    originalPatchDigest: fixture.authorization.value.patchDigest,
    selectedFindings: fixture.authorization.value.selectedFindings,
    repairAttempt: 1,
    workspaceId: TEST_EXTERNAL_PR_REPAIR_WORKSPACE_ID,
    createdAt: "2026-09-01T12:25:00.000Z",
    deadlineAt: "2026-09-01T12:35:00.000Z",
    correlationId: "95000000-0000-4000-8000-000000000006"
  });
}

export function registeredExternalPullRequestRepairExecutionEvent(
  fixture: ReturnType<typeof testExternalPullRequestRepairExecutionFixture>,
  run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>
): CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent> {
  return fixture.documents.externalPullRequestRepairExecutionEvent({
    schemaVersion: "agentlab.external-pull-request-repair-execution-event.v1",
    repairRunId: run.value.runId,
    runDigest: run.digest,
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab/external-pull-request-repair-execution",
      sessionId: run.value.runId
    },
    kind: "registered",
    from: null,
    to: "ready",
    sequence: 1,
    previousEventDigest: null,
    eventId: "95000000-0000-4000-8000-000000000007",
    occurredAt: run.value.createdAt,
    reasonCode: "external-repair-authorization-consumed",
    correlationId: run.value.correlationId
  });
}

function repairCapabilities(): FactoryCapabilityGrant {
  return {
    filesystem: "workspace-write",
    git: "worktree-write",
    remoteRepository: "none",
    process: "sandboxed",
    network: { mode: "off" },
    commandAllowlist: [],
    secretRefs: []
  };
}

function budget(): FactoryBudget {
  return {
    wallClockSeconds: 300,
    maxAgentTurns: 20,
    maxToolCalls: 100,
    maxInputTokens: 100_000,
    maxOutputTokens: 20_000,
    maxCostMicrousd: 200_000,
    maxProcesses: 4,
    maxOutputBytes: 2_097_152,
    maxWorkers: 1,
    maxRepairAttempts: 1,
    maxChangedFiles: 10,
    maxChangedLines: 300
  };
}
