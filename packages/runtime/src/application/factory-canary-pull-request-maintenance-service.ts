import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactorySchedulePolicy,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryCanaryPullRequestMaintenanceCoordinates,
  FactoryCanaryPullRequestMaintenanceQueue,
  FactoryCanaryPullRequestMaintenanceQueueItem
} from "../domain/factory-canary-pull-request-maintenance.js";
import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import { ConflictError } from "../domain/errors.js";
import { resolveFactoryDailyScheduleSlot } from "../domain/factory-schedule-time.js";
import type { FactoryTaskRepository } from "../domain/factory-task-repository.js";
import type { FactoryPullRequestCanaryAuthority } from "./factory-pull-request-canary-authority.js";
import type { FactoryPullRequestObservationService } from "./factory-pull-request-observation-service.js";
import type { FactoryPullRequestRepairAdmissionService } from "./factory-pull-request-repair-admission-service.js";

const tickCommandSchema = z
  .object({
    expectedSchedulePolicyDigest: sha256DigestSchema,
    expectedFactoryPolicyBundleDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema
  })
  .strict();

export interface FactoryCanaryPullRequestMaintenanceTaskResult {
  readonly taskId: string;
  readonly reservationDigest: Sha256Digest;
  readonly source: "unobserved" | "observed-actionable";
  readonly status:
    "clear" | "pending" | "repair-authorized" | "unsafe" | "expired" | "blocked" | "denied";
  readonly reasonCodes: readonly string[];
  readonly observationDigest: Sha256Digest | null;
  readonly repairAuthorizationDigest: Sha256Digest | null;
}

export interface FactoryCanaryPullRequestMaintenanceTickReport {
  readonly schemaVersion: "agentlab.canary-pull-request-maintenance-tick-result.v1";
  readonly status: "idle" | "completed" | "attention-required" | "blocked";
  readonly repositoryId: string;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly maintenanceSlot: string;
  readonly observedAt: string;
  readonly candidatesInspected: number;
  readonly maintenanceAttempts: number;
  readonly observationsCreated: number;
  readonly repairAuthorizationsCreated: number;
  readonly hasMore: boolean;
  readonly reasonCodes: readonly string[];
  readonly tasks: readonly FactoryCanaryPullRequestMaintenanceTaskResult[];
}

export interface FactoryCanaryPullRequestMaintenanceServiceDependencies {
  readonly repositoryId: string;
  readonly schedulePolicy: CanonicalFactoryDocument<FactorySchedulePolicy>;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly costPolicyConfigured: boolean;
  readonly queue: Pick<FactoryCanaryPullRequestMaintenanceQueue, "listPending">;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly canaryAuthority: Pick<FactoryPullRequestCanaryAuthority, "require">;
  readonly observations: Pick<FactoryPullRequestObservationService, "observe">;
  readonly repairAdmissions: Pick<FactoryPullRequestRepairAdmissionService, "admit">;
  readonly now: () => string;
}

/** Observes one bounded canary PR page and durably authorizes only deterministic repairs. */
export class FactoryCanaryPullRequestMaintenanceService {
  public constructor(
    private readonly dependencies: FactoryCanaryPullRequestMaintenanceServiceDependencies
  ) {}

