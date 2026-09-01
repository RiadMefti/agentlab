import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryPullRequestUpdateRecord,
  type FactorySchedulePolicy,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryCanaryPullRequestUpdateAuthorizationItem,
  FactoryCanaryPullRequestUpdateQueue,
  FactoryCanaryPullRequestUpdateQueueItem
} from "../domain/factory-canary-pull-request-update.js";
import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import { ConflictError } from "../domain/errors.js";
import type {
  FactoryDraftPullRequestBroker,
  FactoryRemoteRepositorySnapshot
} from "../domain/factory-pull-request-broker.js";
import type {
  FactoryControlRepository,
  FactoryTaskRepository,
  FactoryTaskSnapshot
} from "../domain/factory-task-repository.js";
import type { FactoryPullRequestCanaryAuthority } from "./factory-pull-request-canary-authority.js";
import { factoryRepositoryGovernanceDenials } from "./factory-pull-request-policy.js";
import type {
  FactoryPullRequestUpdateOutcome,
  FactoryPullRequestUpdateService
} from "./factory-pull-request-update-service.js";

const tickCommandSchema = z
  .object({
    expectedSchedulePolicyDigest: sha256DigestSchema,
    expectedFactoryPolicyBundleDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema
  })
  .strict();

export interface FactoryCanaryPullRequestUpdateTaskResult {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly authorizationDigest: Sha256Digest;
  readonly repairRunDigest: Sha256Digest;
  readonly source: "authorized" | "recoverable";
  readonly status: "updated" | "recovered" | "expired" | "blocked" | "denied" | "needs-human";
  readonly reasonCodes: readonly string[];
  readonly pullRequestNumber: number | null;
  readonly priorHeadRevision: string | null;
  readonly headRevision: string | null;
  readonly remoteUpdated: boolean;
}

export interface FactoryCanaryPullRequestUpdateTickReport {
  readonly schemaVersion: "agentlab.canary-pull-request-update-tick-result.v1";
  readonly status: "idle" | "completed" | "attention-required" | "blocked";
  readonly repositoryId: string;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly observedAt: string;
  readonly candidatesInspected: number;
  readonly recoveryAttempts: number;
  readonly updateAttempts: number;
  readonly updatesCompleted: number;
  readonly remoteUpdates: number;
  readonly hasMore: boolean;
  readonly reasonCodes: readonly string[];
  readonly tasks: readonly FactoryCanaryPullRequestUpdateTaskResult[];
}

interface BrokerReadiness {
  readonly status: "ready" | "blocked";
  readonly repository: FactoryRemoteRepositorySnapshot;
  readonly reasonCodes: readonly string[];
}

export interface FactoryCanaryPullRequestUpdateServiceDependencies {
  readonly repositoryId: string;
  readonly brokerId: string;
  readonly schedulePolicy: CanonicalFactoryDocument<FactorySchedulePolicy>;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly costPolicyConfigured: boolean;
  readonly queue: Pick<FactoryCanaryPullRequestUpdateQueue, "listPending">;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly remote: Pick<FactoryDraftPullRequestBroker, "inspect">;
  readonly canaryAuthority: Pick<FactoryPullRequestCanaryAuthority, "require">;
  readonly updates: Pick<FactoryPullRequestUpdateService, "update">;
  readonly now: () => string;
}

/** Recovers interrupted broker updates, then publishes exact completed canary repairs. */
export class FactoryCanaryPullRequestUpdateService {
  public constructor(
    private readonly dependencies: FactoryCanaryPullRequestUpdateServiceDependencies
  ) {}

  public async tick(input: unknown): Promise<FactoryCanaryPullRequestUpdateTickReport> {
    const command = tickCommandSchema.parse(input);
    this.#assertPolicyPins(command);
    const observedAt = factoryTimestampSchema.parse(this.dependencies.now());
    const policy = this.dependencies.schedulePolicy.value;
    const page = await this.dependencies.queue.listPending({
      repositoryId: this.dependencies.repositoryId,
      observedAt,
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      factoryPolicyBundleDigest: this.dependencies.factoryPolicyBundleDigest,
      roleIdentityPolicyDigest: this.dependencies.roleIdentityPolicyDigest,
      limit: policy.maximumCandidatesPerTick
    });

    if (page.items.length === 0) {
      const readiness = await this.#readiness();
      return this.#report(
        observedAt,
        readiness.status === "ready" ? "idle" : "blocked",
        [],
        page.truncated,
        readiness.reasonCodes
      );
    }

    const tasks: FactoryCanaryPullRequestUpdateTaskResult[] = [];
    let recoveryAttempts = 0;
    let updateAttempts = 0;
    let updatesCompleted = 0;
    let remoteUpdates = 0;
    let hasMore = page.truncated;
    let readiness: BrokerReadiness | null = null;

