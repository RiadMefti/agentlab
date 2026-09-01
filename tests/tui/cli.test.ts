import { describe, expect, it } from "vitest";

import {
  assertSupportedTerminalRuntime,
  helpText,
  parseCliArguments
} from "../../apps/tui/src/cli.js";

describe("terminal CLI", () => {
  it("parses the separately pinned replacement-draft broker commands", () => {
    expect(
      parseCliArguments([
        "factory",
        "external-pr-replacement-draft-preflight",
        "--config",
        "/private/replacement.json"
      ])
    ).toEqual({
      kind: "factory-external-pull-request-replacement-draft-preflight",
      configPath: "/private/replacement.json"
    });
    expect(
      parseCliArguments([
        "factory",
        "external-pr-replacement-draft-tick",
        "--config",
        "/private/replacement.json",
        "--publication-policy",
        `sha256:${"1".repeat(64)}`,
        "--qualification-policy",
        `sha256:${"2".repeat(64)}`,
        "--role-policy",
        `sha256:${"3".repeat(64)}`
      ])
    ).toMatchObject({
      kind: "factory-external-pull-request-replacement-draft-tick",
      configPath: "/private/replacement.json"
    });
  });
  it("always opens the project chooser when no arguments are supplied", () => {
    expect(parseCliArguments([])).toEqual({ kind: "run" });
  });

  it("rejects positional workspaces so startup cannot bypass the project chooser", () => {
    expect(() => parseCliArguments(["/tmp/project"])).toThrow("Usage: agentlab");
  });

  it("recognizes informational flags without requiring a TTY", () => {
    expect(parseCliArguments(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArguments(["-v"])).toEqual({ kind: "version" });
  });

  it("recognizes only exact factory readiness commands", () => {
    expect(
      parseCliArguments([
        "factory",
        "intake-preflight",
        "--config",
        "/private/agentlab/intake.json"
      ])
    ).toEqual({
      kind: "factory-intake-preflight",
      configPath: "/private/agentlab/intake.json"
    });
    expect(
      parseCliArguments([
        "factory",
        "broker-preflight",
        "--config",
        "/private/agentlab/broker.json"
      ])
    ).toEqual({
      kind: "factory-broker-preflight",
      configPath: "/private/agentlab/broker.json"
    });
    expect(() =>
      parseCliArguments(["factory", "broker-preflight", "--config", "broker.json"])
    ).toThrow(/Usage/u);
    expect(() =>
      parseCliArguments(["factory", "broker-preflight", "--enable", "/private/broker.json"])
    ).toThrow(/Usage/u);
    expect(
      parseCliArguments([
        "factory",
        "worker-preflight",
        "--config",
        "/private/agentlab/worker.json"
      ])
    ).toEqual({
      kind: "factory-worker-preflight",
      configPath: "/private/agentlab/worker.json"
    });
    expect(
      parseCliArguments([
        "factory",
        "orchestration-render",
        "--config",
        "/private/agentlab/orchestration.json"
      ])
    ).toEqual({
      kind: "factory-orchestration-render",
      configPath: "/private/agentlab/orchestration.json"
    });
    expect(() =>
      parseCliArguments(["factory", "orchestration-render", "--config", "relative.json"])
    ).toThrow(/Usage/u);
    expect(
      parseCliArguments([
        "factory",
        "maintenance-discovery-preflight",
        "--config",
        "/private/agentlab/discovery.json"
      ])
    ).toEqual({
      kind: "factory-maintenance-discovery-preflight",
      configPath: "/private/agentlab/discovery.json"
    });
    expect(
      parseCliArguments([
        "factory",
        "external-pr-discovery-preflight",
        "--config",
        "/private/agentlab/pr-reader.json"
      ])
    ).toEqual({
      kind: "factory-external-pull-request-discovery-preflight",
      configPath: "/private/agentlab/pr-reader.json"
    });
    const discoveryPolicy = `sha256:${"a".repeat(64)}`;
    const schedulePolicy = `sha256:${"b".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "external-pr-discovery-tick",
        "--config",
        "/private/agentlab/pr-reader.json",
        "--discovery-policy",
        discoveryPolicy,
        "--schedule-policy",
        schedulePolicy
      ])
    ).toEqual({
      kind: "factory-external-pull-request-discovery-tick",
      configPath: "/private/agentlab/pr-reader.json",
      expectedDiscoveryPolicyDigest: discoveryPolicy,
      expectedSchedulePolicyDigest: schedulePolicy
    });
    expect(
      parseCliArguments([
        "factory",
        "external-pr-review-preflight",
        "--config",
        "/private/agentlab/pr-reviewer.json"
      ])
    ).toEqual({
      kind: "factory-external-pull-request-review-preflight",
      configPath: "/private/agentlab/pr-reviewer.json"
    });
    const costPolicy = `sha256:${"c".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "external-pr-review-tick",
        "--config",
        "/private/agentlab/pr-reviewer.json",
        "--review-policy",
        discoveryPolicy,
        "--discovery-policy",
        schedulePolicy,
        "--cost-policy",
        costPolicy
      ])
    ).toEqual({
      kind: "factory-external-pull-request-review-tick",
      configPath: "/private/agentlab/pr-reviewer.json",
      expectedReviewPolicyDigest: discoveryPolicy,
      expectedDiscoveryPolicyDigest: schedulePolicy,
      expectedCostPolicyDigest: costPolicy
    });
    expect(
      parseCliArguments([
        "factory",
        "external-pr-feedback-preflight",
        "--config",
        "/private/agentlab/pr-feedback.json"
      ])
    ).toEqual({
      kind: "factory-external-pull-request-feedback-preflight",
      configPath: "/private/agentlab/pr-feedback.json"
    });
    expect(
      parseCliArguments([
        "factory",
        "external-pr-feedback-tick",
        "--config",
        "/private/agentlab/pr-feedback.json",
        "--feedback-policy",
        costPolicy,
        "--review-policy",
        discoveryPolicy
      ])
    ).toEqual({
      kind: "factory-external-pull-request-feedback-tick",
      configPath: "/private/agentlab/pr-feedback.json",
      expectedFeedbackPolicyDigest: costPolicy,
      expectedReviewPolicyDigest: discoveryPolicy
    });
    expect(
      parseCliArguments([
        "factory",
        "external-pr-repair-admission-preflight",
        "--config",
        "/private/agentlab/pr-repair-admission.json"
      ])
    ).toEqual({
      kind: "factory-external-pull-request-repair-admission-preflight",
      configPath: "/private/agentlab/pr-repair-admission.json"
    });
    const repairPolicy = `sha256:${"d".repeat(64)}`;
    const rolePolicy = `sha256:${"e".repeat(64)}`;
    const gateProfile = `sha256:${"f".repeat(64)}`;
    const executionPolicy = `sha256:${"0".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "external-pr-repair-admission-tick",
        "--config",
        "/private/agentlab/pr-repair-admission.json",
        "--admission-policy",
        repairPolicy,
        "--review-policy",
        discoveryPolicy,
        "--feedback-policy",
        schedulePolicy,
        "--repair-execution-policy",
        executionPolicy,
        "--cost-policy",
        costPolicy,
        "--role-policy",
        rolePolicy,
        "--gate-profile",
        gateProfile
      ])
    ).toEqual({
      kind: "factory-external-pull-request-repair-admission-tick",
      configPath: "/private/agentlab/pr-repair-admission.json",
      expectedAdmissionPolicyDigest: repairPolicy,
      expectedReviewPolicyDigest: discoveryPolicy,
      expectedFeedbackPolicyDigest: schedulePolicy,
      expectedRepairExecutionPolicyDigest: executionPolicy,
      expectedCostPolicyDigest: costPolicy,
      expectedRoleIdentityPolicyDigest: rolePolicy,
      expectedGateProfileDigest: gateProfile
    });
    expect(
      parseCliArguments([
        "factory",
        "external-pr-repair-execution-preflight",
        "--config",
        "/private/agentlab/pr-repair-execution.json"
      ])
    ).toEqual({
      kind: "factory-external-pull-request-repair-execution-preflight",
      configPath: "/private/agentlab/pr-repair-execution.json"
    });
    expect(
      parseCliArguments([
        "factory",
        "external-pr-repair-execution-tick",
        "--config",
        "/private/agentlab/pr-repair-execution.json",
        "--repair-execution-policy",
        executionPolicy,
        "--admission-policy",
        repairPolicy,
        "--review-policy",
        discoveryPolicy,
        "--feedback-policy",
        schedulePolicy,
        "--cost-policy",
        costPolicy,
        "--role-policy",
        rolePolicy,
        "--gate-profile",
        gateProfile
      ])
    ).toEqual({
      kind: "factory-external-pull-request-repair-execution-tick",
      configPath: "/private/agentlab/pr-repair-execution.json",
      expectedRepairExecutionPolicyDigest: executionPolicy,
      expectedAdmissionPolicyDigest: repairPolicy,
      expectedReviewPolicyDigest: discoveryPolicy,
      expectedFeedbackPolicyDigest: schedulePolicy,
      expectedCostPolicyDigest: costPolicy,
      expectedRoleIdentityPolicyDigest: rolePolicy,
      expectedGateProfileDigest: gateProfile
    });
    expect(
      parseCliArguments([
        "factory",
        "external-pr-repair-qualification-preflight",
        "--config",
        "/private/agentlab/pr-repair-qualification.json"
      ])
    ).toEqual({
      kind: "factory-external-pull-request-repair-qualification-preflight",
      configPath: "/private/agentlab/pr-repair-qualification.json"
    });
    expect(
      parseCliArguments([
        "factory",
        "external-pr-repair-qualification-tick",
        "--config",
        "/private/agentlab/pr-repair-qualification.json",
        "--qualification-policy",
        repairPolicy,
        "--repair-execution-policy",
        executionPolicy,
        "--cost-policy",
        costPolicy,
        "--role-policy",
        rolePolicy,
        "--gate-profile",
        gateProfile
      ])
    ).toEqual({
      kind: "factory-external-pull-request-repair-qualification-tick",
      configPath: "/private/agentlab/pr-repair-qualification.json",
      expectedQualificationPolicyDigest: repairPolicy,
      expectedRepairExecutionPolicyDigest: executionPolicy,
      expectedCostPolicyDigest: costPolicy,
      expectedRoleIdentityPolicyDigest: rolePolicy,
      expectedGateProfileDigest: gateProfile
    });
  });

  it("requires exact eval and human canary authority coordinates", () => {
    const assessment = `sha256:${"a".repeat(64)}`;
    const productionJob = `sha256:${"b".repeat(64)}`;
    const taskId = "10000000-0000-4000-8000-000000000001";
    expect(
      parseCliArguments([
        "factory",
        "eval-producer-preflight",
        "--config",
        "/private/agentlab/eval-producer.json",
        "--job",
        "/private/agentlab/eval-production-job.json",
        "--job-digest",
        productionJob
      ])
    ).toEqual({
      kind: "factory-eval-producer-preflight",
      configPath: "/private/agentlab/eval-producer.json",
      jobPath: "/private/agentlab/eval-production-job.json",
      expectedJobDigest: productionJob
    });
    expect(
      parseCliArguments([
        "factory",
        "eval-produce",
        "--config",
        "/private/agentlab/eval-producer.json",
        "--job",
        "/private/agentlab/eval-production-job.json",
        "--job-digest",
        productionJob
      ])
    ).toEqual({
      kind: "factory-eval-produce",
      configPath: "/private/agentlab/eval-producer.json",
      jobPath: "/private/agentlab/eval-production-job.json",
      expectedJobDigest: productionJob
    });
    expect(
      parseCliArguments([
        "factory",
        "eval-sign",
        "--config",
        "/private/agentlab/attestor.json",
        "--run",
        "/private/agentlab/eval-run.json",
        "--confirm-sign"
      ])
    ).toEqual({
      kind: "factory-eval-sign",
      configPath: "/private/agentlab/attestor.json",
      runPath: "/private/agentlab/eval-run.json",
      confirmation: "sign-eval"
    });
    expect(
      parseCliArguments([
        "factory",
        "eval-attest",
        "--config",
        "/private/agentlab/evaluator.json",
        "--assessment",
        assessment,
        "--attestation",
        "/private/agentlab/signed-attestation.json",
        "--confirm-attest"
      ])
    ).toEqual({
      kind: "factory-eval-attest",
      configPath: "/private/agentlab/evaluator.json",
      assessmentDigest: assessment,
      attestationPath: "/private/agentlab/signed-attestation.json",
      confirmation: "attest-eval"
    });
    expect(
      parseCliArguments([
        "factory",
        "eval-assess",
        "--config",
        "/private/agentlab/evaluator.json",
        "--run",
        "/private/agentlab/eval-run.json",
        "--confirm-assess"
      ])
    ).toEqual({
      kind: "factory-eval-assess",
      configPath: "/private/agentlab/evaluator.json",
      runPath: "/private/agentlab/eval-run.json",
      confirmation: "assess-eval"
    });
    expect(
      parseCliArguments([
        "factory",
        "eval-inspect",
        "--config",
        "/private/agentlab/evaluator.json",
        "--assessment",
        assessment
      ])
    ).toEqual({
      kind: "factory-eval-inspect",
      configPath: "/private/agentlab/evaluator.json",
      assessmentDigest: assessment
    });
    expect(
      parseCliArguments([
        "factory",
        "canary-authorize",
        "--config",
        "/private/agentlab/canary.json",
        "--attestation",
        assessment,
        "--request",
        "/private/agentlab/canary-request.json",
        "--confirm-authorize-canary"
      ])
    ).toEqual({
      kind: "factory-canary-authorize",
      configPath: "/private/agentlab/canary.json",
      attestationDigest: assessment,
      requestPath: "/private/agentlab/canary-request.json",
      confirmation: "authorize-canary"
    });
    expect(
      parseCliArguments([
        "factory",
        "canary-reserve",
        "--config",
        "/private/agentlab/canary-admission.json",
        "--task",
        taskId
      ])
    ).toEqual({
      kind: "factory-canary-reserve",
      configPath: "/private/agentlab/canary-admission.json",
      taskId
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "eval-produce",
        "--config",
        "/private/agentlab/eval-producer.json",
        "--job",
        "/private/agentlab/eval-production-job.json",
        "--job-digest",
        "not-a-digest"
      ])
    ).toThrow(/Usage/u);
    expect(() =>
      parseCliArguments([
        "factory",
        "eval-assess",
        "--config",
        "/private/agentlab/evaluator.json",
        "--run",
        "/private/agentlab/eval-run.json"
      ])
    ).toThrow(/Usage/u);
    expect(() =>
      parseCliArguments([
        "factory",
        "canary-authorize",
        "--config",
        "/private/agentlab/canary.json",
        "--attestation",
        "not-a-digest",
        "--request",
        "/private/agentlab/canary-request.json",
        "--confirm-authorize-canary"
      ])
    ).toThrow(/Usage/u);
    expect(() =>
      parseCliArguments([
        "factory",
        "canary-reserve",
        "--config",
        "/private/agentlab/canary-admission.json",
        "--task",
        "not-a-task"
      ])
    ).toThrow(/Usage/u);
  });

  it("requires exact request, policy pin, and confirmation for factory intake", () => {
    const policy = `sha256:${"a".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "intake-register",
        "--config",
        "/private/agentlab/intake.json",
        "--request",
        "/private/agentlab/request.json",
        "--policy",
        policy,
        "--confirm-register"
      ])
    ).toEqual({
      kind: "factory-intake-register",
      configPath: "/private/agentlab/intake.json",
      requestPath: "/private/agentlab/request.json",
      expectedPolicyBundleDigest: policy,
      confirmation: "register-request"
    });
    expect(
      parseCliArguments([
        "factory",
        "intake-register",
        "--config",
        "/private/agentlab/intake.json",
        "--request",
        "/private/agentlab/request.json",
        "--policy",
        policy,
        "--confirm-register-scheduled"
      ])
    ).toEqual({
      kind: "factory-intake-register",
      configPath: "/private/agentlab/intake.json",
      requestPath: "/private/agentlab/request.json",
      expectedPolicyBundleDigest: policy,
      confirmation: "register-scheduled-request"
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "intake-register",
        "--config",
        "/private/agentlab/intake.json",
        "--request",
        "/private/agentlab/request.json",
        "--policy",
        policy
      ])
    ).toThrow(/Usage/u);
  });

  it("requires exact autonomous discovery and canary-consumer policy pins", () => {
    const discoveryPolicy = `sha256:${"1".repeat(64)}` as const;
    const schedulePolicy = `sha256:${"2".repeat(64)}` as const;
    const factoryPolicy = `sha256:${"3".repeat(64)}` as const;
    const preparationGrant = `sha256:${"4".repeat(64)}` as const;
    const rolePolicy = `sha256:${"5".repeat(64)}` as const;
    expect(
      parseCliArguments([
        "factory",
        "maintenance-discovery-tick",
        "--config",
        "/private/agentlab/discovery.json",
        "--discovery-policy",
        discoveryPolicy,
        "--schedule-policy",
        schedulePolicy,
        "--policy",
        factoryPolicy,
        "--preparation-grant",
        preparationGrant,
        "--role-policy",
        rolePolicy
      ])
    ).toEqual({
      kind: "factory-maintenance-discovery-tick",
      configPath: "/private/agentlab/discovery.json",
      expectedDiscoveryPolicyDigest: discoveryPolicy,
      expectedSchedulePolicyDigest: schedulePolicy,
      expectedFactoryPolicyBundleDigest: factoryPolicy,
      expectedPreparationGrantDigest: preparationGrant,
      expectedRoleIdentityPolicyDigest: rolePolicy
    });
    expect(
      parseCliArguments([
        "factory",
        "canary-admission-tick",
        "--config",
        "/private/agentlab/canary-admission.json",
        "--cohort",
        discoveryPolicy,
        "--candidate",
        schedulePolicy,
        "--schedule-policy",
        factoryPolicy,
        "--role-policy",
        preparationGrant,
        "--policy",
        rolePolicy
      ])
    ).toEqual({
      kind: "factory-canary-admission-tick",
      configPath: "/private/agentlab/canary-admission.json",
      expectedCohortDigest: discoveryPolicy,
      expectedCandidateDigest: schedulePolicy,
      expectedSchedulePolicyDigest: factoryPolicy,
      expectedRoleIdentityPolicyDigest: preparationGrant,
      expectedFactoryPolicyBundleDigest: rolePolicy
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "maintenance-discovery-tick",
        "--config",
        "/private/agentlab/discovery.json",
        "--discovery-policy",
        "not-a-digest",
        "--schedule-policy",
        schedulePolicy,
        "--policy",
        factoryPolicy,
        "--preparation-grant",
        preparationGrant,
        "--role-policy",
        rolePolicy
      ])
    ).toThrow(/Usage/u);
  });

  it("requires exact schedule and factory policy pins for one scheduler tick", () => {
    const schedulePolicy = `sha256:${"1".repeat(64)}`;
    const dailyQuotaPolicy = `sha256:${"3".repeat(64)}`;
    const factoryPolicy = `sha256:${"2".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "scheduler-tick",
        "--config",
        "/private/agentlab/worker.json",
        "--schedule-policy",
        schedulePolicy,
        "--daily-quota",
        dailyQuotaPolicy,
        "--policy",
        factoryPolicy
      ])
    ).toEqual({
      kind: "factory-scheduler-tick",
      configPath: "/private/agentlab/worker.json",
      expectedSchedulePolicyDigest: schedulePolicy,
      expectedDailyQuotaPolicyDigest: dailyQuotaPolicy,
      expectedFactoryPolicyBundleDigest: factoryPolicy
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "scheduler-tick",
        "--config",
        "/private/agentlab/worker.json",
        "--schedule-policy",
        "not-a-digest",
        "--policy",
        factoryPolicy
      ])
    ).toThrow(/Usage/u);
  });

  it("requires an exact task, policy pin, and confirmation for draft creation", () => {
    const taskId = "0198f005-4ec4-7000-8000-000000000001";
    const policy = `sha256:${"a".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "broker-open-draft",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        taskId,
        "--policy",
        policy,
        "--confirm-draft"
      ])
    ).toEqual({
      kind: "factory-broker-open-draft",
      configPath: "/private/agentlab/broker.json",
      taskId,
      expectedPolicyBundleDigest: policy,
      confirmation: "confirm-draft"
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-open-draft",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        taskId,
        "--policy",
        policy
      ])
    ).toThrow(/Usage/u);
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-open-draft",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        "not-a-task",
        "--policy",
        policy,
        "--confirm-draft"
      ])
    ).toThrow(/Usage/u);
  });

  it("binds autonomous draft creation to exact canary and policy digests", () => {
    const taskId = "0198f005-4ec4-7000-8000-000000000001";
    const reservation = `sha256:${"1".repeat(64)}`;
    const schedulePolicy = `sha256:${"2".repeat(64)}`;
    const rolePolicy = `sha256:${"3".repeat(64)}`;
    const factoryPolicy = `sha256:${"4".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "broker-open-canary-draft",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        taskId,
        "--reservation",
        reservation,
        "--schedule-policy",
        schedulePolicy,
        "--role-policy",
        rolePolicy,
        "--policy",
        factoryPolicy
      ])
    ).toEqual({
      kind: "factory-broker-open-canary-draft",
      configPath: "/private/agentlab/broker.json",
      taskId,
      reservationDigest: reservation,
      schedulePolicyDigest: schedulePolicy,
      roleIdentityPolicyDigest: rolePolicy,
      expectedPolicyBundleDigest: factoryPolicy
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-open-canary-draft",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        taskId,
        "--reservation",
        "invalid",
        "--schedule-policy",
        schedulePolicy,
        "--role-policy",
        rolePolicy,
        "--policy",
        factoryPolicy
      ])
    ).toThrow(/Usage/u);
  });

  it("binds a canary broker tick to exact schedule, role, and factory policies", () => {
    const schedulePolicy = `sha256:${"2".repeat(64)}`;
    const rolePolicy = `sha256:${"3".repeat(64)}`;
    const factoryPolicy = `sha256:${"4".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "broker-canary-tick",
        "--config",
        "/private/agentlab/broker.json",
        "--schedule-policy",
        schedulePolicy,
        "--role-policy",
        rolePolicy,
        "--policy",
        factoryPolicy
      ])
    ).toEqual({
      kind: "factory-broker-canary-tick",
      configPath: "/private/agentlab/broker.json",
      expectedSchedulePolicyDigest: schedulePolicy,
      expectedRoleIdentityPolicyDigest: rolePolicy,
      expectedFactoryPolicyBundleDigest: factoryPolicy
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-canary-tick",
        "--config",
        "/private/agentlab/broker.json",
        "--schedule-policy",
        schedulePolicy,
        "--role-policy",
        "invalid",
        "--policy",
        factoryPolicy
      ])
    ).toThrow(/Usage/u);
  });

  it("binds PR maintenance to exact schedule, role, and factory policies", () => {
    const schedulePolicy = `sha256:${"2".repeat(64)}`;
    const rolePolicy = `sha256:${"3".repeat(64)}`;
    const factoryPolicy = `sha256:${"4".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "broker-pr-maintenance-tick",
        "--config",
        "/private/agentlab/broker.json",
        "--schedule-policy",
        schedulePolicy,
        "--role-policy",
        rolePolicy,
        "--policy",
        factoryPolicy
      ])
    ).toEqual({
      kind: "factory-broker-pr-maintenance-tick",
      configPath: "/private/agentlab/broker.json",
      expectedSchedulePolicyDigest: schedulePolicy,
      expectedRoleIdentityPolicyDigest: rolePolicy,
      expectedFactoryPolicyBundleDigest: factoryPolicy
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-pr-maintenance-tick",
        "--config",
        "/private/agentlab/broker.json",
        "--schedule-policy",
        schedulePolicy,
        "--role-policy",
        "invalid",
        "--policy",
        factoryPolicy
      ])
    ).toThrow(/Usage/u);
  });

  it("binds autonomous PR updates to exact schedule, role, and factory policies", () => {
    const schedulePolicy = `sha256:${"2".repeat(64)}`;
    const rolePolicy = `sha256:${"3".repeat(64)}`;
    const factoryPolicy = `sha256:${"4".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "broker-pr-update-tick",
        "--config",
        "/private/agentlab/broker.json",
        "--schedule-policy",
        schedulePolicy,
        "--role-policy",
        rolePolicy,
        "--policy",
        factoryPolicy
      ])
    ).toEqual({
      kind: "factory-broker-pr-update-tick",
      configPath: "/private/agentlab/broker.json",
      expectedSchedulePolicyDigest: schedulePolicy,
      expectedRoleIdentityPolicyDigest: rolePolicy,
      expectedFactoryPolicyBundleDigest: factoryPolicy
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-pr-update-tick",
        "--config",
        "/private/agentlab/broker.json",
        "--schedule-policy",
        schedulePolicy,
        "--role-policy",
        "invalid",
        "--policy",
        factoryPolicy
      ])
    ).toThrow(/Usage/u);
  });

  it("requires an exact task, policy pin, and confirmation for worker execution", () => {
    const taskId = "0198f005-4ec4-7000-8000-000000000001";
    const policy = `sha256:${"b".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "worker-run",
        "--config",
        "/private/agentlab/worker.json",
        "--task",
        taskId,
        "--policy",
        policy,
        "--confirm-run"
      ])
    ).toEqual({
      kind: "factory-worker-run",
      configPath: "/private/agentlab/worker.json",
      taskId,
      expectedPolicyBundleDigest: policy,
      confirmation: "run-task"
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "worker-run",
        "--config",
        "/private/agentlab/worker.json",
        "--task",
        taskId,
        "--policy",
        policy
      ])
    ).toThrow(/Usage/u);
  });

  it("requires an exact repair authorization, policy pin, and worker confirmation", () => {
    const taskId = "0198f005-4ec4-7000-8000-000000000001";
    const authorization = `sha256:${"d".repeat(64)}`;
    const policy = `sha256:${"e".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "worker-repair-pr",
        "--config",
        "/private/agentlab/worker.json",
        "--task",
        taskId,
        "--authorization",
        authorization,
        "--policy",
        policy,
        "--confirm-repair"
      ])
    ).toEqual({
      kind: "factory-worker-repair-pr",
      configPath: "/private/agentlab/worker.json",
      taskId,
      authorizationDigest: authorization,
      expectedPolicyBundleDigest: policy,
      confirmation: "repair-pr"
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "worker-repair-pr",
        "--config",
        "/private/agentlab/worker.json",
        "--task",
        taskId,
        "--authorization",
        authorization,
        "--policy",
        policy
      ])
    ).toThrow(/Usage/u);
  });

  it("binds autonomous worker repair to exact schedule, role, and factory policies", () => {
    const schedulePolicy = `sha256:${"5".repeat(64)}`;
    const rolePolicy = `sha256:${"6".repeat(64)}`;
    const factoryPolicy = `sha256:${"7".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "worker-pr-repair-tick",
        "--config",
        "/private/agentlab/worker.json",
        "--schedule-policy",
        schedulePolicy,
        "--role-policy",
        rolePolicy,
        "--policy",
        factoryPolicy
      ])
    ).toEqual({
      kind: "factory-worker-pr-repair-tick",
      configPath: "/private/agentlab/worker.json",
      expectedSchedulePolicyDigest: schedulePolicy,
      expectedRoleIdentityPolicyDigest: rolePolicy,
      expectedFactoryPolicyBundleDigest: factoryPolicy
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "worker-pr-repair-tick",
        "--config",
        "/private/agentlab/worker.json",
        "--schedule-policy",
        schedulePolicy,
        "--role-policy",
        "invalid",
        "--policy",
        factoryPolicy
      ])
    ).toThrow(/Usage/u);
  });

  it("requires an exact repair authorization, policy pin, and broker update confirmation", () => {
    const taskId = "0198f005-4ec4-7000-8000-000000000001";
    const authorization = `sha256:${"f".repeat(64)}`;
    const policy = `sha256:${"e".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "broker-update-draft",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        taskId,
        "--authorization",
        authorization,
        "--policy",
        policy,
        "--confirm-update"
      ])
    ).toEqual({
      kind: "factory-broker-update-draft",
      configPath: "/private/agentlab/broker.json",
      taskId,
      authorizationDigest: authorization,
      expectedPolicyBundleDigest: policy,
      confirmation: "confirm-update"
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-update-draft",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        taskId,
        "--authorization",
        authorization,
        "--policy",
        policy
      ])
    ).toThrow(/Usage/u);
  });

  it("requires an exact task, policy pin, and confirmation for PR observation", () => {
    const taskId = "0198f005-4ec4-7000-8000-000000000001";
    const policy = `sha256:${"c".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "broker-observe-pr",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        taskId,
        "--policy",
        policy,
        "--confirm-observe"
      ])
    ).toEqual({
      kind: "factory-broker-observe-pr",
      configPath: "/private/agentlab/broker.json",
      taskId,
      expectedPolicyBundleDigest: policy,
      confirmation: "confirm-observe"
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-observe-pr",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        taskId,
        "--policy",
        policy
      ])
    ).toThrow(/Usage/u);
  });

  it("requires an exact observation digest and explicit repair-admission confirmation", () => {
    const taskId = "0198f005-4ec4-7000-8000-000000000001";
    const observation = `sha256:${"d".repeat(64)}`;
    const policy = `sha256:${"c".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "broker-authorize-repair",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        taskId,
        "--observation",
        observation,
        "--policy",
        policy,
        "--confirm-repair"
      ])
    ).toEqual({
      kind: "factory-broker-authorize-repair",
      configPath: "/private/agentlab/broker.json",
      taskId,
      observationDigest: observation,
      expectedPolicyBundleDigest: policy,
      confirmation: "authorize-repair"
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-authorize-repair",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        taskId,
        "--observation",
        observation,
        "--policy",
        policy
      ])
    ).toThrow(/Usage/u);
  });

  it("requires exact compare-and-set state, reason, and matching broker confirmation", () => {
    expect(
      parseCliArguments([
        "factory",
        "authority-status",
        "--config",
        "/private/agentlab/authority.json"
      ])
    ).toEqual({
      kind: "factory-authority-status",
      configPath: "/private/agentlab/authority.json"
    });
    expect(
      parseCliArguments([
        "factory",
        "broker-authority",
        "--config",
        "/private/agentlab/authority.json",
        "--expected",
        "disabled",
        "--to",
        "enabled",
        "--reason",
        "Approved for one governed canary.",
        "--confirm-enable-draft-broker"
      ])
    ).toEqual({
      kind: "factory-broker-authority",
      configPath: "/private/agentlab/authority.json",
      expectedEnabled: false,
      enabled: true,
      reason: "Approved for one governed canary.",
      confirmation: "enable-draft-broker"
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-authority",
        "--config",
        "/private/agentlab/authority.json",
        "--expected",
        "disabled",
        "--to",
        "enabled",
        "--reason",
        "Wrong confirmation.",
        "--confirm-disable-draft-broker"
      ])
    ).toThrow(/Usage/u);
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-authority",
        "--config",
        "/private/agentlab/authority.json",
        "--expected",
        "enabled",
        "--to",
        "enabled",
        "--reason",
        "No-op.",
        "--confirm-enable-draft-broker"
      ])
    ).toThrow(/Usage/u);
  });

  it("keeps scheduler authority on its own exact compare-and-set command", () => {
    expect(
      parseCliArguments([
        "factory",
        "scheduler-authority",
        "--config",
        "/private/agentlab/authority.json",
        "--expected",
        "disabled",
        "--to",
        "enabled",
        "--reason",
        "Approved bounded daily maintenance.",
        "--confirm-enable-scheduler"
      ])
    ).toEqual({
      kind: "factory-scheduler-authority",
      configPath: "/private/agentlab/authority.json",
      expectedEnabled: false,
      enabled: true,
      reason: "Approved bounded daily maintenance.",
      confirmation: "enable-scheduler"
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "scheduler-authority",
        "--config",
        "/private/agentlab/authority.json",
        "--expected",
        "disabled",
        "--to",
        "enabled",
        "--reason",
        "Wrong confirmation.",
        "--confirm-disable-scheduler"
      ])
    ).toThrow(/Usage/u);
  });

  it("documents explicit factory commands and the child-mouse emergency kill switch", () => {
    expect(helpText).toContain("factory broker-preflight --config");
    expect(helpText).toContain("factory intake-preflight --config");
    expect(helpText).toContain("factory intake-register --config");
    expect(helpText).toContain("factory worker-preflight --config");
    expect(helpText).toContain("factory orchestration-render --config");
    expect(helpText).toContain("factory operations-health --config");
    expect(helpText).toContain("factory incident-containment --config");
    expect(helpText).toContain("factory maintenance-discovery-preflight --config");
    expect(helpText).toContain("factory maintenance-discovery-tick --config");
    expect(helpText).toContain("factory external-pr-review-preflight --config");
    expect(helpText).toContain("factory external-pr-review-tick --config");
    expect(helpText).toContain("factory external-pr-feedback-preflight --config");
    expect(helpText).toContain("factory external-pr-feedback-tick --config");
    expect(helpText).toContain("factory external-pr-repair-admission-preflight --config");
    expect(helpText).toContain("factory external-pr-repair-admission-tick --config");
    expect(helpText).toContain("factory external-pr-repair-execution-preflight --config");
    expect(helpText).toContain("factory external-pr-repair-execution-tick --config");
    expect(helpText).toContain("factory external-pr-repair-qualification-preflight --config");
    expect(helpText).toContain("factory external-pr-repair-qualification-tick --config");
    expect(helpText).toContain("factory canary-admission-tick --config");
    expect(helpText).toContain("factory worker-run --config");
    expect(helpText).toContain("factory scheduler-tick --config");
    expect(helpText).toContain("factory broker-open-draft --config");
    expect(helpText).toContain("factory broker-open-canary-draft --config");
    expect(helpText).toContain("factory broker-canary-tick --config");
    expect(helpText).toContain("factory broker-pr-maintenance-tick --config");
    expect(helpText).toContain("factory broker-pr-update-tick --config");
    expect(helpText).toContain("factory worker-pr-repair-tick --config");
    expect(helpText).toContain("factory broker-update-draft --config");
    expect(helpText).toContain("factory broker-observe-pr --config");
    expect(helpText).toContain("factory broker-authorize-repair --config");
    expect(helpText).toContain("factory authority-status --config");
    expect(helpText).toContain("factory broker-authority --config");
    expect(helpText).toContain("factory scheduler-authority --config");
    expect(helpText).toContain("never enables scheduling or contacts GitHub");
    expect(helpText).toContain("--confirm-draft");
    expect(helpText).toContain("--confirm-update");
    expect(helpText).toContain("--confirm-observe");
    expect(helpText).toContain("--confirm-repair");
    expect(helpText).toContain("--confirm-run");
    expect(helpText).toContain("AGENTLAB_DISABLE_MOUSE");
    expect(helpText).toContain("keep mouse input local");
  });

  it("parses only an absolute operations health config path", () => {
    expect(
      parseCliArguments([
        "factory",
        "operations-health",
        "--config",
        "/private/agentlab/operations-health.json"
      ])
    ).toEqual({
      kind: "factory-operations-health",
      configPath: "/private/agentlab/operations-health.json"
    });
    expect(() =>
      parseCliArguments(["factory", "operations-health", "--config", "health.json"])
    ).toThrow(/Usage/u);
  });

  it("parses only an absolute incident containment config path", () => {
    expect(
      parseCliArguments([
        "factory",
        "incident-containment",
        "--config",
        "/private/agentlab/incident.json",
        "--health-policy",
        `sha256:${"a".repeat(64)}`,
        "--daily-quota",
        `sha256:${"b".repeat(64)}`
      ])
    ).toEqual({
      kind: "factory-incident-containment",
      configPath: "/private/agentlab/incident.json",
      expectedHealthPolicyDigest: `sha256:${"a".repeat(64)}`,
      expectedDailyQuotaPolicyDigest: `sha256:${"b".repeat(64)}`
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "incident-containment",
        "--config",
        "incident.json",
        "--health-policy",
        `sha256:${"a".repeat(64)}`,
        "--daily-quota",
        `sha256:${"b".repeat(64)}`
      ])
    ).toThrow(/Usage/u);
  });

  it("rejects unknown flags and ambiguous arguments", () => {
    expect(() => parseCliArguments(["--listen"])).toThrow("Usage");
    expect(() => parseCliArguments(["one", "two"])).toThrow("Usage");
  });

  it("fails clearly before OpenTUI loads for an unsupported musl build", () => {
    expect(() => {
      assertSupportedTerminalRuntime("linux", { OPENTUI_LIBC: "musl" });
    }).toThrow("requires glibc");
    expect(() => {
      assertSupportedTerminalRuntime("linux", { OPENTUI_LIBC: "glibc" });
    }).not.toThrow();
    expect(() => {
      assertSupportedTerminalRuntime("darwin", { OPENTUI_LIBC: "musl" });
    }).not.toThrow();
  });
});
