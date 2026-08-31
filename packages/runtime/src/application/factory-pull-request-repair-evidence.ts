import type {
  EvidenceItem,
  FactoryPatchProposal,
  FactoryPullRequestAuthorityRecord,
  FactoryPullRequestObservation,
  FactoryPullRequestRecord,
  FactoryPullRequestRepairAuthorization,
  FactoryPullRequestRepairRun,
  FactoryTaskUsageRecord,
  Sha256Digest
} from "@agentlab/contracts";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type {
  FactoryTaskSnapshot,
  StoredEvidenceBundle
} from "../domain/factory-task-repository.js";
import type { FactoryPullRequestDispatchSnapshot } from "../domain/factory-pull-request-dispatch-repository.js";
import { factoryPullRequestAuthorityCoordinates } from "../domain/factory-pull-request-authority-record.js";
import {
  selectFactoryPullRequestRepair,
  type FactoryPullRequestRepairFeedback
} from "../domain/factory-pull-request-repair.js";
import type { FactoryWorkspacePatch } from "../domain/factory-workspace.js";

const observationMediaType = "application/vnd.agentlab.pull-request-observation.v1+json";
const authorizationMediaType = "application/vnd.agentlab.pull-request-repair-authorization.v1+json";
const usageMediaType = "application/vnd.agentlab.task-usage-record.v1+json";
const patchProposalMediaType = "application/vnd.agentlab.patch-proposal.v1+json";
const repairRunMediaType = "application/vnd.agentlab.pull-request-repair-run.v1+json";
const utf8Encoder = new TextEncoder();

export interface FactoryPriorPatch {
  readonly proposal: CanonicalFactoryDocument<FactoryPatchProposal>;
  readonly workspacePatch: FactoryWorkspacePatch;
}

export interface FactoryPullRequestObservedEvidence {
  readonly observation: CanonicalFactoryDocument<FactoryPullRequestObservation>;
  readonly item: EvidenceItem;
  readonly bundle: StoredEvidenceBundle;
}

export interface FactoryPullRequestRepairEvidenceReaderDependencies {
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
}

/** Reads and revalidates canonical broker/control-plane artifacts before repair admission trusts them. */
export class FactoryPullRequestRepairEvidenceReader {
  public constructor(
    private readonly dependencies: FactoryPullRequestRepairEvidenceReaderDependencies
  ) {}

  public async exactLatestObservation(input: {
    readonly bundles: readonly StoredEvidenceBundle[];
    readonly expectedDigest: Sha256Digest;
    readonly task: FactoryTaskSnapshot;
    readonly proposalDigest: Sha256Digest;
    readonly record: CanonicalFactoryDocument<FactoryPullRequestAuthorityRecord>;
  }): Promise<FactoryPullRequestObservedEvidence> {
    const candidates = input.bundles.flatMap((bundle) =>
      bundle.bundle.items
        .filter(
          (item) => item.kind === "pull-request" && item.artifact.mediaType === observationMediaType
        )
        .map((item) => ({ bundle, item }))
    );
    const latest = candidates.at(-1);
    if (latest?.item.artifact.digest !== input.expectedDigest) {
      throw new Error("Repair admission requires the exact latest PR observation digest.");
    }
    const observation = this.dependencies.documents.pullRequestObservation(
      parseJson(
        await this.dependencies.artifacts.readText(
          latest.item.artifact.digest,
          latest.item.artifact.sizeBytes + 1
        )
      )
    );
    if (
      observation.digest !== input.expectedDigest ||
      latest.item.subjectDigest !== observation.digest ||
      latest.item.result !== "fail" ||
      latest.item.createdAt !== observation.value.observedAt ||
      latest.item.producer.kind !== "broker" ||
      latest.item.producer.role !== "pr-broker" ||
      claim(latest.item, "disposition") !== "actionable"
    ) {
      throw new Error("PR observation evidence is not an exact actionable broker record.");
    }
    assertObservationIdentity(input.task, input.proposalDigest, input.record, {
      observation,
      item: latest.item,
      bundle: latest.bundle
    });
    return { observation, item: latest.item, bundle: latest.bundle };
  }

