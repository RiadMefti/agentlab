import type {
  EvidenceItem,
  FactoryPullRequestObservation,
  FactoryPullRequestRecord,
  FactoryPullRequestRepairAuthorization,
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

const observationMediaType = "application/vnd.agentlab.pull-request-observation.v1+json";
const authorizationMediaType = "application/vnd.agentlab.pull-request-repair-authorization.v1+json";
const usageMediaType = "application/vnd.agentlab.task-usage-record.v1+json";

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
    readonly record: CanonicalFactoryDocument<FactoryPullRequestRecord>;
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
    readonly record: CanonicalFactoryDocument<FactoryPullRequestRecord>;
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
        if (
          authorization.digest !== item.artifact.digest ||
          authorization.digest !== item.subjectDigest ||
          authorization.value.taskId !== input.task.contract.taskId ||
          authorization.value.contractDigest !== input.task.contractDigest ||
          authorization.value.policyBundleDigest !== input.task.contract.gateProfile.policyDigest ||
          authorization.value.proposalDigest !== input.proposalDigest ||
          authorization.value.priorPatchProposalDigest !== input.priorPatchProposalDigest ||
          authorization.value.pullRequestRecordDigest !== input.record.digest ||
          authorization.value.repositoryId !== input.record.value.repositoryId ||
          authorization.value.pullRequestNumber !== input.record.value.number ||
          authorization.value.headRevision !== input.record.value.headRevision ||
          authorization.value.brokerId !== input.record.value.brokerId ||
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
  record: CanonicalFactoryDocument<FactoryPullRequestRecord>,
  observed: FactoryPullRequestObservedEvidence
): void {
  const observation = observed.observation.value;
  if (
    observation.taskId !== task.contract.taskId ||
    observation.contractDigest !== task.contractDigest ||
    observation.proposalDigest !== proposalDigest ||
    observation.pullRequestRecordDigest !== record.digest ||
    observation.repositoryId !== task.contract.repository.id ||
    observation.authorizedBaseRevision !== task.contract.repository.baseRevision ||
    observation.pullRequestNumber !== record.value.number ||
    observation.url !== record.value.url ||
    observation.recordedHeadRevision !== record.value.headRevision ||
    observation.branchName !== record.value.branchName ||
    observation.brokerId !== record.value.brokerId ||
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
