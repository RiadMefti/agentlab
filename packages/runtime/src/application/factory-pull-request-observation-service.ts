import {
  factoryPullRequestRecordSchema,
  type FactoryPullRequestObservation,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type { FactoryPullRequestObserver } from "../domain/factory-pull-request-broker.js";
import type { FactoryPullRequestDispatchRepository } from "../domain/factory-pull-request-dispatch-repository.js";
import {
  assessFactoryPullRequestObservation,
  type FactoryPullRequestAssessment
} from "../domain/factory-pull-request-observation.js";
import type {
  FactoryControlRepository,
  FactoryTaskRepository
} from "../domain/factory-task-repository.js";
import type { FactoryEvidenceIngress } from "./factory-evidence-ingress.js";
import {
  FactoryEvidencePublisher,
  type FactoryEvidencePublisherCredentials
} from "./factory-evidence-publisher.js";

const observationInputSchema = z.object({ taskId: z.uuid() }).strict();

export interface FactoryPullRequestObservationServiceDependencies {
  readonly dispatches: Pick<FactoryPullRequestDispatchRepository, "findByTaskId">;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly evidenceIngress: FactoryEvidenceIngress;
  readonly evidenceCredentials: Pick<FactoryEvidencePublisherCredentials, "prBroker">;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly remote: FactoryPullRequestObserver;
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
    const dispatch = await this.dependencies.dispatches.findByTaskId(command.taskId);
    if (dispatch?.state !== "completed" || dispatch.record === null) {
      throw new Error("PR observation requires a completed durable dispatch record.");
    }
    const record = factoryPullRequestRecordSchema.parse(dispatch.record);
    const identity = this.dependencies.remote.identity();
    const recordDigest = this.dependencies.documents.pullRequestRecord(record).digest;
    if (
      dispatch.run.taskId !== task.contract.taskId ||
      dispatch.run.contractDigest !== task.contractDigest ||
      dispatch.run.proposalDigest !== record.proposalDigest ||
      record.taskId !== task.contract.taskId ||
      record.contractDigest !== task.contractDigest ||
      record.repositoryId !== task.contract.repository.id ||
      identity.repositoryId !== record.repositoryId ||
      identity.brokerId !== record.brokerId
    ) {
      throw new Error("PR observation identities do not match the task and durable dispatch.");
    }
    const observation = this.dependencies.documents.pullRequestObservation(
      await this.dependencies.remote.observe({ record })
    );
    if (
      observation.value.taskId !== task.contract.taskId ||
      observation.value.contractDigest !== task.contractDigest ||
      observation.value.proposalDigest !== record.proposalDigest ||
      observation.value.pullRequestRecordDigest !== recordDigest ||
      observation.value.repositoryId !== record.repositoryId ||
      observation.value.pullRequestNumber !== record.number ||
      observation.value.url !== record.url ||
      observation.value.brokerId !== record.brokerId ||
      observation.value.authorizedBaseRevision !== record.baseRevision ||
      observation.value.recordedHeadRevision !== record.headRevision ||
      observation.value.branchName !== record.branchName
    ) {
      throw new Error("PR observation does not match its exact local authority record.");
    }
    const assessment = assessFactoryPullRequestObservation(observation.value);
    const evidence = await this.#publisher.pullRequestObservation({
      task,
      observation,
      assessment
    });
    return {
      status: "observed",
      observation: observation.value,
      observationDigest: observation.digest,
      evidenceBundleDigest: evidence.digest,
      assessment
    };
  }
}
