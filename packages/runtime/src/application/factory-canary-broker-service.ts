import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryPullRequestRecord,
  type FactorySchedulePolicy,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryCanaryBrokerQueue,
  FactoryCanaryBrokerQueueItem
} from "../domain/factory-canary-broker-queue.js";
import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import { ConflictError } from "../domain/errors.js";
import type { FactoryPullRequestService } from "./factory-pull-request-service.js";

const tickCommandSchema = z
  .object({
    expectedSchedulePolicyDigest: sha256DigestSchema,
    expectedFactoryPolicyBundleDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema
  })
  .strict();

export interface FactoryCanaryBrokerTaskResult {
  readonly taskId: string;
  readonly reservationDigest: Sha256Digest;
  readonly source: "undispatched" | "recoverable";
  readonly status: "completed" | "expired" | "blocked" | "denied" | "needs-human";
  readonly reasonCodes: readonly string[];
  readonly pullRequestNumber: number | null;
}

export interface FactoryCanaryBrokerTickReport {
  readonly schemaVersion: "agentlab.canary-broker-tick-result.v1";
  readonly status: "idle" | "completed" | "attention-required" | "blocked";
  readonly repositoryId: string;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly observedAt: string;
  readonly candidatesInspected: number;
  readonly dispatchAttempts: number;
  readonly draftsCompleted: number;
  readonly hasMore: boolean;
  readonly reasonCodes: readonly string[];
  readonly tasks: readonly FactoryCanaryBrokerTaskResult[];
}

export interface FactoryCanaryBrokerServiceDependencies {
  readonly repositoryId: string;
  readonly schedulePolicy: CanonicalFactoryDocument<FactorySchedulePolicy>;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly costPolicyConfigured: boolean;
  readonly queue: Pick<FactoryCanaryBrokerQueue, "listPending">;
  readonly pullRequests: Pick<FactoryPullRequestService, "openDraft">;
  readonly now: () => string;
}

/** Reconciles broker-authorized scheduler handoffs through the existing durable dispatch journal. */
export class FactoryCanaryBrokerService {
  public constructor(private readonly dependencies: FactoryCanaryBrokerServiceDependencies) {}

  public async tick(input: unknown): Promise<FactoryCanaryBrokerTickReport> {
    const command = tickCommandSchema.parse(input);
    this.#assertPolicyPins(command);
    const observedAt = factoryTimestampSchema.parse(this.dependencies.now());
    if (!this.dependencies.costPolicyConfigured) {
      return this.#report(observedAt, "blocked", [], false, ["cost-policy-unconfigured"]);
    }
    const policy = this.dependencies.schedulePolicy.value;
    const page = await this.dependencies.queue.listPending({
      repositoryId: this.dependencies.repositoryId,
      observedAt,
      limit: policy.maximumCandidatesPerTick
    });
    if (page.items.length === 0) {
      return this.#report(observedAt, "idle", [], page.truncated, []);
    }

    const tasks: FactoryCanaryBrokerTaskResult[] = [];
    let dispatchAttempts = 0;
    let hasMore = page.truncated;
    for (const [index, item] of page.items.entries()) {
      this.#assertCandidate(item);
      if (dispatchAttempts >= policy.maximumTasksPerTick) {
        hasMore = true;
        break;
      }
      const currentTime = factoryTimestampSchema.parse(this.dependencies.now());
      if (currentTime < item.finishedAt || currentTime < item.reservedAt) {
        tasks.push(taskResult(item, "blocked", ["canary-broker-clock-regression"], null));
        hasMore ||= index + 1 < page.items.length;
        break;
      }
      if (currentTime >= item.expiresAt) {
        tasks.push(taskResult(item, "expired", ["canary-reservation-expired"], null));
        continue;
      }
      dispatchAttempts += 1;
      const outcome = await this.dependencies.pullRequests.openDraft({
        taskId: item.taskId,
        canary: {
          reservationDigest: item.reservationDigest,
          schedulePolicyDigest: item.schedulePolicyDigest,
          roleIdentityPolicyDigest: item.roleIdentityPolicyDigest
        }
      });
      if (outcome.status === "opened") {
        tasks.push(taskResult(item, "completed", [], outcome.record));
        continue;
      }
      tasks.push(taskResult(item, outcome.status, outcome.reasonCodes, null));
      hasMore ||= index + 1 < page.items.length;
      break;
    }

    const attention = tasks.some(({ status }) => status !== "completed");
    return this.#report(
      observedAt,
      attention ? "attention-required" : "completed",
      tasks,
      hasMore,
      tasks.flatMap(({ reasonCodes }) => reasonCodes),
      dispatchAttempts
    );
  }

  #assertPolicyPins(command: z.infer<typeof tickCommandSchema>): void {
    if (command.expectedSchedulePolicyDigest !== this.dependencies.schedulePolicy.digest) {
      throw new ConflictError("Factory schedule policy changed after broker review.");
    }
    if (command.expectedFactoryPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest) {
      throw new ConflictError("Factory policy bundle changed after broker review.");
    }
    if (command.expectedRoleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicyDigest) {
      throw new ConflictError("Factory role identity policy changed after broker review.");
    }
  }

  #assertCandidate(item: FactoryCanaryBrokerQueueItem): void {
    if (
      item.schedulePolicyDigest !== this.dependencies.schedulePolicy.digest ||
      item.factoryPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest ||
      item.roleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicyDigest ||
      item.handoffSchedulePolicyDigest !== this.dependencies.schedulePolicy.digest ||
      item.handoffFactoryPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest ||
      item.handoffRoleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicyDigest ||
      item.scheduledFor > item.finishedAt ||
      item.reservedAt > item.finishedAt ||
      item.reservedAt >= item.expiresAt
    ) {
      throw new Error(
        "Pending canary broker handoff changed its immutable policy or time identity."
      );
    }
  }

  #report(
    observedAt: string,
    status: FactoryCanaryBrokerTickReport["status"],
    tasks: readonly FactoryCanaryBrokerTaskResult[],
    hasMore: boolean,
    reasonCodes: readonly string[],
    dispatchAttempts = 0
  ): FactoryCanaryBrokerTickReport {
    return {
      schemaVersion: "agentlab.canary-broker-tick-result.v1",
      status,
      repositoryId: this.dependencies.repositoryId,
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      factoryPolicyBundleDigest: this.dependencies.factoryPolicyBundleDigest,
      roleIdentityPolicyDigest: this.dependencies.roleIdentityPolicyDigest,
      observedAt,
      candidatesInspected: tasks.length,
      dispatchAttempts,
      draftsCompleted: tasks.filter(({ status: taskStatus }) => taskStatus === "completed").length,
      hasMore,
      reasonCodes: uniqueSorted(reasonCodes),
      tasks
    };
  }
}

function taskResult(
  item: FactoryCanaryBrokerQueueItem,
  status: FactoryCanaryBrokerTaskResult["status"],
  reasonCodes: readonly string[],
  record: Pick<FactoryPullRequestRecord, "number"> | null
): FactoryCanaryBrokerTaskResult {
  return {
    taskId: item.taskId,
    reservationDigest: item.reservationDigest,
    source: item.source,
    status,
    reasonCodes: uniqueSorted(reasonCodes),
    pullRequestNumber: record?.number ?? null
  };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
