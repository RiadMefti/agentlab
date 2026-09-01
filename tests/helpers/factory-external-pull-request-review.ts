import {
  factoryExternalPullRequestReviewPolicySchema,
  factorySkillPackageSchema,
  skillManifestSchema,
  type FactoryExternalPullRequestReviewEvent,
  type FactoryExternalPullRequestReviewBundle,
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

export function completedExternalPullRequestReviewDocuments(
  fixture: ReturnType<typeof testExternalPullRequestReviewFixture>
): {
  readonly events: readonly CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>[];
  readonly bundle: CanonicalFactoryDocument<FactoryExternalPullRequestReviewBundle>;
} {
  const events: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>[] = [
    registeredExternalPullRequestReviewEvent(fixture)
  ];
  const patchDigest = testDigest("7");
  events.push(
    fixture.documents.externalPullRequestReviewEvent({
      ...reviewEventBase(fixture.run, 2, events[0]?.digest ?? null, id(4)),
      kind: "workspace-started",
      from: "ready",
      to: "workspace-active",
      reasonCode: "exact-head-workspace-started"
    })
  );
  events.push(
    fixture.documents.externalPullRequestReviewEvent({
      ...reviewEventBase(fixture.run, 3, events[1]?.digest ?? null, id(5)),
      kind: "workspace-prepared",
      from: "workspace-active",
      to: "reviewing",
      patchDigest,
      patchArtifact: artifact(patchDigest, "application/vnd.git.patch"),
      reasonCode: "authenticated-paths-and-local-patch-match"
    })
  );
  const records = fixture.policy.reviewerProfiles.map((profile, index) => {
    const sequence = index === 0 ? 4 : 6;
    const executionId = id(10 + index);
    const requestDigest = testDigest(index === 0 ? "a" : "b");
    events.push(
      fixture.documents.externalPullRequestReviewEvent({
        ...reviewEventBase(fixture.run, sequence, events.at(-1)?.digest ?? null, id(6 + index * 2)),
        kind: "reviewer-started",
        from: "reviewing",
        to: "reviewer-active",
        reviewerId: profile.id,
        executionId,
        requestDigest,
        reasonCode: "independent-review-started"
      })
    );
    const record = fixture.documents.externalPullRequestReviewerRecord({
      schemaVersion: "agentlab.external-pull-request-reviewer-record.v1",
      reviewRunId: fixture.run.value.runId,
      runDigest: fixture.run.digest,
      requestDigest,
      executionId,
      reviewerId: profile.id,
      provider: profile.provider,
      providerVersion: `${profile.provider} test`,
      harnessVersion: "agentlab-test/1",
      model: profile.model,
      reasoning: profile.reasoning,
      providerSessionId: `session-${String(index + 1)}`,
      status: "succeeded",
      startedAt: `2026-09-01T12:${String(13 + index * 2)}:00.000Z`,
      finishedAt: `2026-09-01T12:${String(14 + index * 2)}:00.000Z`,
      exitCode: 0,
      stdoutArtifact: artifact(testDigest(index === 0 ? "c" : "d"), "text/plain"),
      stderrArtifact: artifact(testDigest(index === 0 ? "e" : "f"), "text/plain"),
      finalOutputArtifact: artifact(testDigest(index === 0 ? "1" : "2"), "application/json"),
      usage: usage(),
      usageComplete: true,
      errorCode: null,
      isolation: {
        isolationId: executionId,
        mechanism: { id: "linux/systemd-user-scope", version: "systemd 261" },
        scopeName: `agentlab-factory-${executionId.replaceAll("-", "")}.scope`,
        limits: fixture.policy.resourceLimits
      }
    });
    const result = fixture.documents.externalPullRequestReviewResult({
      schemaVersion: "agentlab.external-pull-request-review-result.v1",
      reviewRunId: fixture.run.value.runId,
      runDigest: fixture.run.digest,
      candidateDigest: fixture.candidateDocument.digest,
      patchDigest,
      reviewerId: profile.id,
      requestDigest,
      reviewerRecordDigest: record.digest,
      executionId,
      verdict: index === 0 ? "approved" : "changes-requested",
      summary: index === 0 ? "No blocking findings." : "A focused correction is required.",
      findings:
        index === 0
          ? []
          : [
              {
                id: "review/finding",
                severity: "high",
                path: "tracked.txt",
                line: 1,
                title: "Behavior is incorrect",
                detail: "Correct the behavior and retain the focused regression test."
              }
            ],
      createdAt: `2026-09-01T12:${String(14 + index * 2)}:00.000Z`
    });
    events.push(
      fixture.documents.externalPullRequestReviewEvent({
        ...reviewEventBase(
          fixture.run,
          sequence + 1,
          events.at(-1)?.digest ?? null,
          id(7 + index * 2)
        ),
        kind: "reviewer-finished",
        from: "reviewer-active",
        to: "reviewing",
        reviewerId: profile.id,
        executionId,
        requestDigest,
        reviewerRecordDigest: record.digest,
        reviewResultDigest: result.digest,
        reasonCode: "independent-review-recorded"
      })
    );
    return { record, result };
  });
  const bundle = fixture.documents.externalPullRequestReviewBundle({
    schemaVersion: "agentlab.external-pull-request-review-bundle.v1",
    reviewRunId: fixture.run.value.runId,
    runDigest: fixture.run.digest,
    repositoryId: fixture.run.value.repositoryId,
    pullRequestNumber: fixture.run.value.pullRequestNumber,
    candidateDigest: fixture.candidateDocument.digest,
    patchDigest,
    reviewPolicyDigest: fixture.policyDocument.digest,
    decision: "human-review-required",
    reviewerRecords: records.map(({ record }) => record.value),
    reviews: records.map(({ result }) => result.value),
    aggregateUsage: { ...usage(), workers: 1 },
    usageComplete: true,
    workspaceUnchanged: true,
    createdAt: "2026-09-01T12:17:00.000Z"
  });
  events.push(
    fixture.documents.externalPullRequestReviewEvent({
      ...reviewEventBase(fixture.run, 8, events.at(-1)?.digest ?? null, id(20)),
      kind: "bundle-recorded",
      from: "reviewing",
      to: "recorded",
      bundleDigest: bundle.digest,
      bundleArtifact: artifact(
        bundle.digest,
        "application/vnd.agentlab.external-pull-request-review-bundle+json;version=1",
        new TextEncoder().encode(bundle.json).byteLength
      ),
      reasonCode: "review-bundle-recorded"
    })
  );
  events.push(
    fixture.documents.externalPullRequestReviewEvent({
      ...reviewEventBase(fixture.run, 9, events.at(-1)?.digest ?? null, id(21)),
      kind: "completed",
      from: "recorded",
      to: "completed",
      decision: bundle.value.decision,
      reasonCode: "independent-review-completed"
    })
  );
  return { events, bundle };
}

function id(suffix: number): string {
  return `92000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function artifact(digest: Sha256Digest, mediaType: string, sizeBytes = 32) {
  return { digest, mediaType, sizeBytes };
}

function usage() {
  return {
    wallClockSeconds: 1,
    agentTurns: 1,
    toolCalls: 1,
    inputTokens: 100,
    outputTokens: 20,
    costMicrousd: 100,
    processes: 1,
    outputBytes: 128,
    workers: 1,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0
  };
}

export type ExternalPullRequestReviewFixture = ReturnType<
  typeof testExternalPullRequestReviewFixture
>;
export type ExternalPullRequestReviewPolicy = FactoryExternalPullRequestReviewPolicy;
