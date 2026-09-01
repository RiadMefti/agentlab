import {
  isFactoryAuthorityReason,
  isFactoryTaskId,
  isNormalizedAbsolutePath,
  isSha256Digest
} from "./factory-cli-input.js";

export type CliAction =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "run" }
  | { readonly kind: "factory-intake-preflight"; readonly configPath: string }
  | {
      readonly kind: "factory-intake-register";
      readonly configPath: string;
      readonly requestPath: string;
      readonly expectedPolicyBundleDigest: `sha256:${string}`;
      readonly confirmation: "register-request" | "register-scheduled-request";
    }
  | { readonly kind: "factory-broker-preflight"; readonly configPath: string }
  | { readonly kind: "factory-worker-preflight"; readonly configPath: string }
  | { readonly kind: "factory-orchestration-render"; readonly configPath: string }
  | { readonly kind: "factory-maintenance-discovery-preflight"; readonly configPath: string }
  | {
      readonly kind: "factory-maintenance-discovery-tick";
      readonly configPath: string;
      readonly expectedDiscoveryPolicyDigest: `sha256:${string}`;
      readonly expectedSchedulePolicyDigest: `sha256:${string}`;
      readonly expectedFactoryPolicyBundleDigest: `sha256:${string}`;
      readonly expectedPreparationGrantDigest: `sha256:${string}`;
      readonly expectedRoleIdentityPolicyDigest: `sha256:${string}`;
    }
  | {
      readonly kind: "factory-eval-assess";
      readonly configPath: string;
      readonly runPath: string;
      readonly confirmation: "assess-eval";
    }
  | {
      readonly kind: "factory-eval-sign";
      readonly configPath: string;
      readonly runPath: string;
      readonly confirmation: "sign-eval";
    }
  | {
      readonly kind: "factory-eval-attest";
      readonly configPath: string;
      readonly assessmentDigest: `sha256:${string}`;
      readonly attestationPath: string;
      readonly confirmation: "attest-eval";
    }
  | {
      readonly kind: "factory-eval-inspect";
      readonly configPath: string;
      readonly assessmentDigest: `sha256:${string}`;
    }
  | {
      readonly kind: "factory-canary-authorize";
      readonly configPath: string;
      readonly attestationDigest: `sha256:${string}`;
      readonly requestPath: string;
      readonly confirmation: "authorize-canary";
    }
  | {
      readonly kind: "factory-canary-reserve";
      readonly configPath: string;
      readonly taskId: string;
    }
  | {
      readonly kind: "factory-canary-admission-tick";
      readonly configPath: string;
      readonly expectedCohortDigest: `sha256:${string}`;
      readonly expectedCandidateDigest: `sha256:${string}`;
      readonly expectedSchedulePolicyDigest: `sha256:${string}`;
      readonly expectedRoleIdentityPolicyDigest: `sha256:${string}`;
      readonly expectedFactoryPolicyBundleDigest: `sha256:${string}`;
    }
  | {
      readonly kind: "factory-scheduler-tick";
      readonly configPath: string;
      readonly expectedSchedulePolicyDigest: `sha256:${string}`;
      readonly expectedFactoryPolicyBundleDigest: `sha256:${string}`;
    }
  | {
      readonly kind: "factory-worker-run";
      readonly configPath: string;
      readonly taskId: string;
      readonly expectedPolicyBundleDigest: `sha256:${string}`;
      readonly confirmation: "run-task";
    }
  | {
      readonly kind: "factory-worker-repair-pr";
      readonly configPath: string;
      readonly taskId: string;
      readonly authorizationDigest: `sha256:${string}`;
      readonly expectedPolicyBundleDigest: `sha256:${string}`;
      readonly confirmation: "repair-pr";
    }
  | {
      readonly kind: "factory-worker-pr-repair-tick";
      readonly configPath: string;
      readonly expectedSchedulePolicyDigest: `sha256:${string}`;
      readonly expectedRoleIdentityPolicyDigest: `sha256:${string}`;
      readonly expectedFactoryPolicyBundleDigest: `sha256:${string}`;
    }
  | { readonly kind: "factory-authority-status"; readonly configPath: string }
  | {
      readonly kind: "factory-broker-authority";
      readonly configPath: string;
      readonly expectedEnabled: boolean;
      readonly enabled: boolean;
      readonly reason: string;
      readonly confirmation: "enable-draft-broker" | "disable-draft-broker";
    }
  | {
      readonly kind: "factory-scheduler-authority";
      readonly configPath: string;
      readonly expectedEnabled: boolean;
      readonly enabled: boolean;
      readonly reason: string;
      readonly confirmation: "enable-scheduler" | "disable-scheduler";
    }
  | {
      readonly kind: "factory-broker-open-draft";
      readonly configPath: string;
      readonly taskId: string;
      readonly expectedPolicyBundleDigest: `sha256:${string}`;
      readonly confirmation: "confirm-draft";
    }
  | {
      readonly kind: "factory-broker-open-canary-draft";
      readonly configPath: string;
      readonly taskId: string;
      readonly reservationDigest: `sha256:${string}`;
      readonly schedulePolicyDigest: `sha256:${string}`;
      readonly roleIdentityPolicyDigest: `sha256:${string}`;
      readonly expectedPolicyBundleDigest: `sha256:${string}`;
    }
  | {
      readonly kind: "factory-broker-canary-tick";
      readonly configPath: string;
      readonly expectedSchedulePolicyDigest: `sha256:${string}`;
      readonly expectedRoleIdentityPolicyDigest: `sha256:${string}`;
      readonly expectedFactoryPolicyBundleDigest: `sha256:${string}`;
    }
  | {
      readonly kind: "factory-broker-pr-maintenance-tick";
      readonly configPath: string;
      readonly expectedSchedulePolicyDigest: `sha256:${string}`;
      readonly expectedRoleIdentityPolicyDigest: `sha256:${string}`;
      readonly expectedFactoryPolicyBundleDigest: `sha256:${string}`;
    }
  | {
      readonly kind: "factory-broker-pr-update-tick";
      readonly configPath: string;
      readonly expectedSchedulePolicyDigest: `sha256:${string}`;
      readonly expectedRoleIdentityPolicyDigest: `sha256:${string}`;
      readonly expectedFactoryPolicyBundleDigest: `sha256:${string}`;
    }
  | {
      readonly kind: "factory-broker-observe-pr";
      readonly configPath: string;
      readonly taskId: string;
      readonly expectedPolicyBundleDigest: `sha256:${string}`;
      readonly confirmation: "confirm-observe";
    }
  | {
      readonly kind: "factory-broker-update-draft";
      readonly configPath: string;
      readonly taskId: string;
      readonly authorizationDigest: `sha256:${string}`;
      readonly expectedPolicyBundleDigest: `sha256:${string}`;
      readonly confirmation: "confirm-update";
    }
  | {
      readonly kind: "factory-broker-authorize-repair";
      readonly configPath: string;
      readonly taskId: string;
      readonly observationDigest: `sha256:${string}`;
      readonly expectedPolicyBundleDigest: `sha256:${string}`;
      readonly confirmation: "authorize-repair";
    };

