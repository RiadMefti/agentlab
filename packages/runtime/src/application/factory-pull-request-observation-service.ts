import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryPullRequestObservation,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type { FactoryPullRequestObserver } from "../domain/factory-pull-request-broker.js";
import type { FactoryPullRequestDispatchRepository } from "../domain/factory-pull-request-dispatch-repository.js";
import { factoryPullRequestAuthorityCoordinates } from "../domain/factory-pull-request-authority-record.js";
import type { FactoryPullRequestUpdateRepository } from "../domain/factory-pull-request-update-repository.js";
import type { FactoryCanaryPullRequestMaintenanceCoordinates } from "../domain/factory-canary-pull-request-maintenance.js";
import {
  assessFactoryPullRequestObservation,
  type FactoryPullRequestAssessment
} from "../domain/factory-pull-request-observation.js";
import type {
  FactoryControlRepository,
  FactoryTaskRepository,
  FactoryTaskSnapshot
} from "../domain/factory-task-repository.js";
import type { FactoryEvidenceIngress } from "./factory-evidence-ingress.js";
import {
  FactoryEvidencePublisher,
  type FactoryEvidencePublisherCredentials
} from "./factory-evidence-publisher.js";
import { FactoryPullRequestLineageReader } from "./factory-pull-request-lineage.js";
import type { FactoryPullRequestCanaryAuthority } from "./factory-pull-request-canary-authority.js";

const maintenanceCoordinatesSchema = z
  .object({
    reservationDigest: sha256DigestSchema,
    schedulePolicyDigest: sha256DigestSchema,
    factoryPolicyBundleDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    scheduledFor: factoryTimestampSchema
  })
  .strict();

const observationInputSchema = z
  .object({
    taskId: z.uuid(),
    maintenance: maintenanceCoordinatesSchema.optional()
  })
  .strict();

export interface FactoryPullRequestObservationServiceDependencies {
  readonly dispatches: Pick<FactoryPullRequestDispatchRepository, "findByTaskId">;
  readonly updates: Pick<FactoryPullRequestUpdateRepository, "listByTaskId">;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly evidenceIngress: FactoryEvidenceIngress;
  readonly evidenceCredentials: Pick<FactoryEvidencePublisherCredentials, "prBroker">;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly remote: FactoryPullRequestObserver;
  readonly canaryAuthority: Pick<FactoryPullRequestCanaryAuthority, "require"> | null;
  readonly now: () => string;
  readonly createId: () => string;
}

export type FactoryPullRequestObservationOutcome =
  | {
      readonly status: "observed";
      readonly observation: FactoryPullRequestObservation;
      readonly observationDigest: Sha256Digest;
      readonly evidenceBundleDigest: Sha256Digest;
      readonly assessment: FactoryPullRequestAssessment;
    }
  | {
      readonly status: "denied";
      readonly reasonCodes: readonly ["pr-broker-disabled"];
    };

/** Observes one durable PR record and appends facts; it owns no repair or remote-write path. */
export class FactoryPullRequestObservationService {
  readonly #publisher: FactoryEvidencePublisher;
  readonly #lineage: FactoryPullRequestLineageReader;

  public constructor(
    private readonly dependencies: FactoryPullRequestObservationServiceDependencies
  ) {
    this.#publisher = new FactoryEvidencePublisher({
      evidenceIngress: dependencies.evidenceIngress,
      credentials: { prBroker: dependencies.evidenceCredentials.prBroker },
      artifacts: dependencies.artifacts,
      documents: dependencies.documents,
      now: dependencies.now,
      createId: dependencies.createId
    });
    this.#lineage = new FactoryPullRequestLineageReader(dependencies);
  }

  public async observe(input: unknown): Promise<FactoryPullRequestObservationOutcome> {
    const command = observationInputSchema.parse(input);
    if (!(await this.dependencies.controls.state()).prBroker) {
      return { status: "denied", reasonCodes: ["pr-broker-disabled"] };
    }
    const task = await this.dependencies.tasks.findById(command.taskId);
    if (task === null) throw new Error(`Factory task ${command.taskId} does not exist.`);
    if (task.state !== "pr-open") {
      throw new Error("PR observation requires a task with a durably opened pull request.");
    }
    if (command.maintenance !== undefined) {
      await this.#requireMaintenanceAuthority(task, command.maintenance);
    }
    const lineage = await this.#lineage.current(task);
    const record = lineage.record;
    const coordinates = factoryPullRequestAuthorityCoordinates(record.value);
    const identity = this.dependencies.remote.identity();
    if (
      lineage.dispatch.run.taskId !== task.contract.taskId ||
      lineage.dispatch.run.contractDigest !== task.contractDigest ||
      lineage.dispatch.run.proposalDigest !== coordinates.initialProposalDigest ||
      coordinates.taskId !== task.contract.taskId ||
      coordinates.contractDigest !== task.contractDigest ||
      coordinates.repositoryId !== task.contract.repository.id ||
      identity.repositoryId !== coordinates.repositoryId ||
      identity.brokerId !== coordinates.brokerId
    ) {
      throw new Error("PR observation identities do not match the task and durable dispatch.");
    }
    const observation = this.dependencies.documents.pullRequestObservation(
      await this.dependencies.remote.observe({ record: record.value })
    );
    if (
      observation.value.taskId !== task.contract.taskId ||
      observation.value.contractDigest !== task.contractDigest ||
      observation.value.proposalDigest !== coordinates.initialProposalDigest ||
      observation.value.pullRequestRecordDigest !== record.digest ||
      observation.value.repositoryId !== coordinates.repositoryId ||
      observation.value.pullRequestNumber !== coordinates.number ||
      observation.value.url !== coordinates.url ||
      observation.value.brokerId !== coordinates.brokerId ||
      observation.value.authorizedBaseRevision !== coordinates.baseRevision ||
      observation.value.recordedHeadRevision !== coordinates.headRevision ||
      observation.value.branchName !== coordinates.branchName
    ) {
      throw new Error("PR observation does not match its exact local authority record.");
    }
    const assessment = assessFactoryPullRequestObservation(observation.value);
    const evidence = await this.#publisher.pullRequestObservation({
      task,
      observation,
      assessment,
      ...(command.maintenance === undefined ? {} : { maintenance: command.maintenance })
    });
    return {
      status: "observed",
      observation: observation.value,
      observationDigest: observation.digest,
      evidenceBundleDigest: evidence.digest,
      assessment
    };
  }

  async #requireMaintenanceAuthority(
    task: FactoryTaskSnapshot,
    maintenance: FactoryCanaryPullRequestMaintenanceCoordinates
  ): Promise<void> {
    if (
      task.contract.trigger !== "scheduled" ||
      task.contract.gateProfile.policyDigest !== maintenance.factoryPolicyBundleDigest
    ) {
      throw new Error("Autonomous PR observation requires the exact scheduled task policy.");
    }
    if (maintenance.scheduledFor > factoryTimestampSchema.parse(this.dependencies.now())) {
      throw new Error("Autonomous PR observation cannot precede its maintenance slot.");
    }
    if (this.dependencies.canaryAuthority === null) {
      throw new Error("Autonomous PR observation requires broker config v3.");
    }
    await this.dependencies.canaryAuthority.require(task, {
      reservationDigest: maintenance.reservationDigest,
      schedulePolicyDigest: maintenance.schedulePolicyDigest,
      roleIdentityPolicyDigest: maintenance.roleIdentityPolicyDigest
    });
  }
}
