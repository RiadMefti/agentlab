import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type EvidenceItem,
  type FactoryPullRequestRepairAuthorization,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type { FactoryPullRequestDispatchRepository } from "../domain/factory-pull-request-dispatch-repository.js";
import { selectFactoryPullRequestRepair } from "../domain/factory-pull-request-repair.js";
import type {
  FactoryControlRepository,
  FactoryEvidenceRepository,
  FactoryTaskRepository,
  FactoryTaskSnapshot
} from "../domain/factory-task-repository.js";
import type { FactoryEvidenceIngress } from "./factory-evidence-ingress.js";
import {
  FactoryEvidencePublisher,
  type FactoryEvidencePublisherCredentials
} from "./factory-evidence-publisher.js";
import {
  FactoryPullRequestRepairEvidenceReader,
  type FactoryPullRequestObservedEvidence
} from "./factory-pull-request-repair-evidence.js";

const admissionInputSchema = z
  .object({
    taskId: z.uuid(),
    observationDigest: sha256DigestSchema,
    correlationId: z.uuid().optional()
  })
  .strict();

export interface FactoryPullRequestRepairAdmissionServiceDependencies {
  readonly dispatches: Pick<FactoryPullRequestDispatchRepository, "findByTaskId">;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly evidence: Pick<FactoryEvidenceRepository, "listEvidence">;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly evidenceIngress: FactoryEvidenceIngress;
  readonly evidenceCredentials: Pick<FactoryEvidencePublisherCredentials, "prBroker">;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly now: () => string;
  readonly createId: () => string;
}

export type FactoryPullRequestRepairAdmissionOutcome =
  | {
      readonly status: "authorized";
      readonly authorization: FactoryPullRequestRepairAuthorization;
      readonly authorizationDigest: Sha256Digest;
      readonly evidenceBundleDigest: Sha256Digest;
      readonly created: boolean;
    }
  | {
      readonly status: "denied";
      readonly reasonCodes: readonly string[];
    };

/** Reserves one bounded repair from exact broker-authenticated facts; it executes no model. */
export class FactoryPullRequestRepairAdmissionService {
  readonly #publisher: FactoryEvidencePublisher;
  readonly #evidenceReader: FactoryPullRequestRepairEvidenceReader;

