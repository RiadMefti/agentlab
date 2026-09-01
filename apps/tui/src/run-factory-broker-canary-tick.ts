import type { Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryBroker,
  loadLocalFactoryBrokerConfig,
  type FactoryBrokerPreflight,
  type FactoryCanaryBrokerTickReport,
  type LocalFactoryBrokerConfig,
  type LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryBrokerCanaryTickRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryBrokerConfig>;
  readonly createRuntime: (config: LocalFactoryBrokerConfig) => LocalFactoryBrokerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryBrokerCanaryTickRunnerDependencies = {
  loadConfig: loadLocalFactoryBrokerConfig,
  createRuntime: createConfiguredLocalFactoryBroker,
  write: (message) => process.stdout.write(message)
};

/** Reconciles one bounded page of evaluated scheduler handoffs into durable draft dispatches. */
export async function runFactoryBrokerCanaryTick(
  configPath: string,
  expectedSchedulePolicyDigest: string,
  expectedRoleIdentityPolicyDigest: string,
  expectedFactoryPolicyBundleDigest: string,
  dependencies: FactoryBrokerCanaryTickRunnerDependencies = defaultDependencies
): Promise<number> {
  assertInput(
    configPath,
    expectedSchedulePolicyDigest,
    expectedRoleIdentityPolicyDigest,
    expectedFactoryPolicyBundleDigest
  );
  const config = await dependencies.loadConfig(configPath);
  if (config.schemaVersion !== "agentlab.local-factory-broker.v4") {
    throw new Error("Factory canary broker tick requires broker config v4 with daily quotas.");
  }
  const runtime = dependencies.createRuntime(config);
  let preflight: FactoryBrokerPreflight;
  let reconciliation: FactoryCanaryBrokerTickReport | null = null;
  let reasonCodes: readonly string[] = [];
  try {
    preflight = await runtime.commands.preflight();
    if (preflight.policyBundleDigest !== expectedFactoryPolicyBundleDigest) {
      reasonCodes = ["policy-bundle-digest-mismatch"];
    } else if (preflight.status !== "ready") {
      reasonCodes = preflight.reasonCodes;
    } else {
      reconciliation = await runtime.commands.reconcileCanaryDrafts({
        expectedSchedulePolicyDigest,
        expectedRoleIdentityPolicyDigest,
        expectedFactoryPolicyBundleDigest
      });
      assertReportIdentity(
        reconciliation,
        preflight,
        expectedSchedulePolicyDigest,
        expectedRoleIdentityPolicyDigest,
        expectedFactoryPolicyBundleDigest
      );
      reasonCodes = reconciliation.reasonCodes;
    }
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(`${serializeResult(preflight, reconciliation, uniqueSorted(reasonCodes))}\n`);
  return reconciliation !== null &&
    (reconciliation.status === "idle" || reconciliation.status === "completed")
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
    throw new Error("Factory canary broker tick requires a normalized absolute config path.");
  }
  for (const [label, digest] of [
    ["schedule policy", expectedSchedulePolicyDigest],
    ["role policy", expectedRoleIdentityPolicyDigest],
    ["factory policy", expectedFactoryPolicyBundleDigest]
  ] as const) {
    if (!isSha256Digest(digest)) {
      throw new Error(`Factory canary broker tick ${label} digest is invalid.`);
    }
  }
}

function assertReportIdentity(
  report: FactoryCanaryBrokerTickReport,
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
    throw new Error("Factory canary broker tick returned different reviewed coordinates.");
  }
}

function serializeResult(
  preflight: FactoryBrokerPreflight,
  reconciliation: FactoryCanaryBrokerTickReport | null,
  reasonCodes: readonly string[]
): string {
  return JSON.stringify({
    schemaVersion: "agentlab.broker-canary-tick-command-result.v1",
    status: reconciliation?.status ?? "blocked",
    repository: {
      repositoryId: preflight.repository.repositoryId,
      baseBranch: preflight.repository.baseBranch,
      baseRevision: preflight.repository.baseRevision
    },
    policyBundleDigest: preflight.policyBundleDigest,
    reasonCodes,
    reconciliation
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
      "Factory canary broker tick and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
