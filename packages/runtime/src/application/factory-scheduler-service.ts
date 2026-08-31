import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryBudgetUsage,
  type FactoryScheduleEvent,
  type FactorySchedulePolicy,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError } from "../domain/errors.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type {
  FactoryPreparationRepository,
  FactoryPreparationSnapshot
} from "../domain/factory-preparation-repository.js";
import {
  addReservation,
  emptyReservedUsage,
  exceedsBudget
} from "../domain/factory-schedule-integrity.js";
import type {
  FactoryScheduleRepository,
  FactoryScheduleRunSnapshot
} from "../domain/factory-schedule-repository.js";
import { resolveFactoryDailyScheduleSlot } from "../domain/factory-schedule-time.js";
import type { FactoryWorkerOperator, FactoryWorkerPreflight } from "./factory-worker-operator.js";
import type {
  FactoryWorkerTaskRunner,
  FactoryWorkerTaskRunReport
} from "./factory-worker-task-runner.js";

const schedulerTickCommandSchema = z
  .object({
    expectedSchedulePolicyDigest: sha256DigestSchema,
    expectedFactoryPolicyBundleDigest: sha256DigestSchema
  })
  .strict();

export interface FactorySchedulerTickReport {
  readonly schemaVersion: "agentlab.scheduler-tick-result.v1";
  readonly status: "completed" | "already-completed" | "missed-deadline" | "blocked";
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly scheduledFor: string;
  readonly deadlineAt: string;
  readonly runId: string | null;
  readonly runDigest: Sha256Digest | null;
  readonly tasksClaimed: number;
  readonly tasksFinished: number;
  readonly tasksSkipped: number;
  readonly reservedUsage: FactoryBudgetUsage;
  readonly reasonCodes: readonly string[];
}

export interface FactorySchedulerServiceDependencies {
  readonly schedulePolicy: CanonicalFactoryDocument<FactorySchedulePolicy>;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly schedules: FactoryScheduleRepository;
  readonly preparations: Pick<FactoryPreparationRepository, "listScheduled">;
  readonly worker: Pick<FactoryWorkerOperator, "preflight">;
  readonly taskRunner: Pick<FactoryWorkerTaskRunner, "run">;
  readonly documents: Pick<
    FactoryDocumentCodec,
    "schedulePolicy" | "scheduleRun" | "scheduleEvent"
  >;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Runs one bounded UTC daily slot; it owns no broker, credential, merge, or release capability. */
export class FactorySchedulerService {
  public constructor(private readonly dependencies: FactorySchedulerServiceDependencies) {}