  public constructor(
    private readonly dependencies: FactoryPullRequestRepairAdmissionServiceDependencies
  ) {
    this.#publisher = new FactoryEvidencePublisher({
      evidenceIngress: dependencies.evidenceIngress,
      credentials: { prBroker: dependencies.evidenceCredentials.prBroker },
      artifacts: dependencies.artifacts,
      documents: dependencies.documents,
      now: dependencies.now,
      createId: dependencies.createId
    });
    this.#evidenceReader = new FactoryPullRequestRepairEvidenceReader(dependencies);
  }

  public async admit(input: unknown): Promise<FactoryPullRequestRepairAdmissionOutcome> {
    const command = admissionInputSchema.parse(input);
    if (!(await this.dependencies.controls.state()).prBroker) {
      return denied("pr-broker-disabled");
    }
    const task = await this.#requireTask(command.taskId);
    if (task.state !== "pr-open") {
      throw new Error("PR repair admission requires an open pull-request task.");
    }
    if (task.contract.riskTier !== "R1") {
      return denied("post-pr-repair-risk-tier-not-admitted");
    }
    const inspectedAt = factoryTimestampSchema.parse(this.dependencies.now());
    if (inspectedAt >= task.contract.expiresAt) return denied("task-contract-expired");
    const dispatch = await this.dependencies.dispatches.findByTaskId(command.taskId);
    if (dispatch?.state !== "completed" || dispatch.record === null) {
      throw new Error("PR repair admission requires a completed durable dispatch record.");
    }
    const record = this.dependencies.documents.pullRequestRecord(dispatch.record);
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
    const bundles = await this.dependencies.evidence.listEvidence(command.taskId);
    const observed = await this.#evidenceReader.exactLatestObservation({
      bundles,
      expectedDigest: command.observationDigest,
      task,
      proposalDigest: dispatch.run.proposalDigest,
      record
    });
    const selection = selectFactoryPullRequestRepair(observed.observation.value);
    if (selection.status === "denied")
      return { status: "denied", reasonCodes: selection.reasonCodes };
    const observedReasons = new Set((claim(observed.item, "reason-codes") ?? "").split(","));
    if (selection.reasonCodes.some((reason) => !observedReasons.has(reason))) {
      throw new Error("PR observation evidence reasons differ from deterministic assessment.");
    }

    const existing = await this.#evidenceReader.authorizations({
      bundles,
      task,
      record,
      proposalDigest: dispatch.run.proposalDigest,
      priorPatchProposalDigest: dispatch.run.proposal.patchProposalDigest
    });
    const exactExisting = existing.find(
      ({ value }) => value.observationDigest === observed.observation.digest
    );
    if (exactExisting !== undefined) {
      this.#assertExistingSelection(exactExisting.value, observed, selection);
      const evidence = bundles.find(({ bundle }) =>
        bundle.items.some(({ artifact }) => artifact.digest === exactExisting.digest)
      );
      if (evidence === undefined) throw new Error("Repair authorization lost its evidence bundle.");
      return {
        status: "authorized",
        authorization: exactExisting.value,
        authorizationDigest: exactExisting.digest,
        evidenceBundleDigest: evidence.digest,
        created: false
      };
    }
    if (existing.length > 0) return denied("repair-authorization-outstanding");

    const usage = await this.#evidenceReader.initialUsage({
      bundles,
      task,
      patchProposalDigest: dispatch.run.proposal.patchProposalDigest
    });
    const contractRepairAttempt = usage.value.usage.repairAttempts + 1;
    const missingRequirements = [
      ...(contractRepairAttempt > task.contract.budget.maxRepairAttempts
        ? ["repair-budget-exhausted"]
        : []),
      ...(task.contract.skillPlan.some(({ phase }) => phase === "repair")
        ? []
        : ["repair-skill-not-pinned"]),
      ...(task.contract.agentPolicy.workerProfiles.some(({ roles }) => roles.includes("repairer"))
        ? []
        : ["repairer-profile-not-pinned"])
    ];
    if (missingRequirements.length > 0) {
      return { status: "denied", reasonCodes: missingRequirements.sort(compareText) };
    }
    if (!(await this.dependencies.controls.state()).prBroker) {
      return denied("pr-broker-disabled-after-observation");
    }
    const createdAt = factoryTimestampSchema.parse(this.dependencies.now());
    if (createdAt >= task.contract.expiresAt) {
      return denied("task-contract-expired-after-observation");
    }

    const authorization = this.dependencies.documents.pullRequestRepairAuthorization({
      schemaVersion: "agentlab.pull-request-repair-authorization.v1",
      authorizationId: this.dependencies.createId(),
      taskId: task.contract.taskId,
      contractDigest: task.contractDigest,
      policyBundleDigest: task.contract.gateProfile.policyDigest,
      proposalDigest: dispatch.run.proposalDigest,
      priorPatchProposalDigest: dispatch.run.proposal.patchProposalDigest,
      pullRequestRecordDigest: record.digest,
      observationDigest: observed.observation.digest,
      observationEvidenceBundleDigest: observed.bundle.digest,
      repositoryId: record.value.repositoryId,
      pullRequestNumber: record.value.number,
      headRevision: record.value.headRevision,
      brokerId: record.value.brokerId,
      contractRepairAttempt,
      reasonCodes: selection.reasonCodes,
      selectedReviewIds: selection.selectedReviewIds,
      selectedReviewCommentIds: selection.selectedReviewCommentIds,
      failedChecks: selection.failedChecks,
      createdAt,
      expiresAt: task.contract.expiresAt,
      correlationId: command.correlationId ?? this.dependencies.createId()
    });
    const evidence = await this.#publisher.pullRequestRepairAuthorization({
      task,
      authorization
    });
    return {
      status: "authorized",
      authorization: authorization.value,
      authorizationDigest: authorization.digest,
      evidenceBundleDigest: evidence.digest,
      created: true
    };
  }

  #assertExistingSelection(
    authorization: FactoryPullRequestRepairAuthorization,
    observed: FactoryPullRequestObservedEvidence,
    selection: Extract<ReturnType<typeof selectFactoryPullRequestRepair>, { status: "selected" }>
  ): void {
    if (
      authorization.observationEvidenceBundleDigest !== observed.bundle.digest ||
      authorization.headRevision !== observed.observation.value.remoteHeadRevision ||
      !sameStrings(authorization.reasonCodes, selection.reasonCodes) ||
      !sameStrings(authorization.selectedReviewIds, selection.selectedReviewIds) ||
      !sameStrings(authorization.selectedReviewCommentIds, selection.selectedReviewCommentIds) ||
      JSON.stringify(authorization.failedChecks) !== JSON.stringify(selection.failedChecks)
    ) {
      throw new Error("Existing repair authorization does not match its deterministic selection.");
    }
  }

  async #requireTask(taskId: string): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(taskId);
    if (task === null) throw new Error(`Factory task ${taskId} does not exist.`);
    return task;
  }
}

function denied(reasonCode: string): FactoryPullRequestRepairAdmissionOutcome {
  return { status: "denied", reasonCodes: [reasonCode] };
}

function claim(item: EvidenceItem, name: string): string | null {
  return item.claims.find((candidate) => candidate.name === name)?.value ?? null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
