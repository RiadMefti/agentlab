import type {
  FactoryArtifactReference,
  FactoryPreparationEvent,
  FactoryPreparationPhase,
  FactoryQualification,
  FactorySpecification
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import type { FactoryPreparationSnapshot } from "../domain/factory-preparation-repository.js";

export function nextPreparationPhase(
  state: FactoryPreparationSnapshot["state"]
): FactoryPreparationPhase {
  if (state === "registered") return "qualify";
  if (state === "qualified") return "specify";
  if (state === "specified") return "plan";
  throw new Error(`Preparation state ${state} has no executable phase.`);
}

export function preparationPhaseStates(phase: FactoryPreparationPhase) {
  if (phase === "qualify") {
    return { stable: "registered", running: "qualifying", complete: "qualified" } as const;
  }
  if (phase === "specify") {
    return { stable: "qualified", running: "specifying", complete: "specified" } as const;
  }
  return { stable: "specified", running: "planning", complete: "planned" } as const;
}

export function preparationPhaseAttempt(
  history: readonly FactoryPreparationEvent[],
  phase: FactoryPreparationPhase
): number {
  return history.filter((event) => event.kind === "phase-started" && event.phase === phase).length;
}

export function preparationProfile(
  snapshot: FactoryPreparationSnapshot,
  phase: FactoryPreparationPhase
) {
  const profile = snapshot.authority.preparationProfiles.find(
    (candidate) => candidate.phase === phase
  );
  if (profile === undefined) throw new Error(`Preparation authority has no ${phase} profile.`);
  return profile;
}

export function preparationPredecessorDigests(
  requestDigest: string,
  qualification: CanonicalFactoryDocument<FactoryQualification> | null,
  specification: CanonicalFactoryDocument<FactorySpecification> | null,
  phase: FactoryPreparationPhase
): readonly string[] {
  if (phase === "qualify") return [requestDigest];
  if (qualification === null) throw new Error("Preparation has no qualification predecessor.");
  if (phase === "specify") return [requestDigest, qualification.digest];
  if (specification === null) throw new Error("Preparation has no specification predecessor.");
  return [requestDigest, qualification.digest, specification.digest];
}

export function successfulPreparationOutput(
  history: readonly FactoryPreparationEvent[],
  phase: FactoryPreparationPhase
): FactoryArtifactReference | null {
  const event = [...history]
    .reverse()
    .find((candidate) => candidate.kind === "phase-succeeded" && candidate.phase === phase);
  return event?.kind === "phase-succeeded" ? event.outputArtifact : null;
}

export function requirePreparationStart(
  event: FactoryPreparationEvent
): Extract<FactoryPreparationEvent, { readonly kind: "phase-started" }> {
  if (event.kind !== "phase-started") throw new Error("Expected a phase-started event.");
  return event;
}

export function preparationCompletionEventBase(
  snapshot: FactoryPreparationSnapshot,
  started: Extract<FactoryPreparationEvent, { readonly kind: "phase-started" }>,
  occurredAt: string,
  correlationId: string
) {
  return {
    schemaVersion: "agentlab.preparation-event.v1" as const,
    taskId: snapshot.request.taskId,
    sequence: snapshot.sequence + 1,
    requestDigest: snapshot.requestDigest,
    authorityDigest: snapshot.authorityDigest,
    previousEventDigest: snapshot.lastEventDigest,
    phase: started.phase,
    attempt: started.attempt,
    executionId: started.executionId,
    runRequestDigest: started.runRequestDigest,
    occurredAt,
    reasonCode: `${started.phase}-completed`,
    summary: null,
    correlationId
  };
}
