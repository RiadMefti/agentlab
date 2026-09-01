import {
  factoryExternalPullRequestDiscoveryPolicySchema,
  type FactoryExternalPullRequestCandidate,
  type FactoryExternalPullRequestDiscoveryEvent,
  type FactoryExternalPullRequestDiscoveryPolicy,
  type FactoryExternalPullRequestDiscoveryRun,
  type FactoryExternalPullRequestDiscoverySnapshot,
  type FactorySchedulePolicy
} from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../packages/runtime/src/domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactorySchedulePolicy } from "./factory-schedule.js";

export const TEST_EXTERNAL_PR_RUN_ID = "91000000-0000-4000-8000-000000000001";
export const TEST_EXTERNAL_PR_CORRELATION_ID = "91000000-0000-4000-8000-000000000002";

export interface ExternalPullRequestDiscoveryFixture {
  readonly documents: FactoryDocumentCodec;
  readonly policy: FactoryExternalPullRequestDiscoveryPolicy;
  readonly policyDocument: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryPolicy>;
  readonly schedulePolicy: FactorySchedulePolicy;
  readonly scheduleDocument: CanonicalFactoryDocument<FactorySchedulePolicy>;
  readonly run: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryRun>;
}

export function testExternalPullRequestDiscoveryFixture(): ExternalPullRequestDiscoveryFixture {
  const documents: FactoryDocumentCodec = new NodeFactoryDocumentCodec();
  const policy = factoryExternalPullRequestDiscoveryPolicySchema.parse({
    schemaVersion: "agentlab.external-pull-request-discovery-policy.v1",
    id: "agentlab/external-pull-request-discovery",
    version: "1.0.0",
    repositoryId: "owner/agentlab",
    allowedBaseBranches: ["main"],
    protectedPaths: [".github/**", "packages/launcher/**"],
    agentReviewAssociations: ["owner", "member", "collaborator", "contributor"],
    includeDrafts: false,
    maximumPullRequestsPerTick: 5,
    maximumChangedFilesForAgentReview: 20,
    maximumChangedLinesForAgentReview: 500,
    maximumAgeDays: 30
  });
  const schedulePolicy = testFactorySchedulePolicy({
    cadence: {
      kind: "daily",
      timeZone: "UTC",
      at: "12:00",
      startDeadlineSeconds: 3_600
    },
    maximumTasksPerTick: 2,
    maximumCandidatesPerTick: 5
  });
  const policyDocument = documents.externalPullRequestDiscoveryPolicy(policy);
  const scheduleDocument = documents.schedulePolicy(schedulePolicy);
  const run = documents.externalPullRequestDiscoveryRun({
    schemaVersion: "agentlab.external-pull-request-discovery-run.v1",
    runId: TEST_EXTERNAL_PR_RUN_ID,
    repositoryId: "owner/agentlab",
    observerId: "github/pr-reader",
    discoveryPolicyDigest: policyDocument.digest,
    discoveryPolicy: policy,
    schedulePolicyDigest: scheduleDocument.digest,
    schedulePolicy,
    scheduledFor: "2026-09-01T12:00:00.000Z",
    deadlineAt: "2026-09-01T13:00:00.000Z",
    createdAt: "2026-09-01T12:05:00.000Z",
    correlationId: TEST_EXTERNAL_PR_CORRELATION_ID
  });
  return { documents, policy, policyDocument, schedulePolicy, scheduleDocument, run };
}

export function testExternalPullRequestCandidate(
  overrides: Partial<FactoryExternalPullRequestCandidate> = {}
): FactoryExternalPullRequestCandidate {
  return {
    repositoryId: "owner/agentlab",
    pullRequestNumber: 42,
    url: "https://github.com/owner/agentlab/pull/42",
    untrustedTitle: "Fix the parser",
    untrustedBody: "Untrusted contributor text.",
    author: {
      externalId: "github-user/7",
      login: "contributor",
      kind: "human",
      association: "contributor"
    },
    base: { branchName: "main", revision: "a".repeat(40) },
    head: {
      repositoryId: "contributor/agentlab",
      branchName: "fix/parser",
      revision: "b".repeat(40)
    },
    fromFork: true,
    draft: false,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-09-01T11:00:00.000Z",
    totalChangedFiles: 1,
    filesComplete: true,
    changedFiles: [
      {
        path: "packages/runtime/src/parser.ts",
        previousPath: null,
        status: "modified",
        revision: "c".repeat(40),
        additions: 4,
        deletions: 2,
        changes: 6
      }
    ],
    additions: 4,
    deletions: 2,
    changedLines: 6,
    disposition: "agent-review-candidate",
    reasonCodes: ["read-only-agent-review-candidate"],
    ...overrides
  };
}

export function registeredExternalPullRequestEvent(
  fixture: ExternalPullRequestDiscoveryFixture
): CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent> {
  return fixture.documents.externalPullRequestDiscoveryEvent({
    schemaVersion: "agentlab.external-pull-request-discovery-event.v1",
    eventId: "91000000-0000-4000-8000-000000000003",
    runId: fixture.run.value.runId,
    runDigest: fixture.run.digest,
    sequence: 1,
    previousEventDigest: null,
    actor: {
      kind: "control-plane",
      id: fixture.run.value.observerId,
      role: "maintenance-scout",
      sessionId: fixture.run.value.runId
    },
    kind: "registered",
    from: null,
    to: "ready",
    occurredAt: fixture.run.value.createdAt,
    reasonCode: "daily-slot-registered",
    correlationId: fixture.run.value.correlationId
  });
}

export function testExternalPullRequestSnapshot(
  fixture: ExternalPullRequestDiscoveryFixture,
  overrides: Partial<FactoryExternalPullRequestDiscoverySnapshot> = {}
): CanonicalFactoryDocument<FactoryExternalPullRequestDiscoverySnapshot> {
  return fixture.documents.externalPullRequestDiscoverySnapshot({
    schemaVersion: "agentlab.external-pull-request-discovery-snapshot.v1",
    runId: fixture.run.value.runId,
    runDigest: fixture.run.digest,
    repositoryId: fixture.run.value.repositoryId,
    observerId: fixture.run.value.observerId,
    discoveryPolicyDigest: fixture.run.value.discoveryPolicyDigest,
    scheduledFor: fixture.run.value.scheduledFor,
    observedAt: "2026-09-01T12:06:00.000Z",
    hasMore: false,
    pullRequests: [testExternalPullRequestCandidate()],
    counts: {
      agentReviewCandidates: 1,
      humanReviewRequired: 0,
      deferred: 0,
      factoryOwned: 0
    },
    ...overrides
  });
}