  public async tick(input: unknown): Promise<FactorySchedulerTickReport> {
    const command = schedulerTickCommandSchema.parse(input);
    this.#assertPolicyPins(command);
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    const slot = resolveFactoryDailyScheduleSlot(this.dependencies.schedulePolicy.value, now);
    const open = await this.dependencies.schedules.findOpen();
    let snapshot: FactoryScheduleRunSnapshot | null;
    if (open !== null) {
      if (open.state === "completed") {
        throw new Error("Factory schedule repository returned a completed run as open.");
      }
      if (now < open.run.scheduledFor || now < open.lastEvent.occurredAt) {
        return this.#report("blocked", open, ["open-schedule-clock-regression"]);
      }
      if (!this.#runUsesCurrentPolicies(open)) {
        return this.#report("blocked", open, ["open-schedule-policy-drift"]);
      }
      this.#assertRunIdentity(open, open.run.scheduledFor, open.run.deadlineAt);
      snapshot = open;
    } else {
      snapshot = await this.dependencies.schedules.findBySlot(
        this.dependencies.schedulePolicy.value.id,
        slot.scheduledFor
      );
      if (snapshot !== null) {
        if (!this.#runUsesCurrentPolicies(snapshot)) {
          return this.#report("blocked", snapshot, ["schedule-slot-policy-drift"]);
        }
        this.#assertRunIdentity(snapshot, slot.scheduledFor, slot.deadlineAt);
        if (snapshot.state === "completed") {
          return this.#report("already-completed", snapshot, []);
        }
      } else if (slot.status === "missed-deadline") {
        return emptyReport(
          "missed-deadline",
          this.dependencies.schedulePolicy.digest,
          this.dependencies.factoryPolicyBundleDigest,
          slot.scheduledFor,
          slot.deadlineAt,
          ["schedule-start-deadline-missed"]
        );
      }
    }

    const preflight = await this.dependencies.worker.preflight();
    if (preflight.status !== "ready") {
      return snapshot === null
        ? emptyReport(
            "blocked",
            this.dependencies.schedulePolicy.digest,
            this.dependencies.factoryPolicyBundleDigest,
            slot.scheduledFor,
            slot.deadlineAt,
            preflight.reasonCodes
          )
        : this.#report("blocked", snapshot, preflight.reasonCodes);
    }
    this.#assertPreflight(preflight);
    snapshot ??= await this.#register(slot.scheduledFor, slot.deadlineAt, now);
    if (snapshot.state === "completed") {
      return this.#report("already-completed", snapshot, []);
    }
    snapshot = await this.#finishActiveTask(snapshot);

    const policy = this.dependencies.schedulePolicy.value;
    const selectedTaskIds = new Set(
      snapshot.events.flatMap((event) =>
        event.kind === "task-claimed" || event.kind === "task-skipped" ? [event.taskId] : []
      )
    );
    let claims = countEvents(snapshot.events, "task-claimed");
    const candidates = await this.dependencies.preparations.listScheduled(
      policy.maximumCandidatesPerTick
    );
    for (const candidate of candidates) {
      if (claims >= policy.maximumTasksPerTick) break;
      if (selectedTaskIds.has(candidate.request.taskId)) continue;
      this.#assertCandidate(candidate);
      const currentUsage = reservedUsage(snapshot.events);
      const prospectiveUsage = addReservation(currentUsage, candidate.authority.budgetCeiling);
      if (exceedsBudget(prospectiveUsage, policy.tickBudget)) {
        snapshot = await this.#skip(snapshot, candidate, "tick-budget-exceeded");
        selectedTaskIds.add(candidate.request.taskId);
        continue;
      }
      snapshot = await this.#claim(snapshot, candidate);
      selectedTaskIds.add(candidate.request.taskId);
      claims += 1;
      snapshot = await this.#finishActiveTask(snapshot);
    }
    snapshot = await this.#complete(snapshot);
    return this.#report("completed", snapshot, []);
  }

  #assertPolicyPins(command: z.infer<typeof schedulerTickCommandSchema>): void {
    if (command.expectedSchedulePolicyDigest !== this.dependencies.schedulePolicy.digest) {
      throw new ConflictError("Factory schedule policy changed after operator review.");
    }
    if (command.expectedFactoryPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest) {
      throw new ConflictError("Factory policy bundle changed after scheduler review.");
    }
  }