  public async authorizations(input: {
    readonly bundles: readonly StoredEvidenceBundle[];
    readonly task: FactoryTaskSnapshot;
    readonly record: CanonicalFactoryDocument<FactoryPullRequestAuthorityRecord>;
    readonly proposalDigest: Sha256Digest;
    readonly priorPatchProposalDigest: Sha256Digest;
  }): Promise<readonly CanonicalFactoryDocument<FactoryPullRequestRepairAuthorization>[]> {
    const documents: CanonicalFactoryDocument<FactoryPullRequestRepairAuthorization>[] = [];
    for (const { bundle } of input.bundles) {
      for (const item of bundle.items) {
        if (item.kind !== "pull-request" || item.artifact.mediaType !== authorizationMediaType) {
          continue;
        }
        const authorization = this.dependencies.documents.pullRequestRepairAuthorization(
          parseJson(
            await this.dependencies.artifacts.readText(
              item.artifact.digest,
              item.artifact.sizeBytes + 1
            )
          )
        );
        const coordinates = factoryPullRequestAuthorityCoordinates(input.record.value);
        if (
          authorization.value.priorPatchProposalDigest !== input.priorPatchProposalDigest ||
          authorization.value.pullRequestRecordDigest !== input.record.digest
        ) {
          continue;
        }
        if (
          authorization.digest !== item.artifact.digest ||
          authorization.digest !== item.subjectDigest ||
          authorization.value.taskId !== input.task.contract.taskId ||
          authorization.value.contractDigest !== input.task.contractDigest ||
          authorization.value.policyBundleDigest !== input.task.contract.gateProfile.policyDigest ||
          authorization.value.proposalDigest !== input.proposalDigest ||
          authorization.value.repositoryId !== coordinates.repositoryId ||
          authorization.value.pullRequestNumber !== coordinates.number ||
          authorization.value.headRevision !== coordinates.headRevision ||
          authorization.value.brokerId !== coordinates.brokerId ||
          authorization.value.expiresAt !== input.task.contract.expiresAt ||
          authorization.value.contractRepairAttempt >
            input.task.contract.budget.maxRepairAttempts ||
          authorization.value.brokerId !== item.producer.id ||
          authorization.value.createdAt !== item.createdAt ||
          item.producer.kind !== "broker" ||
          item.producer.role !== "pr-broker" ||
          item.result !== "pass" ||
          claim(item, "observation-digest") !== authorization.value.observationDigest ||
          claim(item, "observation-evidence-bundle-digest") !==
            authorization.value.observationEvidenceBundleDigest ||
          claim(item, "pull-request-record-digest") !== input.record.digest ||
          claim(item, "head-revision") !== authorization.value.headRevision ||
          claim(item, "contract-repair-attempt") !==
            String(authorization.value.contractRepairAttempt)
        ) {
          throw new Error("Stored PR repair authorization failed identity validation.");
        }
        documents.push(authorization);
      }
    }
    const attempts = documents.map(({ value }) => value.contractRepairAttempt);
    if (new Set(attempts).size !== attempts.length) {
      throw new Error("PR repair authorizations reuse a contract repair attempt.");
    }
    return documents;
  }

  public async exactAuthorization(input: {
    readonly bundles: readonly StoredEvidenceBundle[];
    readonly expectedDigest: Sha256Digest;
    readonly task: FactoryTaskSnapshot;
    readonly record: CanonicalFactoryDocument<FactoryPullRequestAuthorityRecord>;
    readonly proposalDigest: Sha256Digest;
    readonly priorPatchProposalDigest: Sha256Digest;
  }): Promise<CanonicalFactoryDocument<FactoryPullRequestRepairAuthorization>> {
    const authorizations = await this.authorizations(input);
    const authorization = authorizations.find(({ digest }) => digest === input.expectedDigest);
    if (authorization === undefined) {
      throw new Error("Factory worker requires the exact stored PR repair authorization.");
    }
    return authorization;
  }

