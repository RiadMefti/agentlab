import {
  createConfiguredLocalFactoryIncidentContainment,
  loadLocalFactoryIncidentContainmentConfig,
  type LocalFactoryIncidentContainmentConfig,
  type LocalFactoryIncidentContainmentRuntime
} from "@agentlab/runtime/factory-incident-containment";
import type { Sha256Digest } from "@agentlab/contracts";

export interface FactoryIncidentContainmentRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryIncidentContainmentConfig>;
  readonly createRuntime: (
    config: LocalFactoryIncidentContainmentConfig
  ) => LocalFactoryIncidentContainmentRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryIncidentContainmentRunnerDependencies = {
  loadConfig: loadLocalFactoryIncidentContainmentConfig,
  createRuntime: createConfiguredLocalFactoryIncidentContainment,
  write: (message) => process.stdout.write(message)
};

/** Runs one fail-closed health check and emits its complete containment result after cleanup. */
export async function runFactoryIncidentContainment(
  configPath: string,
  expectedHealthPolicyDigest: Sha256Digest,
  expectedDailyQuotaPolicyDigest: Sha256Digest,
  dependencies: FactoryIncidentContainmentRunnerDependencies = defaultDependencies
): Promise<number> {
  const config = await dependencies.loadConfig(configPath);
  if (
    config.expectedHealthPolicyDigest !== expectedHealthPolicyDigest ||
    config.expectedDailyQuotaPolicyDigest !== expectedDailyQuotaPolicyDigest
  ) {
    throw new Error("Factory incident containment command policy pins do not match configuration.");
  }
  const runtime = dependencies.createRuntime(config);
  const result = await runtime.commands
    .containIfCritical()
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${JSON.stringify(result)}\n`);
  if (result.report.status === "critical") return 3;
  if (result.report.status === "degraded") return 2;
  return 0;
}

async function closeAfterFailure(
  runtime: LocalFactoryIncidentContainmentRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory incident containment and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
