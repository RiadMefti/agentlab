import type { FactoryTaskState } from "@agentlab/contracts";

const transitions: Readonly<Record<FactoryTaskState, readonly FactoryTaskState[]>> = {
  intake: ["qualified", "rejected", "cancelled", "expired"],
  qualified: ["specified", "rejected", "cancelled", "expired"],
  specified: ["planned", "rejected", "cancelled", "expired"],
  planned: ["awaiting-execution-approval", "queued", "rejected", "cancelled", "expired"],
  "awaiting-execution-approval": ["queued", "rejected", "cancelled", "expired"],
  queued: ["executing", "cancelled", "expired", "failed", "quarantined"],
  executing: ["verifying", "needs-attention", "cancelled", "failed", "quarantined"],
  verifying: ["reviewing", "repairing", "needs-attention", "failed", "quarantined"],
  reviewing: ["repairing", "pr-proposed", "needs-attention", "rejected", "quarantined"],
  repairing: ["verifying", "needs-attention", "cancelled", "failed", "quarantined"],
  "pr-proposed": ["pr-open", "repairing", "needs-attention", "rejected", "quarantined"],
  "pr-open": ["repairing", "merge-ready", "needs-attention", "cancelled", "quarantined"],
  "merge-ready": [
    "awaiting-merge-approval",
    "merge-queued",
    "repairing",
    "needs-attention",
    "quarantined"
  ],
  "awaiting-merge-approval": ["merge-queued", "repairing", "rejected", "cancelled", "quarantined"],
  "merge-queued": ["merged", "repairing", "needs-attention", "failed", "quarantined"],
  merged: ["canary", "released", "observing", "quarantined"],
  canary: ["released", "observing", "rolled-back", "quarantined"],
  released: ["observing", "rolled-back", "quarantined"],
  observing: ["completed", "rolled-back", "quarantined"],
  completed: [],
  "needs-attention": [],
  rejected: [],
  cancelled: [],
  expired: [],
  failed: [],
  quarantined: [],
  "rolled-back": []
};

const terminalStates = new Set<FactoryTaskState>([
  "completed",
  "needs-attention",
  "rejected",
  "cancelled",
  "expired",
  "failed",
  "quarantined",
  "rolled-back"
]);

export function allowedFactoryTaskTransitions(
  state: FactoryTaskState
): readonly FactoryTaskState[] {
  return transitions[state];
}

export function isFactoryTaskTransitionAllowed(
  from: FactoryTaskState | null,
  to: FactoryTaskState
): boolean {
  return from === null ? to === "intake" : transitions[from].includes(to);
}

export function isTerminalFactoryTaskState(state: FactoryTaskState): boolean {
  return terminalStates.has(state);
}