  public async repairRuns(input: {
    readonly bundles: readonly StoredEvidenceBundle[];
    readonly task: FactoryTaskSnapshot;
    readonly authorizations: readonly CanonicalFactoryDocument<FactoryPullRequestRepairAuthorization>[];
  }): Promise<readonly CanonicalFactoryDocument<FactoryPullRequestRepairRun>[]> {
    const authorizationByDigest = new Map(
      input.authorizations.map((authorization) => [authorization.digest, authorization] as const)
    );
    const runs: CanonicalFactoryDocument<FactoryPullRequestRepairRun>[] = [];
    for (const { bundle } of input.bundles) {
      for (const item of bundle.items) {
        if (item.kind !== "execution" || item.artifact.mediaType !== repairRunMediaType) continue;
        const run = this.dependencies.documents.pullRequestRepairRun(
          parseJson(
            await this.dependencies.artifacts.readText(
              item.artifact.digest,
              item.artifact.sizeBytes + 1
            )
          )
        );
        const authorization = authorizationByDigest.get(run.value.authorizationDigest);
        if (authorization === undefined) continue;
        if (
          run.digest !== item.artifact.digest ||
          run.value.taskId !== input.task.contract.taskId ||
          run.value.contractDigest !== input.task.contractDigest ||
          run.value.policyBundleDigest !== input.task.contract.gateProfile.policyDigest ||
          run.value.authorizationId !== authorization.value.authorizationId ||
          run.value.observationDigest !== authorization.value.observationDigest ||
          run.value.priorPatchProposalDigest !== authorization.value.priorPatchProposalDigest ||
          run.value.repository.id !== input.task.contract.repository.id ||
          run.value.repository.baseRevision !== input.task.contract.repository.baseRevision ||
          run.value.contractRepairAttempt !== authorization.value.contractRepairAttempt ||
          run.value.maximumAttempts !== authorization.value.contractRepairAttempt ||
          run.value.createdAt < authorization.value.createdAt ||
          run.value.createdAt >= authorization.value.expiresAt ||
          item.subjectDigest !== authorization.digest ||
          item.result !== "informational" ||
          item.createdAt !== run.value.createdAt ||
          item.producer.kind !== "control-plane" ||
          item.producer.role !== "policy-engine" ||
          item.producer.id !== "agentlab-policy" ||
          claim(item, "repair-run-digest") !== run.digest ||
          claim(item, "authorization-id") !== run.value.authorizationId ||
          claim(item, "authorization-digest") !== authorization.digest ||
          claim(item, "contract-repair-attempt") !== String(run.value.contractRepairAttempt)
        ) {
          throw new Error("Stored PR repair run failed identity validation.");
        }
        runs.push(run);
      }
    }
    if (
      new Set(runs.map(({ value }) => value.authorizationDigest)).size !== runs.length ||
      new Set(runs.map(({ value }) => value.contractRepairAttempt)).size !== runs.length
    ) {
      throw new Error("PR repair-run evidence reuses an authorization or repair attempt.");
    }
    return runs;
  }

  public async priorPatch(input: {
    readonly bundles: readonly StoredEvidenceBundle[];
    readonly expectedDigest: Sha256Digest;
    readonly task: FactoryTaskSnapshot;
  }): Promise<FactoryPriorPatch> {
    const item = input.bundles
      .flatMap(({ bundle }) => bundle.items)
      .find(
        (candidate) =>
          candidate.kind === "patch" &&
          candidate.subjectDigest === input.expectedDigest &&
          candidate.artifact.mediaType === patchProposalMediaType
      );
    if (item === undefined) throw new Error("PR repair requires its exact prior patch proposal.");
    const proposal = this.dependencies.documents.patchProposal(
      parseJson(
        await this.dependencies.artifacts.readText(
          item.artifact.digest,
          item.artifact.sizeBytes + 1
        )
      )
    );
    if (
      proposal.digest !== input.expectedDigest ||
      proposal.digest !== item.artifact.digest ||
      proposal.value.taskId !== input.task.contract.taskId ||
      proposal.value.contractDigest !== input.task.contractDigest ||
      proposal.value.baseRevision !== input.task.contract.repository.baseRevision ||
      proposal.value.changeSet.baseRevision !== input.task.contract.repository.baseRevision ||
      proposal.value.patchArtifact.mediaType !== "text/x-diff; charset=utf-8" ||
      proposal.value.patchArtifact.sizeBytes > input.task.contract.budget.maxOutputBytes ||
      item.result !== "pass" ||
      item.createdAt !== proposal.value.createdAt ||
      item.producer.kind !== "control-plane" ||
      item.producer.role !== "gate-runner" ||
      item.producer.id !== "agentlab-local-gates" ||
      claim(item, "patch-digest") !== proposal.value.patchArtifact.digest ||
      claim(item, "base-revision") !== proposal.value.baseRevision ||
      claim(item, "execution-id") !== proposal.value.executionId
    ) {
      throw new Error("Prior PR patch evidence failed identity validation.");
    }
    const patch = await this.dependencies.artifacts.readText(
      proposal.value.patchArtifact.digest,
      proposal.value.patchArtifact.sizeBytes + 1
    );
    if (utf8Encoder.encode(patch).byteLength !== proposal.value.patchArtifact.sizeBytes) {
      throw new Error("Prior PR patch artifact has the wrong size.");
    }
    return {
      proposal,
      workspacePatch: { patch, changeSet: proposal.value.changeSet }
    };
  }

