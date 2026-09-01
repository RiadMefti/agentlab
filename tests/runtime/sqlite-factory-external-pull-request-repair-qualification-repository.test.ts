import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  FactoryExternalPullRequestRepairExecutionEvent,
  FactoryExternalPullRequestRepairExecutionRun,
  FactoryExternalPullRequestRepairQualificationEvent,
  FactoryExternalPullRequestRepairQualificationRun,
  FactoryExternalPullRequestReplacementDraftEvent,
  FactoryExternalPullRequestReplacementDraftRun,
  FactoryGateObservation,
  FactoryResourceIsolationRecord,
  Sha256Digest
} from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { SqliteFactoryExternalPullRequestRepairAdmissionRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-repair-admission-repository.js";
import { SqliteFactoryExternalPullRequestRepairExecutionRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-repair-execution-repository.js";
import { SqliteFactoryExternalPullRequestRepairQualificationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-repair-qualification-repository.js";
import { SqliteFactoryExternalPullRequestReplacementDraftRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-replacement-draft-repository.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { testDigest } from "../helpers/factory.js";
import { registeredExternalPullRequestRepairExecutionEvent } from "../helpers/factory-external-pull-request-repair-execution.js";
import {
  externalPullRequestRepairQualificationRun,
  registeredExternalPullRequestRepairQualificationEvent,
  testExternalPullRequestRepairQualificationFixture,
  type ExternalPullRequestRepairQualificationFixture
} from "../helpers/factory-external-pull-request-repair-qualification.js";
import { seedCompletedExternalPullRequestFeedback } from "./sqlite-factory-external-pull-request-repair-admission-repository.test.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type ExecutionPayload<
  Event extends FactoryExternalPullRequestRepairExecutionEvent =
    FactoryExternalPullRequestRepairExecutionEvent
> = Event extends FactoryExternalPullRequestRepairExecutionEvent
  ? Omit<
      Event,
      | "schemaVersion"
      | "eventId"
      | "repairRunId"
      | "runDigest"
      | "sequence"
      | "previousEventDigest"
      | "actor"
      | "occurredAt"
      | "correlationId"
    >
  : never;

type QualificationPayload<
  Event extends FactoryExternalPullRequestRepairQualificationEvent =
    FactoryExternalPullRequestRepairQualificationEvent
> = Event extends FactoryExternalPullRequestRepairQualificationEvent
  ? Omit<
      Event,
      | "schemaVersion"
      | "eventId"
      | "qualificationRunId"
      | "runDigest"
      | "sequence"
      | "previousEventDigest"
      | "actor"
      | "occurredAt"
      | "correlationId"
    >
  : never;

type PublicationPayload<
  Event extends FactoryExternalPullRequestReplacementDraftEvent =
    FactoryExternalPullRequestReplacementDraftEvent
> = Event extends FactoryExternalPullRequestReplacementDraftEvent
  ? Omit<
      Event,
      | "schemaVersion"
      | "eventId"
      | "publicationRunId"
      | "runDigest"
      | "sequence"
      | "previousEventDigest"
      | "actor"
      | "occurredAt"
      | "correlationId"
    >
  : never;

describe("SqliteFactoryExternalPullRequestRepairQualificationRepository", () => {
  it("roots strict gate and independent-review evidence in one immutable completed repair", async () => {
    const fixture = testExternalPullRequestRepairQualificationFixture();
    const databasePath = temporaryDatabase();
    await seedCompletedRepair(databasePath, fixture);
    const repository = new SqliteFactoryExternalPullRequestRepairQualificationRepository(
      databasePath,
      { documents: fixture.documents }
    );
    const run = externalPullRequestRepairQualificationRun(fixture);
    const registered = registeredExternalPullRequestRepairQualificationEvent(fixture, run);
    try {
      await expect(
        repository.listCompletedRepairs({
          repositoryId: fixture.policy.repositoryId,
          repairExecutionPolicyDigest: fixture.execution.executionPolicyDocument.digest,
          qualificationPolicyDigest: fixture.policyDocument.digest,
          limit: 5
        })
      ).resolves.toHaveLength(1);
      await expect(
        repository.register(
          fixture.policyDocument,
          run,
          registered,
          fixture.candidate,
          fixture.repairerRecord
        )
      ).resolves.toMatchObject({ state: "ready", sequence: 1 });

      let previous = registered;
      previous = await append(
        repository,
        qualificationEvent(fixture, run, 2, previous.digest, {
          kind: "workspace-started",
          from: "ready",
          to: "workspace-active",
          reasonCode: "exact-repaired-head-workspace-started"
        })
      );
      previous = await append(
        repository,
        qualificationEvent(fixture, run, 3, previous.digest, {
          kind: "workspace-prepared",
          from: "workspace-active",
          to: "gating",
          patchDigest: fixture.repairBundle.value.patchArtifact.digest,
          patchArtifact: fixture.repairBundle.value.patchArtifact,
          reasonCode: "exact-repaired-patch-materialized"
        })
      );

      const gateObservations: FactoryGateObservation[] = [];
      const gateIsolationRecords: FactoryResourceIsolationRecord[] = [];
      let sequence = 4;
      for (const [index, gate] of fixture.policy.gateProfile.gates.entries()) {
        const isolationId = `96000000-0000-4000-8000-${String(index + 30).padStart(12, "0")}`;
        const started = qualificationEvent(fixture, run, sequence, previous.digest, {
          kind: "gate-started",
          from: "gating",
          to: "gate-active",
          gateId: gate.id,
          isolationId,
          reasonCode: "strict-repair-qualification-gate-started"
        });
        previous = await append(repository, started);
        sequence += 1;
        const observation = fixture.documents.gateObservation({
          schemaVersion: "agentlab.gate-observation.v1",
          gateId: gate.id,
          taskId: run.value.qualificationRunId,
          contractDigest: run.digest,
          baseRevision: run.value.expectedHeadRevision,
          result: "pass",
          command: { executable: gate.command.executable, args: gate.command.args },
          startedAt: "2026-09-01T12:31:00.000Z",
          finishedAt: "2026-09-01T12:31:01.000Z",
          exitCode: 0,
          stdoutArtifact: artifact(testDigest("a"), "text/plain; charset=utf-8", 2),
          stderrArtifact: artifact(testDigest("b"), "text/plain; charset=utf-8", 0)
        });
        const isolationRecord = fixture.documents.resourceIsolation({
          schemaVersion: "agentlab.resource-isolation-record.v1",
          taskId: run.value.qualificationRunId,
          contractDigest: run.digest,
          policyBundleDigest: run.value.gateProfileDigest,
          subjectDigest: run.value.repairBundleDigest,
          attempt: index + 1,
          execution: { kind: "gate", gateId: gate.id },
          isolation: isolation(isolationId),
          result: "enforced",
          observedAt: "2026-09-01T12:31:01.000Z"
        });
        const finished = qualificationEvent(fixture, run, sequence, previous.digest, {
          kind: "gate-finished",
          from: "gate-active",
          to: "gating",
          gateId: gate.id,
          isolationId,
          gateObservationDigest: observation.digest,
          isolationRecordDigest: isolationRecord.digest,
          reasonCode: "strict-repair-qualification-gate-finished"
        });
        previous = await append(repository, finished);
        sequence += 1;
        gateObservations.push(observation.value);
        gateIsolationRecords.push(isolationRecord.value);
      }
      previous = await append(
        repository,
        qualificationEvent(fixture, run, sequence, previous.digest, {
          kind: "gates-passed",
          from: "gating",
          to: "reviewing",
          reasonCode: "strict-repair-qualification-gates-passed"
        })
      );
      sequence += 1;

      const reviewer = fixture.policy.reviewerProfiles[0];
      if (reviewer === undefined) throw new Error("Missing reviewer fixture.");
      const executionId = "96000000-0000-4000-8000-000000000050";
      const requestDigest = testDigest("c");
      previous = await append(
        repository,
        qualificationEvent(fixture, run, sequence, previous.digest, {
          kind: "reviewer-started",
          from: "reviewing",
          to: "reviewer-active",
          reviewerId: reviewer.id,
          executionId,
          requestDigest,
          reasonCode: "post-repair-independent-reviewer-started"
        })
      );
      sequence += 1;
      const record = fixture.documents.externalPullRequestReviewerRecord({
        schemaVersion: "agentlab.external-pull-request-reviewer-record.v1",
        reviewRunId: run.value.qualificationRunId,
        runDigest: run.digest,
        requestDigest,
        executionId,
        reviewerId: reviewer.id,
        provider: reviewer.provider,
        providerVersion: "codex 1",
        harnessVersion: "agentlab-test-harness/1",
        model: reviewer.model,
        reasoning: reviewer.reasoning,
        providerSessionId: "independent-qualification-review-session",
        status: "succeeded",
        startedAt: "2026-09-01T12:32:00.000Z",
        finishedAt: "2026-09-01T12:32:10.000Z",
        exitCode: 0,
        stdoutArtifact: artifact(testDigest("d"), "application/x-ndjson", 2),
        stderrArtifact: artifact(testDigest("e"), "text/plain; charset=utf-8", 0),
        finalOutputArtifact: artifact(testDigest("f"), "application/json; charset=utf-8", 42),
        usage: reviewUsage(),
        usageComplete: true,
        errorCode: null,
        isolation: isolation(executionId)
      });
      const result = fixture.documents.externalPullRequestReviewResult({
        schemaVersion: "agentlab.external-pull-request-review-result.v1",
        reviewRunId: run.value.qualificationRunId,
        runDigest: run.digest,
        candidateDigest: run.value.repairBundleDigest,
        patchDigest: run.value.repairedPatchDigest,
        reviewerId: reviewer.id,
        requestDigest,
        reviewerRecordDigest: record.digest,
        executionId,
        verdict: "approved",
        summary: "The repaired patch resolves the selected findings.",
        findings: [],
        createdAt: "2026-09-01T12:32:10.000Z"
      });
      previous = await append(
        repository,
        qualificationEvent(fixture, run, sequence, previous.digest, {
          kind: "reviewer-finished",
          from: "reviewer-active",
          to: "reviewing",
          reviewerId: reviewer.id,
          executionId,
          requestDigest,
          reviewerRecordDigest: record.digest,
          reviewResultDigest: result.digest,
          reasonCode: "post-repair-independent-reviewer-finished"
        })
      );
      sequence += 1;

      const bundle = fixture.documents.externalPullRequestRepairQualificationBundle({
        schemaVersion: "agentlab.external-pull-request-repair-qualification-bundle.v1",
        qualificationRunId: run.value.qualificationRunId,
        runDigest: run.digest,
        repositoryId: run.value.repositoryId,
        pullRequestNumber: run.value.pullRequestNumber,
        repairRunDigest: run.value.repairRunDigest,
        repairBundleDigest: run.value.repairBundleDigest,
        qualificationPolicyDigest: run.value.qualificationPolicyDigest,
        gateProfileDigest: run.value.gateProfileDigest,
        repairedPatchArtifact: fixture.repairBundle.value.patchArtifact,
        changeSet: fixture.repairBundle.value.changeSet,
        gateObservations,
        gateIsolationRecords,
        reviewerRecords: [record.value],
        reviews: [result.value],
        decision: "qualified",
        aggregateUsage: qualificationUsage(),
        usageComplete: true,
        workspaceUnchanged: true,
        workspaceClosed: true,
        publicationMode: "replacement-draft",
        remoteWrite: false,
        autoMerge: false,
        release: false,
        createdAt: "2026-09-01T12:33:00.000Z"
      });
      const recorded = qualificationEvent(fixture, run, sequence, previous.digest, {
        kind: "bundle-recorded",
        from: "reviewing",
        to: "recorded",
        bundleDigest: bundle.digest,
        bundleArtifact: artifact(
          bundle.digest,
          "application/vnd.agentlab.external-pull-request-repair-qualification-bundle+json;version=1",
          new TextEncoder().encode(bundle.json).byteLength
        ),
        decision: "qualified",
        reasonCode: "external-repair-qualification-evidence-recorded"
      });
      await expect(repository.recordBundle(recorded, bundle)).resolves.toMatchObject({
        state: "recorded",
        bundle: { decision: "qualified", workspaceClosed: true }
      });
      sequence += 1;
      const completed = qualificationEvent(fixture, run, sequence, recorded.digest, {
        kind: "completed",
        from: "recorded",
        to: "completed",
        bundleDigest: bundle.digest,
        decision: "qualified",
        reasonCode: "external-repair-qualification-completed"
      });
      await expect(repository.append(completed)).resolves.toMatchObject({
        state: "completed",
        bundle: { decision: "qualified" }
      });
      await expect(
        repository.listCompletedRepairs({
          repositoryId: fixture.policy.repositoryId,
          repairExecutionPolicyDigest: fixture.execution.executionPolicyDocument.digest,
          qualificationPolicyDigest: fixture.policyDocument.digest,
          limit: 5
        })
      ).resolves.toEqual([]);
    } finally {
      repository.close();
    }

    const publications = new SqliteFactoryExternalPullRequestReplacementDraftRepository(
      databasePath,
      { documents: fixture.documents }
    );
    try {
      const candidates = await publications.listQualified({
        repositoryId: fixture.policy.repositoryId,
        qualificationPolicyDigest: fixture.policyDocument.digest,
        publicationPolicyDigest: testDigest("1"),
        limit: 5
      });
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      if (candidate === undefined) throw new Error("Missing qualified publication candidate.");
      const policy = fixture.documents.externalPullRequestReplacementDraftPolicy({
        schemaVersion: "agentlab.external-pull-request-replacement-draft-policy.v1",
        id: "agentlab/external-pull-request-replacement-draft",
        version: "1.0.0",
        repositoryId: fixture.policy.repositoryId,
        brokerId: "github-app/external-repair",
        publisherId: "github-user/77",
        brokerUserId: 1003,
        qualificationPolicyDigest: fixture.policyDocument.digest,
        roleIdentityPolicyDigest: fixture.policy.roleIdentityPolicyDigest,
        branchPrefix: "agentlab/external-repair",
        requiredStatusChecks: ["verify", "factory-sandbox"],
        maximumPatchBytes: fixture.policy.maximumPatchBytes,
        maximumCandidatesPerTick: 3,
        operationDeadlineSeconds: 900,
        maximumRiskTier: "R1",
        draft: true,
        contributorBranchWrite: false,
        forcePush: false,
        approval: false,
        autoMerge: false,
        release: false
      });
      const publicationRun = fixture.documents.externalPullRequestReplacementDraftRun({
        schemaVersion: "agentlab.external-pull-request-replacement-draft-run.v1",
        publicationRunId: "97000000-0000-4000-8000-000000000001",
        repositoryId: candidate.qualificationBundle.value.repositoryId,
        originalPullRequestNumber: candidate.qualificationBundle.value.pullRequestNumber,
        qualificationRunId: candidate.qualificationRun.value.qualificationRunId,
        qualificationRunDigest: candidate.qualificationRun.digest,
        qualificationBundleDigest: candidate.qualificationBundle.digest,
        repairBundleDigest: candidate.repairBundle.digest,
        publicationPolicyDigest: policy.digest,
        publicationPolicy: policy.value,
        qualificationPolicyDigest: candidate.qualificationBundle.value.qualificationPolicyDigest,
        expectedBaseRevision: candidate.qualificationRun.value.expectedBaseRevision,
        expectedHeadRevision: candidate.qualificationRun.value.expectedHeadRevision,
        repairedPatchDigest: candidate.qualificationBundle.value.repairedPatchArtifact.digest,
        changeSet: candidate.qualificationBundle.value.changeSet,
        createdAt: "2026-09-01T13:00:00.000Z",
        deadlineAt: "2026-09-01T13:15:00.000Z",
        correlationId: "97000000-0000-4000-8000-000000000002"
      });
      const registered = publicationEvent(fixture, publicationRun, 1, null, {
        kind: "registered",
        from: null,
        to: "ready",
        reasonCode: "qualified-repair-selected"
      });
      await expect(
        publications.register(policy, publicationRun, registered, candidate)
      ).resolves.toMatchObject({ state: "ready" });
      const proposalDigest = testDigest("2");
      const intent = publicationEvent(fixture, publicationRun, 2, registered.digest, {
        kind: "branch-publish-intent-recorded",
        from: "ready",
        to: "branch-publish-intent-recorded",
        proposalDigest,
        proposalArtifact: artifact(proposalDigest, "application/json", 512),
        reasonCode: "durable-branch-publish-intent"
      });
      await publications.append(intent);
      const headRevision = "e".repeat(40);
      const published = publicationEvent(fixture, publicationRun, 3, intent.digest, {
        kind: "branch-published",
        from: "branch-publish-intent-recorded",
        to: "branch-published",
        proposalDigest,
        headRevision,
        reasonCode: "replacement-branch-created"
      });
      await publications.append(published);
      const pullRequestIntent = publicationEvent(fixture, publicationRun, 4, published.digest, {
        kind: "pull-request-open-intent-recorded",
        from: "branch-published",
        to: "pull-request-open-intent-recorded",
        proposalDigest,
        headRevision,
        reasonCode: "durable-draft-open-intent"
      });
      await publications.append(pullRequestIntent);
      const record = fixture.documents.externalPullRequestReplacementDraftRecord({
        schemaVersion: "agentlab.external-pull-request-replacement-draft-record.v1",
        publicationRunId: publicationRun.value.publicationRunId,
        runDigest: publicationRun.digest,
        proposalDigest,
        qualificationBundleDigest: candidate.qualificationBundle.digest,
        repositoryId: publicationRun.value.repositoryId,
        originalPullRequestNumber: publicationRun.value.originalPullRequestNumber,
        originalPullRequestUrl: "https://github.com/riadmefti/agentlab/pull/42",
        replacementPullRequestNumber: 99,
        replacementPullRequestUrl: "https://github.com/riadmefti/agentlab/pull/99",
        baseBranch: "main",
        baseRevision: publicationRun.value.expectedBaseRevision,
        branchName: `agentlab/external-repair/pr-42-${candidate.qualificationBundle.digest.slice(7, 23)}`,
        headRevision,
        brokerId: policy.value.brokerId,
        publisherId: policy.value.publisherId,
        draft: true,
        createdAt: "2026-09-01T13:00:01.000Z"
      });
      const opened = publicationEvent(fixture, publicationRun, 5, pullRequestIntent.digest, {
        kind: "pull-request-opened",
        from: "pull-request-open-intent-recorded",
        to: "pull-request-opened",
        recordDigest: record.digest,
        recordArtifact: artifact(record.digest, "application/json", 512),
        reasonCode: "replacement-draft-created"
      });
      await expect(publications.record(opened, record)).resolves.toMatchObject({
        state: "pull-request-opened",
        record: { replacementPullRequestNumber: 99 }
      });
      const completed = publicationEvent(fixture, publicationRun, 6, opened.digest, {
        kind: "completed",
        from: "pull-request-opened",
        to: "completed",
        recordDigest: record.digest,
        reasonCode: "replacement-draft-verified"
      });
      await expect(publications.append(completed)).resolves.toMatchObject({ state: "completed" });
      await expect(
        publications.listQualified({
          repositoryId: fixture.policy.repositoryId,
          qualificationPolicyDigest: fixture.policyDocument.digest,
          publicationPolicyDigest: policy.digest,
          limit: 5
        })
      ).resolves.toEqual([]);
    } finally {
      publications.close();
    }

    const database = new DatabaseSync(databasePath);
    try {
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      ).toBe(latestSchemaVersion);
      expect(() =>
        database
          .prepare(
            "UPDATE factory_external_pr_repair_qualification_runs SET qualification_run_id = qualification_run_id"
          )
          .run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_external_pr_repair_qualification_events").run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_external_pr_repair_qualification_bundles").run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_external_pr_replacement_draft_events").run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_external_pr_replacement_draft_records").run()
      ).toThrow(/immutable/u);
    } finally {
      database.close();
    }
  });
});

async function seedCompletedRepair(
  databasePath: string,
  fixture: ExternalPullRequestRepairQualificationFixture
): Promise<void> {
  await seedCompletedExternalPullRequestFeedback(databasePath, fixture.execution.admission);
  const admission = new SqliteFactoryExternalPullRequestRepairAdmissionRepository(databasePath, {
    documents: fixture.documents,
    now: () => "2026-09-01T12:25:00.000Z"
  });
  try {
    await admission.decide(
      fixture.execution.admission.policyDocument,
      fixture.execution.decision,
      fixture.execution.authorization,
      fixture.execution.admission.candidate
    );
  } finally {
    admission.close();
  }
  const execution = new SqliteFactoryExternalPullRequestRepairExecutionRepository(databasePath, {
    documents: fixture.documents,
    now: () => "2026-09-01T12:25:00.000Z"
  });
  const run = fixture.repairRun;
  const registered = registeredExternalPullRequestRepairExecutionEvent(fixture.execution, run);
  try {
    await execution.register(
      fixture.execution.admission.policyDocument,
      fixture.execution.executionPolicyDocument,
      run,
      registered,
      fixture.execution.candidate
    );
    const started = executionEvent(fixture, run, 2, registered.digest, {
      kind: "workspace-started",
      from: "ready",
      to: "workspace-active",
      reasonCode: "exact-external-pr-head-workspace-started"
    });
    await execution.append(started);
    const prepared = executionEvent(fixture, run, 3, started.digest, {
      kind: "workspace-prepared",
      from: "workspace-active",
      to: "prepared",
      sourcePatchDigest: run.value.originalPatchDigest,
      sourcePatchArtifact: artifact(run.value.originalPatchDigest, "application/vnd.git.patch", 42),
      reasonCode: "exact-reviewed-patch-and-head-materialized"
    });
    await execution.append(prepared);
    const active = executionEvent(fixture, run, 4, prepared.digest, {
      kind: "repairer-started",
      from: "prepared",
      to: "repairer-active",
      repairerId: run.value.repairExecutionPolicy.repairerProfile.id,
      executionId: fixture.repairBundle.value.executionId,
      requestDigest: fixture.repairBundle.value.repairerRequestDigest,
      reasonCode: "credentialless-external-repairer-started"
    });
    await execution.append(active);
    const recorded = executionEvent(fixture, run, 5, active.digest, {
      kind: "bundle-recorded",
      from: "repairer-active",
      to: "recorded",
      repairerId: run.value.repairExecutionPolicy.repairerProfile.id,
      executionId: fixture.repairBundle.value.executionId,
      requestDigest: fixture.repairBundle.value.repairerRequestDigest,
      repairerRecordDigest: fixture.repairBundle.value.repairerRecordDigest,
      bundleDigest: fixture.repairBundle.digest,
      bundleArtifact: artifact(
        fixture.repairBundle.digest,
        "application/vnd.agentlab.external-pull-request-repair-bundle+json;version=1",
        new TextEncoder().encode(fixture.repairBundle.json).byteLength
      ),
      reasonCode: "credentialless-external-repair-bundle-recorded"
    });
    await execution.recordBundle(recorded, fixture.repairBundle);
    const completed = executionEvent(fixture, run, 6, recorded.digest, {
      kind: "completed",
      from: "recorded",
      to: "completed",
      bundleDigest: fixture.repairBundle.digest,
      reasonCode: "credentialless-external-repair-completed"
    });
    await execution.append(completed);
  } finally {
    execution.close();
  }
}

function executionEvent(
  fixture: ExternalPullRequestRepairQualificationFixture,
  run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>,
  sequence: number,
  previousEventDigest: Sha256Digest,
  payload: ExecutionPayload
) {
  return fixture.documents.externalPullRequestRepairExecutionEvent({
    schemaVersion: "agentlab.external-pull-request-repair-execution-event.v1",
    eventId: `96000000-0000-4000-8000-${String(sequence + 60).padStart(12, "0")}`,
    repairRunId: run.value.runId,
    runDigest: run.digest,
    sequence,
    previousEventDigest,
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab/external-pull-request-repair-execution",
      sessionId: run.value.runId
    },
    ...payload,
    occurredAt: `2026-09-01T12:${String(sequence + 24).padStart(2, "0")}:00.000Z`,
    correlationId: run.value.correlationId
  });
}

