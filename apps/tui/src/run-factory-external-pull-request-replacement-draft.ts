import {
  createConfiguredLocalFactoryExternalPullRequestReplacementDraft,
  loadLocalFactoryExternalPullRequestReplacementDraftConfig,
  type FactoryExternalPullRequestReplacementDraftPreflight,
  type FactoryExternalPullRequestReplacementDraftTickReport,
  type LocalFactoryExternalPullRequestReplacementDraftConfig,
  type LocalFactoryExternalPullRequestReplacementDraftRuntime
} from "@agentlab/runtime/factory-external-pull-request-replacement-draft";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryExternalPullRequestReplacementDraftRunnerDependencies {
  readonly loadConfig: (
    path: string
  ) => Promise<LocalFactoryExternalPullRequestReplacementDraftConfig>;
  readonly createRuntime: (
    config: LocalFactoryExternalPullRequestReplacementDraftConfig
  ) => LocalFactoryExternalPullRequestReplacementDraftRuntime;
  readonly write: (message: string) => void;
}
const defaults: FactoryExternalPullRequestReplacementDraftRunnerDependencies = {
  loadConfig: loadLocalFactoryExternalPullRequestReplacementDraftConfig,
  createRuntime: createConfiguredLocalFactoryExternalPullRequestReplacementDraft,
  write: (message) => process.stdout.write(message)
};

export async function runFactoryExternalPullRequestReplacementDraftPreflight(
  configPath: string,
  dependencies = defaults
): Promise<number> {
  assertConfig(configPath);
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(configPath));
  const report = await runtime.commands
    .preflight()
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serialize(report)}\n`);
  return report.status === "ready" ? 0 : 2;
}
export async function runFactoryExternalPullRequestReplacementDraftTick(
  configPath: string,
  pins: {
    readonly expectedPublicationPolicyDigest: string;
    readonly expectedQualificationPolicyDigest: string;
    readonly expectedRoleIdentityPolicyDigest: string;
  },
  dependencies = defaults
): Promise<number> {
  assertConfig(configPath);
  if (!Object.values(pins).every(isSha256Digest))
    throw new Error("Replacement-draft tick requires exact policy digests.");
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(configPath));
  const report = await runtime.commands
    .tick(pins)
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serialize(report)}\n`);
  return report.status === "completed" || report.status === "idle"
    ? 0
    : report.status === "blocked"
      ? 2
      : 1;
}
function serialize(
  report:
    | FactoryExternalPullRequestReplacementDraftPreflight
    | FactoryExternalPullRequestReplacementDraftTickReport
): string {
  return JSON.stringify({ ...report, reasonCodes: [...report.reasonCodes].sort() });
}
function assertConfig(path: string): void {
  if (!isNormalizedAbsolutePath(path))
    throw new Error("Replacement-draft publication requires a normalized absolute config path.");
}
async function closeAfterFailure(
  runtime: LocalFactoryExternalPullRequestReplacementDraftRuntime,
  primary: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanup: unknown) {
    throw new AggregateError(
      [primary, cleanup],
      "Replacement-draft publication and cleanup both failed.",
      { cause: primary }
    );
  }
  throw primary;
}