    for (const [index, item] of page.items.entries()) {
      this.#assertCandidate(item);
      if (recoveryAttempts + updateAttempts >= policy.maximumTasksPerTick) {
        hasMore = true;
        break;
      }

      const currentTime = factoryTimestampSchema.parse(this.dependencies.now());
      if (item.source === "recoverable") {
        if (currentTime < item.runCreatedAt || currentTime < item.lastEventAt) {
          tasks.push(taskResult(item, "blocked", ["canary-pr-update-recovery-clock-regression"]));
          hasMore ||= index + 1 < page.items.length;
          break;
        }
        recoveryAttempts += 1;
        const outcome = await this.dependencies.updates.update({
          taskId: item.taskId,
          authorizationDigest: item.authorizationDigest
        });
        const result = this.#result(item, outcome, true);
        tasks.push(result);
        if (result.status === "recovered") {
          updatesCompleted += 1;
          if (result.remoteUpdated) remoteUpdates += 1;
          continue;
        }
        hasMore ||= index + 1 < page.items.length;
        break;
      }

      const task = await this.#requireFreshTask(item);
      if (
        currentTime < item.repairFinishedAt ||
        currentTime < item.authorizationCreatedAt ||
        currentTime < item.observationCreatedAt
      ) {
        tasks.push(taskResult(item, "blocked", ["canary-pr-update-clock-regression"]));
        hasMore ||= index + 1 < page.items.length;
        break;
      }
      if (currentTime >= item.expiresAt || currentTime >= task.contract.expiresAt) {
        tasks.push(
          taskResult(item, "expired", [
            currentTime >= item.expiresAt ? "canary-reservation-expired" : "task-contract-expired"
          ])
        );
        continue;
      }

      readiness = await this.#readiness();
      if (readiness.status !== "ready") {
        tasks.push(taskResult(item, "blocked", readiness.reasonCodes));
        hasMore ||= index + 1 < page.items.length;
        break;
      }
      await this.dependencies.canaryAuthority.require(task, {
        reservationDigest: item.reservationDigest,
        schedulePolicyDigest: item.schedulePolicyDigest,
        roleIdentityPolicyDigest: item.roleIdentityPolicyDigest
      });
      updateAttempts += 1;
      const outcome = await this.dependencies.updates.update({
        taskId: item.taskId,
        authorizationDigest: item.authorizationDigest
      });
      const result = this.#result(item, outcome, false);
      tasks.push(result);
      if (result.status === "updated") {
        updatesCompleted += 1;
        if (result.remoteUpdated) remoteUpdates += 1;
        continue;
      }
      hasMore ||= index + 1 < page.items.length;
      break;
    }

