import { describe, expect, it, vi } from "vitest";

import {
  FactoryBrokerOperator,
  type FactoryBrokerOperatorDependencies
} from "../../packages/runtime/src/application/factory-broker-operator.js";
import type {
  FactoryRemoteRepositorySnapshot,
  FactoryRepositoryGovernance
} from "../../packages/runtime/src/domain/factory-pull-request-broker.js";

const policyBundleDigest = `sha256:${"a".repeat(64)}`;

describe("FactoryBrokerOperator", () => {
  it("reports every repository and local-authority blocker without changing state", async () => {
    const fixture = operatorFixture({
      requiresPullRequest: false,
      requiredApprovals: 0,
      dismissesStaleReviews: false,
      requiresCodeOwnerReviews: false,
      requiresLastPushApproval: false,
      enforcesAdmins: false,
      allowsForcePushes: true,
      allowsDeletions: true,
      requiredStatusChecks: ["verify"]
    });

    const report = await fixture.operator.preflight();

    expect(report).toMatchObject({
      schemaVersion: "agentlab.broker-preflight.v1",
      status: "blocked",
      policyBundleDigest,
      authorityEnabled: false
    });
    expect(report.reasonCodes).toEqual(
      [
        "pr-broker-disabled",
        "repository-admin-bypass-enabled",
        "repository-approval-rule-too-weak",
        "repository-branch-deletion-enabled",
        "repository-code-owner-review-rule-missing",
        "repository-factory-sandbox-check-missing",
        "repository-force-push-enabled",
        "repository-last-push-rule-missing",
        "repository-pr-rule-missing",
        "repository-stale-review-rule-missing"
      ].sort()
    );
    expect(fixture.openDraft).not.toHaveBeenCalled();
  });

  it("reports ready only when remote governance and local authority are both strong", async () => {
    const fixture = operatorFixture(strongGovernance, true);

    await expect(fixture.operator.preflight()).resolves.toMatchObject({
      status: "ready",
      authorityEnabled: true,
      reasonCodes: []
    });
  });

  it("blocks activation when no reviewed exact-model cost rule is configured", async () => {
    const fixture = operatorFixture(strongGovernance, true, "riadmefti/agentlab", false);

    await expect(fixture.operator.preflight()).resolves.toMatchObject({
      status: "blocked",
      authorityEnabled: true,
      reasonCodes: ["cost-policy-unconfigured"]
    });
    await expect(fixture.operator.openDraft({ taskId: "test" })).resolves.toEqual({
      status: "denied",
      reasonCodes: ["cost-policy-unconfigured"],
      decision: null
    });
    expect(fixture.openDraft).not.toHaveBeenCalled();
  });

  it("fails closed when the remote inspection returns another repository", async () => {
    const fixture = operatorFixture(strongGovernance, true, "riadmefti/another");

    await expect(fixture.operator.preflight()).rejects.toThrow(/another repository identity/u);
  });

  it("delegates draft creation only through the hardened pull-request service", async () => {
    const fixture = operatorFixture(strongGovernance, true);
    const draftCommand = { taskId: "0198f005-4ec4-7000-8000-000000000001" };

    await expect(fixture.operator.openDraft(draftCommand)).resolves.toEqual({
      status: "denied",
      reasonCodes: ["test-denial"],
      decision: null
    });
    expect(fixture.openDraft).toHaveBeenCalledWith(draftCommand);
  });

  it("delegates autonomous draft reconciliation only through the canary broker service", async () => {
    const fixture = operatorFixture(strongGovernance, true);
    const command = {
      expectedSchedulePolicyDigest: `sha256:${"1".repeat(64)}`,
      expectedRoleIdentityPolicyDigest: `sha256:${"2".repeat(64)}`,
      expectedFactoryPolicyBundleDigest: policyBundleDigest
    };

    await expect(fixture.operator.reconcileCanaryDrafts(command)).resolves.toMatchObject({
      schemaVersion: "agentlab.canary-broker-tick-result.v1",
      status: "idle"
    });
    expect(fixture.canaryTick).toHaveBeenCalledWith(command);
    expect(fixture.openDraft).not.toHaveBeenCalled();
  });

  it("rejects autonomous draft reconciliation when config v3 did not compose it", () => {
    const fixture = operatorFixture(strongGovernance, true);
    const operator = new FactoryBrokerOperator({ ...fixture.dependencies, canaryBroker: null });

    expect(() => operator.reconcileCanaryDrafts({})).toThrow(/config v3/u);
    expect(fixture.canaryTick).not.toHaveBeenCalled();
  });

  it("delegates autonomous PR maintenance only through the canary maintenance service", async () => {
    const fixture = operatorFixture(strongGovernance, true);
    const command = {
      expectedSchedulePolicyDigest: `sha256:${"1".repeat(64)}`,
      expectedRoleIdentityPolicyDigest: `sha256:${"2".repeat(64)}`,
      expectedFactoryPolicyBundleDigest: policyBundleDigest
    };

    await expect(fixture.operator.maintainCanaryPullRequests(command)).resolves.toMatchObject({
      schemaVersion: "agentlab.canary-pull-request-maintenance-tick-result.v1",
      status: "idle"
    });
    expect(fixture.maintenanceTick).toHaveBeenCalledWith(command);
    expect(fixture.openDraft).not.toHaveBeenCalled();
    expect(fixture.observe).not.toHaveBeenCalled();
  });

  it("rejects autonomous PR maintenance when config v3 did not compose it", () => {
    const fixture = operatorFixture(strongGovernance, true);
    const operator = new FactoryBrokerOperator({
      ...fixture.dependencies,
      canaryPullRequestMaintenance: null
    });

    expect(() => operator.maintainCanaryPullRequests({})).toThrow(/config v3/u);
    expect(fixture.maintenanceTick).not.toHaveBeenCalled();
  });

  it("delegates autonomous repaired-branch publication only through the update consumer", async () => {
    const fixture = operatorFixture(strongGovernance, true);
    const command = {
      expectedSchedulePolicyDigest: `sha256:${"1".repeat(64)}`,
      expectedRoleIdentityPolicyDigest: `sha256:${"2".repeat(64)}`,
      expectedFactoryPolicyBundleDigest: policyBundleDigest
    };

    await expect(fixture.operator.updateCanaryPullRequests(command)).resolves.toMatchObject({
      schemaVersion: "agentlab.canary-pull-request-update-tick-result.v1",
      status: "idle"
    });
    expect(fixture.updateTick).toHaveBeenCalledWith(command);
    expect(fixture.updatePullRequest).not.toHaveBeenCalled();
  });

  it("rejects autonomous repaired-branch publication when config v3 did not compose it", () => {
    const fixture = operatorFixture(strongGovernance, true);
    const operator = new FactoryBrokerOperator({
      ...fixture.dependencies,
      canaryPullRequestUpdates: null
    });

    expect(() => operator.updateCanaryPullRequests({})).toThrow(/config v3/u);
    expect(fixture.updateTick).not.toHaveBeenCalled();
  });

  it("delegates PR observation only through the facts-only observation service", async () => {
    const fixture = operatorFixture(strongGovernance, true);
    const command = { taskId: "0198f005-4ec4-7000-8000-000000000001" };

    await expect(fixture.operator.observePullRequest(command)).resolves.toEqual({
      status: "denied",
      reasonCodes: ["pr-broker-disabled"]
    });
    expect(fixture.observe).toHaveBeenCalledWith(command);
    expect(fixture.openDraft).not.toHaveBeenCalled();
  });

  it("delegates repair admission only through the non-executing admission service", async () => {
    const fixture = operatorFixture(strongGovernance, true);
    const command = {
      taskId: "0198f005-4ec4-7000-8000-000000000001",
      observationDigest: `sha256:${"f".repeat(64)}`
    };

    await expect(fixture.operator.admitPullRequestRepair(command)).resolves.toEqual({
      status: "denied",
      reasonCodes: ["test-repair-denial"]
    });
    expect(fixture.admitRepair).toHaveBeenCalledWith(command);
    expect(fixture.openDraft).not.toHaveBeenCalled();
    expect(fixture.observe).not.toHaveBeenCalled();
  });

  it("delegates repaired branch publication only through the governed update service", async () => {
    const fixture = operatorFixture(strongGovernance, true);
    const command = {
      taskId: "0198f005-4ec4-7000-8000-000000000001",
      authorizationDigest: `sha256:${"e".repeat(64)}`
    };

    await expect(fixture.operator.updatePullRequest(command)).resolves.toEqual({
      status: "denied",
      reasonCodes: ["test-update-denial"],
      decision: null
    });
    expect(fixture.updatePullRequest).toHaveBeenCalledWith(command);
    expect(fixture.openDraft).not.toHaveBeenCalled();
    expect(fixture.observe).not.toHaveBeenCalled();
    expect(fixture.admitRepair).not.toHaveBeenCalled();
  });
});

