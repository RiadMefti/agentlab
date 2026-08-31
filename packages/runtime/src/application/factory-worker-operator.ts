import type { ProviderId, Sha256Digest } from "@agentlab/contracts";

import type { FactoryWorkerHostInspector } from "../domain/factory-worker-host.js";
import type { FactoryControlRepository } from "../domain/factory-task-repository.js";
import type {
  FactoryExecutionAdmissionOutcome,
  FactoryExecutionAdmissionService
} from "./factory-execution-admission-service.js";
import type {
  FactoryExecutionRecoveryOutcome,
  FactoryExecutionRecoveryService
} from "./factory-execution-recovery-service.js";
import type {
  FactoryExecutionOutcome,
  FactoryExecutionService
} from "./factory-execution-service.js";
import type {
  FactoryPullRequestRepairExecutionOutcome,
  FactoryPullRequestRepairExecutionService
} from "./factory-pull-request-repair-execution-service.js";
import type {
  FactoryPullRequestRepairRecoveryOutcome,
  FactoryPullRequestRepairRecoveryService
} from "./factory-pull-request-repair-recovery-service.js";
import type {
  FactoryPreparationMaterializationResult,
  FactoryPreparationMaterializer
} from "./factory-preparation-materializer.js";
import type { FactoryPreparationService } from "./factory-preparation-service.js";

const requiredGateIds = [
  "architecture",
  "build",
  "format",
  "lint",
  "secret-scan",
  "test",
  "typecheck"
] as const;

type WorkerProviderId = Extract<ProviderId, "codex" | "claude">;

export interface FactoryWorkerPreflight {
  readonly schemaVersion: "agentlab.worker-preflight.v2";
  readonly status: "ready" | "blocked";
  readonly policyBundleDigest: Sha256Digest;
  readonly schedulePolicyDigest: Sha256Digest | null;
  readonly schedulerEnabled: boolean;
  readonly costPolicyConfigured: boolean;
  readonly hostReady: boolean;
  readonly configuredProviders: readonly WorkerProviderId[];
  readonly gateIds: readonly string[];
  readonly reasonCodes: readonly string[];
}

export interface FactoryWorkerOperatorDependencies {
  readonly policyBundleDigest: Sha256Digest;
  readonly schedulePolicyDigest: Sha256Digest | null;
  readonly costPolicyConfigured: boolean;
  readonly configuredProviders: readonly WorkerProviderId[];
  readonly gateIds: readonly string[];
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly host: FactoryWorkerHostInspector;
  readonly preparation: Pick<FactoryPreparationService, "advance" | "recover">;
  readonly materializer: Pick<FactoryPreparationMaterializer, "materialize">;
  readonly admission: Pick<FactoryExecutionAdmissionService, "admit">;
  readonly execution: Pick<FactoryExecutionService, "execute">;
  readonly executionRecovery: Pick<FactoryExecutionRecoveryService, "recover">;
  readonly pullRequestRepair: Pick<FactoryPullRequestRepairExecutionService, "execute">;
  readonly pullRequestRepairRecovery: Pick<FactoryPullRequestRepairRecoveryService, "recover">;
}

/** Credentialless worker boundary; it can observe controls but cannot grant authority. */
export class FactoryWorkerOperator {
  readonly #configuredProviders: readonly WorkerProviderId[];
  readonly #gateIds: readonly string[];

  public constructor(private readonly dependencies: FactoryWorkerOperatorDependencies) {
    const inventory = validateFactoryWorkerInventory(
      dependencies.configuredProviders,
      dependencies.gateIds
    );
    this.#configuredProviders = inventory.configuredProviders;
    this.#gateIds = inventory.gateIds;
  }

  public async preflight(): Promise<FactoryWorkerPreflight> {
    const [authority, host] = await Promise.all([
      this.dependencies.controls.state(),
      this.dependencies.host.inspect()
    ]);
    const reasonCodes = [
      ...host.reasonCodes,
      ...(this.dependencies.costPolicyConfigured ? [] : ["cost-policy-unconfigured"]),
      ...(this.dependencies.schedulePolicyDigest === null ? ["schedule-policy-unconfigured"] : []),
      ...(authority.scheduler ? [] : ["scheduler-disabled"])
    ];
    return {
      schemaVersion: "agentlab.worker-preflight.v2",
      status: reasonCodes.length === 0 ? "ready" : "blocked",
      policyBundleDigest: this.dependencies.policyBundleDigest,
      schedulePolicyDigest: this.dependencies.schedulePolicyDigest,
      schedulerEnabled: authority.scheduler,
      costPolicyConfigured: this.dependencies.costPolicyConfigured,
      hostReady: host.status === "ready",
      configuredProviders: this.#configuredProviders,
      gateIds: this.#gateIds,
      reasonCodes: [...new Set(reasonCodes)].sort()
    };
  }

  public async advancePreparation(input: unknown) {
    await this.#requireOperationalHost();
    return this.dependencies.preparation.advance(input);
  }

  public recoverPreparation(input: unknown) {
    return this.dependencies.preparation.recover(input);
  }

  public async materializePreparation(
    input: unknown
  ): Promise<FactoryPreparationMaterializationResult> {
    this.#requireCostPolicy();
    return this.dependencies.materializer.materialize(input);
  }

  public async admitExecution(input: unknown): Promise<FactoryExecutionAdmissionOutcome> {
    await this.#requireOperationalHost();
    return this.dependencies.admission.admit(input);
  }

  public async execute(input: unknown): Promise<FactoryExecutionOutcome> {
    await this.#requireOperationalHost();
    return this.dependencies.execution.execute(input);
  }

  public recoverExecution(input: unknown): Promise<FactoryExecutionRecoveryOutcome> {
    return this.dependencies.executionRecovery.recover(input);
  }

  public async executePullRequestRepair(
    input: unknown
  ): Promise<FactoryPullRequestRepairExecutionOutcome> {
    await this.#requireOperationalHost();
    return this.dependencies.pullRequestRepair.execute(input);
  }

  public recoverPullRequestRepair(
    input: unknown
  ): Promise<FactoryPullRequestRepairRecoveryOutcome> {
    return this.dependencies.pullRequestRepairRecovery.recover(input);
  }

  async #requireOperationalHost(): Promise<void> {
    this.#requireCostPolicy();
    const host = await this.dependencies.host.inspect();
    if (host.status !== "ready") {
      throw new Error(`Factory worker host is blocked: ${host.reasonCodes.join(", ")}.`);
    }
  }

  #requireCostPolicy(): void {
    if (!this.dependencies.costPolicyConfigured) {
      throw new Error("Factory worker cost policy is not configured.");
    }
  }
}

export function validateFactoryWorkerInventory(
  configuredProviders: readonly WorkerProviderId[],
  gateIds: readonly string[]
): {
  readonly configuredProviders: readonly WorkerProviderId[];
  readonly gateIds: readonly string[];
} {
  return {
    configuredProviders: validatedProviders(configuredProviders),
    gateIds: validatedGates(gateIds)
  };
}

function validatedProviders(input: readonly WorkerProviderId[]): readonly WorkerProviderId[] {
  if (input.length < 1 || input.length > 2 || new Set(input).size !== input.length) {
    throw new Error("Factory worker providers must be one or two unique supported IDs.");
  }
  return [...input].sort();
}

function validatedGates(input: readonly string[]): readonly string[] {
  const sorted = [...input].sort();
  if (
    sorted.length !== requiredGateIds.length ||
    sorted.some((gateId, index) => gateId !== requiredGateIds[index])
  ) {
    throw new Error("Factory worker requires the exact R1 gate set.");
  }
  return sorted;
}
