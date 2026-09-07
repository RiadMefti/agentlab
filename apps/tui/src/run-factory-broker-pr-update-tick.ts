import type { Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryBroker,
  loadLocalFactoryBrokerConfig,
  type FactoryCanaryPullRequestUpdateTickReport,
  type LocalFactoryBrokerConfig,
  type LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryBrokerPullRequestUpdateTickRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryBrokerConfig>;
  readonly createRuntime: (config: LocalFactoryBrokerConfig) => LocalFactoryBrokerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryBrokerPullRequestUpdateTickRunnerDependencies = {
  loadConfig: loadLocalFactoryBrokerConfig,
  createRuntime: createConfiguredLocalFactoryBroker,
  write: (message) => process.stdout.write(message)
};

/** Recovers broker update journals, then publishes one bounded page of completed canary repairs. */
export async function runFactoryBrokerPullRequestUpdateTick(
  configPath: string,
  expectedSchedulePolicyDigest: string,
  expectedRoleIdentityPolicyDigest: string,
  expectedFactoryPolicyBundleDigest: string,
  dependencies: FactoryBrokerPullRequestUpdateTickRunnerDependencies = defaultDependencies
): Promise<number> {
  assertInput(
    configPath,
    expectedSchedulePolicyDigest,
    expectedRoleIdentityPolicyDigest,
    expectedFactoryPolicyBundleDigest
  );
  const config = await dependencies.loadConfig(configPath);
  if (
    config.schemaVersion !== "agentlab.local-factory-broker.v4" &&
    config.schemaVersion !== "agentlab.local-factory-broker.v5"
  ) {
    throw new Error("Factory PR update tick requires broker config v4 or v5 with daily quotas.");
  }
  const runtime = dependencies.createRuntime(config);
  let report: FactoryCanaryPullRequestUpdateTickReport;
  try {
    report = await runtime.commands.updateCanaryPullRequests({
      expectedSchedulePolicyDigest,
      expectedRoleIdentityPolicyDigest,
      expectedFactoryPolicyBundleDigest
    });
    assertReportIdentity(
      report,
      config.repositoryId,
      expectedSchedulePolicyDigest,
      expectedRoleIdentityPolicyDigest,
      expectedFactoryPolicyBundleDigest
    );
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(`${serializeResult(report)}\n`);
  return report.status === "idle" || report.status === "completed" ? 0 : 2;
}

function assertInput(
  configPath: string,
  expectedSchedulePolicyDigest: string,
  expectedRoleIdentityPolicyDigest: string,
  expectedFactoryPolicyBundleDigest: string
): asserts expectedSchedulePolicyDigest is Sha256Digest {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory PR update tick requires a normalized absolute config path.");
  }
  for (const [label, digest] of [
    ["schedule policy", expectedSchedulePolicyDigest],
    ["role policy", expectedRoleIdentityPolicyDigest],
    ["factory policy", expectedFactoryPolicyBundleDigest]
  ] as const) {
    if (!isSha256Digest(digest)) {
      throw new Error(`Factory PR update tick ${label} digest is invalid.`);
    }
  }
}

function assertReportIdentity(
  report: FactoryCanaryPullRequestUpdateTickReport,
  repositoryId: string,
  schedulePolicyDigest: string,
  roleIdentityPolicyDigest: string,
  factoryPolicyBundleDigest: string
): void {
  if (
    report.repositoryId !== repositoryId ||
    report.schedulePolicyDigest !== schedulePolicyDigest ||
    report.roleIdentityPolicyDigest !== roleIdentityPolicyDigest ||
    report.factoryPolicyBundleDigest !== factoryPolicyBundleDigest
  ) {
    throw new Error("Factory PR update tick returned different reviewed coordinates.");
  }
}

function serializeResult(report: FactoryCanaryPullRequestUpdateTickReport): string {
  return JSON.stringify({
    schemaVersion: "agentlab.broker-pr-update-tick-command-result.v1",
    status: report.status,
    repositoryId: report.repositoryId,
    policyBundleDigest: report.factoryPolicyBundleDigest,
    reasonCodes: report.reasonCodes,
    update: report
  });
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
      "Factory PR update tick and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