  public repairFeedback(input: {
    readonly authorization: FactoryPullRequestRepairAuthorization;
    readonly observation: FactoryPullRequestObservation;
  }): FactoryPullRequestRepairFeedback {
    const selection = selectFactoryPullRequestRepair(input.observation);
    if (
      selection.status !== "selected" ||
      !sameValues(selection.reasonCodes, input.authorization.reasonCodes) ||
      !sameValues(selection.selectedReviewIds, input.authorization.selectedReviewIds) ||
      !sameValues(
        selection.selectedReviewCommentIds,
        input.authorization.selectedReviewCommentIds
      ) ||
      JSON.stringify(selection.failedChecks) !== JSON.stringify(input.authorization.failedChecks)
    ) {
      throw new Error(
        "PR repair authorization no longer matches deterministic feedback selection."
      );
    }
    const reviewById = new Map(
      input.observation.reviews.map((review) => [review.reviewId, review])
    );
    const commentById = new Map(
      input.observation.reviewComments.map((comment) => [comment.commentId, comment])
    );
    return {
      formalReviews: input.authorization.selectedReviewIds.map((reviewId) => {
        const review = reviewById.get(reviewId);
        if (review === undefined) throw new Error(`Authorized review ${reviewId} is missing.`);
        return {
          reviewId,
          authorLogin: review.author.login,
          authorAssociation: review.author.association,
          submittedAt: review.submittedAt,
          untrustedBody: review.untrustedBody
        };
      }),
      reviewComments: input.authorization.selectedReviewCommentIds.map((commentId) => {
        const comment = commentById.get(commentId);
        if (comment?.reviewId === null || comment === undefined) {
          throw new Error(`Authorized review comment ${commentId} is missing.`);
        }
        return {
          commentId,
          reviewId: comment.reviewId,
          authorLogin: comment.author.login,
          path: comment.path,
          line: comment.line,
          side: comment.side,
          untrustedBody: comment.untrustedBody
        };
      }),
      failedChecks: input.authorization.failedChecks
    };
  }

  public async initialUsage(input: {
    readonly bundles: readonly StoredEvidenceBundle[];
    readonly task: FactoryTaskSnapshot;
    readonly patchProposalDigest: Sha256Digest;
  }): Promise<CanonicalFactoryDocument<FactoryTaskUsageRecord>> {
    const candidates = input.bundles
      .flatMap(({ bundle }) => bundle.items)
      .filter(
        (item) =>
          item.kind === "usage" &&
          item.result === "pass" &&
          item.subjectDigest === input.patchProposalDigest &&
          item.artifact.mediaType === usageMediaType
      );
    const item = candidates.at(-1);
    if (item === undefined) throw new Error("PR repair admission requires complete task usage.");
    const usage = this.dependencies.documents.taskUsage(
      parseJson(
        await this.dependencies.artifacts.readText(
          item.artifact.digest,
          item.artifact.sizeBytes + 1
        )
      )
    );
    if (
      usage.digest !== item.artifact.digest ||
      usage.value.taskId !== input.task.contract.taskId ||
      usage.value.contractDigest !== input.task.contractDigest ||
      usage.value.patchProposalDigest !== input.patchProposalDigest ||
      !usage.value.complete ||
      usage.value.usage.repairAttempts > input.task.contract.budget.maxRepairAttempts ||
      usage.value.calculatedAt !== item.createdAt ||
      item.producer.kind !== "control-plane" ||
      item.producer.role !== "gate-runner" ||
      item.producer.id !== "agentlab-local-gates" ||
      claim(item, "usage-complete") !== "true" ||
      claim(item, "patch-proposal-digest") !== input.patchProposalDigest
    ) {
      throw new Error("Task usage does not authorize a remaining repair budget.");
    }
    return usage;
  }
}