export function parseCliArguments(input: readonly string[]): CliAction {
  if (input.length === 0) return { kind: "run" };
  if (input.length === 1) {
    const value = input[0];
    if (value === "--help" || value === "-h") return { kind: "help" };
    if (value === "--version" || value === "-v") return { kind: "version" };
  }
  if (
    input.length === 4 &&
    input[0] === "factory" &&
    input[1] === "orchestration-render" &&
    input[2] === "--config"
  ) {
    const configPath = input[3];
    if (isNormalizedAbsolutePath(configPath)) {
      return { kind: "factory-orchestration-render", configPath };
    }
  }
  if (
    input.length === 4 &&
    input[0] === "factory" &&
    input[1] === "maintenance-discovery-preflight" &&
    input[2] === "--config"
  ) {
    const configPath = input[3];
    if (isNormalizedAbsolutePath(configPath)) {
      return { kind: "factory-maintenance-discovery-preflight", configPath };
    }
  }
  if (
    input.length === 14 &&
    input[0] === "factory" &&
    input[1] === "maintenance-discovery-tick" &&
    input[2] === "--config" &&
    input[4] === "--discovery-policy" &&
    input[6] === "--schedule-policy" &&
    input[8] === "--policy" &&
    input[10] === "--preparation-grant" &&
    input[12] === "--role-policy"
  ) {
    const configPath = input[3];
    const expectedDiscoveryPolicyDigest = input[5];
    const expectedSchedulePolicyDigest = input[7];
    const expectedFactoryPolicyBundleDigest = input[9];
    const expectedPreparationGrantDigest = input[11];
    const expectedRoleIdentityPolicyDigest = input[13];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isSha256Digest(expectedDiscoveryPolicyDigest) &&
      isSha256Digest(expectedSchedulePolicyDigest) &&
      isSha256Digest(expectedFactoryPolicyBundleDigest) &&
      isSha256Digest(expectedPreparationGrantDigest) &&
      isSha256Digest(expectedRoleIdentityPolicyDigest)
    ) {
      return {
        kind: "factory-maintenance-discovery-tick",
        configPath,
        expectedDiscoveryPolicyDigest,
        expectedSchedulePolicyDigest,
        expectedFactoryPolicyBundleDigest,
        expectedPreparationGrantDigest,
        expectedRoleIdentityPolicyDigest
      };
    }
  }
  if (
    input.length === 7 &&
    input[0] === "factory" &&
    input[1] === "eval-sign" &&
    input[2] === "--config" &&
    input[4] === "--run" &&
    input[6] === "--confirm-sign"
  ) {
    const configPath = input[3];
    const runPath = input[5];
    if (isNormalizedAbsolutePath(configPath) && isNormalizedAbsolutePath(runPath)) {
      return { kind: "factory-eval-sign", configPath, runPath, confirmation: "sign-eval" };
    }
  }
  if (
    input.length === 14 &&
    input[0] === "factory" &&
    input[1] === "canary-admission-tick" &&
    input[2] === "--config" &&
    input[4] === "--cohort" &&
    input[6] === "--candidate" &&
    input[8] === "--schedule-policy" &&
    input[10] === "--role-policy" &&
    input[12] === "--policy"
  ) {
    const configPath = input[3];
    const expectedCohortDigest = input[5];
    const expectedCandidateDigest = input[7];
    const expectedSchedulePolicyDigest = input[9];
    const expectedRoleIdentityPolicyDigest = input[11];
    const expectedFactoryPolicyBundleDigest = input[13];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isSha256Digest(expectedCohortDigest) &&
      isSha256Digest(expectedCandidateDigest) &&
      isSha256Digest(expectedSchedulePolicyDigest) &&
      isSha256Digest(expectedRoleIdentityPolicyDigest) &&
      isSha256Digest(expectedFactoryPolicyBundleDigest)
    ) {
      return {
        kind: "factory-canary-admission-tick",
        configPath,
        expectedCohortDigest,
        expectedCandidateDigest,
        expectedSchedulePolicyDigest,
        expectedRoleIdentityPolicyDigest,
        expectedFactoryPolicyBundleDigest
      };
    }
  }
  if (
    input.length === 6 &&
    input[0] === "factory" &&
    input[1] === "canary-reserve" &&
    input[2] === "--config" &&
    input[4] === "--task"
  ) {
    const configPath = input[3];
    const taskId = input[5];
    if (isNormalizedAbsolutePath(configPath) && isFactoryTaskId(taskId)) {
      return { kind: "factory-canary-reserve", configPath, taskId };
    }
  }
  if (
    input.length === 10 &&
    input[0] === "factory" &&
    input[1] === "broker-canary-tick" &&
    input[2] === "--config" &&
    input[4] === "--schedule-policy" &&
    input[6] === "--role-policy" &&
    input[8] === "--policy"
  ) {
    const configPath = input[3];
    const expectedSchedulePolicyDigest = input[5];
    const expectedRoleIdentityPolicyDigest = input[7];
    const expectedFactoryPolicyBundleDigest = input[9];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isSha256Digest(expectedSchedulePolicyDigest) &&
      isSha256Digest(expectedRoleIdentityPolicyDigest) &&
      isSha256Digest(expectedFactoryPolicyBundleDigest)
    ) {
      return {
        kind: "factory-broker-canary-tick",
        configPath,
        expectedSchedulePolicyDigest,
        expectedRoleIdentityPolicyDigest,
        expectedFactoryPolicyBundleDigest
      };
    }
  }
  if (
    input.length === 10 &&
    input[0] === "factory" &&
    input[1] === "broker-pr-maintenance-tick" &&
    input[2] === "--config" &&
    input[4] === "--schedule-policy" &&
    input[6] === "--role-policy" &&
    input[8] === "--policy"
  ) {
    const configPath = input[3];
    const expectedSchedulePolicyDigest = input[5];
    const expectedRoleIdentityPolicyDigest = input[7];
    const expectedFactoryPolicyBundleDigest = input[9];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isSha256Digest(expectedSchedulePolicyDigest) &&
      isSha256Digest(expectedRoleIdentityPolicyDigest) &&
      isSha256Digest(expectedFactoryPolicyBundleDigest)
    ) {
      return {
        kind: "factory-broker-pr-maintenance-tick",
        configPath,
        expectedSchedulePolicyDigest,
        expectedRoleIdentityPolicyDigest,
        expectedFactoryPolicyBundleDigest
      };
    }
  }
  if (
    input.length === 10 &&
    input[0] === "factory" &&
    input[1] === "broker-pr-update-tick" &&
    input[2] === "--config" &&
    input[4] === "--schedule-policy" &&
    input[6] === "--role-policy" &&
    input[8] === "--policy"
  ) {
    const configPath = input[3];
    const expectedSchedulePolicyDigest = input[5];
    const expectedRoleIdentityPolicyDigest = input[7];
    const expectedFactoryPolicyBundleDigest = input[9];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isSha256Digest(expectedSchedulePolicyDigest) &&
      isSha256Digest(expectedRoleIdentityPolicyDigest) &&
      isSha256Digest(expectedFactoryPolicyBundleDigest)
    ) {
      return {
        kind: "factory-broker-pr-update-tick",
        configPath,
        expectedSchedulePolicyDigest,
        expectedRoleIdentityPolicyDigest,
        expectedFactoryPolicyBundleDigest
      };
    }
  }
  if (
    input.length === 14 &&
    input[0] === "factory" &&
    input[1] === "broker-open-canary-draft" &&
    input[2] === "--config" &&
    input[4] === "--task" &&
    input[6] === "--reservation" &&
    input[8] === "--schedule-policy" &&
    input[10] === "--role-policy" &&
    input[12] === "--policy"
  ) {
    const configPath = input[3];
    const taskId = input[5];
    const reservationDigest = input[7];
    const schedulePolicyDigest = input[9];
    const roleIdentityPolicyDigest = input[11];
    const expectedPolicyBundleDigest = input[13];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isFactoryTaskId(taskId) &&
      isSha256Digest(reservationDigest) &&
      isSha256Digest(schedulePolicyDigest) &&
      isSha256Digest(roleIdentityPolicyDigest) &&
      isSha256Digest(expectedPolicyBundleDigest)
    ) {
      return {
        kind: "factory-broker-open-canary-draft",
        configPath,
        taskId,
        reservationDigest,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        expectedPolicyBundleDigest
      };
    }
  }
  if (
    input.length === 9 &&
    input[0] === "factory" &&
    input[1] === "eval-attest" &&
    input[2] === "--config" &&
    input[4] === "--assessment" &&
    input[6] === "--attestation" &&
    input[8] === "--confirm-attest"
  ) {
    const configPath = input[3];
    const assessmentDigest = input[5];
    const attestationPath = input[7];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isSha256Digest(assessmentDigest) &&
      isNormalizedAbsolutePath(attestationPath)
    ) {
      return {
        kind: "factory-eval-attest",
        configPath,
        assessmentDigest,
        attestationPath,
        confirmation: "attest-eval"
      };
    }
  }
  if (
    input.length === 7 &&
    input[0] === "factory" &&
    input[1] === "eval-assess" &&
    input[2] === "--config" &&
    input[4] === "--run" &&
    input[6] === "--confirm-assess"
  ) {
    const configPath = input[3];
    const runPath = input[5];
    if (isNormalizedAbsolutePath(configPath) && isNormalizedAbsolutePath(runPath)) {
      return { kind: "factory-eval-assess", configPath, runPath, confirmation: "assess-eval" };
    }
  }
  if (
    input.length === 6 &&
    input[0] === "factory" &&
    input[1] === "eval-inspect" &&
    input[2] === "--config" &&
    input[4] === "--assessment"
  ) {
    const configPath = input[3];
    const assessmentDigest = input[5];
    if (isNormalizedAbsolutePath(configPath) && isSha256Digest(assessmentDigest)) {
      return { kind: "factory-eval-inspect", configPath, assessmentDigest };
    }
  }
  if (
    input.length === 9 &&
    input[0] === "factory" &&
    input[1] === "canary-authorize" &&
    input[2] === "--config" &&
    input[4] === "--attestation" &&
    input[6] === "--request" &&
    input[8] === "--confirm-authorize-canary"
  ) {
    const configPath = input[3];
    const attestationDigest = input[5];
    const requestPath = input[7];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isSha256Digest(attestationDigest) &&
      isNormalizedAbsolutePath(requestPath)
    ) {
      return {
        kind: "factory-canary-authorize",
        configPath,
        attestationDigest,
        requestPath,
        confirmation: "authorize-canary"
      };
    }
  }
  if (
    input.length === 8 &&
    input[0] === "factory" &&
    input[1] === "scheduler-tick" &&
    input[2] === "--config" &&
    input[4] === "--schedule-policy" &&
    input[6] === "--policy"
  ) {
    const configPath = input[3];
    const expectedSchedulePolicyDigest = input[5];
    const expectedFactoryPolicyBundleDigest = input[7];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isSha256Digest(expectedSchedulePolicyDigest) &&
      isSha256Digest(expectedFactoryPolicyBundleDigest)
    ) {
      return {
        kind: "factory-scheduler-tick",
        configPath,
        expectedSchedulePolicyDigest,
        expectedFactoryPolicyBundleDigest
      };
    }
  }
  if (
    input.length === 11 &&
    input[0] === "factory" &&
    input[1] === "broker-update-draft" &&
    input[2] === "--config" &&
    input[4] === "--task" &&
    input[6] === "--authorization" &&
    input[8] === "--policy" &&
    input[10] === "--confirm-update"
  ) {
    const configPath = input[3];
    const taskId = input[5];
    const authorizationDigest = input[7];
    const expectedPolicyBundleDigest = input[9];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isFactoryTaskId(taskId) &&
      isSha256Digest(authorizationDigest) &&
      isSha256Digest(expectedPolicyBundleDigest)
    ) {
      return {
        kind: "factory-broker-update-draft",
        configPath,
        taskId,
        authorizationDigest,
        expectedPolicyBundleDigest,
        confirmation: "confirm-update"
      };
    }
  }
  if (
    input.length === 11 &&
    input[0] === "factory" &&
    input[1] === "worker-repair-pr" &&
    input[2] === "--config" &&
    input[4] === "--task" &&
    input[6] === "--authorization" &&
    input[8] === "--policy" &&
    input[10] === "--confirm-repair"
  ) {
    const configPath = input[3];
    const taskId = input[5];
    const authorizationDigest = input[7];
    const expectedPolicyBundleDigest = input[9];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isFactoryTaskId(taskId) &&
      isSha256Digest(authorizationDigest) &&
      isSha256Digest(expectedPolicyBundleDigest)
    ) {
      return {
        kind: "factory-worker-repair-pr",
        configPath,
        taskId,
        authorizationDigest,
        expectedPolicyBundleDigest,
        confirmation: "repair-pr"
      };
    }
  }
  if (
    input.length === 10 &&
    input[0] === "factory" &&
    input[1] === "worker-pr-repair-tick" &&
    input[2] === "--config" &&
    input[4] === "--schedule-policy" &&
    input[6] === "--role-policy" &&
    input[8] === "--policy"
  ) {
    const configPath = input[3];
    const expectedSchedulePolicyDigest = input[5];
    const expectedRoleIdentityPolicyDigest = input[7];
    const expectedFactoryPolicyBundleDigest = input[9];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isSha256Digest(expectedSchedulePolicyDigest) &&
      isSha256Digest(expectedRoleIdentityPolicyDigest) &&
      isSha256Digest(expectedFactoryPolicyBundleDigest)
    ) {
      return {
        kind: "factory-worker-pr-repair-tick",
        configPath,
        expectedSchedulePolicyDigest,
        expectedRoleIdentityPolicyDigest,
        expectedFactoryPolicyBundleDigest
      };
    }
  }
  if (
    input.length === 11 &&
    input[0] === "factory" &&
    input[1] === "broker-authorize-repair" &&
    input[2] === "--config" &&
    input[4] === "--task" &&
    input[6] === "--observation" &&
    input[8] === "--policy" &&
    input[10] === "--confirm-repair"
  ) {
    const configPath = input[3];
    const taskId = input[5];
    const observationDigest = input[7];
    const expectedPolicyBundleDigest = input[9];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isFactoryTaskId(taskId) &&
      isSha256Digest(observationDigest) &&
      isSha256Digest(expectedPolicyBundleDigest)
    ) {
      return {
        kind: "factory-broker-authorize-repair",
        configPath,
        taskId,
        observationDigest,
        expectedPolicyBundleDigest,
        confirmation: "authorize-repair"
      };
    }
  }
  if (
    input.length === 9 &&
    input[0] === "factory" &&
    input[1] === "broker-observe-pr" &&
    input[2] === "--config" &&
    input[4] === "--task" &&
    input[6] === "--policy" &&
    input[8] === "--confirm-observe"
  ) {
    const configPath = input[3];
    const taskId = input[5];
    const expectedPolicyBundleDigest = input[7];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isFactoryTaskId(taskId) &&
      isSha256Digest(expectedPolicyBundleDigest)
    ) {
      return {
        kind: "factory-broker-observe-pr",
        configPath,
        taskId,
        expectedPolicyBundleDigest,
        confirmation: "confirm-observe"
      };
    }
  }
  if (
    input.length === 9 &&
    input[0] === "factory" &&
    input[1] === "worker-run" &&
    input[2] === "--config" &&
    input[4] === "--task" &&
    input[6] === "--policy" &&
    input[8] === "--confirm-run"
  ) {
    const configPath = input[3];
    const taskId = input[5];
    const expectedPolicyBundleDigest = input[7];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isFactoryTaskId(taskId) &&
      isSha256Digest(expectedPolicyBundleDigest)
    ) {
      return {
        kind: "factory-worker-run",
        configPath,
        taskId,
        expectedPolicyBundleDigest,
        confirmation: "run-task"
      };
    }
  }
  if (
    input.length === 4 &&
    input[0] === "factory" &&
    input[1] === "intake-preflight" &&
    input[2] === "--config"
  ) {
    const configPath = input[3];
    if (isNormalizedAbsolutePath(configPath)) {
      return { kind: "factory-intake-preflight", configPath };
    }
  }
  if (
    input.length === 9 &&
    input[0] === "factory" &&
    input[1] === "intake-register" &&
    input[2] === "--config" &&
    input[4] === "--request" &&
    input[6] === "--policy" &&
    (input[8] === "--confirm-register" || input[8] === "--confirm-register-scheduled")
  ) {
    const configPath = input[3];
    const requestPath = input[5];
    const expectedPolicyBundleDigest = input[7];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isNormalizedAbsolutePath(requestPath) &&
      isSha256Digest(expectedPolicyBundleDigest)
    ) {
      return {
        kind: "factory-intake-register",
        configPath,
        requestPath,
        expectedPolicyBundleDigest,
        confirmation:
          input[8] === "--confirm-register-scheduled"
            ? "register-scheduled-request"
            : "register-request"
      };
    }
  }
  if (
    input.length === 4 &&
    input[0] === "factory" &&
    input[1] === "broker-preflight" &&
    input[2] === "--config"
  ) {
    const configPath = input[3];
    if (isNormalizedAbsolutePath(configPath)) {
      return { kind: "factory-broker-preflight", configPath };
    }
  }
  if (
    input.length === 11 &&
    input[0] === "factory" &&
    input[1] === "scheduler-authority" &&
    input[2] === "--config" &&
    input[4] === "--expected" &&
    input[6] === "--to" &&
    input[8] === "--reason"
  ) {
    const configPath = input[3];
    const expectedEnabled = authorityState(input[5]);
    const enabled = authorityState(input[7]);
    const reason = input[9];
    const confirmation = schedulerAuthorityConfirmation(input[10], enabled);
    if (
      isNormalizedAbsolutePath(configPath) &&
      expectedEnabled !== null &&
      enabled !== null &&
      expectedEnabled !== enabled &&
      isFactoryAuthorityReason(reason) &&
      confirmation !== null
    ) {
      return {
        kind: "factory-scheduler-authority",
        configPath,
        expectedEnabled,
        enabled,
        reason,
        confirmation
      };
    }
  }
  if (
    input.length === 4 &&
    input[0] === "factory" &&
    input[1] === "worker-preflight" &&
    input[2] === "--config"
  ) {
    const configPath = input[3];
    if (isNormalizedAbsolutePath(configPath)) {
      return { kind: "factory-worker-preflight", configPath };
    }
  }
  if (
    input.length === 4 &&
    input[0] === "factory" &&
    input[1] === "authority-status" &&
    input[2] === "--config"
  ) {
    const configPath = input[3];
    if (isNormalizedAbsolutePath(configPath)) {
      return { kind: "factory-authority-status", configPath };
    }
  }
  if (
    input.length === 11 &&
    input[0] === "factory" &&
    input[1] === "broker-authority" &&
    input[2] === "--config" &&
    input[4] === "--expected" &&
    input[6] === "--to" &&
    input[8] === "--reason"
  ) {
    const configPath = input[3];
    const expectedEnabled = authorityState(input[5]);
    const enabled = authorityState(input[7]);
    const reason = input[9];
    const confirmation = authorityConfirmation(input[10], enabled);
    if (
      isNormalizedAbsolutePath(configPath) &&
      expectedEnabled !== null &&
      enabled !== null &&
      expectedEnabled !== enabled &&
      isFactoryAuthorityReason(reason) &&
      confirmation !== null
    ) {
      return {
        kind: "factory-broker-authority",
        configPath,
        expectedEnabled,
        enabled,
        reason,
        confirmation
      };
    }
  }
  if (
    input.length === 9 &&
    input[0] === "factory" &&
    input[1] === "broker-open-draft" &&
    input[2] === "--config" &&
    input[4] === "--task" &&
    input[6] === "--policy" &&
    input[8] === "--confirm-draft"
  ) {
    const configPath = input[3];
    const taskId = input[5];
    const expectedPolicyBundleDigest = input[7];
    if (
      isNormalizedAbsolutePath(configPath) &&
      isFactoryTaskId(taskId) &&
      isSha256Digest(expectedPolicyBundleDigest)
    ) {
      return {
        kind: "factory-broker-open-draft",
        configPath,
        taskId,
        expectedPolicyBundleDigest,
        confirmation: "confirm-draft"
      };
    }
  }
  throw new Error(
    "Usage: agentlab [factory intake-preflight|intake-register ...|maintenance-discovery-preflight|maintenance-discovery-tick ...|eval-sign ...|eval-assess ...|eval-attest ...|eval-inspect ...|canary-authorize ...|canary-reserve ...|canary-admission-tick ...|broker-preflight|worker-preflight|orchestration-render|worker-run ...|worker-repair-pr ...|worker-pr-repair-tick ...|scheduler-tick ...|authority-status|scheduler-authority ...|broker-authority ...|broker-open-draft ...|broker-open-canary-draft ...|broker-canary-tick ...|broker-pr-maintenance-tick ...|broker-pr-update-tick ...|broker-update-draft ...|broker-observe-pr ...|broker-authorize-repair ...]"
  );
}

