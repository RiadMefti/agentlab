import { createHash } from "node:crypto";

import {
  factoryExternalPullRequestRepairGateProfileSchema,
  factoryExternalPullRequestRepairQualificationPolicySchema,
  factorySkillPackageSchema,
  type FactoryBudget,
  type FactoryCapabilityGrant,
  type FactoryExternalPullRequestRepairQualificationEvent,
  type FactoryExternalPullRequestRepairQualificationRun,
  type FactorySkillPackage,
  type Sha256Digest
} from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../packages/runtime/src/domain/factory-documents.js";
import type { FactoryExternalPullRequestRepairQualificationCandidate } from "../../packages/runtime/src/domain/factory-external-pull-request-repair-qualification-repository.js";
import { testDigest } from "./factory.js";
import {
  externalPullRequestRepairExecutionRun,
  testExternalPullRequestRepairExecutionFixture,
  type ExternalPullRequestRepairExecutionFixture
} from "./factory-external-pull-request-repair-execution.js";
import { testExternalPullRequestRepairAdmissionFixture } from "./factory-external-pull-request-repair-admission.js";

export const TEST_EXTERNAL_PR_QUALIFICATION_RUN_ID = "96000000-0000-4000-8000-000000000001";
export const TEST_EXTERNAL_PR_QUALIFICATION_WORKSPACE_ID = "96000000-0000-4000-8000-000000000002";

export const TEST_REPAIRED_PATCH =
  "diff --git a/tracked.txt b/tracked.txt\nindex 1111111..2222222 100644\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-old\n+new\n";

export interface ExternalPullRequestRepairQualificationFixture {
  readonly execution: ExternalPullRequestRepairExecutionFixture;
  readonly documents: FactoryDocumentCodec;
  readonly reviewerSkill: FactorySkillPackage;
  readonly reviewerSkillDocument: CanonicalFactoryDocument<FactorySkillPackage>;
  readonly gateProfile: ReturnType<typeof factoryExternalPullRequestRepairGateProfileSchema.parse>;
  readonly gateProfileDocument: ReturnType<
    FactoryDocumentCodec["externalPullRequestRepairGateProfile"]
  >;
  readonly policy: ReturnType<
    typeof factoryExternalPullRequestRepairQualificationPolicySchema.parse
  >;
  readonly policyDocument: ReturnType<
    FactoryDocumentCodec["externalPullRequestRepairQualificationPolicy"]
  >;
  readonly repairRun: ReturnType<typeof externalPullRequestRepairExecutionRun>;
  readonly repairerRecord: ReturnType<FactoryDocumentCodec["externalPullRequestRepairerRecord"]>;
  readonly repairBundle: ReturnType<FactoryDocumentCodec["externalPullRequestRepairBundle"]>;
  readonly candidate: FactoryExternalPullRequestRepairQualificationCandidate;
  readonly repairedPatch: string;
}

