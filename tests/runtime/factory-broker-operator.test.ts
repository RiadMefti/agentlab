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
  const dependencies: FactoryBrokerOperatorDependencies = {
    repositoryId: "riadmefti/agentlab",
    policyBundleDigest,
    costPolicyConfigured,
    remote: { inspect },
    controls: { state },
    pullRequests: { openDraft },
    pullRequestObservations: { observe },
    pullRequestRepairAdmissions: { admit: admitRepair }
  };
  return {
    operator: new FactoryBrokerOperator(dependencies),
    inspect,
    state,
    openDraft,
    observe,
    admitRepair
  };
}
