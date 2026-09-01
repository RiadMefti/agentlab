import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryBudgetUsage,
  type FactorySchedulePolicy,
  type FactoryTaskState,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryCanaryPullRequestRepairAuthorizationItem,
  FactoryCanaryPullRequestRepairQueue,
  FactoryCanaryPullRequestRepairQueueItem,
  FactoryCanaryPullRequestRepairRecoveryItem
} from "../domain/factory-canary-pull-request-repair.js";
import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import { ConflictError } from "../domain/errors.js";
import {
  addReservation,
  emptyReservedUsage,
  exceedsBudget
} from "../domain/factory-schedule-integrity.js";
import type {
  FactoryTaskRepository,
  FactoryTaskSnapshot
} from "../domain/factory-task-repository.js";
import type { FactoryPullRequestCanaryAuthority } from "./factory-pull-request-canary-authority.js";
import type { FactoryPullRequestRepairExecutionOutcome } from "./factory-pull-request-repair-execution-service.js";
import type { FactoryPullRequestRepairRecoveryOutcome } from "./factory-pull-request-repair-recovery-service.js";
import type { FactoryWorkerOperator, FactoryWorkerPreflight } from "./factory-worker-operator.js";

const tickCommandSchema = z
  .object({
    expectedSchedulePolicyDigest: sha256DigestSchema,
    expectedFactoryPolicyBundleDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema
  })
  .strict();

export interface FactoryCanaryPullRequestRepairTaskResult {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly authorizationDigest: Sha256Digest;
  readonly source: "authorized" | "recoverable";
  readonly status:
    | "recovered"
    | "pr-proposed"
    | "already-advanced"
    | "expired"
    | "blocked"
    | "needs-attention"
    | "failed"
    | "quarantined";
  readonly taskState: FactoryTaskState | null;
  readonly reasonCodes: readonly string[];
  readonly repairRunDigest: Sha256Digest | null;
  readonly patchProposalDigest: Sha256Digest | null;
}

export interface FactoryCanaryPullRequestRepairTickReport {
  readonly schemaVersion: "agentlab.canary-pull-request-repair-tick-result.v1";
  readonly status: "idle" | "completed" | "attention-required" | "blocked";
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly observedAt: string;
  readonly candidatesInspected: number;
  readonly recoveryAttempts: number;
  readonly repairAttempts: number;
  readonly repairRunsCreated: number;
  readonly proposalsCreated: number;
  readonly reservedUsage: FactoryBudgetUsage;
  readonly hasMore: boolean;
  readonly reasonCodes: readonly string[];
  readonly tasks: readonly FactoryCanaryPullRequestRepairTaskResult[];
}

export interface FactoryCanaryPullRequestRepairServiceDependencies {
  readonly schedulePolicy: CanonicalFactoryDocument<FactorySchedulePolicy>;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly queue: Pick<FactoryCanaryPullRequestRepairQueue, "listPending">;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly canaryAuthority: Pick<FactoryPullRequestCanaryAuthority, "require">;
  readonly worker: Pick<
    FactoryWorkerOperator,
    "preflight" | "executePullRequestRepair" | "recoverPullRequestRepair"
  >;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Recovers interrupted repairs, then consumes bounded exact canary repair authorizations. */
export class FactoryCanaryPullRequestRepairService {
  public constructor(
    private readonly dependencies: FactoryCanaryPullRequestRepairServiceDependencies
  ) {}

  public async tick(input: unknown): Promise<FactoryCanaryPullRequestRepairTickReport> {
    const command = tickCommandSchema.parse(input);
    this.#assertPolicyPins(command);
    const observedAt = factoryTimestampSchema.parse(this.dependencies.now());
    const policy = this.dependencies.schedulePolicy.value;
    const page = await this.dependencies.queue.listPending({
      observedAt,
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      factoryPolicyBundleDigest: this.dependencies.factoryPolicyBundleDigest,
      roleIdentityPolicyDigest: this.dependencies.roleIdentityPolicyDigest,
      limit: policy.maximumCandidatesPerTick
    });

    if (page.items.length === 0) {
      const readiness = await this.#preflight();
      return this.#report(
        observedAt,
        readiness.status === "ready" ? "idle" : "blocked",
        [],
        page.truncated,
        readiness.reasonCodes
      );
    }

    const tasks: FactoryCanaryPullRequestRepairTaskResult[] = [];
    let recoveryAttempts = 0;
    let repairAttempts = 0;
    let repairRunsCreated = 0;
    let proposalsCreated = 0;
    let reservedUsage = emptyReservedUsage();
    let hasMore = page.truncated;
    let readiness: FactoryWorkerPreflight | null = null;

