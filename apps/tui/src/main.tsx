import { assertSupportedTerminalRuntime, helpText, parseCliArguments } from "./cli.js";
import {
  consumeNativeDiagnosticsInvocation,
  runWithNativeDiagnostics,
  type NativeDiagnosticsRuntime
} from "./bootstrap/native-diagnostics.js";
import { appVersion } from "./version.js";

let rendererRuntime: NativeDiagnosticsRuntime | null = null;

async function main(): Promise<void> {
  const invocation = await consumeNativeDiagnosticsInvocation();
  if (invocation.kind === "invalid") {
    process.exitCode = 1;
    return;
  }
  rendererRuntime = invocation.kind === "runtime" ? invocation : null;
  const action = parseCliArguments(invocation.arguments);
  if (action.kind === "help") {
    process.stdout.write(helpText);
    return;
  }
  if (action.kind === "version") {
    process.stdout.write(`${appVersion}\n`);
    return;
  }
  if (action.kind === "factory-intake-preflight") {
    const { runFactoryIntakePreflight } = await import("./run-factory-intake-preflight.js");
    process.exitCode = await runFactoryIntakePreflight(action.configPath);
    return;
  }
  if (action.kind === "factory-intake-register") {
    const { runFactoryIntakeRegister } = await import("./run-factory-intake-register.js");
    process.exitCode = await runFactoryIntakeRegister(
      action.configPath,
      action.requestPath,
      action.expectedPolicyBundleDigest,
      action.confirmation
    );
    return;
  }
  if (action.kind === "factory-maintenance-discovery-preflight") {
    const { runFactoryMaintenanceDiscoveryPreflight } =
      await import("./run-factory-maintenance-discovery.js");
    process.exitCode = await runFactoryMaintenanceDiscoveryPreflight(action.configPath);
    return;
  }
  if (action.kind === "factory-external-pull-request-discovery-preflight") {
    const { runFactoryExternalPullRequestDiscoveryPreflight } =
      await import("./run-factory-external-pull-request-discovery.js");
    process.exitCode = await runFactoryExternalPullRequestDiscoveryPreflight(action.configPath);
    return;
  }
  if (action.kind === "factory-external-pull-request-discovery-tick") {
    const { runFactoryExternalPullRequestDiscoveryTick } =
      await import("./run-factory-external-pull-request-discovery.js");
    process.exitCode = await runFactoryExternalPullRequestDiscoveryTick(
      action.configPath,
      action.expectedDiscoveryPolicyDigest,
      action.expectedSchedulePolicyDigest
    );
    return;
  }
  if (action.kind === "factory-external-pull-request-review-preflight") {
    const { runFactoryExternalPullRequestReviewPreflight } =
      await import("./run-factory-external-pull-request-review.js");
    process.exitCode = await runFactoryExternalPullRequestReviewPreflight(action.configPath);
    return;
  }
  if (action.kind === "factory-external-pull-request-review-tick") {
    const { runFactoryExternalPullRequestReviewTick } =
      await import("./run-factory-external-pull-request-review.js");
    process.exitCode = await runFactoryExternalPullRequestReviewTick(
      action.configPath,
      action.expectedReviewPolicyDigest,
      action.expectedDiscoveryPolicyDigest,
      action.expectedCostPolicyDigest
    );
    return;
  }
  if (action.kind === "factory-external-pull-request-feedback-preflight") {
    const { runFactoryExternalPullRequestFeedbackPreflight } =
      await import("./run-factory-external-pull-request-feedback.js");
    process.exitCode = await runFactoryExternalPullRequestFeedbackPreflight(action.configPath);
    return;
  }
  if (action.kind === "factory-external-pull-request-feedback-tick") {
    const { runFactoryExternalPullRequestFeedbackTick } =
      await import("./run-factory-external-pull-request-feedback.js");
    process.exitCode = await runFactoryExternalPullRequestFeedbackTick(
      action.configPath,
      action.expectedFeedbackPolicyDigest,
      action.expectedReviewPolicyDigest
    );
    return;
  }
  if (action.kind === "factory-maintenance-discovery-tick") {
    const { runFactoryMaintenanceDiscoveryTick } =
      await import("./run-factory-maintenance-discovery.js");
    process.exitCode = await runFactoryMaintenanceDiscoveryTick(
      action.configPath,
      action.expectedDiscoveryPolicyDigest,
      action.expectedSchedulePolicyDigest,
      action.expectedFactoryPolicyBundleDigest,
      action.expectedPreparationGrantDigest,
      action.expectedRoleIdentityPolicyDigest
    );
    return;
  }
  if (action.kind === "factory-eval-assess") {
    const { runFactoryEvalAssess } = await import("./run-factory-evaluator.js");
    process.exitCode = await runFactoryEvalAssess(
      action.configPath,
      action.runPath,
      action.confirmation
    );
    return;
  }
  if (action.kind === "factory-eval-producer-preflight") {
    const { runFactoryEvalProducerPreflight } = await import("./run-factory-eval-producer.js");
    process.exitCode = await runFactoryEvalProducerPreflight(
      action.configPath,
      action.jobPath,
      action.expectedJobDigest
    );
    return;
  }
  if (action.kind === "factory-eval-produce") {
    const { runFactoryEvalProduce } = await import("./run-factory-eval-producer.js");
    process.exitCode = await runFactoryEvalProduce(
      action.configPath,
      action.jobPath,
      action.expectedJobDigest
    );
    return;
  }
  if (action.kind === "factory-eval-sign") {
    const { runFactoryEvalSign } = await import("./run-factory-eval-attestor.js");
    process.exitCode = await runFactoryEvalSign(
      action.configPath,
      action.runPath,
      action.confirmation
    );
    return;
  }
  if (action.kind === "factory-eval-attest") {
    const { runFactoryEvalAttest } = await import("./run-factory-evaluator.js");
    process.exitCode = await runFactoryEvalAttest(
      action.configPath,
      action.assessmentDigest,
      action.attestationPath,
      action.confirmation
    );
    return;
  }
  if (action.kind === "factory-eval-inspect") {
    const { runFactoryEvalInspect } = await import("./run-factory-evaluator.js");
    process.exitCode = await runFactoryEvalInspect(action.configPath, action.assessmentDigest);
    return;
  }
  if (action.kind === "factory-canary-authorize") {
    const { runFactoryCanaryAuthorize } = await import("./run-factory-canary-authority.js");
    process.exitCode = await runFactoryCanaryAuthorize(
      action.configPath,
      action.attestationDigest,
      action.requestPath,
      action.confirmation
    );
    return;
  }
  if (action.kind === "factory-canary-reserve") {
    const { runFactoryCanaryReserve } = await import("./run-factory-canary-admission.js");
    process.exitCode = await runFactoryCanaryReserve(action.configPath, action.taskId);
    return;
  }
  if (action.kind === "factory-canary-admission-tick") {
    const { runFactoryCanaryAdmissionTick } = await import("./run-factory-canary-admission.js");
    process.exitCode = await runFactoryCanaryAdmissionTick(
      action.configPath,
      action.expectedCohortDigest,
      action.expectedCandidateDigest,
      action.expectedSchedulePolicyDigest,
      action.expectedRoleIdentityPolicyDigest,
      action.expectedFactoryPolicyBundleDigest
    );
    return;
  }
  if (action.kind === "factory-broker-preflight") {
    const { runFactoryBrokerPreflight } = await import("./run-factory-broker-preflight.js");
    process.exitCode = await runFactoryBrokerPreflight(action.configPath);
    return;
  }
  if (action.kind === "factory-worker-preflight") {
    const { runFactoryWorkerPreflight } = await import("./run-factory-worker-preflight.js");
    process.exitCode = await runFactoryWorkerPreflight(action.configPath);
    return;
  }
  if (action.kind === "factory-orchestration-render") {
    const { runFactoryOrchestrationRender } = await import("./run-factory-orchestration-render.js");
    process.exitCode = await runFactoryOrchestrationRender(action.configPath);
    return;
  }
  if (action.kind === "factory-scheduler-tick") {
    const { runFactorySchedulerTick } = await import("./run-factory-scheduler-tick.js");
    process.exitCode = await runFactorySchedulerTick(
      action.configPath,
      action.expectedSchedulePolicyDigest,
      action.expectedFactoryPolicyBundleDigest
    );
    return;
  }
  if (action.kind === "factory-worker-run") {
    const { runFactoryWorkerTask } = await import("./run-factory-worker-task.js");
    process.exitCode = await runFactoryWorkerTask(
      action.configPath,
      action.taskId,
      action.expectedPolicyBundleDigest,
      action.confirmation
    );
    return;
  }
  if (action.kind === "factory-worker-repair-pr") {
    const { runFactoryWorkerRepairPullRequest } = await import("./run-factory-worker-repair-pr.js");
    process.exitCode = await runFactoryWorkerRepairPullRequest(
      action.configPath,
      action.taskId,
      action.authorizationDigest,
      action.expectedPolicyBundleDigest,
      action.confirmation
    );
    return;
  }
  if (action.kind === "factory-worker-pr-repair-tick") {
    const { runFactoryWorkerPullRequestRepairTick } =
      await import("./run-factory-worker-pr-repair-tick.js");
    process.exitCode = await runFactoryWorkerPullRequestRepairTick(
      action.configPath,
      action.expectedSchedulePolicyDigest,
      action.expectedRoleIdentityPolicyDigest,
      action.expectedFactoryPolicyBundleDigest
    );
    return;
  }
  if (action.kind === "factory-authority-status") {
    const { runFactoryAuthorityStatus } = await import("./run-factory-authority.js");
    process.exitCode = await runFactoryAuthorityStatus(action.configPath);
    return;
  }
  if (action.kind === "factory-broker-authority") {
    const { runFactoryBrokerAuthority } = await import("./run-factory-authority.js");
    process.exitCode = await runFactoryBrokerAuthority(
      action.configPath,
      action.expectedEnabled,
      action.enabled,
      action.reason,
      action.confirmation
    );
    return;
  }
  if (action.kind === "factory-scheduler-authority") {
    const { runFactorySchedulerAuthority } = await import("./run-factory-authority.js");
    process.exitCode = await runFactorySchedulerAuthority(
      action.configPath,
      action.expectedEnabled,
      action.enabled,
      action.reason,
      action.confirmation
    );
    return;
  }
  if (action.kind === "factory-broker-open-draft") {
    const { runFactoryBrokerOpenDraft } = await import("./run-factory-broker-open-draft.js");
    process.exitCode = await runFactoryBrokerOpenDraft(
      action.configPath,
      action.taskId,
      action.expectedPolicyBundleDigest,
      action.confirmation
    );
    return;
  }
  if (action.kind === "factory-broker-open-canary-draft") {
    const { runFactoryBrokerOpenCanaryDraft } = await import("./run-factory-broker-open-draft.js");
    process.exitCode = await runFactoryBrokerOpenCanaryDraft(
      action.configPath,
      action.taskId,
      action.reservationDigest,
      action.schedulePolicyDigest,
      action.roleIdentityPolicyDigest,
      action.expectedPolicyBundleDigest
    );
    return;
  }
  if (action.kind === "factory-broker-canary-tick") {
    const { runFactoryBrokerCanaryTick } = await import("./run-factory-broker-canary-tick.js");
    process.exitCode = await runFactoryBrokerCanaryTick(
      action.configPath,
      action.expectedSchedulePolicyDigest,
      action.expectedRoleIdentityPolicyDigest,
      action.expectedFactoryPolicyBundleDigest
    );
    return;
  }
  if (action.kind === "factory-broker-pr-maintenance-tick") {
    const { runFactoryBrokerPullRequestMaintenanceTick } =
      await import("./run-factory-broker-pr-maintenance-tick.js");
    process.exitCode = await runFactoryBrokerPullRequestMaintenanceTick(
      action.configPath,
      action.expectedSchedulePolicyDigest,
      action.expectedRoleIdentityPolicyDigest,
      action.expectedFactoryPolicyBundleDigest
    );
    return;
  }
  if (action.kind === "factory-broker-pr-update-tick") {
    const { runFactoryBrokerPullRequestUpdateTick } =
      await import("./run-factory-broker-pr-update-tick.js");
    process.exitCode = await runFactoryBrokerPullRequestUpdateTick(
      action.configPath,
      action.expectedSchedulePolicyDigest,
      action.expectedRoleIdentityPolicyDigest,
      action.expectedFactoryPolicyBundleDigest
    );
    return;
  }
  if (action.kind === "factory-broker-observe-pr") {
    const { runFactoryBrokerObservePullRequest } =
      await import("./run-factory-broker-observe-pr.js");
    process.exitCode = await runFactoryBrokerObservePullRequest(
      action.configPath,
      action.taskId,
      action.expectedPolicyBundleDigest,
      action.confirmation
    );
    return;
  }
  if (action.kind === "factory-broker-update-draft") {
    const { runFactoryBrokerUpdateDraft } = await import("./run-factory-broker-update-draft.js");
    process.exitCode = await runFactoryBrokerUpdateDraft(
      action.configPath,
      action.taskId,
      action.authorizationDigest,
      action.expectedPolicyBundleDigest,
      action.confirmation
    );
    return;
  }
  if (action.kind === "factory-broker-authorize-repair") {
    const { runFactoryBrokerAuthorizeRepair } =
      await import("./run-factory-broker-authorize-repair.js");
    process.exitCode = await runFactoryBrokerAuthorizeRepair(
      action.configPath,
      action.taskId,
      action.observationDigest,
      action.expectedPolicyBundleDigest,
      action.confirmation
    );
    return;
  }

  assertSupportedTerminalRuntime(process.platform, process.env);
  if (invocation.kind === "direct") {
    process.exitCode = await runWithNativeDiagnostics(invocation.arguments);
    return;
  }
  const { runTerminalUi } = await import("./run-terminal-ui.js");
  await runTerminalUi(invocation.diagnostics);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected startup failure.";
  if (rendererRuntime !== null) rendererRuntime.diagnostics.write(`Renderer failure: ${message}`);
  else process.stderr.write(`agentlab: ${message}\n`);
  process.exitCode = 1;
});
