import type {
  FactoryExternalPullRequestRepairQualificationBundle,
  FactoryExternalPullRequestRepairQualificationEvent,
  FactoryExternalPullRequestRepairQualificationPolicy,
  FactoryExternalPullRequestRepairQualificationRun,
  FactoryExternalPullRequestRepairerRecord,
  Sha256Digest
} from "@agentlab/contracts";

import type { FactoryExternalPullRequestRepairQualificationCandidate } from "./factory-external-pull-request-repair-qualification-repository.js";
import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";

type PolicyDocument = CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationPolicy>;
type RunDocument = CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>;
type EventDocument = CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>;
type BundleDocument = CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationBundle>;
type RepairerRecordDocument = CanonicalFactoryDocument<FactoryExternalPullRequestRepairerRecord>;

type Documents = Pick<
  FactoryDocumentCodec,
  | "externalPullRequestRepairExecutionRun"
  | "externalPullRequestRepairBundle"
  | "externalPullRequestRepairerRecord"
  | "externalPullRequestFeedbackRun"
  | "externalPullRequestRepairQualificationPolicy"
  | "externalPullRequestRepairGateProfile"
  | "gateObservation"
  | "resourceIsolation"
  | "externalPullRequestReviewerRecord"
>;

export function assertExternalPullRequestRepairQualificationRun(
  policy: PolicyDocument,
  candidate: FactoryExternalPullRequestRepairQualificationCandidate,
  run: RunDocument,
  repairerRecord: RepairerRecordDocument,
  documents: Documents
): void {
  const execution = candidate.repairRun;
  const repair = candidate.repairBundle;
  const feedback = candidate.feedbackRun;
  const executionPolicy = execution.value.repairExecutionPolicy;
  if (
    documents.externalPullRequestRepairQualificationPolicy(run.value.qualificationPolicy).digest !==
      run.value.qualificationPolicyDigest ||
    run.value.qualificationPolicyDigest !== policy.digest ||
    documents.externalPullRequestRepairGateProfile(policy.value.gateProfile).digest !==
      policy.value.gateProfileDigest ||
    executionPolicy.qualificationPolicyDigest !== policy.digest ||
    executionPolicy.costPolicyDigest !== policy.value.costPolicyDigest ||
    executionPolicy.roleIdentityPolicyDigest !== policy.value.roleIdentityPolicyDigest ||
    executionPolicy.gateProfileDigest !== policy.value.gateProfileDigest ||
    policy.value.reviewerProfiles.some(({ id }) => id === executionPolicy.repairerProfile.id) ||
    documents.externalPullRequestRepairExecutionRun(execution.value).digest !== execution.digest ||
    documents.externalPullRequestRepairBundle(repair.value).digest !== repair.digest ||
    documents.externalPullRequestFeedbackRun(feedback.value).digest !== feedback.digest ||
    documents.externalPullRequestRepairerRecord(repairerRecord.value).digest !==
      repairerRecord.digest ||
    run.value.repositoryId !== execution.value.repositoryId ||
    run.value.pullRequestNumber !== execution.value.pullRequestNumber ||
    run.value.repairRunId !== execution.value.runId ||
    run.value.repairRunDigest !== execution.digest ||
    run.value.repairBundleDigest !== repair.digest ||
    run.value.authorizationDigest !== execution.value.authorizationDigest ||
    run.value.repairExecutionPolicyDigest !== execution.value.repairExecutionPolicyDigest ||
    run.value.gateProfileDigest !== executionPolicy.gateProfileDigest ||
    run.value.expectedBaseRevision !== execution.value.expectedBaseRevision ||
    run.value.expectedHeadRevision !== execution.value.expectedHeadRevision ||
    run.value.originalPatchDigest !== execution.value.originalPatchDigest ||
    run.value.repairedPatchDigest !== repair.value.patchArtifact.digest ||
    run.value.repairerId !== executionPolicy.repairerProfile.id ||
    run.value.repairerRecordDigest !== repair.value.repairerRecordDigest ||
    run.value.repairerExecutionId !== repair.value.executionId ||
    run.value.repairerRecordDigest !== repairerRecord.digest ||
    run.value.repairerProviderSessionId !== repairerRecord.value.providerSessionId ||
    repairerRecord.value.repairRunId !== execution.value.runId ||
    repairerRecord.value.runDigest !== execution.digest ||
    repairerRecord.value.executionId !== repair.value.executionId ||
    repairerRecord.value.repairerId !== executionPolicy.repairerProfile.id ||
    repairerRecord.value.status !== "succeeded" ||
    !repairerRecord.value.usageComplete ||
    repair.value.repairRunId !== execution.value.runId ||
    repair.value.runDigest !== execution.digest ||
    repair.value.expectedHeadRevision !== execution.value.expectedHeadRevision ||
    repair.value.originalPatchDigest !== execution.value.originalPatchDigest ||
    repair.value.changeSet.baseRevision !== execution.value.expectedHeadRevision ||
    feedback.digest !== execution.value.feedbackPublicationRunDigest ||
    feedback.value.bundleDigest !== execution.value.reviewBundleDigest
  ) {
    throw new Error("External repair qualification run changed its transitive repair lineage.");
  }
}

