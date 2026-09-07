import {
  factoryExternalPullRequestReplacementDraftProposalSchema,
  replacementDraftBranchName,
  replacementDraftMarker,
  sha256DigestSchema,
  type FactoryExternalPullRequestReplacementDraftEvent,
  type FactoryExternalPullRequestReplacementDraftPolicy,
  type FactoryExternalPullRequestReplacementDraftProposal,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import {
  FactoryExternalPullRequestReplacementQuarantineError,
  FactoryExternalPullRequestReplacementStaleError,
  type FactoryExternalPullRequestOriginalSnapshot,
  type FactoryExternalPullRequestReplacementDraftBroker
} from "../domain/factory-external-pull-request-replacement-draft-broker.js";
import type {
  FactoryExternalPullRequestReplacementDraftCandidate,
  FactoryExternalPullRequestReplacementDraftJournalSnapshot,
  FactoryExternalPullRequestReplacementDraftRepository
} from "../domain/factory-external-pull-request-replacement-draft-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type { FactoryControlRepository } from "../domain/factory-task-repository.js";
import { factoryTimestampAddSeconds } from "../domain/factory-timestamp.js";

const tickInputSchema = z
  .object({
    expectedPublicationPolicyDigest: sha256DigestSchema,
    expectedQualificationPolicyDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema
  })
  .strict();

export interface FactoryExternalPullRequestReplacementDraftPreflight {
  readonly schemaVersion: "agentlab.external-pull-request-replacement-draft-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repositoryId: string;
  readonly brokerId: string;
  readonly publicationPolicyDigest: Sha256Digest;
  readonly qualificationPolicyDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly schedulerEnabled: boolean;
  readonly prBrokerEnabled: boolean;
  readonly draftOnly: true;
  readonly contributorBranchWrite: false;
  readonly forcePush: false;
  readonly approval: false;
  readonly autoMerge: false;
  readonly release: false;
  readonly reasonCodes: readonly string[];
}
export interface FactoryExternalPullRequestReplacementDraftRunReport {
  readonly publicationRunId: string;
  readonly runDigest: Sha256Digest;
  readonly qualificationBundleDigest: Sha256Digest;
  readonly originalPullRequestNumber: number;
  readonly replacementPullRequestNumber: number | null;
  readonly status: "completed" | "stale" | "blocked" | "quarantined";
  readonly reasonCode: string | null;
}
export interface FactoryExternalPullRequestReplacementDraftTickReport {
  readonly schemaVersion: "agentlab.external-pull-request-replacement-draft-tick-result.v1";
  readonly status: "completed" | "idle" | "partial" | "blocked";
  readonly repositoryId: string;
  readonly publicationPolicyDigest: Sha256Digest;
  readonly inspected: number;
  readonly completed: number;
  readonly stale: number;
  readonly blocked: number;
  readonly quarantined: number;
  readonly reasonCodes: readonly string[];
  readonly runs: readonly FactoryExternalPullRequestReplacementDraftRunReport[];
}

export interface FactoryExternalPullRequestReplacementDraftServiceDependencies {
  readonly repositoryRoot: string;
  readonly publicationPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftPolicy>;
  readonly repository: FactoryExternalPullRequestReplacementDraftRepository;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly remote: FactoryExternalPullRequestReplacementDraftBroker;
  readonly now: () => string;
  readonly createId: () => string;
}

type EventPayload<
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
    > & { readonly occurredAt?: string }
  : never;

/** Consumes only qualified repair bundles and publishes a separate, auditable draft PR. */
export class FactoryExternalPullRequestReplacementDraftService {
  public constructor(
    private readonly dependencies: FactoryExternalPullRequestReplacementDraftServiceDependencies
  ) {}

  public async preflight(): Promise<FactoryExternalPullRequestReplacementDraftPreflight> {
    const controls = await this.dependencies.controls.state();
    const identity = this.dependencies.remote.identity();
    const policy = this.dependencies.publicationPolicy;
    const reasonCodes = [
      ...(identity.repositoryId === policy.value.repositoryId
        ? []
        : ["broker-repository-mismatch"]),
      ...(identity.brokerId === policy.value.brokerId ? [] : ["broker-identity-mismatch"]),
      ...(controls.scheduler ? [] : ["scheduler-disabled"]),
      ...(controls.prBroker ? [] : ["pr-broker-disabled"])
    ].toSorted();
    return {
      schemaVersion: "agentlab.external-pull-request-replacement-draft-preflight.v1",
      status: reasonCodes.length === 0 ? "ready" : "blocked",
      repositoryId: policy.value.repositoryId,
      brokerId: policy.value.brokerId,
      publicationPolicyDigest: policy.digest,
      qualificationPolicyDigest: policy.value.qualificationPolicyDigest,
      roleIdentityPolicyDigest: policy.value.roleIdentityPolicyDigest,
      schedulerEnabled: controls.scheduler,
      prBrokerEnabled: controls.prBroker,
      draftOnly: true,
      contributorBranchWrite: false,
      forcePush: false,
      approval: false,
      autoMerge: false,
      release: false,
      reasonCodes
    };
  }

  public async tick(input: unknown): Promise<FactoryExternalPullRequestReplacementDraftTickReport> {
    const command = tickInputSchema.parse(input);
    this.#assertPins(command);
    const policy = this.dependencies.publicationPolicy;
    const reports: FactoryExternalPullRequestReplacementDraftRunReport[] = [];
    const active = await this.dependencies.repository.listActive({
      repositoryId: policy.value.repositoryId,
      publicationPolicyDigest: policy.digest,
      limit: policy.value.maximumCandidatesPerTick
    });
    for (const journal of active) reports.push(await this.#execute(journal));
    const remaining = policy.value.maximumCandidatesPerTick - reports.length;
    const controls = await this.dependencies.controls.state();
    if (
      remaining > 0 &&
      controls.scheduler &&
      controls.prBroker &&
      !reports.some(({ status }) => status === "blocked")
    ) {
      const candidates = await this.dependencies.repository.listQualified({
        repositoryId: policy.value.repositoryId,
        qualificationPolicyDigest: policy.value.qualificationPolicyDigest,
        publicationPolicyDigest: policy.digest,
        limit: remaining
      });
      for (const candidate of candidates) {
        if (!(await this.#authorityEnabled())) break;
        reports.push(await this.#execute(await this.#register(candidate)));
      }
    }
    const blockers = [
      ...(!controls.scheduler ? ["scheduler-disabled"] : []),
      ...(!controls.prBroker ? ["pr-broker-disabled"] : []),
      ...reports.flatMap(({ reasonCode }) => (reasonCode === null ? [] : [reasonCode]))
    ]
      .filter((value, index, values) => values.indexOf(value) === index)
      .toSorted();
    if (reports.length === 0)
      return this.#report([], blockers.length === 0 ? "idle" : "blocked", blockers);
    const completed = reports.filter(({ status }) => status === "completed").length;
    return this.#report(
      reports,
      completed === reports.length ? "completed" : completed === 0 ? "blocked" : "partial",
      blockers
    );
  }

  async #register(
    candidate: FactoryExternalPullRequestReplacementDraftCandidate
  ): Promise<FactoryExternalPullRequestReplacementDraftJournalSnapshot> {
    const policy = this.dependencies.publicationPolicy;
    const createdAt = this.dependencies.now();
    const publicationRunId = this.dependencies.createId();
    const run = this.dependencies.documents.externalPullRequestReplacementDraftRun({
      schemaVersion: "agentlab.external-pull-request-replacement-draft-run.v1",
      publicationRunId,
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
      createdAt,
      deadlineAt: factoryTimestampAddSeconds(createdAt, policy.value.operationDeadlineSeconds),
      correlationId: this.dependencies.createId()
    });
    const event = this.dependencies.documents.externalPullRequestReplacementDraftEvent({
      schemaVersion: "agentlab.external-pull-request-replacement-draft-event.v1",
      eventId: this.dependencies.createId(),
      publicationRunId,
      runDigest: run.digest,
      sequence: 1,
      previousEventDigest: null,
      actor: this.#actor(publicationRunId),
      occurredAt: createdAt,
      reasonCode: "qualified-repair-selected",
      correlationId: run.value.correlationId,
      kind: "registered",
      from: null,
      to: "ready"
    });
    return this.dependencies.repository.register(policy, run, event, candidate);
  }

  async #execute(
    initial: FactoryExternalPullRequestReplacementDraftJournalSnapshot
  ): Promise<FactoryExternalPullRequestReplacementDraftRunReport> {
    let journal = initial;
    try {
      for (let transitions = 0; transitions < 6; transitions += 1) {
        if (journal.state === "ready") {
          this.#assertBeforeDeadline(journal);
          if (!(await this.#authorityEnabled()))
            return reportFor(journal, "blocked", "publication-authority-disabled");
          const remote = await this.dependencies.remote.inspectOriginal(
            journal.run.originalPullRequestNumber
          );
          this.#assertSnapshot(journal, remote);
          const proposal = this.#proposal(journal, remote);
          const artifact = await this.dependencies.artifacts.putText(
            this.dependencies.documents.externalPullRequestReplacementDraftProposal(proposal).json
          );
          journal = await this.#append(journal, {
            kind: "branch-publish-intent-recorded",
            from: "ready",
            to: "branch-publish-intent-recorded",
            reasonCode: "durable-branch-publish-intent",
            proposalDigest:
              this.dependencies.documents.externalPullRequestReplacementDraftProposal(proposal)
                .digest,
            proposalArtifact: {
              digest: artifact.digest,
              sizeBytes: artifact.sizeBytes,
              mediaType: "application/json"
            }
          });
          continue;
        }
        if (journal.state === "branch-publish-intent-recorded") {
          this.#assertBeforeDeadline(journal);
          if (!(await this.#authorityEnabled()))
            return reportFor(journal, "blocked", "publication-authority-disabled");
          const proposal = await this.#readProposal(journal);
          const patch = await this.dependencies.artifacts.readText(
            journal.run.repairedPatchDigest,
            journal.run.publicationPolicy.maximumPatchBytes
          );
          const published = await this.dependencies.remote.publishBranch({
            proposal,
            patch,
            repositoryRoot: this.dependencies.repositoryRoot
          });
          journal = await this.#append(journal, {
            kind: "branch-published",
            from: "branch-publish-intent-recorded",
            to: "branch-published",
            reasonCode: published.created
              ? "replacement-branch-created"
              : "replacement-branch-reconciled",
            proposalDigest: this.#proposalDigest(journal),
            headRevision: published.headRevision
          });
          continue;
        }
        if (journal.state === "branch-published") {
          this.#assertBeforeDeadline(journal);
          if (!(await this.#authorityEnabled()))
            return reportFor(journal, "blocked", "publication-authority-disabled");
          const published = journal.lastEvent;
          if (published.kind !== "branch-published")
            throw new Error("Published branch state has no exact head.");
          journal = await this.#append(journal, {
            kind: "pull-request-open-intent-recorded",
            from: "branch-published",
            to: "pull-request-open-intent-recorded",
            reasonCode: "durable-draft-open-intent",
            proposalDigest: published.proposalDigest,
            headRevision: published.headRevision
          });
          continue;
        }
        if (journal.state === "pull-request-open-intent-recorded") {
          this.#assertBeforeDeadline(journal);
          if (!(await this.#authorityEnabled()))
            return reportFor(journal, "blocked", "publication-authority-disabled");
          const intent = journal.lastEvent;
          if (intent.kind !== "pull-request-open-intent-recorded")
            throw new Error("Draft intent state has no exact head.");
          const proposal = await this.#readProposal(journal);
          const opened = await this.dependencies.remote.openDraft({
            proposal,
            headRevision: intent.headRevision
          });
          const record = this.dependencies.documents.externalPullRequestReplacementDraftRecord(
            opened.record
          );
          const artifact = await this.dependencies.artifacts.putText(record.json);
          journal = await this.#record(journal, record, {
            kind: "pull-request-opened",
            from: "pull-request-open-intent-recorded",
            to: "pull-request-opened",
            reasonCode: opened.created
              ? "replacement-draft-created"
              : "replacement-draft-reconciled",
            recordDigest: record.digest,
            recordArtifact: {
              digest: artifact.digest,
              sizeBytes: artifact.sizeBytes,
              mediaType: "application/json"
            }
          });
          continue;
        }
        if (journal.state === "pull-request-opened") {
          if (journal.record === null) throw new Error("Opened replacement draft has no record.");
          await this.dependencies.remote.verifyDraft({
            proposal: await this.#readProposal(journal),
            record: journal.record
          });
          const opened = journal.lastEvent;
          if (opened.kind !== "pull-request-opened")
            throw new Error("Opened state has no record event.");
          journal = await this.#append(journal, {
            kind: "completed",
            from: "pull-request-opened",
            to: "completed",
            reasonCode: "replacement-draft-verified",
            recordDigest: opened.recordDigest
          });
          return reportFor(journal, "completed", null);
        }
        if (journal.state === "completed") return reportFor(journal, "completed", null);
        if (journal.state === "stale")
          return reportFor(journal, "stale", journal.lastEvent.reasonCode);
        return reportFor(journal, "quarantined", journal.lastEvent.reasonCode);
      }
      return reportFor(journal, "blocked", "publication-transition-limit-reached");
    } catch (error: unknown) {
      if (
        error instanceof FactoryExternalPullRequestReplacementStaleError ||
        error instanceof PublicationStaleError
      ) {
        const terminal = await this.#append(journal, {
          kind: "stale",
          from: journal.state as
            | "ready"
            | "branch-publish-intent-recorded"
            | "branch-published"
            | "pull-request-open-intent-recorded",
          to: "stale",
          reasonCode: "qualified-original-pr-moved",
          evidenceDigest: null
        });
        return reportFor(terminal, "stale", "qualified-original-pr-moved");
      }
      if (journal.state === "pull-request-opened") {
        const opened = journal.lastEvent;
        const terminal = await this.#append(journal, {
          kind: "quarantined",
          from: "pull-request-opened",
          to: "quarantined",
          reasonCode: "replacement-draft-verification-failed",
          evidenceDigest: opened.kind === "pull-request-opened" ? opened.recordDigest : null
        });
        return reportFor(terminal, "quarantined", "replacement-draft-verification-failed");
      }
      if (
        error instanceof FactoryExternalPullRequestReplacementQuarantineError &&
        journal.state !== "ready" &&
        journal.state !== "completed" &&
        journal.state !== "stale" &&
        journal.state !== "quarantined"
      ) {
        const terminal = await this.#append(journal, {
          kind: "quarantined",
          from: journal.state,
          to: "quarantined",
          reasonCode: "replacement-draft-remote-conflict",
          evidenceDigest: null
        });
        return reportFor(terminal, "quarantined", "replacement-draft-remote-conflict");
      }
      return reportFor(journal, "blocked", safeReason(error));
    }
  }

  #proposal(
    journal: FactoryExternalPullRequestReplacementDraftJournalSnapshot,
    remote: FactoryExternalPullRequestOriginalSnapshot
  ): FactoryExternalPullRequestReplacementDraftProposal {
    const branchName = replacementDraftBranchName(
      journal.run.originalPullRequestNumber,
      journal.run.qualificationBundleDigest
    );
    const marker = replacementDraftMarker(journal.run.publicationRunId, journal.runDigest);
    return factoryExternalPullRequestReplacementDraftProposalSchema.parse({
      schemaVersion: "agentlab.external-pull-request-replacement-draft-proposal.v1",
      publicationRunId: journal.run.publicationRunId,
      runDigest: journal.runDigest,
      repositoryId: journal.run.repositoryId,
      originalPullRequestNumber: journal.run.originalPullRequestNumber,
      originalPullRequestUrl: remote.url,
      qualificationBundleDigest: journal.run.qualificationBundleDigest,
      expectedBaseBranch: remote.baseBranch,
      expectedBaseRevision: journal.run.expectedBaseRevision,
      expectedOriginalHeadRevision: journal.run.expectedHeadRevision,
      repairedPatchDigest: journal.run.repairedPatchDigest,
      changeSet: journal.run.changeSet,
      branchName,
      title: `Qualified repair for external PR #${String(journal.run.originalPullRequestNumber)}`,
      body: `${marker}\n\nThis draft contains AgentLab's independently qualified repair for ${remote.url}.\n\nQualification bundle: \`${journal.run.qualificationBundleDigest}\`\nOriginal head: \`${journal.run.expectedHeadRevision}\`\n\nThis PR does not modify the contributor's branch and requires normal human review and protected-branch checks.`,
      commitTitle: `repair: qualify external PR #${String(journal.run.originalPullRequestNumber)}`,
      createdAt: journal.run.createdAt,
      draft: true,
      maintainerCanModify: false
    });
  }

  #assertSnapshot(
    journal: FactoryExternalPullRequestReplacementDraftJournalSnapshot,
    remote: FactoryExternalPullRequestOriginalSnapshot
  ): void {
    const governance = remote.governance;
    if (
      remote.repositoryId !== journal.run.repositoryId ||
      remote.number !== journal.run.originalPullRequestNumber ||
      remote.state !== "open" ||
      remote.baseRevision !== journal.run.expectedBaseRevision ||
      remote.headRevision !== journal.run.expectedHeadRevision ||
      !governance.requiresPullRequest ||
      governance.requiredApprovals < 1 ||
      !governance.dismissesStaleReviews ||
      !governance.requiresCodeOwnerReviews ||
      !governance.requiresLastPushApproval ||
      !governance.enforcesAdmins ||
      governance.allowsForcePushes ||
      governance.allowsDeletions ||
      !journal.run.publicationPolicy.requiredStatusChecks.every((check) =>
        governance.requiredStatusChecks.includes(check)
      )
    ) {
      throw new PublicationStaleError();
    }
  }

  async #readProposal(
    journal: FactoryExternalPullRequestReplacementDraftJournalSnapshot
  ): Promise<FactoryExternalPullRequestReplacementDraftProposal> {
    const intent = journal.history.find((event) => event.kind === "branch-publish-intent-recorded");
    if (intent?.kind !== "branch-publish-intent-recorded")
      throw new Error("Replacement-draft proposal intent is absent.");
    const text = await this.dependencies.artifacts.readText(
      intent.proposalArtifact.digest,
      Math.min(intent.proposalArtifact.sizeBytes, 1_048_576)
    );
    const proposal = this.dependencies.documents.externalPullRequestReplacementDraftProposal(
      JSON.parse(text) as unknown
    );
    if (proposal.digest !== intent.proposalDigest || proposal.json !== text)
      throw new Error("Replacement-draft proposal artifact changed after intent.");
    return proposal.value;
  }
  #proposalDigest(
    journal: FactoryExternalPullRequestReplacementDraftJournalSnapshot
  ): Sha256Digest {
    const intent = journal.history.find((event) => event.kind === "branch-publish-intent-recorded");
    if (intent?.kind !== "branch-publish-intent-recorded")
      throw new Error("Replacement-draft proposal digest is absent.");
    return intent.proposalDigest;
  }
  async #authorityEnabled(): Promise<boolean> {
    const state = await this.dependencies.controls.state();
    return state.scheduler && state.prBroker;
  }
  #assertBeforeDeadline(journal: FactoryExternalPullRequestReplacementDraftJournalSnapshot): void {
    if (this.dependencies.now() > journal.run.deadlineAt) throw new PublicationStaleError();
  }
  #assertPins(command: z.infer<typeof tickInputSchema>): void {
    const policy = this.dependencies.publicationPolicy;
    if (
      command.expectedPublicationPolicyDigest !== policy.digest ||
      command.expectedQualificationPolicyDigest !== policy.value.qualificationPolicyDigest ||
      command.expectedRoleIdentityPolicyDigest !== policy.value.roleIdentityPolicyDigest
    )
      throw new Error("Replacement-draft policy pins changed after operator review.");
  }
  #actor(sessionId: string) {
    return {
      kind: "broker",
      role: "pr-broker",
      id: this.dependencies.publicationPolicy.value.brokerId,
      sessionId
    } as const;
  }
  async #append(
    journal: FactoryExternalPullRequestReplacementDraftJournalSnapshot,
    payload: EventPayload
  ): Promise<FactoryExternalPullRequestReplacementDraftJournalSnapshot> {
    const occurredAt = payload.occurredAt ?? this.dependencies.now();
    const event = this.dependencies.documents.externalPullRequestReplacementDraftEvent({
      schemaVersion: "agentlab.external-pull-request-replacement-draft-event.v1",
      eventId: this.dependencies.createId(),
      publicationRunId: journal.run.publicationRunId,
      runDigest: journal.runDigest,
      sequence: journal.sequence + 1,
      previousEventDigest: journal.lastEventDigest,
      actor: this.#actor(journal.run.publicationRunId),
      occurredAt,
      correlationId: journal.run.correlationId,
      ...payload
    });
    const updated = await this.dependencies.repository.append(event);
    if (updated === null) throw new Error("Replacement-draft journal changed concurrently.");
    return updated;
  }
  async #record(
    journal: FactoryExternalPullRequestReplacementDraftJournalSnapshot,
    record: ReturnType<FactoryDocumentCodec["externalPullRequestReplacementDraftRecord"]>,
    payload: EventPayload
  ): Promise<FactoryExternalPullRequestReplacementDraftJournalSnapshot> {
    const event = this.dependencies.documents.externalPullRequestReplacementDraftEvent({
      schemaVersion: "agentlab.external-pull-request-replacement-draft-event.v1",
      eventId: this.dependencies.createId(),
      publicationRunId: journal.run.publicationRunId,
      runDigest: journal.runDigest,
      sequence: journal.sequence + 1,
      previousEventDigest: journal.lastEventDigest,
      actor: this.#actor(journal.run.publicationRunId),
      occurredAt: payload.occurredAt ?? this.dependencies.now(),
      correlationId: journal.run.correlationId,
      ...payload
    });
    const updated = await this.dependencies.repository.record(event, record);
    if (updated === null) throw new Error("Replacement-draft journal changed concurrently.");
    return updated;
  }
  #report(
    runs: readonly FactoryExternalPullRequestReplacementDraftRunReport[],
    status: FactoryExternalPullRequestReplacementDraftTickReport["status"],
    reasonCodes: readonly string[]
  ): FactoryExternalPullRequestReplacementDraftTickReport {
    return {
      schemaVersion: "agentlab.external-pull-request-replacement-draft-tick-result.v1",
      status,
      repositoryId: this.dependencies.publicationPolicy.value.repositoryId,
      publicationPolicyDigest: this.dependencies.publicationPolicy.digest,
      inspected: runs.length,
      completed: runs.filter(({ status }) => status === "completed").length,
      stale: runs.filter(({ status }) => status === "stale").length,
      blocked: runs.filter(({ status }) => status === "blocked").length,
      quarantined: runs.filter(({ status }) => status === "quarantined").length,
      reasonCodes,
      runs
    };
  }
}

class PublicationStaleError extends Error {}
function reportFor(
  journal: FactoryExternalPullRequestReplacementDraftJournalSnapshot,
  status: FactoryExternalPullRequestReplacementDraftRunReport["status"],
  reasonCode: string | null
): FactoryExternalPullRequestReplacementDraftRunReport {
  return {
    publicationRunId: journal.run.publicationRunId,
    runDigest: journal.runDigest,
    qualificationBundleDigest: journal.run.qualificationBundleDigest,
    originalPullRequestNumber: journal.run.originalPullRequestNumber,
    replacementPullRequestNumber: journal.record?.replacementPullRequestNumber ?? null,
    status,
    reasonCode
  };
}
function safeReason(error: unknown): string {
  if (
    error instanceof Error &&
    /cleanup|ambiguous|not confirmed|changed concurrently/iu.test(error.message)
  )
    return "publication-recovery-required";
  return "publication-operation-failed";
}
