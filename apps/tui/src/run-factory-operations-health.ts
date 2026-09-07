import {
  createConfiguredLocalFactoryOperationsHealth,
  loadLocalFactoryOperationsHealthConfig,
  type LocalFactoryOperationsHealthConfig,
  type LocalFactoryOperationsHealthRuntime
} from "@agentlab/runtime/factory-operations-health";

export interface FactoryOperationsHealthRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryOperationsHealthConfig>;
  readonly createRuntime: (
    config: LocalFactoryOperationsHealthConfig
  ) => LocalFactoryOperationsHealthRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryOperationsHealthRunnerDependencies = {
  loadConfig: loadLocalFactoryOperationsHealthConfig,
  createRuntime: createConfiguredLocalFactoryOperationsHealth,
  write: (message) => process.stdout.write(message)
};

/** Emits one canonical query-only report; nonzero health states are monitor-friendly exit codes. */
export async function runFactoryOperationsHealth(
  configPath: string,
  dependencies: FactoryOperationsHealthRunnerDependencies = defaultDependencies
): Promise<number> {
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  const report = await runtime.commands
    .inspect()
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${JSON.stringify({ report: report.value, reportDigest: report.digest })}\n`);
  if (report.value.status === "critical") return 3;
  if (report.value.status === "degraded") return 2;
  return 0;
}

async function closeAfterFailure(
  runtime: LocalFactoryOperationsHealthRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory operations health observation and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
