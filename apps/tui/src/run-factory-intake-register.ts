import {
  createConfiguredLocalFactoryIntake,
  loadLocalFactoryIntakeConfig,
  loadLocalFactoryIntakeSubmission,
  type FactoryIntakePreflight,
  type FactoryIntakeRegistrationResult,
  type LocalFactoryIntakeConfig,
  type LocalFactoryIntakeRuntime
} from "@agentlab/runtime/factory-intake";
import type { FactoryIntakeSubmission } from "@agentlab/contracts";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryIntakeRegisterRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryIntakeConfig>;
  readonly loadSubmission: (path: string) => Promise<FactoryIntakeSubmission>;
  readonly createRuntime: (config: LocalFactoryIntakeConfig) => LocalFactoryIntakeRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryIntakeRegisterRunnerDependencies = {
  loadConfig: loadLocalFactoryIntakeConfig,
  loadSubmission: loadLocalFactoryIntakeSubmission,
  createRuntime: createConfiguredLocalFactoryIntake,
  write: (message) => process.stdout.write(message)
};

/** Registers one exact owner-confirmed request only after a clean, policy-pinned preflight. */
export async function runFactoryIntakeRegister(
  configPath: string,
  requestPath: string,
  expectedPolicyBundleDigest: string,
  confirmation: string,
  dependencies: FactoryIntakeRegisterRunnerDependencies = defaultDependencies
): Promise<number> {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory intake requires a normalized absolute config path.");
  }
  if (!isNormalizedAbsolutePath(requestPath)) {
    throw new Error("Factory intake requires a normalized absolute request path.");
  }
  if (!isSha256Digest(expectedPolicyBundleDigest)) {
    throw new Error("Factory intake expected policy digest is invalid.");
  }
  if (confirmation !== "register-request") {
    throw new Error("Factory intake requires explicit registration confirmation.");
  }
  const [config, submission] = await Promise.all([
    dependencies.loadConfig(configPath),
    dependencies.loadSubmission(requestPath)
  ]);
  const runtime = dependencies.createRuntime(config);
  let output: string;
  let exitCode: number;
  try {
    const preflight = await runtime.commands.preflight();
    const commandReasons = [
      ...preflight.reasonCodes,
      ...(preflight.policyBundleDigest === expectedPolicyBundleDigest
        ? []
        : ["policy-bundle-digest-mismatch"])
    ];
    if (commandReasons.length > 0) {
      output = blockedResult(preflight, commandReasons);
      exitCode = 2;
    } else {
      const result = await runtime.commands.register({
        submission,
        expectedPolicyBundleDigest,
        confirmation
      });
      output = successfulResult(result);
      exitCode = 0;
    }
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(`${output}\n`);
  return exitCode;
}

function blockedResult(preflight: FactoryIntakePreflight, reasonCodes: readonly string[]): string {
  return JSON.stringify({
    schemaVersion: "agentlab.intake-register-command-result.v1",
    status: "blocked",
    policyBundleDigest: preflight.policyBundleDigest,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    registration: null
  });
}

function successfulResult(result: FactoryIntakeRegistrationResult): string {
  return JSON.stringify({
    schemaVersion: "agentlab.intake-register-command-result.v1",
    status: result.status,
    policyBundleDigest: result.policyBundleDigest,
    reasonCodes: [],
    registration: {
      schemaVersion: result.schemaVersion,
      taskId: result.taskId,
      state: result.state,
      requestKind: result.requestKind,
      conversationId: result.conversationId,
      repository: result.repository,
      deduplicationKey: result.deduplicationKey,
      requestDigest: result.requestDigest,
      authorityDigest: result.authorityDigest,
      skillPackageDigests: [...result.skillPackageDigests].sort()
    }
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
      "Factory intake registration and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
