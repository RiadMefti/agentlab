import type {
  FactoryCanaryRequest,
  FactoryCanaryApproval,
  FactoryCanaryCohort,
  FactoryRoleIdentityPolicy,
  Sha256Digest
} from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryCanaryAuthority,
  createLocalFactoryCanaryAuthority,
  loadLocalFactoryCanaryAuthorityConfig,
  loadLocalFactoryCanaryRequest,
  type FactoryCanaryAuthorityCommand,
  type FactoryCanaryAuthorityCommandPort,
  type FactoryCanaryAuthorityResult,
  type LocalFactoryCanaryAuthorityConfig,
  type LocalFactoryCanaryAuthorityOptions,
  type LocalFactoryCanaryAuthorityRuntime
} from "@agentlab/runtime/factory-canary-authority";
// @ts-expect-error Human canary authority must not be exported by the interactive runtime.
import { createLocalFactoryCanaryAuthority as forbiddenInteractiveAuthority } from "@agentlab/runtime";
// @ts-expect-error Human canary authority must not be exported by the credential-bearing broker.
import { createLocalFactoryCanaryAuthority as forbiddenBrokerAuthority } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Human canary authority must not be exported by the model-bearing worker.
import { createLocalFactoryCanaryAuthority as forbiddenWorkerAuthority } from "@agentlab/runtime/factory-worker";
// @ts-expect-error Human canary authority must not be reachable through the evaluator.
import { createLocalFactoryCanaryAuthority as forbiddenEvaluatorAuthority } from "@agentlab/runtime/factory-evaluator";

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

type ExpectedConfig =
  | {
      schemaVersion: "agentlab.local-factory-canary-authority.v1";
      databasePath: string;
      operatorId: string;
    }
  | {
      schemaVersion: "agentlab.local-factory-canary-authority.v2";
      databasePath: string;
      operatorId: string;
      runnerId: string;
      trustedPublicKeyPath: string;
      trustedKeyId: Sha256Digest;
      roleIdentityPolicyPath: string;
      expectedRoleIdentityPolicyDigest: Sha256Digest;
      maximumIssuanceDelaySeconds: number;
      maximumAttestationLifetimeSeconds: number;
      readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
    };

interface ExpectedOptions {
  readonly databasePath: string;
  readonly operatorId: string;
  readonly runnerId: string;
  readonly trustedPublicKeyPath: string;
  readonly trustedKeyId: Sha256Digest;
  readonly maximumIssuanceDelaySeconds: number;
  readonly maximumAttestationLifetimeSeconds: number;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  readonly now?: () => string;
  readonly createId?: () => string;
}

interface ExpectedCommand {
  attestationDigest: Sha256Digest;
  request: FactoryCanaryRequest;
  confirmation: "authorize-canary";
}

interface ExpectedResult {
  readonly schemaVersion: "agentlab.canary-authority-result.v2";
  readonly status: "authorized" | "existing";
  readonly approval: Extract<
    FactoryCanaryApproval,
    { readonly schemaVersion: "agentlab.canary-approval.v2" }
  >;
  readonly approvalDigest: Sha256Digest;
  readonly cohort: Extract<
    FactoryCanaryCohort,
    { readonly schemaVersion: "agentlab.canary-cohort.v2" }
  >;
  readonly cohortDigest: Sha256Digest;
}

export type FactoryCanaryAuthorityPublicApiAssertions = [
  Assert<Equal<LocalFactoryCanaryAuthorityConfig, ExpectedConfig>>,
  Assert<Equal<LocalFactoryCanaryAuthorityOptions, ExpectedOptions>>,
  Assert<Equal<FactoryCanaryAuthorityCommand, ExpectedCommand>>,
  Assert<Equal<FactoryCanaryAuthorityResult, ExpectedResult>>,
  Assert<Equal<keyof FactoryCanaryAuthorityCommandPort, "authorize">>,
  Assert<Equal<keyof LocalFactoryCanaryAuthorityRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryCanaryAuthority,
      (options: LocalFactoryCanaryAuthorityOptions) => LocalFactoryCanaryAuthorityRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryCanaryAuthority,
      (config: LocalFactoryCanaryAuthorityConfig) => LocalFactoryCanaryAuthorityRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryCanaryAuthorityConfig,
      (pathInput: string) => Promise<LocalFactoryCanaryAuthorityConfig>
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryCanaryRequest,
      (pathInput: string) => Promise<FactoryCanaryRequest>
    >
  >
];

void forbiddenInteractiveAuthority;
void forbiddenBrokerAuthority;
void forbiddenWorkerAuthority;
void forbiddenEvaluatorAuthority;
