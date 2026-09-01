import type {
  FactoryDailyQuotaReservation,
  FactoryScheduleEvent,
  FactoryScheduleRun,
  FactoryScheduleRunState,
  ImmutableTaskContract,
  TaskEvent
} from "@agentlab/contracts";

import type { FactoryAuthorityState } from "./factory-task-repository.js";

export interface FactoryOperationsScheduleObservation {
  readonly run: FactoryScheduleRun;
  readonly state: FactoryScheduleRunState;
  readonly lastEvent: FactoryScheduleEvent;
}

export interface FactoryOperationsTaskObservation {
  readonly contract: ImmutableTaskContract;
  readonly state: TaskEvent["to"];
  readonly lastEvent: TaskEvent;
}

export interface FactoryOperationsHealthObservation {
  readonly authority: FactoryAuthorityState;
  readonly schedules: readonly FactoryOperationsScheduleObservation[];
  readonly tasks: readonly FactoryOperationsTaskObservation[];
  readonly dailyQuotaReservations: readonly FactoryDailyQuotaReservation[];
  readonly truncatedSections: readonly ("schedules" | "tasks" | "daily-quotas")[];
}

export interface FactoryOperationsHealthQuery {
  readonly lookbackStartedAt: string;
  readonly observedAt: string;
  readonly quotaWindowStart: string;
  readonly organizationId: string;
  readonly repositoryIds: readonly string[];
  readonly maximumRecordsPerSection: number;
}

/** Credentialless read-only projection port over existing append-only factory journals. */
export interface FactoryOperationsHealthSource {
  observe(query: FactoryOperationsHealthQuery): Promise<FactoryOperationsHealthObservation>;
  close(): void;
}
