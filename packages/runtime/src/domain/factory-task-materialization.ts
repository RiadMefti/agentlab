import type {
  EvidenceBundle,
  FactoryPreparationAuthority,
  FactoryPreparationBundle,
  FactoryPreparationEvent,
  ImmutableTaskContract,
  Sha256Digest,
  TaskEvent
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";
import type { FactoryTaskSnapshot } from "./factory-task-repository.js";
import { isFactoryTaskTransitionAllowed } from "./factory-task-state.js";

export interface FactoryTaskMaterialization {
  readonly preparationBundle: CanonicalFactoryDocument<FactoryPreparationBundle>;
  readonly contract: CanonicalFactoryDocument<ImmutableTaskContract>;
  readonly taskEvents: readonly CanonicalFactoryDocument<TaskEvent>[];
  readonly initialEvidence: CanonicalFactoryDocument<EvidenceBundle>;
  readonly preparedEvent: CanonicalFactoryDocument<FactoryPreparationEvent>;
}

/** Commits the prepared marker and its complete task-ledger root in one storage transaction. */
export interface FactoryTaskMaterializationRepository {
  materialize(input: FactoryTaskMaterialization): Promise<FactoryTaskSnapshot | null>;
  close(): void;
}

/** Validates the complete immutable document set before a storage adapter starts its transaction. */
export function assertFactoryTaskMaterialization(input: FactoryTaskMaterialization): void {
  const { preparationBundle: bundle, contract, taskEvents, initialEvidence: evidence } = input;
  const prepared = input.preparedEvent;
  if (
    prepared.value.kind !== "prepared" ||
    prepared.value.taskId !== contract.value.taskId ||
    prepared.value.preparationBundleDigest !== bundle.digest ||
    prepared.value.contractDigest !== contract.digest ||
    prepared.value.evidenceBundleDigest !== evidence.digest ||
    prepared.value.actor.kind !== "control-plane" ||
    prepared.value.actor.role !== "policy-engine" ||
    prepared.value.actor.sessionId !== null ||
    bundle.value.taskId !== contract.value.taskId ||
    evidence.value.taskId !== contract.value.taskId ||
    evidence.value.contractDigest !== contract.digest ||
    evidence.value.policyBundleDigest !== contract.value.gateProfile.policyDigest ||
    evidence.value.sequence !== 1 ||
    evidence.value.previousBundleDigest !== null ||
    contract.value.createdAt !== prepared.value.occurredAt ||
    evidence.value.createdAt !== prepared.value.occurredAt
  ) {
    throw new Error("Factory materialization documents do not share one exact identity root.");
  }
  assertTaskEventChain(taskEvents, contract, evidence.digest, prepared.value);
  assertInitialEvidenceContents(evidence.value, bundle, contract);
}

/** Binds the bundle and evidence to the exact successful runs in the durable journal. */
export function assertFactoryPreparationHistoryMaterialization(
  bundle: FactoryPreparationBundle,
  history: readonly CanonicalFactoryDocument<FactoryPreparationEvent>[],
  authority: FactoryPreparationAuthority,
  evidence: EvidenceBundle
): void {
  for (const run of bundle.runs) {
    const completionIndex = history.findIndex(
      ({ value }) =>
        value.kind === "phase-succeeded" &&
        value.phase === run.phase &&
        value.executionId === run.executionId
    );
    const completion = history[completionIndex]?.value;
    const started = history[completionIndex - 1]?.value;
    const profile = authority.preparationProfiles.find(({ phase }) => phase === run.phase);
    const runRequestEvidence = evidence.items.find(
      (item) =>
        item.kind === "provenance" &&
        evidenceClaim(item, "document") === "preparation-run-request" &&
        evidenceClaim(item, "execution-id") === run.executionId
    );
    if (
      completion?.kind !== "phase-succeeded" ||
      started?.kind !== "phase-started" ||
      profile === undefined ||
      started.phase !== run.phase ||
      started.skillId !== run.skillId ||
      started.skillPackageDigest !== run.skillPackageDigest ||
      started.workerProfileId !== run.workerProfileId ||
      profile.id !== run.workerProfileId ||
      profile.skillId !== run.skillId ||
      profile.provider !== run.provider ||
      profile.model !== run.model ||
      profile.reasoning !== run.reasoning ||
      completion.runRecordArtifact.digest !== run.runRecordDigest ||
      completion.outputArtifact.digest !== run.outputDigest ||
      completion.actor.id !== run.workerProfileId ||
      completion.actor.kind !== run.actor.kind ||
      completion.actor.role !== run.actor.role ||
      completion.actor.sessionId !== run.actor.sessionId ||
      completion.occurredAt !== run.finishedAt ||
      run.startedAt < started.occurredAt ||
      runRequestEvidence?.artifact.digest !== started.runRequestDigest
    ) {
      throw new Error(`Preparation bundle ${run.phase} run is not its exact journal history.`);
    }
  }
}

function assertTaskEventChain(
  events: readonly CanonicalFactoryDocument<TaskEvent>[],
  contract: CanonicalFactoryDocument<ImmutableTaskContract>,
  evidenceDigest: Sha256Digest,
  prepared: Extract<FactoryPreparationEvent, { readonly kind: "prepared" }>
): void {
  const expectedStates = ["intake", "qualified", "specified", "planned"] as const;
  if (events.length !== expectedStates.length) {
    throw new Error("Task materialization requires the complete preparation state history.");
  }
  for (const [index, event] of events.entries()) {
    const previous = events[index - 1] ?? null;
    if (
      event.value.taskId !== contract.value.taskId ||
      event.value.contractDigest !== contract.digest ||
      event.value.sequence !== index + 1 ||
      event.value.previousEventDigest !== (previous?.digest ?? null) ||
      event.value.from !== (previous?.value.to ?? null) ||
      event.value.to !== expectedStates[index] ||
      !isFactoryTaskTransitionAllowed(event.value.from, event.value.to) ||
      event.value.actor.kind !== "control-plane" ||
      event.value.actor.role !== "policy-engine" ||
      event.value.actor.sessionId !== null ||
      event.value.actor.id !== prepared.actor.id ||
      event.value.occurredAt !== prepared.occurredAt ||
      event.value.correlationId !== prepared.correlationId ||
      event.value.reasonCode !== `preparation-${event.value.to}` ||
      event.value.evidenceBundleDigest !== (event.value.to === "planned" ? evidenceDigest : null)
    ) {
      throw new Error("Task materialization events are not one policy-authored linked chain.");
    }
  }
}

function assertInitialEvidenceContents(
  evidence: EvidenceBundle,
  bundle: CanonicalFactoryDocument<FactoryPreparationBundle>,
  contract: CanonicalFactoryDocument<ImmutableTaskContract>
): void {
  const expected: readonly (readonly [EvidenceBundle["items"][number]["kind"], Sha256Digest])[] = [
    ["request", bundle.value.requestDigest],
    ["qualification", bundle.value.qualificationDigest],
    ["specification", bundle.value.specificationDigest],
    ["plan", bundle.value.planDigest],
    ["contract", contract.digest],
    ["policy", contract.value.gateProfile.policyDigest],
    ["provenance", bundle.value.authorityDigest],
    ["provenance", bundle.digest],
    ...bundle.value.runs.flatMap((run) => {
      const request = evidence.items.find(
        (item) =>
          item.kind === "provenance" &&
          evidenceClaim(item, "document") === "preparation-run-request" &&
          evidenceClaim(item, "execution-id") === run.executionId
      );
      return [
        ["provenance", request?.artifact.digest ?? missingDigest] as const,
        ["provenance", run.runRecordDigest] as const
      ];
    })
  ];
  for (const [kind, digest] of expected) {
    if (
      digest === missingDigest ||
      !evidence.items.some(
        (item) =>
          item.kind === kind &&
          item.artifact.digest === digest &&
          item.result === "pass" &&
          item.producer.kind === "control-plane" &&
          item.producer.role === "policy-engine" &&
          item.subjectDigest ===
            (kind === "policy" ? contract.value.gateProfile.policyDigest : contract.digest)
      )
    ) {
      throw new Error(`Initial evidence omits its exact ${kind} materialization artifact.`);
    }
  }
}

function evidenceClaim(item: EvidenceBundle["items"][number], name: string): string | null {
  return item.claims.find((candidate) => candidate.name === name)?.value ?? null;
}

const missingDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
