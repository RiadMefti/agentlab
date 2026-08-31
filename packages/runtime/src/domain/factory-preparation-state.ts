import type { FactoryPreparationState } from "@agentlab/contracts";

export function isFactoryPreparationTransitionAllowed(
  from: FactoryPreparationState | null,
  to: FactoryPreparationState
): boolean {
  if (from === null) return to === "registered";
  if (to === "cancelled" || to === "expired" || to === "failed") {
    return isFactoryPreparationActiveState(from);
  }
  if (from === "registered") return to === "qualifying";
  if (from === "qualifying") {
    return to === "registered" || to === "qualified" || to === "needs-human" || to === "rejected";
  }
  if (from === "qualified") return to === "specifying";
  if (from === "specifying") return to === "qualified" || to === "specified";
  if (from === "specified") return to === "planning";
  if (from === "planning") return to === "specified" || to === "planned";
  if (from === "planned") return to === "prepared";
  return false;
}

export function isFactoryPreparationActiveState(state: FactoryPreparationState): boolean {
  return (
    state === "registered" ||
    state === "qualifying" ||
    state === "qualified" ||
    state === "specifying" ||
    state === "specified" ||
    state === "planning" ||
    state === "planned"
  );
}

export function isFactoryPreparationRunningState(state: FactoryPreparationState): boolean {
  return state === "qualifying" || state === "specifying" || state === "planning";
}
