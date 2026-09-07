import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evidenceItemSchema, type EvidenceItem, type FactoryTaskState } from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import { FactoryAutonomousMergeAdmissionService } from "../../packages/runtime/src/application/factory-autonomous-merge-admission-service.js";
import { FactoryAutonomousMergeService } from "../../packages/runtime/src/application/factory-autonomous-merge-service.js";
import { FactoryControlPlane } from "../../packages/runtime/src/application/factory-control-plane.js";
import {
  FactoryEvidenceIngress,
  createFactoryEvidenceCredential
} from "../../packages/runtime/src/application/factory-evidence-ingress.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { storedConversationSchema } from "../../packages/runtime/src/domain/conversation-record.js";
import {
  FactoryPolicyEngine,
  createAutonomousR1FactoryPolicyBundle
} from "../../packages/runtime/src/domain/factory-policy.js";
import type { FactoryPullRequestDispatchSnapshot } from "../../packages/runtime/src/domain/factory-pull-request-dispatch-repository.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import { GitHubAutonomousMerger } from "../../packages/runtime/src/infrastructure/github/github-autonomous-merger.js";
import type { GitHubGraphqlApi } from "../../packages/runtime/src/infrastructure/github/github-graphql-client.js";
import {
  NodeFactoryDocumentCodec,
  encodeCanonicalDocument
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryAutonomousMergeRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-autonomous-merge-repository.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import {
  testFactoryAutonomousMergePolicy,
  TEST_MERGE_HEAD_REVISION
} from "../helpers/factory-autonomous-merge.js";
import { testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import {
  testFactoryContract,
  testDigest,
  testFactoryActor,
  testControlEvent
} from "../helpers/factory.js";

describe("autonomous merge integration", () => {
  it.each([false, true])(
    "admits, queues, restarts, and records a confirmed merge (after expiry: %s)",
    async (afterExpiry) => {
      const fixture = await integrationFixture();
      try {
        const admitted = await fixture.admission.tick(fixture.pins);
        expect(admitted).toMatchObject({ status: "completed", authorized: 1, denied: 0 });
        expect(await fixture.tasks.findById(fixture.taskId)).toMatchObject({
          state: "merge-ready"
        });
        const authorizationDigest = admitted.tasks[0]?.authorizationDigest;
        expect(authorizationDigest).toMatch(/^sha256:/u);

        await expect(fixture.merger().tick(fixture.pins)).resolves.toMatchObject({
          status: "pending",
          pending: 1
        });
        expect(await fixture.tasks.findById(fixture.taskId)).toMatchObject({
          state: "merge-queued"
        });
        const queued = (await fixture.journal.listActive(fixture.query))[0];
        expect(queued).toMatchObject({ state: "enqueued", record: null });
        expect(fixture.mutations).toEqual(["ready", "enqueue"]);

        fixture.restartJournal();
        fixture.confirmMerge(afterExpiry ? "2026-09-01T13:01:00.000Z" : "2026-09-01T12:01:00.000Z");
        if (afterExpiry) {
          const transition = {
            taskId: fixture.taskId,
            expectedState: "merge-queued",
            nextState: "merged",
            actor: {
              kind: "broker",
              role: "merger",
              id: fixture.mergePolicy.value.mergerId,
              sessionId: null
            },
            reasonCode: "test-expired-readback",
            evidenceBundleDigest: (await fixture.tasks.latestEvidence(fixture.taskId))?.digest
          };
          // An authorization alone cannot advance an expired task before remote proof exists.
          await expect(fixture.controlPlane.transition(transition)).rejects.toThrow(/expired/u);
          const interrupted = vi
            .spyOn(fixture.controlPlane, "transition")
            .mockRejectedValueOnce(new Error("simulated ledger interruption"));
          await expect(fixture.merger().tick(fixture.pins)).rejects.toThrow(
            /simulated ledger interruption/u
          );
          interrupted.mockRestore();
          expect((await fixture.journal.listActive(fixture.query))[0]?.state).toBe(
            "merge-evidence-recorded"
          );
          await expect(
            fixture.controlPlane.transition({
              ...transition,
              evidenceBundleDigest: (await fixture.tasks.latestEvidence(fixture.taskId))?.digest,
              actor: { ...transition.actor, id: "github-app/another-merger" }
            })
          ).rejects.toThrow(/expired/u);
          fixture.restartJournal();
        }
        const completed = await fixture.merger().tick(fixture.pins);
        expect(completed).toMatchObject({ status: "completed", completed: 1 });
        const task = await fixture.tasks.findById(fixture.taskId);
        expect(task).toMatchObject({
          state: "merged",
          lastEvent: { actor: { kind: "broker", role: "merger" } }
        });
        const bundles = await fixture.tasks.listEvidence(fixture.taskId);
        const recordItem = bundles
          .flatMap(({ bundle }) => bundle.items)
          .find(
            (item) =>
              item.artifact.mediaType === "application/vnd.agentlab.autonomous-merge-record.v1+json"
          );
        expect(recordItem).toMatchObject({
          result: "pass",
          producer: { kind: "broker", role: "merger", id: fixture.mergePolicy.value.mergerId }
        });
        if (recordItem === undefined) throw new Error("Missing merge evidence.");
        const record = fixture.documents.autonomousMergeRecord(
          JSON.parse(
            await fixture.artifacts.readText(
              recordItem.artifact.digest,
              recordItem.artifact.sizeBytes + 1
            )
          ) as unknown
        );
        expect(record.digest).toBe(recordItem.artifact.digest);
        expect(record.value).toMatchObject({
          authorizationDigest,
          mergeQueueEntryId: "MQE_42",
          mergedRevision: "e".repeat(40)
        });
        expect(task?.lastEvent.evidenceBundleDigest).toBe(bundles.at(-1)?.digest);
        expect(await fixture.journal.listActive(fixture.query)).toEqual([]);
        expect(
          await fixture.journal.countCompletedForUtcDay({
            ...fixture.query,
            windowStart: "2026-09-01T00:00:00.000Z",
            windowEnd: "2026-09-02T00:00:00.000Z"
          })
        ).toBe(1);
        for (const [index, bundle] of bundles.entries()) {
          expect(fixture.documents.evidenceBundle(bundle.bundle).digest).toBe(bundle.digest);
          expect(bundle.bundle.previousBundleDigest).toBe(
            index === 0 ? null : bundles[index - 1]?.digest
          );
        }
        await expect(fixture.merger().tick(fixture.pins)).resolves.toMatchObject({
          status: "idle",
          inspected: 0
        });
        expect(fixture.mutations).toEqual(["ready", "enqueue"]);
        expect(
          fixture.request.mock.calls.some(([query]) => query.includes("mergePullRequest"))
        ).toBe(false);
      } finally {
        fixture.close();
      }
    }
  );
});

async function integrationFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlab-merge-integration-"));
  const path = join(root, "factory.sqlite");
  const documents = new NodeFactoryDocumentCodec();
  const tasks = new SqliteFactoryRepository(path, { documents });
  let journal = new SqliteFactoryAutonomousMergeRepository(path, { documents });
  const artifacts = new FileFactoryArtifactStore(join(root, "artifacts"));
  let now = "2026-09-01T12:00:00.000Z";
  const roleIdentityPolicy = documents.roleIdentityPolicy(
    testFactoryRoleIdentityPolicy({
      keyId: testDigest("a"),
      workerUserId: 2_003,
      attestorUserId: 2_004
    })
  );
  const mergePolicy = documents.autonomousMergePolicy(
    testFactoryAutonomousMergePolicy({ roleIdentityPolicyDigest: roleIdentityPolicy.digest })
  );
  const policyBundle = encodeCanonicalDocument(
    createAutonomousR1FactoryPolicyBundle({
      mergePolicy,
      costPolicy: {
        schemaVersion: "agentlab.cost-policy.v1",
        id: "test/costs",
        version: "1.0.0",
        rules: [
          {
            provider: "codex",
            model: "gpt-5.4",
            accounting: {
              mode: "token-rate",
              inputMicrousdPerMillionTokens: 1_000_000,
              outputMicrousdPerMillionTokens: 2_000_000
            }
          }
        ]
      }
    })
  );
  const policy = new FactoryPolicyEngine(policyBundle.digest, policyBundle.value);
  const contract = documents.taskContract({
    ...testFactoryContract(),
    createdAt: now,
    expiresAt: "2026-09-01T13:00:00.000Z",
    trigger: "scheduled",
    repository: { id: mergePolicy.value.repositoryId, baseRevision: "a".repeat(40) },
    scope: {
      includePaths: ["tests/runtime/example.test.ts"],
      excludePaths: [],
      protectedPaths: []
    },
    gateProfile: {
      id: policyBundle.value.profiles.R1.id,
      version: policyBundle.value.profiles.R1.version,
      policyDigest: policyBundle.digest
    },
    approvals: { ...testFactoryContract().approvals, merge: { mode: "automatic" } }
  });
  const taskId = contract.value.taskId;
  const contractArtifact = await artifacts.putText(contract.json);
  const actor = {
    kind: "control-plane",
    role: "gate-runner",
    id: "agentlab-local-gates",
    sessionId: null
  } as const;
  const genericArtifact = await artifacts.putText(
    "Seeded upstream execution/gate fixture; no live workers are run by this test."
  );
  const item = (
    kind: EvidenceItem["kind"],
    subjectDigest: string,
    overrides: Partial<EvidenceItem> = {}
  ) =>
    evidenceItemSchema.parse({
      id: randomUUID(),
      kind,
      result: "pass",
      subjectDigest,
      artifact: { ...genericArtifact, mediaType: "text/plain" },
      producer: actor,
      createdAt: now,
      claims: [],
      ...overrides
    });
  let previous = documents.taskEvent({
    schemaVersion: "agentlab.task-event.v1",
    eventId: randomUUID(),
    taskId,
    sequence: 1,
    contractDigest: contract.digest,
    previousEventDigest: null,
    from: null,
    to: "intake",
    actor: testFactoryActor,
    occurredAt: now,
    reasonCode: "test-seeded-intake",
    summary: null,
    evidenceBundleDigest: null,
    correlationId: randomUUID()
  });
  const initial = documents.evidenceBundle({
    schemaVersion: "agentlab.evidence-bundle.v1",
    bundleId: randomUUID(),
    taskId,
    sequence: 1,
    contractDigest: contract.digest,
    previousBundleDigest: null,
    policyBundleDigest: policyBundle.digest,
    createdAt: now,
    items: [
      item("contract", contract.digest, {
        artifact: {
          ...contractArtifact,
          mediaType: "application/vnd.agentlab.task-contract.v1+json"
        }
      })
    ],
    attestations: []
  });
  await artifacts.putText(initial.json);
  await tasks.create(contract, previous, initial);
  // Seed only the upstream boundary. Admission, merge policy, transitions, journal, and evidence
  // publication below are real implementations. Worker execution and live canary promotion have
  // their own integration suites and are not claimed by this test.
  for (const state of [
    "qualified",
    "specified",
    "planned",
    "queued",
    "executing",
    "verifying",
    "reviewing",
    "pr-proposed",
    "pr-open"
  ] as const satisfies readonly FactoryTaskState[]) {
    previous = documents.taskEvent({
      ...previous.value,
      eventId: randomUUID(),
      sequence: previous.value.sequence + 1,
      previousEventDigest: previous.digest,
      from: previous.value.to,
      to: state
    });
    await tasks.append(previous);
  }
  for (const control of ["scheduler", "pr-broker", "merge-broker"] as const) {
    await tasks.record(
      documents.controlEvent(testControlEvent({ eventId: randomUUID(), control, enabled: true }))
    );
  }
  const patchArtifact = await artifacts.putText(
    "diff --git a/tests/runtime/example.test.ts b/tests/runtime/example.test.ts\n"
  );
  const executionId = randomUUID();
  const changeSet = {
    baseRevision: contract.value.repository.baseRevision,
    headRevision: TEST_MERGE_HEAD_REVISION,
    changedPaths: ["tests/runtime/example.test.ts"],
    binaryPaths: [],
    changedFiles: 1,
    changedLines: 1
  };
  const patch = documents.patchProposal({
    schemaVersion: "agentlab.patch-proposal.v1",
    taskId,
    contractDigest: contract.digest,
    executionId,
    baseRevision: changeSet.baseRevision,
    changeSet,
    patchArtifact: { ...patchArtifact, mediaType: "text/x-diff; charset=utf-8" },
    createdAt: now
  });
  const usage = documents.taskUsage({
    schemaVersion: "agentlab.task-usage-record.v1",
    taskId,
    contractDigest: contract.digest,
    patchProposalDigest: patch.digest,
    usage: {
      wallClockSeconds: 1,
      agentTurns: 1,
      toolCalls: 1,
      inputTokens: 1,
      outputTokens: 1,
      costMicrousd: 1,
      processes: 1,
      outputBytes: 1,
      workers: 1,
      repairAttempts: 0,
      changedFiles: 1,
      changedLines: 1
    },
    complete: true,
    calculatedAt: now
  });
  const documentItem = async <Value>(
    document: CanonicalFactoryDocument<Value>,
    kind: EvidenceItem["kind"],
    subject: string,
    mediaType: string,
    claims: EvidenceItem["claims"]
  ) =>
    item(kind, subject, {
      artifact: { ...(await artifacts.putText(document.json)), mediaType },
      claims
    });
  const upstream = [
    await documentItem(
      patch,
      "patch",
      patch.digest,
      "application/vnd.agentlab.patch-proposal.v1+json",
      [
        { name: "execution-id", value: executionId },
        { name: "patch-digest", value: patchArtifact.digest },
        { name: "base-revision", value: changeSet.baseRevision }
      ]
    ),
    await documentItem(
      usage,
      "usage",
      patch.digest,
      "application/vnd.agentlab.task-usage-record.v1+json",
      [
        { name: "usage-complete", value: "true" },
        { name: "patch-proposal-digest", value: patch.digest }
      ]
    ),
    item("execution", contract.digest, {
      producer: {
        kind: "agent",
        role: "implementer",
        id: "test/implementer",
        sessionId: "implementer-session"
      },
      claims: [
        { name: "execution-id", value: executionId },
        { name: "isolation-id", value: executionId }
      ]
    }),
    item("review", patch.digest, {
      producer: {
        kind: "agent",
        role: "reviewer",
        id: "test/reviewer",
        sessionId: "reviewer-session"
      }
    }),
    item("provenance", contract.digest, {
      producer: {
        kind: "ci",
        role: "gate-runner",
        id: "agentlab-resource-isolator",
        sessionId: null
      },
      claims: [
        { name: "execution-id", value: executionId },
        { name: "isolation-id", value: executionId },
        { name: "policy-bundle-digest", value: policyBundle.digest },
        { name: "isolation-mechanism", value: "linux/systemd-user-scope" }
      ]
    })
  ];
  for (const kind of policy.requirements("R1", "merge").evidenceKinds) {
    if (["patch", "usage", "execution", "review", "contract"].includes(kind)) continue;
    upstream.push(
      item(
        kind,
        kind === "policy" ? policyBundle.digest : kind === "skill" ? contract.digest : patch.digest
      )
    );
  }
  for (const gateId of policy.requirements("R1", "merge").gateIds) {
    upstream.push(
      item("test", gateId.endsWith("validation") ? contract.digest : patch.digest, {
        claims: [{ name: "gate-id", value: gateId }]
      })
    );
  }
  const proposal = documents.pullRequestProposal({
    schemaVersion: "agentlab.pull-request-proposal.v1",
    taskId,
    contractDigest: contract.digest,
    patchProposalDigest: patch.digest,
    patchArtifactDigest: patchArtifact.digest,
    changeSet,
    policyEvaluationDigest: testDigest("1"),
    deduplicationKey: testDigest("2"),
    repositoryId: mergePolicy.value.repositoryId,
    baseRevision: changeSet.baseRevision,
    baseBranch: "main",
    branchName: `agentlab/${"d".repeat(64)}`,
    title: "Fixture change",
    body: "Seeded PR for admission integration.",
    draft: true,
    createdAt: now
  });
  const record = documents.pullRequestRecord({
    schemaVersion: "agentlab.pull-request-record.v1",
    taskId,
    contractDigest: contract.digest,
    proposalDigest: proposal.digest,
    repositoryId: mergePolicy.value.repositoryId,
    number: 42,
    url: "https://github.com/RiadMefti/agentlab/pull/42",
    baseRevision: changeSet.baseRevision,
    headRevision: TEST_MERGE_HEAD_REVISION,
    branchName: proposal.value.branchName,
    draft: true,
    brokerId: "github-app/agentlab-broker",
    createdAt: now
  });
  const observation = documents.pullRequestObservation({
    schemaVersion: "agentlab.pull-request-observation.v1",
    taskId,
    contractDigest: contract.digest,
    proposalDigest: proposal.digest,
    pullRequestRecordDigest: record.digest,
    repositoryId: record.value.repositoryId,
    pullRequestNumber: 42,
    url: record.value.url,
    brokerId: record.value.brokerId,
    authorizedBaseRevision: changeSet.baseRevision,
    recordedHeadRevision: TEST_MERGE_HEAD_REVISION,
    remoteBaseRevision: changeSet.baseRevision,
    remoteHeadRevision: TEST_MERGE_HEAD_REVISION,
    branchName: record.value.branchName,
    state: "open",
    draft: true,
    merged: false,
    trustedChecks: mergePolicy.value.requiredStatusChecks.map(({ context, producerId }, index) => ({
      name: context,
      producerId,
      status: "completed",
      runId: String(index + 1),
      conclusion: "success",
      url: `${record.value.url}/checks`,
      startedAt: now,
      completedAt: now
    })),
    reviews: [
      {
        reviewId: "1",
        author: {
          externalId: "github-user/77",
          login: "reviewer",
          kind: "human",
          association: "member"
        },
        decision: "approved",
        headRevision: TEST_MERGE_HEAD_REVISION,
        untrustedBody: "",
        submittedAt: now,
        url: record.value.url
      }
    ],
    reviewComments: [],
    conversationComments: [],
    observedAt: now
  });
  upstream.push({
    ...(await documentItem(
      observation,
      "pull-request",
      observation.digest,
      "application/vnd.agentlab.pull-request-observation.v1+json",
      [{ name: "disposition", value: "clear" }]
    )),
    producer: { kind: "broker", role: "pr-broker", id: record.value.brokerId, sessionId: null }
  });
  const seeded = documents.evidenceBundle({
    ...initial.value,
    bundleId: randomUUID(),
    sequence: 2,
    previousBundleDigest: initial.digest,
    items: upstream
  });
  await artifacts.putText(seeded.json);
  await tasks.appendEvidence(seeded);
  const controlPlaneCredential = createFactoryEvidenceCredential();
  const mergerCredential = createFactoryEvidenceCredential();
  const evidenceIngress = new FactoryEvidenceIngress({
    tasks,
    evidence: tasks,
    artifacts,
    documents,
    policyBundleDigest: policyBundle.digest,
    bindings: [
      { credential: controlPlaneCredential, channel: "control-plane" },
      {
        credential: mergerCredential,
        channel: "merge-broker",
        producerId: mergePolicy.value.mergerId
      }
    ],
    now: () => now,
    createId: randomUUID
  });
  const controlPlane = new FactoryControlPlane({
    tasks,
    evidence: tasks,
    controls: tasks,
    artifacts,
    documents,
    policy,
    policyBundle,
    evidenceIngress,
    evidenceCredential: controlPlaneCredential,
    now: () => now,
    createId: randomUUID,
    conversations: {
      findById: () =>
        Promise.resolve(
          storedConversationSchema.parse({
            id: contract.value.conversationId,
            title: "Integration",
            workspacePath: root,
            provider: "codex",
            model: null,
            reasoning: null,
            captainSessionName: "integration-captain",
            createdAt: now,
            updatedAt: now,
            lifecycleState: "active",
            ownershipMode: "legacy-name",
            ownershipNonce: null
          })
        )
    }
  });
  const dispatchRun = documents.pullRequestDispatchRun({
    schemaVersion: "agentlab.pull-request-dispatch.v1",
    dispatchId: randomUUID(),
    taskId,
    contractDigest: contract.digest,
    proposalDigest: proposal.digest,
    proposal: proposal.value,
    brokerId: record.value.brokerId,
    createdAt: now,
    correlationId: randomUUID()
  });
  const dispatchEvent = documents.pullRequestDispatchEvent({
    schemaVersion: "agentlab.pull-request-dispatch-event.v1",
    eventId: randomUUID(),
    dispatchId: dispatchRun.value.dispatchId,
    dispatchDigest: dispatchRun.digest,
    taskId,
    contractDigest: contract.digest,
    sequence: 5,
    previousEventDigest: testDigest("3"),
    actor: { kind: "broker", role: "pr-broker", id: record.value.brokerId, sessionId: null },
    occurredAt: now,
    reasonCode: "test-dispatch-completed",
    summary: null,
    correlationId: dispatchRun.value.correlationId,
    kind: "task-recorded",
    from: "evidence-recorded",
    to: "completed",
    taskEventDigest: previous.digest
  });
  let dispatch: FactoryPullRequestDispatchSnapshot = {
    run: dispatchRun.value,
    runDigest: dispatchRun.digest,
    state: "completed",
    sequence: 5,
    lastEvent: dispatchEvent.value,
    lastEventDigest: dispatchEvent.digest,
    record: record.value,
    evidenceBundleDigest: seeded.digest,
    taskEventDigest: previous.digest
  };
  const reservation = documents.canaryTaskReservation({
    schemaVersion: "agentlab.canary-task-reservation.v1",
    reservationId: randomUUID(),
    cohortId: randomUUID(),
    cohortDigest: testDigest("1"),
    approvalDigest: testDigest("2"),
    assessmentDigest: testDigest("3"),
    attestationDigest: testDigest("4"),
    roleIdentityPolicyDigest: roleIdentityPolicy.digest,
    challengerCandidateDigest: testDigest("5"),
    schedulePolicyDigest: mergePolicy.value.schedulePolicyDigest,
    policyBundleDigest: policyBundle.digest,
    stage: "brokered-draft-pr",
    repository: contract.value.repository,
    taskId,
    requestDigest: testDigest("6"),
    preparationAuthorityDigest: testDigest("7"),
    maximumRiskTier: "R1",
    budget: contract.value.budget,
    reservedAt: now,
    expiresAt: contract.value.expiresAt,
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab-canary-admission",
      sessionId: null
    },
    autoMerge: false,
    release: false
  });
  const admission = new FactoryAutonomousMergeAdmissionService({
    mergePolicy,
    policyBundle,
    schedulePolicyDigest: mergePolicy.value.schedulePolicyDigest,
    dailyQuotaPolicyDigest: mergePolicy.value.dailyQuotaPolicyDigest,
    roleIdentityPolicy,
    dispatches: { findByTaskId: () => Promise.resolve(dispatch) },
    updates: { listByTaskId: () => Promise.resolve([]) },
    tasks,
    evidence: tasks,
    controls: tasks,
    controlPlane,
    canaryAuthority: {
      requireReservation: (_task, command) => {
        expect(command?.reservationDigest).toBe(reservation.digest);
        return Promise.resolve(reservation);
      }
    },
    evidenceIngress,
    evidenceCredentials: { controlPlane: controlPlaneCredential },
    artifacts,
    documents,
    now: () => now,
    createId: randomUUID
  });
  // tick discovers the reservation from the immutable v2 dispatch coordinates.
  const scheduledDispatchRun = documents.pullRequestDispatchRun({
    ...dispatchRun.value,
    schemaVersion: "agentlab.pull-request-dispatch.v2",
    canaryReservationDigest: reservation.digest,
    schedulePolicyDigest: mergePolicy.value.schedulePolicyDigest,
    roleIdentityPolicyDigest: roleIdentityPolicy.digest
  });
  const scheduledDispatchEvent = documents.pullRequestDispatchEvent({
    ...dispatchEvent.value,
    dispatchDigest: scheduledDispatchRun.digest
  });
  dispatch = {
    ...dispatch,
    run: scheduledDispatchRun.value,
    runDigest: scheduledDispatchRun.digest,
    lastEvent: scheduledDispatchEvent.value,
    lastEventDigest: scheduledDispatchEvent.digest
  };
  let draft = true;
  let queued = false;
  let merged = false;
  const mutations: string[] = [];
  const pullRequest = () => ({
    id: "PR_42",
    number: 42,
    url: record.value.url,
    state: merged ? "MERGED" : "OPEN",
    isDraft: draft,
    merged,
    mergedAt: merged ? now : null,
    baseRefOid: changeSet.baseRevision,
    headRefOid: TEST_MERGE_HEAD_REVISION,
    mergeCommit: merged ? { oid: "e".repeat(40) } : null,
    mergeQueueEntry: queued ? { id: "MQE_42" } : null
  });
  const request = vi.fn<GitHubGraphqlApi["request"]>((query) => {
    if (query.includes("markPullRequestReadyForReview")) {
      mutations.push("ready");
      draft = false;
      return Promise.resolve({
        data: { markPullRequestReadyForReview: { pullRequest: pullRequest() } }
      });
    }
    if (query.includes("enqueuePullRequest")) {
      mutations.push("enqueue");
      queued = true;
      return Promise.resolve({
        data: { enqueuePullRequest: { mergeQueueEntry: { id: "MQE_42" } } }
      });
    }
    return Promise.resolve({ data: { repository: { pullRequest: pullRequest() } } });
  });
  const remote = new GitHubAutonomousMerger({
    repositoryId: mergePolicy.value.repositoryId,
    mergerId: mergePolicy.value.mergerId,
    api: { request }
  });
  const pins = {
    expectedMergePolicyDigest: mergePolicy.digest,
    expectedFactoryPolicyBundleDigest: policyBundle.digest,
    expectedSchedulePolicyDigest: mergePolicy.value.schedulePolicyDigest,
    expectedDailyQuotaPolicyDigest: mergePolicy.value.dailyQuotaPolicyDigest,
    expectedRoleIdentityPolicyDigest: roleIdentityPolicy.digest
  };
  return {
    admission,
    controlPlane,
    tasks,
    taskId,
    documents,
    artifacts,
    mergePolicy,
    pins,
    mutations,
    request,
    get journal() {
      return journal;
    },
    query: {
      repositoryId: mergePolicy.value.repositoryId,
      mergePolicyDigest: mergePolicy.digest,
      limit: 10
    },
    merger: () =>
      new FactoryAutonomousMergeService({
        mergePolicy,
        factoryPolicyBundleDigest: policyBundle.digest,
        repository: journal,
        tasks,
        evidence: tasks,
        controls: tasks,
        controlPlane,
        evidenceIngress,
        evidenceCredentials: { merger: mergerCredential },
        artifacts,
        documents,
        remote,
        now: () => now,
        createId: randomUUID
      }),
    confirmMerge: (at: string) => {
      now = at;
      merged = true;
    },
    restartJournal: () => {
      journal.close();
      journal = new SqliteFactoryAutonomousMergeRepository(path, { documents });
    },
    close: () => {
      journal.close();
      tasks.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
