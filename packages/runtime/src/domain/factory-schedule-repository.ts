import type {
  FactoryScheduleEvent,
  FactoryScheduleRun,
  FactoryScheduleRunState,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryScheduleRunSnapshot {
  readonly run: FactoryScheduleRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryScheduleRunState;
  readonly sequence: number;
  readonly lastEvent: FactoryScheduleEvent;
  readonly lastEventDigest: Sha256Digest;
  readonly events: readonly FactoryScheduleEvent[];
}

export interface FactoryScheduledTaskCompletion {
  readonly run: FactoryScheduleRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryScheduleRunState;
  readonly event: Extract<FactoryScheduleEvent, { readonly kind: "task-finished" }>;
}

/** Append-only journal for one policy-pinned autonomous daily slot. */
export interface FactoryScheduleRepository {
  register(
    run: CanonicalFactoryDocument<FactoryScheduleRun>,
    initialEvent: CanonicalFactoryDocument<FactoryScheduleEvent>
  ): Promise<FactoryScheduleRunSnapshot>;
  findById(runId: string): Promise<FactoryScheduleRunSnapshot | null>;
  findBySlot(
    schedulePolicyId: string,
    scheduledFor: string
  ): Promise<FactoryScheduleRunSnapshot | null>;
  findOpen(): Promise<FactoryScheduleRunSnapshot | null>;
  findTaskCompletion(taskId: string): Promise<FactoryScheduledTaskCompletion | null>;
  listEvents(runId: string): Promise<readonly FactoryScheduleEvent[]>;
  append(
    event: CanonicalFactoryDocument<FactoryScheduleEvent>
  ): Promise<FactoryScheduleRunSnapshot | null>;
  close(): void;
}
