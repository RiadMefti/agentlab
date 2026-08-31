import type {
  FactoryCanaryApproval,
  FactoryCanaryCohort,
  FactoryCanaryTaskReservation,
  FactoryConfigurationCandidate,
  FactoryEvalAssessment,
  FactoryEvalRun,
  FactoryIntakeRequest,
  FactoryPreparationAuthority,
  FactoryPreparationEvent,
  Sha256Digest
} from "@agentlab/contracts";

import type { FactoryCanarySnapshot } from "../../packages/runtime/src/domain/factory-canary-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../packages/runtime/src/domain/factory-documents.js";
import type { FactoryEvalAttestationSnapshot } from "../../packages/runtime/src/domain/factory-eval-attestation-repository.js";
import type { FactoryEvalSnapshot } from "../../packages/runtime/src/domain/factory-evaluation-repository.js";
import type { FactoryPreparationSnapshot } from "../../packages/runtime/src/domain/factory-preparation-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import {
  testEvalDigest,
  testFactoryCanaryDocuments,
  testFactoryConfigurationCandidate,
  testFactoryEvalAttestationSnapshot,
  testFactoryEvalBudget,
  testFactoryEvalDocuments,
  testFactoryEvalRun
} from "./factory-evaluation.js";
import { testFactoryPreparationFixture } from "./factory-preparation.js";

export const TEST_CANARY_RESERVATION_ID = "10000000-0000-4000-8000-000000000010";

type AttestedCanaryApproval = Extract<
  FactoryCanaryApproval,
  { readonly schemaVersion: "agentlab.canary-approval.v2" }
>;
type AttestedCanaryCohort = Extract<
  FactoryCanaryCohort,
  { readonly schemaVersion: "agentlab.canary-cohort.v2" }
>;

export interface FactoryCanaryAdmissionFixture {
  readonly documents: FactoryDocumentCodec;
  readonly preparation: FactoryPreparationSnapshot;
  readonly request: CanonicalFactoryDocument<FactoryIntakeRequest>;
  readonly authority: CanonicalFactoryDocument<FactoryPreparationAuthority>;
  readonly registered: CanonicalFactoryDocument<FactoryPreparationEvent>;
  readonly candidate: FactoryConfigurationCandidate;
  readonly candidateDigest: Sha256Digest;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly evaluation: {
    readonly run: CanonicalFactoryDocument<FactoryEvalRun>;
    readonly assessment: CanonicalFactoryDocument<FactoryEvalAssessment>;
    readonly snapshot: FactoryEvalSnapshot;
  };
  readonly attestation: FactoryEvalAttestationSnapshot;
  readonly canary: {
    readonly approval: CanonicalFactoryDocument<AttestedCanaryApproval>;
    readonly cohort: CanonicalFactoryDocument<AttestedCanaryCohort>;
  };
  readonly canarySnapshot: FactoryCanarySnapshot;
}

