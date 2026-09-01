import {
  factoryExternalPullRequestReviewPolicySchema,
  factorySkillPackageSchema,
  skillManifestSchema,
  type FactoryExternalPullRequestReviewEvent,
  type FactoryExternalPullRequestReviewPolicy,
  type FactoryExternalPullRequestReviewRun,
  type FactorySkillPackage,
  type Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { testDigest } from "./factory.js";
import {
  testExternalPullRequestCandidate,
  testExternalPullRequestDiscoveryFixture,
  testExternalPullRequestSnapshot
} from "./factory-external-pull-request-discovery.js";

export const TEST_EXTERNAL_PR_REVIEW_RUN_ID = "92000000-0000-4000-8000-000000000001";
export const TEST_EXTERNAL_PR_REVIEW_WORKSPACE_ID = "92000000-0000-4000-8000-000000000002";

export function testExternalPullRequestReviewFixture() {
  const discovery = testExternalPullRequestDiscoveryFixture();
  const candidate = testExternalPullRequestCandidate();
  const candidateDocument = discovery.documents.externalPullRequestCandidate(candidate);
  const snapshot = testExternalPullRequestSnapshot(discovery);
  const firstSkill = reviewSkillPackage("review/security", "codex");
  const secondSkill = reviewSkillPackage("review/maintainability", "claude");
  const firstSkillDocument = discovery.documents.skillPackage(firstSkill);
  const secondSkillDocument = discovery.documents.skillPackage(secondSkill);
  const policy = factoryExternalPullRequestReviewPolicySchema.parse({
    schemaVersion: "agentlab.external-pull-request-review-policy.v1",
    id: "agentlab/external-pull-request-review",
    version: "1.0.0",
    repositoryId: candidate.repositoryId,
    discoveryPolicyDigest: discovery.policyDocument.digest,
    reviewerProfiles: [
      reviewerProfile("security-reviewer", "codex", firstSkillDocument.digest),
      reviewerProfile("maintainability-reviewer", "claude", secondSkillDocument.digest)
    ],
    minimumIndependentReviews: 2,
    maximumCandidatesPerTick: 3,
    maximumPatchBytes: 1_048_576,
    maximumPromptBytes: 2_097_152,
    aggregateBudget: budget({ wallClockSeconds: 600, maxCostMicrousd: 400_000 }),
    resourceLimits: {
      maxProcesses: 8,
      maxMemoryBytes: 1_073_741_824,
      cpuQuotaPercent: 200
    },
    maximumRecoveryAttempts: 1
  });
  const policyDocument = discovery.documents.externalPullRequestReviewPolicy(policy);
  const run = discovery.documents.externalPullRequestReviewRun({
    schemaVersion: "agentlab.external-pull-request-review-run.v1",
    runId: TEST_EXTERNAL_PR_REVIEW_RUN_ID,
    repositoryId: candidate.repositoryId,
    pullRequestNumber: candidate.pullRequestNumber,
    candidateDigest: candidateDocument.digest,
    candidate,
    discoveryRunId: discovery.run.value.runId,
    discoveryRunDigest: discovery.run.digest,
    discoverySnapshotDigest: snapshot.digest,
    discoveryPolicyDigest: discovery.policyDocument.digest,
    reviewPolicyDigest: policyDocument.digest,
    reviewPolicy: policy,
    costPolicyDigest: testDigest("9"),
    workspaceId: TEST_EXTERNAL_PR_REVIEW_WORKSPACE_ID,
    createdAt: "2026-09-01T12:10:00.000Z",
    deadlineAt: "2026-09-01T12:20:00.000Z",
    correlationId: discovery.run.value.correlationId
  });
  return {
    documents: discovery.documents,
    discovery,
    snapshot,
    candidate,
    candidateDocument,
    policy,
    policyDocument,
    skillPackages: [firstSkillDocument.value, secondSkillDocument.value] as const,
    skillDigests: [firstSkillDocument.digest, secondSkillDocument.digest] as const,
    run
  };
}

export function registeredExternalPullRequestReviewEvent(
  fixture: ReturnType<typeof testExternalPullRequestReviewFixture>
): CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent> {
  return fixture.documents.externalPullRequestReviewEvent({
    ...reviewEventBase(fixture.run, 1, null, "92000000-0000-4000-8000-000000000003"),
    kind: "registered",
    from: null,
    to: "ready",
    occurredAt: fixture.run.value.createdAt,
    reasonCode: "external-review-registered"
  });
}

export function reviewEventBase(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>,
  sequence: number,
  previousEventDigest: Sha256Digest | null,
  eventId: string
) {
  return {
    schemaVersion: "agentlab.external-pull-request-review-event.v1" as const,
    eventId,
    reviewRunId: run.value.runId,
    runDigest: run.digest,
    sequence,
    previousEventDigest,
    actor: {
      kind: "control-plane" as const,
      id: run.value.reviewPolicy.id,
      role: "policy-engine" as const,
      sessionId: run.value.runId
    },
    occurredAt: `2026-09-01T12:${String(sequence + 9).padStart(2, "0")}:00.000Z`,
    correlationId: run.value.correlationId
  };
}

function reviewSkillPackage(id: string, provider: "codex" | "claude"): FactorySkillPackage {
  return factorySkillPackageSchema.parse({
    schemaVersion: "agentlab.skill-package.v1",
    manifest: {
      schemaVersion: "agentlab.skill-manifest.v1",
      id,
      version: "1.0.0",
      instructionPath: "SKILL.md",
      description: "Review one authenticated external patch without modifying it.",
      roles: ["reviewer"],
      triggers: ["scheduled"],
      inputSchemaDigest: null,
      outputSchemaDigest: null,
      requestedCapabilities: readOnlyCapabilities(),
      riskCeiling: "R1",
      allowedFromStates: ["reviewing"],
      allowedToStates: ["pr-proposed"],
      providerCompatibility: { mode: "allowlist", providers: [provider] },
      budgetCeiling: budget(),
      requiredEvidence: ["review"],
      dependencyDigests: []
    },
    files: { "SKILL.md": "Inspect the supplied patch. Return only the required review JSON." }
  });
}

function reviewerProfile(id: string, provider: "codex" | "claude", digest: Sha256Digest) {
  return {
    id,
    provider,
    model: provider === "codex" ? "gpt-5.4" : "claude-sonnet-4-5",
    reasoning: provider === "codex" ? "high" : null,
    skillDigests: [digest],
    capabilities: readOnlyCapabilities(provider === "codex" ? "sandboxed" : "none"),
    budget: budget()
  };
}

function readOnlyCapabilities(process: "none" | "sandboxed" = "none") {
  return {
    filesystem: "read" as const,
    git: "read" as const,
    remoteRepository: "none" as const,
    process,
    network: { mode: "off" as const },
    commandAllowlist: [],
    secretRefs: []
  };
}

function budget(overrides: Record<string, number> = {}) {
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
    maxChangedFiles: 100,
    maxChangedLines: 5_000,
    ...overrides
  };
}

export function reviewSkillManifests(
  fixture: ReturnType<typeof testExternalPullRequestReviewFixture>
) {
  return fixture.skillPackages.map((skillPackage, index) =>
    skillManifestSchema.parse({
      ...skillPackage.manifest,
      packageDigest: fixture.skillDigests[index]
    })
  );
}

export type ExternalPullRequestReviewFixture = ReturnType<
  typeof testExternalPullRequestReviewFixture
>;
export type ExternalPullRequestReviewPolicy = FactoryExternalPullRequestReviewPolicy;
