import type {
  FactoryCanaryTaskReservation,
  FactoryRoleIdentityPolicy,
  Sha256Digest
} from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryCanaryAdmission,
  createLocalFactoryCanaryAdmission,
  loadLocalFactoryCanaryAdmissionConfig,
  type FactoryCanaryAdmissionCommand,
  type FactoryCanaryAdmissionCommandPort,
  type FactoryCanaryAdmissionResult,
  type LocalFactoryCanaryAdmissionConfig,
  type LocalFactoryCanaryAdmissionOptions,
  type LocalFactoryCanaryAdmissionRuntime
} from "@agentlab/runtime/factory-canary-admission";
// @ts-expect-error Canary admission must not be exported by the interactive runtime.
import { createLocalFactoryCanaryAdmission as forbiddenInteractiveAdmission } from "@agentlab/runtime";
// @ts-expect-error Canary admission must not be exported by the credential-bearing broker.
import { createLocalFactoryCanaryAdmission as forbiddenBrokerAdmission } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Canary admission must not be exported by the model-bearing worker.
import { createLocalFactoryCanaryAdmission as forbiddenWorkerAdmission } from "@agentlab/runtime/factory-worker";
// @ts-expect-error Canary admission must not be exported by human cohort issuance.
import { createLocalFactoryCanaryAdmission as forbiddenCanaryAuthorityAdmission } from "@agentlab/runtime/factory-canary-authority";

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

interface ExpectedConfig {
  schemaVersion: "agentlab.local-factory-canary-admission.v1";
  databasePath: string;
  runnerId: string;
  trustedPublicKeyPath: string;
  trustedKeyId: Sha256Digest;
  roleIdentityPolicyPath: string;
  expectedRoleIdentityPolicyDigest: Sha256Digest;
  expectedCohortDigest: Sha256Digest;
  expectedCandidateDigest: Sha256Digest;
  expectedSchedulePolicyDigest: Sha256Digest;
  expectedPolicyBundleDigest: Sha256Digest;
  maximumIssuanceDelaySeconds: number;
  maximumAttestationLifetimeSeconds: number;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
}

interface ExpectedOptions {
  readonly databasePath: string;
  readonly runnerId: string;
  readonly trustedPublicKeyPath: string;
  readonly trustedKeyId: Sha256Digest;
  readonly maximumIssuanceDelaySeconds: number;
  readonly maximumAttestationLifetimeSeconds: number;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  readonly expectedCohortDigest: Sha256Digest;
  readonly expectedCandidateDigest: Sha256Digest;
  readonly expectedSchedulePolicyDigest: Sha256Digest;
  readonly expectedPolicyBundleDigest: Sha256Digest;
  readonly now?: () => string;
  readonly createId?: () => string;
}

interface ExpectedCommand {
  taskId: string;
  expectedCohortDigest: Sha256Digest;
  expectedCandidateDigest: Sha256Digest;
  expectedSchedulePolicyDigest: Sha256Digest;
  expectedPolicyBundleDigest: Sha256Digest;
  expectedRoleIdentityPolicyDigest: Sha256Digest;
}

interface ExpectedResult {
  readonly schemaVersion: "agentlab.canary-admission-result.v1";
  readonly status: "reserved" | "existing";
  readonly reservation: FactoryCanaryTaskReservation;
  readonly reservationDigest: Sha256Digest;
}

export type FactoryCanaryAdmissionPublicApiAssertions = [
  Assert<Equal<LocalFactoryCanaryAdmissionConfig, ExpectedConfig>>,
  Assert<Equal<LocalFactoryCanaryAdmissionOptions, ExpectedOptions>>,
  Assert<Equal<FactoryCanaryAdmissionCommand, ExpectedCommand>>,
  Assert<Equal<FactoryCanaryAdmissionResult, ExpectedResult>>,
  Assert<Equal<keyof FactoryCanaryAdmissionCommandPort, "reserve">>,
  Assert<Equal<keyof LocalFactoryCanaryAdmissionRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryCanaryAdmission,
      (options: LocalFactoryCanaryAdmissionOptions) => LocalFactoryCanaryAdmissionRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryCanaryAdmission,
      (config: LocalFactoryCanaryAdmissionConfig) => LocalFactoryCanaryAdmissionRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryCanaryAdmissionConfig,
      (pathInput: string) => Promise<LocalFactoryCanaryAdmissionConfig>
    >
  >
];

void forbiddenInteractiveAdmission;
void forbiddenBrokerAdmission;
void forbiddenWorkerAdmission;
void forbiddenCanaryAuthorityAdmission;