    for (const [index, item] of page.items.entries()) {
      this.#assertCandidate(item);
      if (recoveryAttempts + repairAttempts >= policy.maximumTasksPerTick) {
        hasMore = true;
        break;
      }

      const currentTime = factoryTimestampSchema.parse(this.dependencies.now());
      if (item.source === "recoverable") {
        if (currentTime < item.lastEventAt || currentTime < item.runCreatedAt) {
          tasks.push(
            taskResult(item, "blocked", null, ["canary-pr-repair-recovery-clock-regression"])
          );
          hasMore ||= index + 1 < page.items.length;
          break;
        }
        recoveryAttempts += 1;
        const recovered = await this.dependencies.worker.recoverPullRequestRepair({
          taskId: item.taskId,
          authorizationDigest: item.authorizationDigest,
          correlationId: this.dependencies.createId()
        });
        this.#assertRecovery(item, recovered);
        tasks.push(
          taskResult(item, "recovered", recovered.task, [recovered.task.lastEvent.reasonCode], {
            repairRunDigest: recovered.execution.runDigest
          })
        );
        continue;
      }

      const task = await this.#requireFreshTask(item);
      if (currentTime < item.authorizationCreatedAt || currentTime < item.observationCreatedAt) {
        tasks.push(taskResult(item, "blocked", task, ["canary-pr-repair-clock-regression"]));
        hasMore ||= index + 1 < page.items.length;
        break;
      }
      if (currentTime >= item.expiresAt || currentTime >= task.contract.expiresAt) {
        tasks.push(
          taskResult(item, "expired", task, [
            currentTime >= item.expiresAt ? "canary-reservation-expired" : "task-contract-expired"
          ])
        );
        continue;
      }

      const prospectiveUsage = addReservation(reservedUsage, task.contract.budget);
      if (exceedsBudget(prospectiveUsage, policy.tickBudget)) {
        tasks.push(taskResult(item, "blocked", task, ["canary-pr-repair-tick-budget-exceeded"]));
        hasMore ||= index + 1 < page.items.length;
        break;
      }

      readiness = await this.#preflight();
      if (readiness.status !== "ready") {
        tasks.push(taskResult(item, "blocked", task, readiness.reasonCodes));
        hasMore ||= index + 1 < page.items.length;
        break;
      }
      await this.dependencies.canaryAuthority.require(task, {
        reservationDigest: item.reservationDigest,
        schedulePolicyDigest: item.schedulePolicyDigest,
        roleIdentityPolicyDigest: item.roleIdentityPolicyDigest
      });
      repairAttempts += 1;
      reservedUsage = prospectiveUsage;
      const outcome = await this.dependencies.worker.executePullRequestRepair({
        taskId: item.taskId,
        authorizationDigest: item.authorizationDigest
      });
      this.#assertExecution(item, outcome);
      if (outcome.created) repairRunsCreated += 1;
      if (outcome.status === "pr-proposed" && outcome.patch !== null) proposalsCreated += 1;
      const reasonCodes = successStatus(outcome.status) ? [] : [outcome.task.lastEvent.reasonCode];
      tasks.push(
        taskResult(item, outcome.status, outcome.task, reasonCodes, {
          repairRunDigest: outcome.repairRunDigest,
          patchProposalDigest: outcome.patch?.digest ?? null
        })
      );
      if (!successStatus(outcome.status)) {
        hasMore ||= index + 1 < page.items.length;
        break;
      }
    }