export function assertExternalPullRequestRepairQualificationRegistration(
  run: RunDocument,
  event: EventDocument
): void {
  if (
    event.value.kind !== "registered" ||
    event.value.qualificationRunId !== run.value.qualificationRunId ||
    event.value.runDigest !== run.digest ||
    event.value.sequence !== 1 ||
    event.value.previousEventDigest !== null ||
    event.value.occurredAt !== run.value.createdAt ||
    event.value.correlationId !== run.value.correlationId ||
    event.value.actor.kind !== "control-plane" ||
    event.value.actor.role !== "policy-engine" ||
    event.value.actor.id !== run.value.qualificationPolicy.id ||
    event.value.actor.sessionId !== run.value.qualificationRunId
  ) {
    throw new Error("External repair qualification registration changed its immutable run.");
  }
}

export function assertExternalPullRequestRepairQualificationEvent(
  run: RunDocument,
  event: EventDocument,
  history: readonly EventDocument[]
): void {
  const previous = history.at(-1);
  if (
    previous === undefined ||
    event.value.qualificationRunId !== run.value.qualificationRunId ||
    event.value.runDigest !== run.digest ||
    event.value.sequence !== previous.value.sequence + 1 ||
    event.value.previousEventDigest !== previous.digest ||
    event.value.from !== previous.value.to ||
    event.value.occurredAt < previous.value.occurredAt ||
    event.value.correlationId !== run.value.correlationId ||
    event.value.actor.kind !== "control-plane" ||
    event.value.actor.role !== "policy-engine" ||
    event.value.actor.id !== run.value.qualificationPolicy.id ||
    event.value.actor.sessionId !== run.value.qualificationRunId
  ) {
    throw new Error("External repair qualification event chain failed lineage validation.");
  }
  if (event.value.kind === "gate-started") {
    const started = event.value;
    if (
      !run.value.qualificationPolicy.gateProfile.gates.some(({ id }) => id === started.gateId) ||
      history.some(
        ({ value }) =>
          (value.kind === "gate-finished" && value.gateId === started.gateId) ||
          (value.kind === "gate-started" && value.isolationId === started.isolationId)
      )
    ) {
      throw new Error("External repair qualification gate is absent or already consumed.");
    }
  }
  if (event.value.kind === "gate-finished") {
    if (
      previous.value.kind !== "gate-started" ||
      previous.value.gateId !== event.value.gateId ||
      previous.value.isolationId !== event.value.isolationId
    ) {
      throw new Error("External repair qualification gate completion has no matching intent.");
    }
  }
  if (event.value.kind === "gates-passed") {
    const completed = history.flatMap(({ value }) =>
      value.kind === "gate-finished" ? [value.gateId] : []
    );
    const required = run.value.qualificationPolicy.gateProfile.gates.map(({ id }) => id);
    if (completed.join("\0") !== required.join("\0")) {
      throw new Error("External repair qualification cannot skip a strict gate.");
    }
  }
  if (event.value.kind === "reviewer-started") {
    const started = event.value;
    const profile = run.value.qualificationPolicy.reviewerProfiles.find(
      ({ id }) => id === started.reviewerId
    );
    if (
      profile === undefined ||
      profile.id === run.value.repairerId ||
      history.some(
        ({ value }) =>
          (value.kind === "reviewer-finished" && value.reviewerId === started.reviewerId) ||
          (value.kind === "reviewer-started" && value.executionId === started.executionId)
      )
    ) {
      throw new Error("External repair qualification reviewer is absent or already consumed.");
    }
  }
  if (event.value.kind === "reviewer-finished") {
    if (
      previous.value.kind !== "reviewer-started" ||
      previous.value.reviewerId !== event.value.reviewerId ||
      previous.value.executionId !== event.value.executionId ||
      previous.value.requestDigest !== event.value.requestDigest
    ) {
      throw new Error("External repair qualification review completion has no matching intent.");
    }
  }
}