export function testExternalPullRequestRepairQualificationFixture(): ExternalPullRequestRepairQualificationFixture {
  const base = testExternalPullRequestRepairAdmissionFixture();
  const documents = base.feedback.review.documents;
  const reviewerSkill = factorySkillPackageSchema.parse({
    schemaVersion: "agentlab.skill-package.v1",
    manifest: {
      schemaVersion: "agentlab.skill-manifest.v1",
      id: "review/post-external-repair",
      version: "1.0.0",
      instructionPath: "SKILL.md",
      description: "Independently review an exact repaired external pull-request patch.",
      roles: ["reviewer"],
      triggers: ["scheduled"],
      inputSchemaDigest: null,
      outputSchemaDigest: null,
      requestedCapabilities: reviewerCapabilities(),
      riskCeiling: "R1",
      allowedFromStates: ["reviewing"],
      allowedToStates: ["pr-proposed"],
      providerCompatibility: { mode: "allowlist", providers: ["codex"] },
      budgetCeiling: reviewerBudget(),
      requiredEvidence: ["review"],
      dependencyDigests: []
    },
    files: {
      "SKILL.md": "Verify every selected finding is fixed without regression or scope expansion."
    }
  });
  const reviewerSkillDocument = documents.skillPackage(reviewerSkill);
  const gateProfile = factoryExternalPullRequestRepairGateProfileSchema.parse({
    schemaVersion: "agentlab.external-pull-request-repair-gate-profile.v1",
    id: "agentlab/external-pull-request-repair-gates",
    version: "1.0.0",
    repositoryId: base.policy.repositoryId,
    gates: gateDefinitions()
  });
  const gateProfileDocument = documents.externalPullRequestRepairGateProfile(gateProfile);
  const costPolicyDigest = testDigest("4");
  const roleIdentityPolicyDigest = testDigest("5");
  const policy = factoryExternalPullRequestRepairQualificationPolicySchema.parse({
    schemaVersion: "agentlab.external-pull-request-repair-qualification-policy.v1",
    id: "agentlab/external-pull-request-repair-qualification",
    version: "1.0.0",
    repositoryId: base.policy.repositoryId,
    costPolicyDigest,
    roleIdentityPolicyDigest,
    gateProfileDigest: gateProfileDocument.digest,
    gateProfile,
    reviewerProfiles: [
      {
        id: "post-repair-reviewer",
        provider: "codex",
        model: "gpt-5.4",
        reasoning: "high",
        skillDigests: [reviewerSkillDocument.digest],
        capabilities: reviewerCapabilities(),
        budget: reviewerBudget()
      }
    ],
    minimumIndependentReviews: 1,
    aggregateBudget: aggregateBudget(),
    resourceLimits: {
      maxProcesses: 8,
      maxMemoryBytes: 1_073_741_824,
      cpuQuotaPercent: 200
    },
    maximumPatchBytes: 1_048_576,
    maximumPromptBytes: 2_097_152,
    operationDeadlineSeconds: 900,
    maximumCandidatesPerTick: 3,
    maximumRecoveryAttempts: 1,
    maximumRiskTier: "R1",
    publicationMode: "replacement-draft",
    remoteWrite: false,
    autoMerge: false,
    release: false
  });
  const policyDocument = documents.externalPullRequestRepairQualificationPolicy(policy);
  const execution = testExternalPullRequestRepairExecutionFixture({
    costPolicyDigest,
    roleIdentityPolicyDigest,
    gateProfileDigest: gateProfileDocument.digest,
    qualificationPolicyDigest: policyDocument.digest
  });
  const repairRun = externalPullRequestRepairExecutionRun(execution);
  const repairerRequestDigest = testDigest("a");
  const repairerExecutionId = "96000000-0000-4000-8000-000000000010";
  const repairerRecord = documents.externalPullRequestRepairerRecord({
    schemaVersion: "agentlab.external-pull-request-repairer-record.v1",
    repairRunId: repairRun.value.runId,
    runDigest: repairRun.digest,
    requestDigest: repairerRequestDigest,
    executionId: repairerExecutionId,
    repairerId: execution.executionPolicy.repairerProfile.id,
    provider: execution.executionPolicy.repairerProfile.provider,
    providerVersion: "codex 1",
    harnessVersion: "agentlab-test-harness/1",
    model: execution.executionPolicy.repairerProfile.model,
    reasoning: execution.executionPolicy.repairerProfile.reasoning,
    providerSessionId: "repairer-provider-session",
    status: "succeeded",
    startedAt: "2026-09-01T12:25:00.000Z",
    finishedAt: "2026-09-01T12:26:00.000Z",
    exitCode: 0,
    stdoutArtifact: artifact(testDigest("b"), "application/x-ndjson", 2),
    stderrArtifact: artifact(testDigest("c"), "text/plain; charset=utf-8", 0),
    finalOutputArtifact: artifact(testDigest("d"), "text/plain; charset=utf-8", 8),
    usage: repairUsage(),
    usageComplete: true,
    errorCode: null,
    isolation: isolation(repairerExecutionId)
  });
  const repairedPatchDigest = digestText(TEST_REPAIRED_PATCH);
  const repairBundle = documents.externalPullRequestRepairBundle({
    schemaVersion: "agentlab.external-pull-request-repair-bundle.v1",
    repairRunId: repairRun.value.runId,
    runDigest: repairRun.digest,
    repositoryId: repairRun.value.repositoryId,
    pullRequestNumber: repairRun.value.pullRequestNumber,
    authorizationDigest: repairRun.value.authorizationDigest,
    repairExecutionPolicyDigest: repairRun.value.repairExecutionPolicyDigest,
    expectedHeadRevision: repairRun.value.expectedHeadRevision,
    originalPatchDigest: repairRun.value.originalPatchDigest,
    repairerRequestDigest,
    repairerRecordDigest: repairerRecord.digest,
    executionId: repairerExecutionId,
    patchArtifact: artifact(
      repairedPatchDigest,
      "application/vnd.git.patch",
      new TextEncoder().encode(TEST_REPAIRED_PATCH).byteLength
    ),
    changeSet: {
      baseRevision: repairRun.value.expectedHeadRevision,
      headRevision: null,
      changedPaths: ["tracked.txt"],
      binaryPaths: [],
      changedFiles: 1,
      changedLines: 2
    },
    usage: repairUsage(),
    usageComplete: true,
    repairAttempt: 1,
    publicationMode: "replacement-draft",
    remoteWrite: false,
    autoMerge: false,
    release: false,
    workspaceClosed: true,
    createdAt: "2026-09-01T12:27:00.000Z"
  });
  const candidate = {
    repairRun,
    repairBundle,
    feedbackRun: execution.candidate.feedbackRun
  };
  return {
    execution,
    documents,
    reviewerSkill,
    reviewerSkillDocument,
    gateProfile,
    gateProfileDocument,
    policy,
    policyDocument,
    repairRun,
    repairerRecord,
    repairBundle,
    candidate,
    repairedPatch: TEST_REPAIRED_PATCH
  };
}

