import {
  createConfiguredLocalFactoryIntake,
  loadLocalFactoryIntakeConfig,
  type FactoryIntakePreflight,
  type LocalFactoryIntakeConfig,
  type LocalFactoryIntakeRuntime
} from "@agentlab/runtime/factory-intake";

export interface FactoryIntakePreflightRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryIntakeConfig>;
  readonly createRuntime: (config: LocalFactoryIntakeConfig) => LocalFactoryIntakeRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryIntakePreflightRunnerDependencies = {
  loadConfig: loadLocalFactoryIntakeConfig,
  createRuntime: createConfiguredLocalFactoryIntake,
  write: (message) => process.stdout.write(message)
};

/** Reports intake readiness without registering a request, then closes all resources first. */
export async function runFactoryIntakePreflight(
  configPath: string,
  dependencies: FactoryIntakePreflightRunnerDependencies = defaultDependencies
): Promise<number> {
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  const report = await runtime.commands
    .preflight()
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializeFactoryIntakePreflight(report)}\n`);
  return report.status === "ready" ? 0 : 2;
}

export function serializeFactoryIntakePreflight(report: FactoryIntakePreflight): string {
  return JSON.stringify({
    schemaVersion: report.schemaVersion,
    status: report.status,
    repository: report.repository,
    conversation: report.conversation,
    policyBundleDigest: report.policyBundleDigest,
    authority: report.authority,
    skillPackages: [...report.skillPackages].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    ),
    reasonCodes: [...report.reasonCodes].sort()
  });
}

async function closeAfterFailure(
  runtime: LocalFactoryIntakeRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory intake preflight and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