export function assertExternalPullRequestRepairQualificationBundle(
  run: RunDocument,
  bundle: BundleDocument,
  event: EventDocument,
  history: readonly EventDocument[],
  documents: Documents
): void {
  if (
    event.value.kind !== "bundle-recorded" ||
    bundle.value.qualificationRunId !== run.value.qualificationRunId ||
    bundle.value.runDigest !== run.digest ||
    bundle.value.repositoryId !== run.value.repositoryId ||
    bundle.value.pullRequestNumber !== run.value.pullRequestNumber ||
    bundle.value.repairRunDigest !== run.value.repairRunDigest ||
    bundle.value.repairBundleDigest !== run.value.repairBundleDigest ||
    bundle.value.qualificationPolicyDigest !== run.value.qualificationPolicyDigest ||
    bundle.value.gateProfileDigest !== run.value.gateProfileDigest ||
    bundle.value.repairedPatchArtifact.digest !== run.value.repairedPatchDigest ||
    bundle.value.changeSet.baseRevision !== run.value.expectedHeadRevision ||
    event.value.bundleDigest !== bundle.digest ||
    event.value.bundleArtifact.digest !== bundle.digest ||
    event.value.decision !== bundle.value.decision
  ) {
    throw new Error("External repair qualification bundle changed its run identity.");
  }
  const configuredGates = run.value.qualificationPolicy.gateProfile.gates;
  for (const [index, observation] of bundle.value.gateObservations.entries()) {
    const isolation = bundle.value.gateIsolationRecords[index];
    if (
      configuredGates[index]?.id !== observation.gateId ||
      documents.gateObservation(observation).digest !==
        gateEvidenceDigest(history, observation.gateId) ||
      isolation === undefined ||
      documents.resourceIsolation(isolation).digest !==
        isolationEvidenceDigest(history, observation.gateId) ||
      isolation.policyBundleDigest !== run.value.gateProfileDigest ||
      isolation.execution.kind !== "gate" ||
      isolation.execution.gateId !== observation.gateId ||
      isolation.result !== "enforced"
    ) {
      throw new Error("External repair qualification bundle contains invalid gate evidence.");
    }
  }
  const gatePassed = bundle.value.gateObservations.every(({ result }) => result === "pass");
  if (gatePassed && bundle.value.gateObservations.length !== configuredGates.length) {
    throw new Error("External repair qualification bundle omits required passing gates.");
  }
  const selected = run.value.qualificationPolicy.reviewerProfiles.slice(
    0,
    run.value.qualificationPolicy.minimumIndependentReviews
  );
  for (const [index, result] of bundle.value.reviews.entries()) {
    const record = bundle.value.reviewerRecords[index];
    const profile = selected[index];
    if (
      record === undefined ||
      profile?.id !== result.reviewerId ||
      result.candidateDigest !== run.value.repairBundleDigest ||
      result.patchDigest !== run.value.repairedPatchDigest ||
      result.reviewRunId !== run.value.qualificationRunId ||
      result.runDigest !== run.digest ||
      result.reviewerRecordDigest !== documents.externalPullRequestReviewerRecord(record).digest ||
      record.reviewRunId !== run.value.qualificationRunId ||
      record.runDigest !== run.digest ||
      record.provider !== profile.provider ||
      record.model !== profile.model ||
      record.reasoning !== profile.reasoning ||
      record.status !== "succeeded" ||
      !record.usageComplete ||
      record.providerSessionId === null ||
      record.providerSessionId === run.value.repairerProviderSessionId ||
      record.executionId === run.value.repairerExecutionId
    ) {
      throw new Error("External repair qualification bundle contains a non-independent review.");
    }
  }
  const sessions = bundle.value.reviewerRecords.map(({ providerSessionId }) => providerSessionId);
  if (new Set(sessions).size !== sessions.length) {
    throw new Error("External repair qualification reviewer sessions are not distinct.");
  }
  const approvals = bundle.value.reviews.filter(({ verdict }) => verdict === "approved").length;
  const expectedDecision = !gatePassed
    ? "rejected"
    : bundle.value.reviews.length !== selected.length
      ? null
      : approvals === selected.length
        ? "qualified"
        : approvals === 0
          ? "rejected"
          : "human-review-required";
  if (expectedDecision === null || bundle.value.decision !== expectedDecision) {
    throw new Error("External repair qualification decision disagrees with its complete evidence.");
  }
}

function gateEvidenceDigest(history: readonly EventDocument[], gateId: string): Sha256Digest {
  const event = history.find(
    ({ value }) => value.kind === "gate-finished" && value.gateId === gateId
  );
  if (event?.value.kind !== "gate-finished") {
    throw new Error("Qualification gate evidence is absent.");
  }
  return event.value.gateObservationDigest;
}

function isolationEvidenceDigest(history: readonly EventDocument[], gateId: string): Sha256Digest {
  const event = history.find(
    ({ value }) => value.kind === "gate-finished" && value.gateId === gateId
  );
  if (event?.value.kind !== "gate-finished") {
    throw new Error("Qualification isolation evidence is absent.");
  }
  return event.value.isolationRecordDigest;
}