export function externalPullRequestRepairQualificationRun(
  fixture: ExternalPullRequestRepairQualificationFixture
): CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun> {
  return fixture.documents.externalPullRequestRepairQualificationRun({
    schemaVersion: "agentlab.external-pull-request-repair-qualification-run.v1",
    qualificationRunId: TEST_EXTERNAL_PR_QUALIFICATION_RUN_ID,
    repositoryId: fixture.repairRun.value.repositoryId,
    pullRequestNumber: fixture.repairRun.value.pullRequestNumber,
    repairRunId: fixture.repairRun.value.runId,
    repairRunDigest: fixture.repairRun.digest,
    repairBundleDigest: fixture.repairBundle.digest,
    authorizationDigest: fixture.repairRun.value.authorizationDigest,
    repairExecutionPolicyDigest: fixture.repairRun.value.repairExecutionPolicyDigest,
    qualificationPolicyDigest: fixture.policyDocument.digest,
    qualificationPolicy: fixture.policy,
    gateProfileDigest: fixture.gateProfileDocument.digest,
    expectedBaseRevision: fixture.repairRun.value.expectedBaseRevision,
    expectedHeadRevision: fixture.repairRun.value.expectedHeadRevision,
    originalPatchDigest: fixture.repairRun.value.originalPatchDigest,
    repairedPatchDigest: fixture.repairBundle.value.patchArtifact.digest,
    repairerId: fixture.execution.executionPolicy.repairerProfile.id,
    repairerRecordDigest: fixture.repairerRecord.digest,
    repairerExecutionId: fixture.repairBundle.value.executionId,
    repairerProviderSessionId: fixture.repairerRecord.value.providerSessionId,
    workspaceId: TEST_EXTERNAL_PR_QUALIFICATION_WORKSPACE_ID,
    createdAt: "2026-09-01T12:30:00.000Z",
    deadlineAt: "2026-09-01T12:45:00.000Z",
    correlationId: "96000000-0000-4000-8000-000000000003"
  });
}