  #assertPreflight(preflight: FactoryWorkerPreflight): void {
    if (
      preflight.policyBundleDigest !== this.dependencies.factoryPolicyBundleDigest ||
      preflight.schedulePolicyDigest !== this.dependencies.schedulePolicy.digest ||
      !preflight.schedulerEnabled ||
      !preflight.costPolicyConfigured ||
      !preflight.hostReady
    ) {
      throw new Error("Ready scheduler preflight returned inconsistent authority or policy state.");
    }
  }

  async #register(
    scheduledFor: string,
    deadlineAt: string,
    createdAt: string
  ): Promise<FactoryScheduleRunSnapshot> {
    const run = this.dependencies.documents.scheduleRun({
      schemaVersion: "agentlab.schedule-run.v1",
      runId: this.dependencies.createId(),
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      schedulePolicy: this.dependencies.schedulePolicy.value,
      factoryPolicyBundleDigest: this.dependencies.factoryPolicyBundleDigest,
      scheduledFor,
      deadlineAt,
      createdAt,
      correlationId: this.dependencies.createId()
    });
    const event = this.dependencies.documents.scheduleEvent({
      ...eventIdentity(run.value.runId, run.digest, run.value.correlationId),
      eventId: this.dependencies.createId(),
      sequence: 1,
      previousEventDigest: null,
      kind: "registered",
      from: null,
      to: "ready",
      actor: schedulerActor(),
      occurredAt: createdAt,
      reasonCode: "schedule-slot-registered"
    });
    try {
      return await this.dependencies.schedules.register(run, event);
    } catch (error: unknown) {
      const existing = await this.dependencies.schedules.findBySlot(
        this.dependencies.schedulePolicy.value.id,
        scheduledFor
      );
      if (existing === null) throw error;
      this.#assertRunIdentity(existing, scheduledFor, deadlineAt);
      return existing;
    }
  }

  async #claim(
    snapshot: FactoryScheduleRunSnapshot,
    candidate: FactoryPreparationSnapshot
  ): Promise<FactoryScheduleRunSnapshot> {
    const taskCorrelationId = this.dependencies.createId();
    return this.#append(snapshot, {
      ...this.#nextEvent(snapshot),
      kind: "task-claimed",
      from: "ready",
      to: "task-active",
      taskId: candidate.request.taskId,
      requestDigest: candidate.requestDigest,
      authorityDigest: candidate.authorityDigest,
      taskCorrelationId,
      reservation: candidate.authority.budgetCeiling,
      reasonCode: "scheduled-task-claimed"
    });
  }

  async #skip(
    snapshot: FactoryScheduleRunSnapshot,
    candidate: FactoryPreparationSnapshot,
    skipReason: string
  ): Promise<FactoryScheduleRunSnapshot> {
    return this.#append(snapshot, {
      ...this.#nextEvent(snapshot),
      kind: "task-skipped",
      from: "ready",
      to: "ready",
      taskId: candidate.request.taskId,
      requestDigest: candidate.requestDigest,
      authorityDigest: candidate.authorityDigest,
      skipReason,
      reasonCode: skipReason
    });
  }

  async #finishActiveTask(
    snapshot: FactoryScheduleRunSnapshot
  ): Promise<FactoryScheduleRunSnapshot> {
    if (snapshot.state !== "task-active") return snapshot;
    const claim = snapshot.lastEvent;
    if (claim.kind !== "task-claimed") {
      throw new Error("Active factory schedule run is missing its exact task claim.");
    }
    const result = await this.dependencies.taskRunner.run({
      taskId: claim.taskId,
      correlationId: claim.taskCorrelationId,
      expectedPolicyBundleDigest: this.dependencies.factoryPolicyBundleDigest
    });
    this.#assertTaskResult(claim, result);
    return this.#append(snapshot, {
      ...this.#nextEvent(snapshot),
      kind: "task-finished",
      from: "task-active",
      to: "ready",
      taskId: claim.taskId,
      taskCorrelationId: claim.taskCorrelationId,
      result: result.status,
      preparationState: result.preparationState,
      taskState: result.taskState,
      contractDigest: result.contractDigest,
      reasonCodes: [...result.reasonCodes],
      reasonCode: `scheduled-task-${result.status}`
    });
  }

  async #complete(snapshot: FactoryScheduleRunSnapshot): Promise<FactoryScheduleRunSnapshot> {
    if (snapshot.state === "completed") return snapshot;
    if (snapshot.state !== "ready") {
      throw new Error("Factory schedule run cannot complete while task work is active.");
    }
    return this.#append(snapshot, {
      ...this.#nextEvent(snapshot),
      kind: "completed",
      from: "ready",
      to: "completed",
      tasksClaimed: countEvents(snapshot.events, "task-claimed"),
      tasksFinished: countEvents(snapshot.events, "task-finished"),
      tasksSkipped: countEvents(snapshot.events, "task-skipped"),
      reservedUsage: reservedUsage(snapshot.events),
      reasonCode: "schedule-slot-completed"
    });
  }

  async #append(
    snapshot: FactoryScheduleRunSnapshot,
    eventValue: FactoryScheduleEvent
  ): Promise<FactoryScheduleRunSnapshot> {
    const event = this.dependencies.documents.scheduleEvent(eventValue);
    const appended = await this.dependencies.schedules.append(event);
    if (appended === null) {
      throw new ConflictError("Factory schedule event chain advanced concurrently.");
    }
    return appended;
  }

  #nextEvent(snapshot: FactoryScheduleRunSnapshot) {
    return {
      schemaVersion: "agentlab.schedule-event.v1" as const,
      eventId: this.dependencies.createId(),
      runId: snapshot.run.runId,
      runDigest: snapshot.runDigest,
      sequence: snapshot.sequence + 1,
      previousEventDigest: snapshot.lastEventDigest,
      actor: schedulerActor(),
      occurredAt: factoryTimestampSchema.parse(this.dependencies.now()),
      correlationId: snapshot.run.correlationId
    };
  }

  #assertRunIdentity(
    snapshot: FactoryScheduleRunSnapshot,
    scheduledFor: string,
    deadlineAt: string
  ): void {
    if (
      !this.#runUsesCurrentPolicies(snapshot) ||
      snapshot.run.scheduledFor !== scheduledFor ||
      snapshot.run.deadlineAt !== deadlineAt
    ) {
      throw new Error(
        "Stored factory schedule run does not match current immutable slot identity."
      );
    }
  }

  #runUsesCurrentPolicies(snapshot: FactoryScheduleRunSnapshot): boolean {
    const storedPolicy = this.dependencies.documents.schedulePolicy(snapshot.run.schedulePolicy);
    return (
      storedPolicy.digest === snapshot.run.schedulePolicyDigest &&
      snapshot.run.schedulePolicyDigest === this.dependencies.schedulePolicy.digest &&
      snapshot.run.factoryPolicyBundleDigest === this.dependencies.factoryPolicyBundleDigest
    );
  }

  #assertCandidate(candidate: FactoryPreparationSnapshot): void {
    if (
      candidate.request.trigger !== "scheduled" ||
      candidate.authority.taskId !== candidate.request.taskId ||
      candidate.authority.requestDigest !== candidate.requestDigest ||
      candidate.authority.policyBundleDigest !== this.dependencies.factoryPolicyBundleDigest
    ) {
      throw new Error("Factory scheduler candidate failed immutable authority validation.");
    }
  }

  #assertTaskResult(
    claim: Extract<FactoryScheduleEvent, { readonly kind: "task-claimed" }>,
    result: FactoryWorkerTaskRunReport
  ): void {
    if (
      result.taskId !== claim.taskId ||
      result.correlationId !== claim.taskCorrelationId ||
      result.policyBundleDigest !== this.dependencies.factoryPolicyBundleDigest
    ) {
      throw new Error("Factory scheduled worker returned different durable coordinates.");
    }
  }

  #report(
    status: FactorySchedulerTickReport["status"],
    snapshot: FactoryScheduleRunSnapshot,
    reasonCodes: readonly string[]
  ): FactorySchedulerTickReport {
    return {
      schemaVersion: "agentlab.scheduler-tick-result.v1",
      status,
      schedulePolicyDigest: snapshot.run.schedulePolicyDigest,
      factoryPolicyBundleDigest: snapshot.run.factoryPolicyBundleDigest,
      scheduledFor: snapshot.run.scheduledFor,
      deadlineAt: snapshot.run.deadlineAt,
      runId: snapshot.run.runId,
      runDigest: snapshot.runDigest,
      tasksClaimed: countEvents(snapshot.events, "task-claimed"),
      tasksFinished: countEvents(snapshot.events, "task-finished"),
      tasksSkipped: countEvents(snapshot.events, "task-skipped"),
      reservedUsage: reservedUsage(snapshot.events),
      reasonCodes: uniqueSorted(reasonCodes)
    };
  }
}