function authorityState(value: string | undefined): boolean | null {
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  return null;
}

function authorityConfirmation(
  value: string | undefined,
  enabled: boolean | null
): "enable-draft-broker" | "disable-draft-broker" | null {
  if (enabled === true && value === "--confirm-enable-draft-broker") {
    return "enable-draft-broker";
  }
  if (enabled === false && value === "--confirm-disable-draft-broker") {
    return "disable-draft-broker";
  }
  return null;
}

function schedulerAuthorityConfirmation(
  value: string | undefined,
  enabled: boolean | null
): "enable-scheduler" | "disable-scheduler" | null {
  if (enabled === true && value === "--confirm-enable-scheduler") return "enable-scheduler";
  if (enabled === false && value === "--confirm-disable-scheduler") return "disable-scheduler";
  return null;
}

export function assertSupportedTerminalRuntime(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): void {
  if (platform === "linux" && environment.OPENTUI_LIBC === "musl") {
    throw new Error("This Linux executable requires glibc; musl is not supported.");
  }
}

export const helpText = `agentlab

Open the local terminal UI, then choose or add a project folder.

Factory authority:
  agentlab factory maintenance-discovery-preflight --config <absolute-path>
      Verify the credentialless scout, exact repository, scheduler authority, provider, policy, and skills without running a model.
  agentlab factory maintenance-discovery-tick --config <absolute-path> --discovery-policy <sha256> --schedule-policy <sha256> --policy <sha256> --preparation-grant <sha256> --role-policy <sha256>
      Discover one bounded daily set of evidenced R1 maintenance candidates and register only policy-admitted scheduled intake.
  agentlab factory intake-preflight --config <absolute-path>
      Verify local repository, conversation, policy, authority, cost, and skill-package readiness.
  agentlab factory intake-register --config <absolute-path> --request <absolute-path> --policy <sha256> --confirm-register[-scheduled]
      Register one owner-authored feature or bug report for explicit or autonomous execution.
  agentlab factory eval-assess --config <absolute-path> --run <absolute-path> --confirm-assess
      Record complete matched trials and compute a deterministic promotion assessment; no model or remote access.
  agentlab factory eval-sign --config <absolute-path> --run <absolute-path> --confirm-sign
      Sign one fresh eval run in an isolated key-bearing process with no database or remote access.
  agentlab factory eval-attest --config <absolute-path> --assessment <sha256> --attestation <absolute-path> --confirm-attest
      Verify one DSSE artifact against a pinned public key and exact immutable assessment, then record it.
  agentlab factory eval-inspect --config <absolute-path> --assessment <sha256>
      Inspect compact metrics and policy reasons for one immutable assessment.
  agentlab factory canary-authorize --config <absolute-path> --attestation <sha256> --request <absolute-path> --confirm-authorize-canary
      Issue one human-reviewed, expiring R0/R1 cohort that structurally forbids merge and release.
  agentlab factory canary-reserve --config <absolute-path> --task <uuid>
      Re-verify the pinned attested cohort and reserve one exact scheduled task ceiling; execute nothing.
  agentlab factory canary-admission-tick --config <absolute-path> --cohort <sha256> --candidate <sha256> --schedule-policy <sha256> --role-policy <sha256> --policy <sha256>
      Reserve one bounded page of scheduled tasks inside existing human-approved attested cohort authority.
  agentlab factory authority-status --config <absolute-path>
      Inspect local scheduler and draft-PR authority plus both immutable event histories.
  agentlab factory scheduler-authority --config <absolute-path> --expected <enabled|disabled> --to <enabled|disabled> --reason <text> --confirm-<enable|disable>-scheduler
      Compare-and-set only the local autonomous scheduler switch; never executes work or contacts GitHub.
  agentlab factory broker-authority --config <absolute-path> --expected <enabled|disabled> --to <enabled|disabled> --reason <text> --confirm-<enable|disable>-draft-broker
      Compare-and-set only the local draft-PR switch; never enables scheduling or contacts GitHub.
  agentlab factory broker-preflight --config <absolute-path>
      Read configuration and report broker/governance readiness without changing GitHub.
  agentlab factory worker-preflight --config <absolute-path>
      Report credentialless worker, toolchain, storage, cost, and scheduler readiness.
  agentlab factory orchestration-render --config <absolute-path>
      Emit a content-addressed daily systemd bundle; never install, enable, or start it.
  agentlab factory scheduler-tick --config <absolute-path> --schedule-policy <sha256> --policy <sha256>
      Run one bounded UTC slot from exact current canary reservations; stop before remote writes.
  agentlab factory worker-run --config <absolute-path> --task <uuid> --policy <sha256> --confirm-run
      Resume one governed task through preparation, execution, gates, and review; stop before remote writes.
  agentlab factory worker-repair-pr --config <absolute-path> --task <uuid> --authorization <sha256> --policy <sha256> --confirm-repair
      Consume one exact authorization in a fresh credentialless repair worker; repeat all gates and independent review.
  agentlab factory worker-pr-repair-tick --config <absolute-path> --schedule-policy <sha256> --role-policy <sha256> --policy <sha256>
      Recover interrupted repairs, then consume one bounded page of exact canary repair authority.
  agentlab factory broker-open-draft --config <absolute-path> --task <uuid> --policy <sha256> --confirm-draft
      Open or reconcile only the exact governed draft after a clean broker preflight.
  agentlab factory broker-open-canary-draft --config <absolute-path> --task <uuid> --reservation <sha256> --schedule-policy <sha256> --role-policy <sha256> --policy <sha256>
      Open or reconcile one scheduled draft only from exact evaluated brokered-PR authority.
  agentlab factory broker-canary-tick --config <absolute-path> --schedule-policy <sha256> --role-policy <sha256> --policy <sha256>
      Reconcile one bounded page of exact completed scheduler handoffs into durable draft dispatches.
  agentlab factory broker-pr-maintenance-tick --config <absolute-path> --schedule-policy <sha256> --role-policy <sha256> --policy <sha256>
      Observe one bounded page of exact canary PR heads and authorize deterministic repairs.
  agentlab factory broker-pr-update-tick --config <absolute-path> --schedule-policy <sha256> --role-policy <sha256> --policy <sha256>
      Recover interrupted updates, then publish one bounded page of completed canary repairs.
  agentlab factory broker-update-draft --config <absolute-path> --task <uuid> --authorization <sha256> --policy <sha256> --confirm-update
      Advance one repaired draft branch without force-push, then record its authenticated new head.
  agentlab factory broker-observe-pr --config <absolute-path> --task <uuid> --policy <sha256> --confirm-observe
      Record bounded checks and untrusted PR feedback as local evidence; never repair or write GitHub.
  agentlab factory broker-authorize-repair --config <absolute-path> --task <uuid> --observation <sha256> --policy <sha256> --confirm-repair
      Reserve one remaining repair attempt from exact actionable facts; never run a model or write GitHub.

Environment:
  AGENTLAB_DATABASE_PATH   Override the local SQLite database path
  AGENTLAB_CODEX_BIN       Override the Codex executable
  AGENTLAB_CLAUDE_BIN      Override the Claude executable
  AGENTLAB_OPENCODE_BIN    Override the OpenCode executable
  AGENTLAB_DISABLE_MOUSE   Set to 1 to keep mouse input local to AgentLab

Keys:
  Alt+1 / Alt+2 / Alt+3        Focus projects / terminal / agents
  Alt+N / Alt+W                New project / worker
  Delete                       Remove the selected project or worker
  Alt+C                        Copy terminal selection via OSC 52
  Alt+Q                        Quit
`;