function qualificationEvent(
  fixture: ExternalPullRequestRepairQualificationFixture,
  run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>,
  sequence: number,
  previousEventDigest: Sha256Digest,
  payload: QualificationPayload
) {
  return fixture.documents.externalPullRequestRepairQualificationEvent({
    schemaVersion: "agentlab.external-pull-request-repair-qualification-event.v1",
    eventId: `96000000-0000-4000-8000-${String(sequence + 100).padStart(12, "0")}`,
    qualificationRunId: run.value.qualificationRunId,
    runDigest: run.digest,
    sequence,
    previousEventDigest,
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab/external-pull-request-repair-qualification",
      sessionId: run.value.qualificationRunId
    },
    ...payload,
    occurredAt: "2026-09-01T12:31:00.000Z",
    correlationId: run.value.correlationId
  });
}

function publicationEvent(
  fixture: ExternalPullRequestRepairQualificationFixture,
  run: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun>,
  sequence: number,
  previousEventDigest: Sha256Digest | null,
  payload: PublicationPayload
) {
  return fixture.documents.externalPullRequestReplacementDraftEvent({
    schemaVersion: "agentlab.external-pull-request-replacement-draft-event.v1",
    eventId: `97000000-0000-4000-8000-${String(sequence + 10).padStart(12, "0")}`,
    publicationRunId: run.value.publicationRunId,
    runDigest: run.digest,
    sequence,
    previousEventDigest,
    actor: {
      kind: "broker",
      role: "pr-broker",
      id: run.value.publicationPolicy.brokerId,
      sessionId: run.value.publicationRunId
    },
    ...payload,
    occurredAt: "2026-09-01T13:00:00.000Z",
    correlationId: run.value.correlationId
  });
}

async function append(
  repository: SqliteFactoryExternalPullRequestRepairQualificationRepository,
  event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>
) {
  const snapshot = await repository.append(event);
  if (snapshot === null) throw new Error("Test qualification append lost its claim.");
  return event;
}

function reviewUsage() {
  return {
    wallClockSeconds: 10,
    agentTurns: 1,
    toolCalls: 1,
    inputTokens: 1_000,
    outputTokens: 200,
    costMicrousd: 100,
    processes: 1,
    outputBytes: 1_000,
    workers: 1,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0
  };
}

function qualificationUsage() {
  return {
    ...reviewUsage(),
    wallClockSeconds: 17,
    processes: 8,
    outputBytes: 1_014,
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
      maxProcesses: 8,
      maxMemoryBytes: 1_073_741_824,
      cpuQuotaPercent: 200
    }
  };
}

function artifact(digest: Sha256Digest, mediaType: string, sizeBytes: number) {
  return { digest, mediaType, sizeBytes };
}

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-repair-qualification-sqlite-"));
  roots.push(root);
  return join(root, "agentlab.sqlite");
}