export function registeredExternalPullRequestRepairQualificationEvent(
  fixture: ExternalPullRequestRepairQualificationFixture,
  run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>
): CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent> {
  return fixture.documents.externalPullRequestRepairQualificationEvent({
    schemaVersion: "agentlab.external-pull-request-repair-qualification-event.v1",
    eventId: "96000000-0000-4000-8000-000000000004",
    qualificationRunId: run.value.qualificationRunId,
    runDigest: run.digest,
    sequence: 1,
    previousEventDigest: null,
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab/external-pull-request-repair-qualification",
      sessionId: run.value.qualificationRunId
    },
    kind: "registered",
    from: null,
    to: "ready",
    occurredAt: run.value.createdAt,
    reasonCode: "completed-external-repair-consumed",
    correlationId: run.value.correlationId
  });
}

export function qualificationGateDefinitions() {
  return gateDefinitions();
}

function gateDefinitions() {
  const definitions = [
    ["format", "test"],
    ["architecture", "test"],
    ["typecheck", "test"],
    ["lint", "test"],
    ["test", "test"],
    ["build", "build"],
    ["secret-scan", "security"]
  ] as const;
  return definitions.map(([id, evidenceKind], index) => ({
    id,
    evidenceKind,
    command: {
      executable: "/usr/bin/npm",
      executableDigest: testDigest(String(index + 1)),
      args: ["run", id]
    },
    timeoutMs: 60_000,
    maximumOutputBytes: 1_048_576
  }));
}

function reviewerCapabilities(): FactoryCapabilityGrant {
  return {
    filesystem: "read",
    git: "read",
    remoteRepository: "none",
    process: "sandboxed",
    network: { mode: "off" },
    commandAllowlist: [],
    secretRefs: []
  };
}

function reviewerBudget(): FactoryBudget {
  return {
    wallClockSeconds: 240,
    maxAgentTurns: 20,
    maxToolCalls: 50,
    maxInputTokens: 100_000,
    maxOutputTokens: 20_000,
    maxCostMicrousd: 200_000,
    maxProcesses: 4,
    maxOutputBytes: 2_097_152,
    maxWorkers: 1,
    maxRepairAttempts: 0,
    maxChangedFiles: 10,
    maxChangedLines: 300
  };
}

function aggregateBudget(): FactoryBudget {
  return {
    wallClockSeconds: 900,
    maxAgentTurns: 40,
    maxToolCalls: 100,
    maxInputTokens: 200_000,
    maxOutputTokens: 40_000,
    maxCostMicrousd: 400_000,
    maxProcesses: 16,
    maxOutputBytes: 16_777_216,
    maxWorkers: 1,
    maxRepairAttempts: 0,
    maxChangedFiles: 10,
    maxChangedLines: 300
  };
}

function repairUsage() {
  return {
    wallClockSeconds: 60,
    agentTurns: 2,
    toolCalls: 3,
    inputTokens: 2_000,
    outputTokens: 400,
    costMicrousd: 200,
    processes: 1,
    outputBytes: 1_000,
    workers: 1,
    repairAttempts: 1,
    changedFiles: 1,
    changedLines: 2
  };
}

function isolation(isolationId: string) {
  return {
    isolationId,
    mechanism: { id: "linux/systemd-user-scope" as const, version: "systemd 261" },
    scopeName: `agentlab-factory-${isolationId.replaceAll("-", "")}.scope`,
    limits: {
      maxProcesses: 4,
      maxMemoryBytes: 1_073_741_824,
      cpuQuotaPercent: 200
    }
  };
}

function artifact(digest: Sha256Digest, mediaType: string, sizeBytes: number) {
  return { digest, mediaType, sizeBytes };
}

function digestText(value: string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