export function testFactoryCanaryAdmissionFixture(
  input: {
    readonly taskId?: string;
    readonly deduplicationKey?: string;
    readonly maximumTasks?: number;
  } = {}
): FactoryCanaryAdmissionFixture {
  const documents = new NodeFactoryDocumentCodec();
  const preparationFixture = testFactoryPreparationFixture({
    trigger: "scheduled",
    budgetCeiling: testFactoryEvalBudget(),
    planBudget: testFactoryEvalBudget(),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.deduplicationKey === undefined ? {} : { deduplicationKey: input.deduplicationKey })
  });
  const request = documents.intakeRequest(preparationFixture.request);
  const authority = documents.preparationAuthority(preparationFixture.authority);
  const registered = documents.preparationEvent({
    schemaVersion: "agentlab.preparation-event.v1",
    eventId: eventId(preparationFixture.request.taskId),
    taskId: preparationFixture.request.taskId,
    sequence: 1,
    requestDigest: request.digest,
    authorityDigest: authority.digest,
    previousEventDigest: null,
    kind: "registered",
    from: null,
    to: "registered",
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "local/factory-control-plane",
      sessionId: null
    },
    occurredAt: authority.value.issuedAt,
    reasonCode: "request-registered",
    summary: null,
    correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  });
  const preparation: FactoryPreparationSnapshot = {
    request: request.value,
    requestDigest: request.digest,
    authority: authority.value,
    authorityDigest: authority.digest,
    state: "registered",
    sequence: 1,
    lastEvent: registered.value,
    lastEventDigest: registered.digest
  };
  const schedulePolicyDigest = testEvalDigest(3);
  const candidate = testFactoryConfigurationCandidate({
    candidateId: "challenger",
    version: "1.1.0",
    providerDigestIndex: 6,
    repositoryId: request.value.repository.id,
    baseRevision: request.value.repository.baseRevision,
    policyBundleDigest: authority.value.policyBundleDigest,
    schedulePolicyDigest,
    skillPackageDigests: authority.value.skills.map(({ manifest }) => manifest.packageDigest)
  });
  const evaluation = testFactoryEvalDocuments({
    run: testFactoryEvalRun({ challengerCandidate: candidate })
  });
  const attestation = testFactoryEvalAttestationSnapshot(evaluation.snapshot);
  const canary = testFactoryCanaryDocuments(evaluation.snapshot, {
    attestation,
    ...(input.maximumTasks === undefined ? {} : { maximumTasks: input.maximumTasks })
  });
  const canarySnapshot = {
    approval: canary.approval.value,
    approvalDigest: canary.approval.digest,
    cohort: canary.cohort.value,
    cohortDigest: canary.cohort.digest
  };
  return {
    documents,
    preparation,
    request,
    authority,
    registered,
    candidate,
    candidateDigest: documents.configurationCandidate(candidate).digest,
    schedulePolicyDigest,
    evaluation,
    attestation,
    canary,
    canarySnapshot
  };
}

export function testFactoryCanaryReservationDocument(
  fixture: FactoryCanaryAdmissionFixture,
  input: {
    readonly reservationId?: string;
    readonly reservedAt?: string;
  } = {}
): CanonicalFactoryDocument<FactoryCanaryTaskReservation> {
  const reservedAt = input.reservedAt ?? "2026-08-30T12:02:00.000Z";
  return fixture.documents.canaryTaskReservation({
    schemaVersion: "agentlab.canary-task-reservation.v1",
    reservationId: input.reservationId ?? TEST_CANARY_RESERVATION_ID,
    cohortId: fixture.canary.cohort.value.cohortId,
    cohortDigest: fixture.canary.cohort.digest,
    approvalDigest: fixture.canary.approval.digest,
    assessmentDigest: fixture.canary.cohort.value.assessmentDigest,
    attestationDigest: fixture.canary.cohort.value.attestationDigest,
    roleIdentityPolicyDigest: fixture.canary.cohort.value.roleIdentityPolicyDigest,
    challengerCandidateDigest: fixture.candidateDigest,
    schedulePolicyDigest: fixture.schedulePolicyDigest,
    policyBundleDigest: fixture.preparation.authority.policyBundleDigest,
    stage: fixture.canary.cohort.value.stage,
    repository: fixture.preparation.request.repository,
    taskId: fixture.preparation.request.taskId,
    requestDigest: fixture.preparation.requestDigest,
    preparationAuthorityDigest: fixture.preparation.authorityDigest,
    maximumRiskTier: fixture.preparation.authority.maximumRiskTier,
    budget: fixture.preparation.authority.budgetCeiling,
    reservedAt,
    expiresAt:
      fixture.canary.cohort.value.expiresAt < fixture.preparation.authority.expiresAt
        ? fixture.canary.cohort.value.expiresAt
        : fixture.preparation.authority.expiresAt,
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab-canary-admission",
      sessionId: null
    },
    autoMerge: false,
    release: false
  });
}

function eventId(taskId: string): string {
  return taskId;
}
