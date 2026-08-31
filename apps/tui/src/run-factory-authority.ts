import {
  createConfiguredLocalFactoryAuthority,
  loadLocalFactoryAuthorityConfig,
  type FactoryAuthorityInspection,
  type FactoryBrokerAuthorityChange,
  type FactoryBrokerAuthorityCommand,
  type FactorySchedulerAuthorityChange,
  type FactorySchedulerAuthorityCommand,
  type LocalFactoryAuthorityConfig,
  type LocalFactoryAuthorityRuntime
} from "@agentlab/runtime/factory-authority";

export interface FactoryAuthorityRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryAuthorityConfig>;
  readonly createRuntime: (config: LocalFactoryAuthorityConfig) => LocalFactoryAuthorityRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryAuthorityRunnerDependencies = {
  loadConfig: loadLocalFactoryAuthorityConfig,
  createRuntime: createConfiguredLocalFactoryAuthority,
  write: (message) => process.stdout.write(message)
};

/** Inspects local authority without loading broker credentials or changing either control. */
export async function runFactoryAuthorityStatus(
  configPath: string,
  dependencies: FactoryAuthorityRunnerDependencies = defaultDependencies
): Promise<number> {
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  const inspection = await runtime.commands
    .inspect()
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializeInspection(inspection)}\n`);
  return 0;
}

/** Performs one explicit compare-and-set of the local draft-PR authority, then closes first. */
export async function runFactoryBrokerAuthority(
  configPath: string,
  expectedEnabled: boolean,
  enabled: boolean,
  reason: string,
  confirmation: FactoryBrokerAuthorityCommand["confirmation"],
  dependencies: FactoryAuthorityRunnerDependencies = defaultDependencies
): Promise<number> {
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  const command: FactoryBrokerAuthorityCommand = {
    expectedEnabled,
    enabled,
    reason,
    confirmation
  };
  const change = await runtime.commands
    .setBrokerAuthority(command)
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializeChange(change)}\n`);
  return 0;
}

/** Performs one explicit compare-and-set of autonomous scheduling authority, then closes first. */
export async function runFactorySchedulerAuthority(
  configPath: string,
  expectedEnabled: boolean,
  enabled: boolean,
  reason: string,
  confirmation: FactorySchedulerAuthorityCommand["confirmation"],
  dependencies: FactoryAuthorityRunnerDependencies = defaultDependencies
): Promise<number> {
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  const command: FactorySchedulerAuthorityCommand = {
    expectedEnabled,
    enabled,
    reason,
    confirmation
  };
  const change = await runtime.commands
    .setSchedulerAuthority(command)
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializeChange(change)}\n`);
  return 0;
}

function serializeInspection(inspection: FactoryAuthorityInspection): string {
  return JSON.stringify({
    schemaVersion: inspection.schemaVersion,
    schedulerEnabled: inspection.schedulerEnabled,
    prBrokerEnabled: inspection.prBrokerEnabled,
    recentSchedulerEvents: inspection.recentSchedulerEvents,
    recentBrokerEvents: inspection.recentBrokerEvents
  });
}

function serializeChange(
  change: FactoryBrokerAuthorityChange | FactorySchedulerAuthorityChange
): string {
  return JSON.stringify({
    schemaVersion: change.schemaVersion,
    changed: change.changed,
    schedulerEnabled: change.schedulerEnabled,
    prBrokerEnabled: change.prBrokerEnabled,
    event: change.event,
    eventDigest: change.eventDigest
  });
}

async function closeAfterFailure(
  runtime: LocalFactoryAuthorityRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory authority operation and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