const strongGovernance: FactoryRepositoryGovernance = {
  requiresPullRequest: true,
  requiredApprovals: 1,
  dismissesStaleReviews: true,
  requiresCodeOwnerReviews: true,
  requiresLastPushApproval: true,
  enforcesAdmins: true,
  allowsForcePushes: false,
  allowsDeletions: false,
  requiredStatusChecks: ["verify", "factory-sandbox"]
};

function operatorFixture(
  governance: FactoryRepositoryGovernance,
  prBroker = false,
  inspectedRepositoryId = "riadmefti/agentlab",
  costPolicyConfigured = true
) {
  const repository: FactoryRemoteRepositorySnapshot = {
    repositoryId: inspectedRepositoryId,
    baseBranch: "main",
    baseRevision: "a".repeat(40),
    governance
  };
  const inspect = vi.fn().mockResolvedValue(repository);
  const state = vi.fn().mockResolvedValue({ scheduler: false, prBroker });
  const openDraft = vi.fn().mockResolvedValue({
    status: "denied" as const,
    reasonCodes: ["test-denial"],
    decision: null
  });
  const observe = vi.fn().mockResolvedValue({
    status: "denied" as const,
    reasonCodes: ["pr-broker-disabled"] as const
  });
  const admitRepair = vi.fn().mockResolvedValue({
    status: "denied" as const,
    reasonCodes: ["test-repair-denial"]
  });
  const updatePullRequest = vi.fn().mockResolvedValue({
    status: "denied" as const,
    reasonCodes: ["test-update-denial"],
    decision: null
  });
  const canaryTick = vi.fn().mockResolvedValue({
    schemaVersion: "agentlab.canary-broker-tick-result.v1" as const,
    status: "idle" as const,
    repositoryId: "riadmefti/agentlab",
    schedulePolicyDigest: `sha256:${"1".repeat(64)}` as const,
    factoryPolicyBundleDigest: policyBundleDigest,
    roleIdentityPolicyDigest: `sha256:${"2".repeat(64)}` as const,
    observedAt: "2026-08-31T12:00:00.000Z",
    candidatesInspected: 0,
    dispatchAttempts: 0,
    draftsCompleted: 0,
    hasMore: false,
    reasonCodes: [],
    tasks: []
  });
  const maintenanceTick = vi.fn().mockResolvedValue({
    schemaVersion: "agentlab.canary-pull-request-maintenance-tick-result.v1" as const,
    status: "idle" as const,
    repositoryId: "riadmefti/agentlab",
    schedulePolicyDigest: `sha256:${"1".repeat(64)}` as const,
    factoryPolicyBundleDigest: policyBundleDigest,
    roleIdentityPolicyDigest: `sha256:${"2".repeat(64)}` as const,
    maintenanceSlot: "2026-08-31T12:00:00.000Z",
    observedAt: "2026-08-31T13:00:00.000Z",
    candidatesInspected: 0,
    maintenanceAttempts: 0,
    observationsCreated: 0,
    repairAuthorizationsCreated: 0,
    hasMore: false,
    reasonCodes: [],
    tasks: []
  });
  const updateTick = vi.fn().mockResolvedValue({
    schemaVersion: "agentlab.canary-pull-request-update-tick-result.v1" as const,
    status: "idle" as const,
    repositoryId: "riadmefti/agentlab",
    schedulePolicyDigest: `sha256:${"1".repeat(64)}` as const,
    factoryPolicyBundleDigest: policyBundleDigest,
    roleIdentityPolicyDigest: `sha256:${"2".repeat(64)}` as const,
    observedAt: "2026-08-31T13:00:00.000Z",
    candidatesInspected: 0,
    recoveryAttempts: 0,
    updateAttempts: 0,
    updatesCompleted: 0,
    remoteUpdates: 0,
    hasMore: false,
    reasonCodes: [],
    tasks: []
  });
  const dependencies: FactoryBrokerOperatorDependencies = {
    repositoryId: "riadmefti/agentlab",
    policyBundleDigest,
    costPolicyConfigured,
    remote: { inspect },
    controls: { state },
    pullRequests: { openDraft },
    pullRequestObservations: { observe },
    pullRequestRepairAdmissions: { admit: admitRepair },
    pullRequestUpdates: { update: updatePullRequest },
    canaryBroker: { tick: canaryTick },
    canaryPullRequestMaintenance: { tick: maintenanceTick },
    canaryPullRequestUpdates: { tick: updateTick }
  };
  return {
    operator: new FactoryBrokerOperator(dependencies),
    dependencies,
    inspect,
    state,
    openDraft,
    observe,
    admitRepair,
    updatePullRequest,
    canaryTick,
    maintenanceTick,
    updateTick
  };
}
