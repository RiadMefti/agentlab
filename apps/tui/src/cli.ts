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
      readonly confirmation: "register-request";
    }
  | { readonly kind: "factory-broker-preflight"; readonly configPath: string }
  | { readonly kind: "factory-worker-preflight"; readonly configPath: string }
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
      readonly kind: "factory-broker-open-draft";
      readonly configPath: string;
      readonly taskId: string;
      readonly expectedPolicyBundleDigest: `sha256:${string}`;
      readonly confirmation: "confirm-draft";
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
    input[8] === "--confirm-register"
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
        confirmation: "register-request"
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
    "Usage: agentlab [factory intake-preflight|intake-register ...|broker-preflight|worker-preflight|authority-status|broker-authority ...|broker-open-draft ...]"
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
  agentlab factory intake-preflight --config <absolute-path>
      Verify local repository, conversation, policy, authority, cost, and skill-package readiness.
  agentlab factory intake-register --config <absolute-path> --request <absolute-path> --policy <sha256> --confirm-register
      Register one owner-authored feature or bug report under the exact reviewed policy.
  agentlab factory authority-status --config <absolute-path>
      Inspect local scheduler and draft-PR authority plus recent broker authority events.
  agentlab factory broker-authority --config <absolute-path> --expected <enabled|disabled> --to <enabled|disabled> --reason <text> --confirm-<enable|disable>-draft-broker
      Compare-and-set only the local draft-PR switch; never enables scheduling or contacts GitHub.
  agentlab factory broker-preflight --config <absolute-path>
      Read configuration and report broker/governance readiness without changing GitHub.
  agentlab factory worker-preflight --config <absolute-path>
      Report credentialless worker, toolchain, storage, cost, and scheduler readiness.
  agentlab factory broker-open-draft --config <absolute-path> --task <uuid> --policy <sha256> --confirm-draft
      Open or reconcile only the exact governed draft after a clean broker preflight.

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