  public async tick(input: unknown): Promise<FactoryCanaryPullRequestMaintenanceTickReport> {
    const command = tickCommandSchema.parse(input);
    this.#assertPolicyPins(command);
    const observedAt = factoryTimestampSchema.parse(this.dependencies.now());
    const maintenanceSlot = resolveFactoryDailyScheduleSlot(
      this.dependencies.schedulePolicy.value,
      observedAt
    ).scheduledFor;
    if (!this.dependencies.costPolicyConfigured) {
      return this.#report(observedAt, maintenanceSlot, "blocked", [], false, [
        "cost-policy-unconfigured"
      ]);
    }
    const policy = this.dependencies.schedulePolicy.value;
    const page = await this.dependencies.queue.listPending({
      repositoryId: this.dependencies.repositoryId,
      observedAt,
      maintenanceSlot,
      limit: policy.maximumCandidatesPerTick
    });
    if (page.items.length === 0) {
      return this.#report(observedAt, maintenanceSlot, "idle", [], page.truncated, []);
    }

    const tasks: FactoryCanaryPullRequestMaintenanceTaskResult[] = [];
    let maintenanceAttempts = 0;
    let observationsCreated = 0;
    let repairAuthorizationsCreated = 0;
    let hasMore = page.truncated;
    for (const [index, item] of page.items.entries()) {
      this.#assertCandidate(item);
      if (maintenanceAttempts >= policy.maximumTasksPerTick) {
        hasMore = true;
        break;
      }
      const currentTime = factoryTimestampSchema.parse(this.dependencies.now());
      if (
        currentTime < maintenanceSlot ||
        currentTime < item.finishedAt ||
        currentTime < item.reservedAt
      ) {
        tasks.push(taskResult(item, "blocked", ["canary-pr-maintenance-clock-regression"]));
        hasMore ||= index + 1 < page.items.length;
        break;
      }
      if (currentTime >= item.expiresAt) {
        tasks.push(taskResult(item, "expired", ["canary-reservation-expired"]));
        continue;
      }
      maintenanceAttempts += 1;
      const task = await this.dependencies.tasks.findById(item.taskId);
      if (task === null) throw new Error(`Factory task ${item.taskId} does not exist.`);
      const coordinates = this.#coordinates(item, maintenanceSlot);
      let observationDigest = item.observationDigest;
      if (item.source === "unobserved") {
        const outcome = await this.dependencies.observations.observe({
          taskId: item.taskId,
          maintenance: coordinates
        });
        if (outcome.status === "denied") {
          tasks.push(taskResult(item, "denied", outcome.reasonCodes));
          hasMore ||= index + 1 < page.items.length;
          break;
        }
        observationsCreated += 1;
        observationDigest = outcome.observationDigest;
        if (
          outcome.observation.pullRequestRecordDigest !== item.currentPullRequestRecordDigest ||
          outcome.observation.recordedHeadRevision !== item.currentHeadRevision
        ) {
          throw new Error("Canary PR maintenance observed a different durable PR head.");
        }
        if (outcome.assessment.disposition === "clear") {
          tasks.push(taskResult(item, "clear", outcome.assessment.reasonCodes, observationDigest));
          continue;
        }
        if (outcome.assessment.disposition === "pending") {
          tasks.push(
            taskResult(item, "pending", outcome.assessment.reasonCodes, observationDigest)
          );
          continue;
        }
        if (outcome.assessment.disposition === "unsafe") {
          tasks.push(taskResult(item, "unsafe", outcome.assessment.reasonCodes, observationDigest));
          hasMore ||= index + 1 < page.items.length;
          break;
        }
      }
      if (observationDigest === null) {
        throw new Error("Actionable canary PR maintenance lost its observation checkpoint.");
      }
      await this.dependencies.canaryAuthority.require(task, {
        reservationDigest: coordinates.reservationDigest,
        schedulePolicyDigest: coordinates.schedulePolicyDigest,
        roleIdentityPolicyDigest: coordinates.roleIdentityPolicyDigest
      });
      const admission = await this.dependencies.repairAdmissions.admit({
        taskId: item.taskId,
        observationDigest
      });
      if (admission.status === "denied") {
        tasks.push(taskResult(item, "denied", admission.reasonCodes, observationDigest));
        hasMore ||= index + 1 < page.items.length;
        break;
      }
      if (admission.created) repairAuthorizationsCreated += 1;
      tasks.push(
        taskResult(item, "repair-authorized", [], observationDigest, admission.authorizationDigest)
      );
    }

    const attention = tasks.some(({ status }) =>
      ["unsafe", "expired", "blocked", "denied"].includes(status)
    );
    return this.#report(
      observedAt,
      maintenanceSlot,
      attention ? "attention-required" : "completed",
      tasks,
      hasMore,
      tasks.flatMap(({ reasonCodes }) => reasonCodes),
      maintenanceAttempts,
      observationsCreated,
      repairAuthorizationsCreated
    );
  }

  #assertPolicyPins(command: z.infer<typeof tickCommandSchema>): void {
    if (command.expectedSchedulePolicyDigest !== this.dependencies.schedulePolicy.digest) {
      throw new ConflictError("Factory schedule policy changed after PR maintenance review.");
    }
    if (command.expectedFactoryPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest) {
      throw new ConflictError("Factory policy bundle changed after PR maintenance review.");
    }
    if (command.expectedRoleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicyDigest) {
      throw new ConflictError("Factory role identity policy changed after PR maintenance review.");
    }
  }

  #assertCandidate(item: FactoryCanaryPullRequestMaintenanceQueueItem): void {
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
      (item.source === "unobserved") !== (item.observationDigest === null)
    ) {
      throw new Error("Pending canary PR maintenance changed its immutable identity.");
    }
  }

  #coordinates(
    item: FactoryCanaryPullRequestMaintenanceQueueItem,
    maintenanceSlot: string
  ): FactoryCanaryPullRequestMaintenanceCoordinates {
    return {
      reservationDigest: item.reservationDigest,
      schedulePolicyDigest: item.schedulePolicyDigest,
      factoryPolicyBundleDigest: item.factoryPolicyBundleDigest,
      roleIdentityPolicyDigest: item.roleIdentityPolicyDigest,
      scheduledFor: maintenanceSlot
    };
  }

  #report(
    observedAt: string,
    maintenanceSlot: string,
    status: FactoryCanaryPullRequestMaintenanceTickReport["status"],
    tasks: readonly FactoryCanaryPullRequestMaintenanceTaskResult[],
    hasMore: boolean,
    reasonCodes: readonly string[],
    maintenanceAttempts = 0,
    observationsCreated = 0,
    repairAuthorizationsCreated = 0
  ): FactoryCanaryPullRequestMaintenanceTickReport {
    return {
      schemaVersion: "agentlab.canary-pull-request-maintenance-tick-result.v1",
      status,
      repositoryId: this.dependencies.repositoryId,
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      factoryPolicyBundleDigest: this.dependencies.factoryPolicyBundleDigest,
      roleIdentityPolicyDigest: this.dependencies.roleIdentityPolicyDigest,
      maintenanceSlot,
      observedAt,
      candidatesInspected: tasks.length,
      maintenanceAttempts,
      observationsCreated,
      repairAuthorizationsCreated,
      hasMore,
      reasonCodes: uniqueSorted(reasonCodes),
      tasks
    };
  }
}

function taskResult(
  item: FactoryCanaryPullRequestMaintenanceQueueItem,
  status: FactoryCanaryPullRequestMaintenanceTaskResult["status"],
  reasonCodes: readonly string[],
  observationDigest: Sha256Digest | null = item.observationDigest,
  repairAuthorizationDigest: Sha256Digest | null = null
): FactoryCanaryPullRequestMaintenanceTaskResult {
  return {
    taskId: item.taskId,
    reservationDigest: item.reservationDigest,
    source: item.source,
    status,
    reasonCodes: uniqueSorted(reasonCodes),
    observationDigest,
    repairAuthorizationDigest
  };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