    const onlyRecovery = tasks.length > 0 && tasks.every(({ source }) => source === "recoverable");
    if (onlyRecovery && !hasMore) readiness = await this.#preflight();
    const blockedReasons = readiness?.status === "blocked" ? readiness.reasonCodes : [];
    const hasBlockedTask = tasks.some(({ status }) => status === "blocked");
    const hasAttentionTask = tasks.some(({ status }) =>
      ["expired", "needs-attention", "failed", "quarantined"].includes(status)
    );
    const status =
      hasBlockedTask || blockedReasons.length > 0
        ? "blocked"
        : hasAttentionTask
          ? "attention-required"
          : "completed";
    return this.#report(
      observedAt,
      status,
      tasks,
      hasMore,
      [...blockedReasons, ...tasks.flatMap(({ reasonCodes }) => reasonCodes)],
      recoveryAttempts,
      repairAttempts,
      repairRunsCreated,
      proposalsCreated,
      reservedUsage
    );
  }

  #assertPolicyPins(command: z.infer<typeof tickCommandSchema>): void {
    if (command.expectedSchedulePolicyDigest !== this.dependencies.schedulePolicy.digest) {
      throw new ConflictError("Factory schedule policy changed after repair-consumer review.");
    }
    if (command.expectedFactoryPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest) {
      throw new ConflictError("Factory policy bundle changed after repair-consumer review.");
    }
    if (command.expectedRoleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicyDigest) {
      throw new ConflictError("Factory role identity policy changed after repair-consumer review.");
    }
  }

  #assertCandidate(item: FactoryCanaryPullRequestRepairQueueItem): void {
    if (item.source === "recoverable") {
      if (item.runCreatedAt > item.lastEventAt) {
        throw new Error("Recoverable PR repair changed its immutable event time identity.");
      }
      return;
    }
    if (
      item.schedulePolicyDigest !== this.dependencies.schedulePolicy.digest ||
      item.factoryPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest ||
      item.roleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicyDigest ||
      item.handoffSchedulePolicyDigest !== this.dependencies.schedulePolicy.digest ||
      item.handoffFactoryPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest ||
      item.handoffRoleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicyDigest ||
      item.scheduledFor > item.finishedAt ||
      item.reservedAt > item.finishedAt ||
      item.reservedAt >= item.expiresAt ||
      item.maintenanceSlot > item.observationCreatedAt ||
      item.observationCreatedAt > item.authorizationCreatedAt
    ) {
      throw new Error("Authorized canary PR repair changed its immutable policy or time identity.");
    }
  }

  async #requireFreshTask(
    item: FactoryCanaryPullRequestRepairAuthorizationItem
  ): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(item.taskId);
    if (task === null) throw new Error(`Factory task ${item.taskId} does not exist.`);
    if (
      task.state !== "pr-open" ||
      task.contract.trigger !== "scheduled" ||
      task.contract.riskTier !== "R1" ||
      task.contract.repository.id !== item.repositoryId ||
      task.contract.gateProfile.policyDigest !== item.factoryPolicyBundleDigest
    ) {
      throw new Error("Authorized canary PR repair no longer matches its immutable task.");
    }
    return task;
  }

  async #preflight(): Promise<FactoryWorkerPreflight> {
    const preflight = await this.dependencies.worker.preflight();
    if (
      preflight.policyBundleDigest !== this.dependencies.factoryPolicyBundleDigest ||
      preflight.schedulePolicyDigest !== this.dependencies.schedulePolicy.digest ||
      preflight.roleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicyDigest ||
      (preflight.status === "ready" &&
        (!preflight.schedulerEnabled || !preflight.costPolicyConfigured || !preflight.hostReady))
    ) {
      throw new Error("Worker repair preflight returned different reviewed authority coordinates.");
    }
    return preflight;
  }

  #assertRecovery(
    item: FactoryCanaryPullRequestRepairRecoveryItem,
    outcome: FactoryPullRequestRepairRecoveryOutcome
  ): void {
    if (
      outcome.task.contract.taskId !== item.taskId ||
      outcome.task.contract.repository.id !== item.repositoryId ||
      outcome.execution.runDigest !== item.repairRunDigest ||
      outcome.execution.run.authorizationDigest !== item.authorizationDigest ||
      outcome.execution.state !== "abandoned"
    ) {
      throw new Error("Recovered PR repair returned different durable coordinates.");
    }
  }

  #assertExecution(
    item: FactoryCanaryPullRequestRepairAuthorizationItem,
    outcome: FactoryPullRequestRepairExecutionOutcome
  ): void {
    if (
      outcome.task.contract.taskId !== item.taskId ||
      outcome.task.contract.repository.id !== item.repositoryId ||
      outcome.authorizationDigest !== item.authorizationDigest ||
      (outcome.status === "already-advanced"
        ? outcome.task.state !== "pr-open"
        : outcome.status !== outcome.task.state)
    ) {
      throw new Error("Canary PR repair returned different authorized coordinates.");
    }
  }

  #report(
    observedAt: string,
    status: FactoryCanaryPullRequestRepairTickReport["status"],
    tasks: readonly FactoryCanaryPullRequestRepairTaskResult[],
    hasMore: boolean,
    reasonCodes: readonly string[],
    recoveryAttempts = 0,
    repairAttempts = 0,
    repairRunsCreated = 0,
    proposalsCreated = 0,
    reservedUsage: FactoryBudgetUsage = emptyReservedUsage()
  ): FactoryCanaryPullRequestRepairTickReport {
    return {
      schemaVersion: "agentlab.canary-pull-request-repair-tick-result.v1",
      status,
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      factoryPolicyBundleDigest: this.dependencies.factoryPolicyBundleDigest,
      roleIdentityPolicyDigest: this.dependencies.roleIdentityPolicyDigest,
      observedAt,
      candidatesInspected: tasks.length,
      recoveryAttempts,
      repairAttempts,
      repairRunsCreated,
      proposalsCreated,
      reservedUsage,
      hasMore,
      reasonCodes: uniqueSorted(reasonCodes),
      tasks
    };
  }
}

function taskResult(
  item: FactoryCanaryPullRequestRepairQueueItem,
  status: FactoryCanaryPullRequestRepairTaskResult["status"],
  task: FactoryTaskSnapshot | null,
  reasonCodes: readonly string[],
  digests: {
    readonly repairRunDigest?: Sha256Digest | null;
    readonly patchProposalDigest?: Sha256Digest | null;
  } = {}
): FactoryCanaryPullRequestRepairTaskResult {
  return {
    taskId: item.taskId,
    repositoryId: item.repositoryId,
    authorizationDigest: item.authorizationDigest,
    source: item.source,
    status,
    taskState: task?.state ?? (item.source === "recoverable" ? item.taskState : null),
    reasonCodes: uniqueSorted(reasonCodes),
    repairRunDigest:
      digests.repairRunDigest ?? (item.source === "recoverable" ? item.repairRunDigest : null),
    patchProposalDigest: digests.patchProposalDigest ?? null
  };
}

function successStatus(
  status: FactoryPullRequestRepairExecutionOutcome["status"]
): status is "pr-proposed" | "already-advanced" {
  return status === "pr-proposed" || status === "already-advanced";
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