function assertObservationIdentity(
  task: FactoryTaskSnapshot,
  proposalDigest: Sha256Digest,
  record: CanonicalFactoryDocument<FactoryPullRequestAuthorityRecord>,
  observed: FactoryPullRequestObservedEvidence
): void {
  const observation = observed.observation.value;
  const coordinates = factoryPullRequestAuthorityCoordinates(record.value);
  if (
    observation.taskId !== task.contract.taskId ||
    observation.contractDigest !== task.contractDigest ||
    observation.proposalDigest !== proposalDigest ||
    observation.pullRequestRecordDigest !== record.digest ||
    observation.repositoryId !== task.contract.repository.id ||
    observation.authorizedBaseRevision !== task.contract.repository.baseRevision ||
    observation.pullRequestNumber !== coordinates.number ||
    observation.url !== coordinates.url ||
    observation.recordedHeadRevision !== coordinates.headRevision ||
    observation.branchName !== coordinates.branchName ||
    observation.brokerId !== coordinates.brokerId ||
    observation.recordedHeadRevision !== observation.remoteHeadRevision ||
    observation.remoteBaseRevision !== observation.authorizedBaseRevision ||
    observation.pullRequestNumber !== Number(claim(observed.item, "pull-request-number")) ||
    observation.remoteHeadRevision !== claim(observed.item, "head-revision") ||
    observation.pullRequestRecordDigest !== claim(observed.item, "pull-request-record-digest") ||
    observed.item.producer.id !== observation.brokerId
  ) {
    throw new Error("PR repair observation does not match the immutable task and dispatch.");
  }
}

function claim(item: EvidenceItem, name: string): string | null {
  return item.claims.find((candidate) => candidate.name === name)?.value ?? null;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error("Stored factory artifact is invalid JSON.", { cause: error });
  }
}

function sameValues(left: readonly unknown[], right: readonly unknown[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Revalidates the completed initial PR dispatch before any repair stage trusts its coordinates. */
export function requireFactoryPullRequestRepairDispatch(
  task: FactoryTaskSnapshot,
  dispatch: FactoryPullRequestDispatchSnapshot | null,
  documents: FactoryDocumentCodec
): {
  readonly dispatch: FactoryPullRequestDispatchSnapshot;
  readonly record: CanonicalFactoryDocument<FactoryPullRequestRecord>;
} {
  if (dispatch?.state !== "completed" || dispatch.record === null) {
    throw new Error("PR repair requires a completed durable dispatch record.");
  }
  const record = documents.pullRequestRecord(dispatch.record);
  if (
    dispatch.run.taskId !== task.contract.taskId ||
    dispatch.run.contractDigest !== task.contractDigest ||
    dispatch.run.proposal.taskId !== task.contract.taskId ||
    dispatch.run.proposal.contractDigest !== task.contractDigest ||
    dispatch.run.proposal.repositoryId !== task.contract.repository.id ||
    dispatch.run.proposal.baseRevision !== task.contract.repository.baseRevision ||
    record.value.taskId !== task.contract.taskId ||
    record.value.contractDigest !== task.contractDigest ||
    record.value.proposalDigest !== dispatch.run.proposalDigest ||
    record.value.repositoryId !== task.contract.repository.id ||
    record.value.baseRevision !== task.contract.repository.baseRevision ||
    record.value.branchName !== dispatch.run.proposal.branchName ||
    record.value.brokerId !== dispatch.run.brokerId
  ) {
    throw new Error("PR repair dispatch does not match its immutable task contract.");
  }
  return { dispatch, record };
}
