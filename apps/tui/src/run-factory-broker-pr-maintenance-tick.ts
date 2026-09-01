import type { Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryBroker,
  loadLocalFactoryBrokerConfig,
  type FactoryBrokerPreflight,
  type FactoryCanaryPullRequestMaintenanceTickReport,
  type LocalFactoryBrokerConfig,
  type LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryBrokerPullRequestMaintenanceTickRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryBrokerConfig>;
  readonly createRuntime: (config: LocalFactoryBrokerConfig) => LocalFactoryBrokerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryBrokerPullRequestMaintenanceTickRunnerDependencies = {
  loadConfig: loadLocalFactoryBrokerConfig,
  createRuntime: createConfiguredLocalFactoryBroker,
  write: (message) => process.stdout.write(message)
};

/** Observes and qualifies one bounded page of exact canary pull requests. */
export async function runFactoryBrokerPullRequestMaintenanceTick(
  configPath: string,
  expectedSchedulePolicyDigest: string,
  expectedRoleIdentityPolicyDigest: string,
  expectedFactoryPolicyBundleDigest: string,
  dependencies: FactoryBrokerPullRequestMaintenanceTickRunnerDependencies = defaultDependencies
): Promise<number> {
  assertInput(
    configPath,
    expectedSchedulePolicyDigest,
    expectedRoleIdentityPolicyDigest,
    expectedFactoryPolicyBundleDigest
  );
  const config = await dependencies.loadConfig(configPath);
  if (config.schemaVersion !== "agentlab.local-factory-broker.v4") {
    throw new Error("Factory PR maintenance tick requires broker config v4 with daily quotas.");
  }
  const runtime = dependencies.createRuntime(config);
  let preflight: FactoryBrokerPreflight;
  let maintenance: FactoryCanaryPullRequestMaintenanceTickReport | null = null;
  let reasonCodes: readonly string[] = [];
  try {
    preflight = await runtime.commands.preflight();
    if (preflight.policyBundleDigest !== expectedFactoryPolicyBundleDigest) {
      reasonCodes = ["policy-bundle-digest-mismatch"];
    } else if (preflight.status !== "ready") {
      reasonCodes = preflight.reasonCodes;
    } else {
      maintenance = await runtime.commands.maintainCanaryPullRequests({
        expectedSchedulePolicyDigest,
        expectedRoleIdentityPolicyDigest,
        expectedFactoryPolicyBundleDigest
      });
      assertReportIdentity(
        maintenance,
        preflight,
        expectedSchedulePolicyDigest,
        expectedRoleIdentityPolicyDigest,
        expectedFactoryPolicyBundleDigest
      );
      reasonCodes = maintenance.reasonCodes;
    }
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(`${serializeResult(preflight, maintenance, uniqueSorted(reasonCodes))}\n`);
  return maintenance !== null &&
    (maintenance.status === "idle" || maintenance.status === "completed")
    ? 0
    : 2;
}

function assertInput(
  configPath: string,
  expectedSchedulePolicyDigest: string,
  expectedRoleIdentityPolicyDigest: string,
  expectedFactoryPolicyBundleDigest: string
): asserts expectedSchedulePolicyDigest is Sha256Digest {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory PR maintenance tick requires a normalized absolute config path.");
  }
  for (const [label, digest] of [
    ["schedule policy", expectedSchedulePolicyDigest],
    ["role policy", expectedRoleIdentityPolicyDigest],
    ["factory policy", expectedFactoryPolicyBundleDigest]
  ] as const) {
    if (!isSha256Digest(digest)) {
      throw new Error(`Factory PR maintenance tick ${label} digest is invalid.`);
    }
  }
}

function assertReportIdentity(
  report: FactoryCanaryPullRequestMaintenanceTickReport,
  preflight: FactoryBrokerPreflight,
  schedulePolicyDigest: string,
  roleIdentityPolicyDigest: string,
  factoryPolicyBundleDigest: string
): void {
  if (
    report.repositoryId !== preflight.repository.repositoryId ||
    report.schedulePolicyDigest !== schedulePolicyDigest ||
    report.roleIdentityPolicyDigest !== roleIdentityPolicyDigest ||
    report.factoryPolicyBundleDigest !== factoryPolicyBundleDigest
  ) {
    throw new Error("Factory PR maintenance tick returned different reviewed coordinates.");
  }
}

function serializeResult(
  preflight: FactoryBrokerPreflight,
  maintenance: FactoryCanaryPullRequestMaintenanceTickReport | null,
  reasonCodes: readonly string[]
): string {
  return JSON.stringify({
    schemaVersion: "agentlab.broker-pr-maintenance-tick-command-result.v1",
    status: maintenance?.status ?? "blocked",
    repository: {
      repositoryId: preflight.repository.repositoryId,
      baseBranch: preflight.repository.baseBranch,
      baseRevision: preflight.repository.baseRevision
    },
    policyBundleDigest: preflight.policyBundleDigest,
    reasonCodes,
    maintenance
  });
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

async function closeAfterFailure(
  runtime: LocalFactoryBrokerRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory PR maintenance tick and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
