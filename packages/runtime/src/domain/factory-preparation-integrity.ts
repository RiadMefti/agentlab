import type {
  FactoryIntakeRequest,
  FactoryPreparationAuthority,
  FactoryPreparationEvent,
  FactoryPreparationPhase
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";
import { assertFactoryPreparationAuthorityPolicy } from "./factory-preparation-authority.js";
import { isFactoryPreparationTransitionAllowed } from "./factory-preparation-state.js";

export interface FactoryPreparationDocuments {
  readonly request: CanonicalFactoryDocument<FactoryIntakeRequest>;
  readonly authority: CanonicalFactoryDocument<FactoryPreparationAuthority>;
}

export function assertFactoryPreparationRegistration(
  request: CanonicalFactoryDocument<FactoryIntakeRequest>,
  authority: CanonicalFactoryDocument<FactoryPreparationAuthority>,
  event: CanonicalFactoryDocument<FactoryPreparationEvent>
): void {
  assertFactoryPreparationAuthorityForRequest(request, authority);
  if (
    event.value.kind !== "registered" ||
    event.value.taskId !== request.value.taskId ||
    event.value.requestDigest !== request.digest ||
    event.value.authorityDigest !== authority.digest ||
    event.value.sequence !== 1 ||
    event.value.previousEventDigest !== null ||
    event.value.occurredAt !== authority.value.issuedAt ||
    event.value.actor.kind !== "control-plane" ||
    event.value.actor.role !== "policy-engine" ||
    event.value.actor.sessionId !== null
  ) {
    throw new Error("Initial preparation event does not register its exact request and authority.");
  }
  assertFactoryPreparationEvent({ request, authority }, event, []);
}

export function assertFactoryPreparationAuthorityForRequest(
  request: CanonicalFactoryDocument<FactoryIntakeRequest>,
  authority: CanonicalFactoryDocument<FactoryPreparationAuthority>
): void {
  assertFactoryPreparationAuthorityPolicy(authority.value);
  if (
    authority.value.taskId !== request.value.taskId ||
    authority.value.requestDigest !== request.digest ||
    authority.value.repository.id !== request.value.repository.id ||
    authority.value.repository.baseRevision !== request.value.repository.baseRevision ||
    authority.value.issuedAt < request.value.createdAt
  ) {
    throw new Error("Preparation authority does not belong to its exact intake request.");
  }
}

export function assertFactoryPreparationEvent(
  preparation: FactoryPreparationDocuments,
  event: CanonicalFactoryDocument<FactoryPreparationEvent>,
  history: readonly CanonicalFactoryDocument<FactoryPreparationEvent>[]
): void {
  if (
    event.value.taskId !== preparation.request.value.taskId ||
    event.value.requestDigest !== preparation.request.digest ||
    event.value.authorityDigest !== preparation.authority.digest ||
    !isFactoryPreparationTransitionAllowed(event.value.from, event.value.to)
  ) {
    throw new Error("Preparation event violates its request, authority, or state machine.");
  }
  const previous = history.at(-1);
  if (previous !== undefined && event.value.occurredAt < previous.value.occurredAt) {
    throw new Error("Preparation event timestamp predates its predecessor.");
  }
  if (event.value.kind === "expired") {
    if (event.value.occurredAt < preparation.authority.value.expiresAt) {
      throw new Error("Preparation cannot expire before its authority.");
    }
  } else if (event.value.occurredAt >= preparation.authority.value.expiresAt) {
    throw new Error("Preparation authority expired before the event occurred.");
  }

  if (event.value.kind === "phase-started") {
    assertPhaseStart(preparation, event.value, history);
    return;
  }
  if (hasRunCoordinates(event.value)) {
    const started = previous?.value;
    if (
      started?.kind !== "phase-started" ||
      started.phase !== event.value.phase ||
      started.executionId !== event.value.executionId ||
      started.attempt !== event.value.attempt ||
      started.runRequestDigest !== event.value.runRequestDigest
    ) {
      throw new Error("Preparation phase result does not match the exact active run.");
    }
    if (
      (event.value.kind === "phase-succeeded" ||
        event.value.kind === "needs-human" ||
        event.value.kind === "rejected") &&
      event.value.actor.id !== started.workerProfileId
    ) {
      throw new Error("Preparation phase result actor does not match its pinned worker profile.");
    }
  }
  if (
    (event.value.kind === "registered" || event.value.kind === "prepared") &&
    !isPolicyEngineActor(event.value.actor)
  ) {
    throw new Error("Preparation registration and materialization require the policy engine.");
  }
  if (
    (event.value.kind === "phase-failed" ||
      event.value.kind === "phase-abandoned" ||
      event.value.kind === "failed" ||
      event.value.kind === "expired") &&
    !isPolicyEngineActor(event.value.actor)
  ) {
    throw new Error("Preparation recovery and failure events require the policy engine.");
  }
  if (
    event.value.kind === "cancelled" &&
    event.value.actor.kind !== "human" &&
    !isPolicyEngineActor(event.value.actor)
  ) {
    throw new Error("Preparation cancellation requires a human or the policy engine.");
  }
}

export function factoryPreparationRunCoordinates(event: FactoryPreparationEvent): {
  readonly phase: string | null;
  readonly executionId: string | null;
  readonly attempt: number | null;
} {
  if (event.kind === "phase-started" || hasRunCoordinates(event)) {
    return { phase: event.phase, executionId: event.executionId, attempt: event.attempt };
  }
  return { phase: null, executionId: null, attempt: null };
}

function assertPhaseStart(
  preparation: FactoryPreparationDocuments,
  event: Extract<FactoryPreparationEvent, { readonly kind: "phase-started" }>,
  history: readonly CanonicalFactoryDocument<FactoryPreparationEvent>[]
): void {
  const profile = preparation.authority.value.preparationProfiles.find(
    ({ phase }) => phase === event.phase
  );
  const skill = preparation.authority.value.skills.find(
    ({ manifest }) => manifest.id === event.skillId
  );
  if (
    profile === undefined ||
    skill === undefined ||
    profile.skillId !== event.skillId ||
    profile.id !== event.workerProfileId ||
    skill.phase !== event.phase ||
    skill.manifest.packageDigest !== event.skillPackageDigest ||
    event.actor.kind !== "control-plane" ||
    event.actor.role !== "policy-engine" ||
    event.actor.sessionId !== null
  ) {
    throw new Error("Preparation phase start does not match its authorized skill and worker.");
  }
  const earlierStarts = history.filter(
    ({ value }) => value.kind === "phase-started" && value.phase === event.phase
  ).length;
  if (
    event.attempt !== earlierStarts + 1 ||
    event.attempt > preparation.authority.value.maximumPreparationAttempts
  ) {
    throw new Error("Preparation phase attempt is not the next authorized attempt.");
  }
  if (
    history.some(
      ({ value }) => factoryPreparationRunCoordinates(value).executionId === event.executionId
    )
  ) {
    throw new Error("Preparation execution ID has already been used.");
  }
  const expectedInputs = expectedPhaseInputs(event.phase, preparation.request.digest, history);
  if (!sameValues(event.inputArtifactDigests, expectedInputs)) {
    throw new Error("Preparation phase input artifacts do not match the predecessor chain.");
  }
}

function expectedPhaseInputs(
  phase: FactoryPreparationPhase,
  requestDigest: string,
  history: readonly CanonicalFactoryDocument<FactoryPreparationEvent>[]
): readonly string[] {
  const qualification = successfulOutput(history, "qualify");
  const specification = successfulOutput(history, "specify");
  if (phase === "qualify") return [requestDigest];
  if (phase === "specify") {
    if (qualification === null) throw new Error("Specification has no qualified input artifact.");
    return [requestDigest, qualification];
  }
  if (qualification === null || specification === null) {
    throw new Error("Planning has no qualified specification input artifacts.");
  }
  return [requestDigest, qualification, specification];
}

function successfulOutput(
  history: readonly CanonicalFactoryDocument<FactoryPreparationEvent>[],
  phase: FactoryPreparationPhase
): string | null {
  const event = [...history]
    .reverse()
    .find(({ value }) => value.kind === "phase-succeeded" && value.phase === phase)?.value;
  return event?.kind === "phase-succeeded" ? event.outputArtifact.digest : null;
}

function hasRunCoordinates(
  event: FactoryPreparationEvent
): event is Exclude<
  FactoryPreparationEvent,
  { readonly kind: "registered" | "prepared" | "failed" | "cancelled" | "expired" }
> {
  return (
    event.kind === "phase-succeeded" ||
    event.kind === "phase-failed" ||
    event.kind === "phase-abandoned" ||
    event.kind === "needs-human" ||
    event.kind === "rejected"
  );
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPolicyEngineActor(actor: FactoryPreparationEvent["actor"]): boolean {
  return (
    actor.kind === "control-plane" && actor.role === "policy-engine" && actor.sessionId === null
  );
}
