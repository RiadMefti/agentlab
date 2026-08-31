import type {
  FactoryCostPolicy,
  FactoryPreparationAuthorityGrant,
  FactorySkillPackage
} from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryIntake,
  createLocalFactoryIntake,
  loadLocalFactoryIntakeConfig,
  loadLocalFactoryIntakeSubmission,
  type FactoryIntakeCommandPort,
  type LocalFactoryIntakeConfig,
  type LocalFactoryIntakeOptions,
  type LocalFactoryIntakeRuntime
} from "@agentlab/runtime/factory-intake";
// @ts-expect-error Intake authority must not be exported by the interactive runtime.
import { createLocalFactoryIntake as forbiddenInteractiveIntake } from "@agentlab/runtime";
// @ts-expect-error Intake authority must not be exported by the credential-bearing broker.
import { createLocalFactoryIntake as forbiddenBrokerIntake } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Intake authority must not be exported by the model-bearing worker.
import { createLocalFactoryIntake as forbiddenWorkerIntake } from "@agentlab/runtime/factory-worker";
// @ts-expect-error Intake authority must not be exported by the human switch boundary.
import { createLocalFactoryIntake as forbiddenAuthorityIntake } from "@agentlab/runtime/factory-authority";

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? [keyof Left] extends [keyof Right]
      ? [keyof Right] extends [keyof Left]
        ? true
        : false
      : false
    : false
  : false;
type Assert<Value extends true> = Value;

interface ExpectedOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly conversationId: string;
  readonly operatorId: string;
  readonly gitExecutable: string;
  readonly flockExecutable: string;
  readonly costPolicy: FactoryCostPolicy;
  readonly preparationGrant: FactoryPreparationAuthorityGrant;
  readonly skillPackages: readonly FactorySkillPackage[];
  readonly authorityLifetimeSeconds: number;
  readonly now?: () => string;
  readonly createId?: () => string;
}

export type FactoryIntakePublicApiAssertions = [
  Assert<Equal<LocalFactoryIntakeOptions, ExpectedOptions>>,
  Assert<Equal<keyof FactoryIntakeCommandPort, "preflight" | "register">>,
  Assert<Equal<keyof LocalFactoryIntakeRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryIntake,
      (options: LocalFactoryIntakeOptions) => LocalFactoryIntakeRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryIntake,
      (config: LocalFactoryIntakeConfig) => LocalFactoryIntakeRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryIntakeConfig,
      (pathInput: string) => Promise<LocalFactoryIntakeConfig>
    >
  >,
  Assert<
    Equal<Awaited<ReturnType<typeof loadLocalFactoryIntakeSubmission>>["kind"], "feature" | "bug">
  >
];

void forbiddenInteractiveIntake;
void forbiddenBrokerIntake;
void forbiddenWorkerIntake;
void forbiddenAuthorityIntake;
