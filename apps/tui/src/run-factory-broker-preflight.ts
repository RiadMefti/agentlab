import {
  createConfiguredLocalFactoryBroker,
  loadLocalFactoryBrokerConfig,
  type FactoryBrokerPreflight,
  type LocalFactoryBrokerConfig,
  type LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";

export interface FactoryBrokerPreflightRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryBrokerConfig>;
  readonly createRuntime: (config: LocalFactoryBrokerConfig) => LocalFactoryBrokerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryBrokerPreflightRunnerDependencies = {
  loadConfig: loadLocalFactoryBrokerConfig,
  createRuntime: createConfiguredLocalFactoryBroker,
  write: (message) => process.stdout.write(message)
};

/** Executes readiness without changing authority or GitHub, then closes all resources first. */
export async function runFactoryBrokerPreflight(
  configPath: string,
  dependencies: FactoryBrokerPreflightRunnerDependencies = defaultDependencies
): Promise<number> {
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  const report: FactoryBrokerPreflight = await runtime.commands
    .preflight()
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializePreflight(report)}\n`);
  return report.status === "ready" ? 0 : 2;
}

function serializePreflight(report: FactoryBrokerPreflight): string {
  const governance = report.repository.governance;
  return JSON.stringify({
    schemaVersion: report.schemaVersion,
    status: report.status,
    repository: {
      repositoryId: report.repository.repositoryId,
      baseBranch: report.repository.baseBranch,
      baseRevision: report.repository.baseRevision,
      governance: {
        requiresPullRequest: governance.requiresPullRequest,
        requiredApprovals: governance.requiredApprovals,
        dismissesStaleReviews: governance.dismissesStaleReviews,
        requiresCodeOwnerReviews: governance.requiresCodeOwnerReviews,
        requiresLastPushApproval: governance.requiresLastPushApproval,
        enforcesAdmins: governance.enforcesAdmins,
        allowsForcePushes: governance.allowsForcePushes,
        allowsDeletions: governance.allowsDeletions,
        requiredStatusChecks: [...governance.requiredStatusChecks].sort()
      }
    },
    policyBundleDigest: report.policyBundleDigest,
    authorityEnabled: report.authorityEnabled,
    reasonCodes: [...report.reasonCodes].sort()
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
      "Factory broker preflight and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