    const onlyRecovery = tasks.length > 0 && tasks.every(({ source }) => source === "recoverable");
    if (onlyRecovery && !hasMore) readiness = await this.#readiness();
    const blockedReasons = readiness?.status === "blocked" ? readiness.reasonCodes : [];
    const hasBlockedTask = tasks.some(({ status }) => status === "blocked");
    const hasAttentionTask = tasks.some(({ status }) =>
      ["expired", "denied", "needs-human"].includes(status)
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
      updateAttempts,
      updatesCompleted,
      remoteUpdates
    );
  }

  #assertPolicyPins(command: z.infer<typeof tickCommandSchema>): void {
    if (command.expectedSchedulePolicyDigest !== this.dependencies.schedulePolicy.digest) {
      throw new ConflictError("Factory schedule policy changed after update-consumer review.");
    }
    if (command.expectedFactoryPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest) {
      throw new ConflictError("Factory policy bundle changed after update-consumer review.");
    }
    if (command.expectedRoleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicyDigest) {
      throw new ConflictError("Factory role identity policy changed after update-consumer review.");
    }
  }

  #assertCandidate(item: FactoryCanaryPullRequestUpdateQueueItem): void {
    if (item.repositoryId !== this.dependencies.repositoryId) {
      throw new Error("Pending canary PR update changed its repository identity.");
    }
    if (item.source === "recoverable") {
      if (item.runCreatedAt > item.lastEventAt || item.brokerId !== this.dependencies.brokerId) {
        throw new Error("Recoverable canary PR update changed its immutable broker identity.");
      }
      return;
    }
    if (
      item.brokerId !== this.dependencies.brokerId ||
      item.schedulePolicyDigest !== this.dependencies.schedulePolicy.digest ||
      item.factoryPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest ||
      item.roleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicyDigest ||
      item.handoffSchedulePolicyDigest !== this.dependencies.schedulePolicy.digest ||
      item.handoffFactoryPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest ||
      item.handoffRoleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicyDigest ||
      item.repairRunPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest ||
      item.scheduledFor > item.handoffFinishedAt ||
      item.reservedAt > item.handoffFinishedAt ||
      item.reservedAt >= item.expiresAt ||
      item.maintenanceSlot > item.observationCreatedAt ||
      item.observationCreatedAt > item.authorizationCreatedAt ||
      item.authorizationCreatedAt > item.repairFinishedAt
    ) {
      throw new Error("Authorized canary PR update changed its immutable policy or time identity.");
    }
  }

  async #requireFreshTask(
    item: FactoryCanaryPullRequestUpdateAuthorizationItem
  ): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(item.taskId);
    if (task === null) throw new Error(`Factory task ${item.taskId} does not exist.`);
    if (
      task.state !== "pr-proposed" ||
      task.contract.trigger !== "scheduled" ||
      task.contract.riskTier !== "R1" ||
      task.contract.repository.id !== item.repositoryId ||
      task.contract.gateProfile.policyDigest !== item.factoryPolicyBundleDigest
    ) {
      throw new Error("Authorized canary PR update no longer matches its immutable task.");
    }
    return task;
  }

  async #readiness(): Promise<BrokerReadiness> {
    const [repository, authority] = await Promise.all([
      this.dependencies.remote.inspect(this.dependencies.repositoryId),
      this.dependencies.controls.state()
    ]);
    if (repository.repositoryId !== this.dependencies.repositoryId) {
      throw new Error("Canary PR update readiness returned another repository identity.");
    }
    const reasonCodes = uniqueSorted([
      ...factoryRepositoryGovernanceDenials(repository.governance),
      ...(this.dependencies.costPolicyConfigured ? [] : ["cost-policy-unconfigured"]),
      ...(authority.prBroker ? [] : ["pr-broker-disabled"])
    ]);
    return { status: reasonCodes.length === 0 ? "ready" : "blocked", repository, reasonCodes };
  }

  #result(
    item: FactoryCanaryPullRequestUpdateQueueItem,
    outcome: FactoryPullRequestUpdateOutcome,
    recovery: boolean
  ): FactoryCanaryPullRequestUpdateTaskResult {
    if (outcome.status !== "updated") {
      return taskResult(item, outcome.status, outcome.reasonCodes);
    }
    this.#assertOutcome(item, outcome.record);
    return taskResult(
      item,
      recovery ? "recovered" : "updated",
      [],
      outcome.record,
      outcome.remoteUpdated
    );
  }

  #assertOutcome(
    item: FactoryCanaryPullRequestUpdateQueueItem,
    record: FactoryPullRequestUpdateRecord
  ): void {
    if (
      record.taskId !== item.taskId ||
      record.repositoryId !== item.repositoryId ||
      record.repairAuthorizationDigest !== item.authorizationDigest ||
      record.repairRunDigest !== item.repairRunDigest ||
      record.brokerId !== this.dependencies.brokerId
    ) {
      throw new Error("Canary PR update returned different authorized coordinates.");
    }
  }

  #report(
    observedAt: string,
    status: FactoryCanaryPullRequestUpdateTickReport["status"],
    tasks: readonly FactoryCanaryPullRequestUpdateTaskResult[],
    hasMore: boolean,
    reasonCodes: readonly string[],
    recoveryAttempts = 0,
    updateAttempts = 0,
    updatesCompleted = 0,
    remoteUpdates = 0
  ): FactoryCanaryPullRequestUpdateTickReport {
    return {
      schemaVersion: "agentlab.canary-pull-request-update-tick-result.v1",
      status,
      repositoryId: this.dependencies.repositoryId,
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      factoryPolicyBundleDigest: this.dependencies.factoryPolicyBundleDigest,
      roleIdentityPolicyDigest: this.dependencies.roleIdentityPolicyDigest,
      observedAt,
      candidatesInspected: tasks.length,
      recoveryAttempts,
      updateAttempts,
      updatesCompleted,
      remoteUpdates,
      hasMore,
      reasonCodes: uniqueSorted(reasonCodes),
      tasks
    };
  }
}

function taskResult(
  item: FactoryCanaryPullRequestUpdateQueueItem,
  status: FactoryCanaryPullRequestUpdateTaskResult["status"],
  reasonCodes: readonly string[],
  record: FactoryPullRequestUpdateRecord | null = null,
  remoteUpdated = false
): FactoryCanaryPullRequestUpdateTaskResult {
  return {
    taskId: item.taskId,
    repositoryId: item.repositoryId,
    authorizationDigest: item.authorizationDigest,
    repairRunDigest: item.repairRunDigest,
    source: item.source,
    status,
    reasonCodes: uniqueSorted(reasonCodes),
    pullRequestNumber: record?.number ?? null,
    priorHeadRevision: record?.priorHeadRevision ?? null,
    headRevision: record?.headRevision ?? null,
    remoteUpdated
  };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