function eventIdentity(runId: string, runDigest: Sha256Digest, correlationId: string) {
  return {
    schemaVersion: "agentlab.schedule-event.v1" as const,
    runId,
    runDigest,
    correlationId
  };
}

function schedulerActor() {
  return {
    kind: "control-plane" as const,
    role: "policy-engine" as const,
    id: "agentlab-scheduler",
    sessionId: null
  };
}

function countEvents(
  events: readonly FactoryScheduleEvent[],
  kind: FactoryScheduleEvent["kind"]
): number {
  return events.filter((event) => event.kind === kind).length;
}

function reservedUsage(events: readonly FactoryScheduleEvent[]): FactoryBudgetUsage {
  return events.reduce<FactoryBudgetUsage>((usage, event) => {
    return event.kind === "task-claimed" ? addReservation(usage, event.reservation) : usage;
  }, emptyReservedUsage());
}

function emptyReport(
  status: FactorySchedulerTickReport["status"],
  schedulePolicyDigest: Sha256Digest,
  factoryPolicyBundleDigest: Sha256Digest,
  scheduledFor: string,
  deadlineAt: string,
  reasonCodes: readonly string[]
): FactorySchedulerTickReport {
  return {
    schemaVersion: "agentlab.scheduler-tick-result.v1",
    status,
    schedulePolicyDigest,
    factoryPolicyBundleDigest,
    scheduledFor,
    deadlineAt,
    runId: null,
    runDigest: null,
    tasksClaimed: 0,
    tasksFinished: 0,
    tasksSkipped: 0,
    reservedUsage: emptyReservedUsage(),
    reasonCodes: uniqueSorted(reasonCodes)
  };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
