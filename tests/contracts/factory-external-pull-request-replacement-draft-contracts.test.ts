import {
  factoryExternalPullRequestReplacementDraftPolicySchema,
  factoryExternalPullRequestReplacementDraftProposalSchema,
  factoryExternalPullRequestReplacementDraftRunSchema,
  replacementDraftBranchName,
  replacementDraftMarker
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { testDigest } from "../helpers/factory.js";

const runId = "97000000-0000-4000-8000-000000000001";
const runDigest = testDigest("a");
const qualificationDigest = testDigest("b");
const head = "1".repeat(40);
const base = "2".repeat(40);

describe("external pull-request replacement-draft contracts", () => {
  it("structurally forbids contributor writes, force pushes, approval, merge, and release", () => {
    const policy = policyFixture();
    expect(policy).toMatchObject({
      draft: true,
      contributorBranchWrite: false,
      forcePush: false,
      approval: false,
      autoMerge: false,
      release: false,
      maximumRiskTier: "R1"
    });
    expect(
      factoryExternalPullRequestReplacementDraftPolicySchema.safeParse({
        ...policy,
        forcePush: true
      }).success
    ).toBe(false);
    expect(
      factoryExternalPullRequestReplacementDraftPolicySchema.safeParse({
        ...policy,
        requiredStatusChecks: ["verify", "verify"]
      }).success
    ).toBe(false);
  });

  it("binds a run to the qualified exact head and a deadline", () => {
    const run = runFixture();
    expect(run.changeSet.baseRevision).toBe(run.expectedHeadRevision);
    expect(
      factoryExternalPullRequestReplacementDraftRunSchema.safeParse({
        ...run,
        deadlineAt: run.createdAt
      }).success
    ).toBe(false);
    expect(
      factoryExternalPullRequestReplacementDraftRunSchema.safeParse({
        ...run,
        changeSet: { ...run.changeSet, baseRevision: base }
      }).success
    ).toBe(false);
  });

  it("derives a separate deterministic branch and requires an auditable marker", () => {
    const branchName = replacementDraftBranchName(42, qualificationDigest);
    const proposal = proposalFixture(branchName);
    expect(branchName).toBe("agentlab/external-repair/pr-42-bbbbbbbbbbbbbbbb");
    expect(proposal.body).toContain(replacementDraftMarker(runId, runDigest));
    expect(
      factoryExternalPullRequestReplacementDraftProposalSchema.safeParse({
        ...proposal,
        branchName: "contributor/topic"
      }).success
    ).toBe(false);
    expect(
      factoryExternalPullRequestReplacementDraftProposalSchema.safeParse({
        ...proposal,
        body: "marker removed"
      }).success
    ).toBe(false);
  });
});

function policyFixture() {
  return factoryExternalPullRequestReplacementDraftPolicySchema.parse({
    schemaVersion: "agentlab.external-pull-request-replacement-draft-policy.v1",
    id: "agentlab/external-pull-request-replacement-draft",
    version: "1.0.0",
    repositoryId: "riadmefti/agentlab",
    brokerId: "github-app/external-repair",
    publisherId: "github-user/77",
    brokerUserId: 1003,
    qualificationPolicyDigest: testDigest("3"),
    roleIdentityPolicyDigest: testDigest("4"),
    branchPrefix: "agentlab/external-repair",
    requiredStatusChecks: ["verify", "factory-sandbox"],
    maximumPatchBytes: 1_048_576,
    maximumCandidatesPerTick: 3,
    operationDeadlineSeconds: 900,
    maximumRiskTier: "R1",
    draft: true,
    contributorBranchWrite: false,
    forcePush: false,
    approval: false,
    autoMerge: false,
    release: false
  });
}
function runFixture() {
  const policy = policyFixture();
  return factoryExternalPullRequestReplacementDraftRunSchema.parse({
    schemaVersion: "agentlab.external-pull-request-replacement-draft-run.v1",
    publicationRunId: runId,
    repositoryId: policy.repositoryId,
    originalPullRequestNumber: 42,
    qualificationRunId: "97000000-0000-4000-8000-000000000002",
    qualificationRunDigest: testDigest("5"),
    qualificationBundleDigest: qualificationDigest,
    repairBundleDigest: testDigest("6"),
    publicationPolicyDigest: testDigest("7"),
    publicationPolicy: policy,
    qualificationPolicyDigest: policy.qualificationPolicyDigest,
    expectedBaseRevision: base,
    expectedHeadRevision: head,
    repairedPatchDigest: testDigest("8"),
    changeSet: {
      baseRevision: head,
      headRevision: null,
      changedPaths: ["tracked.txt"],
      binaryPaths: [],
      changedFiles: 1,
      changedLines: 2
    },
    createdAt: "2026-09-01T13:00:00.000Z",
    deadlineAt: "2026-09-01T13:15:00.000Z",
    correlationId: "97000000-0000-4000-8000-000000000003"
  });
}
function proposalFixture(branchName: string) {
  return factoryExternalPullRequestReplacementDraftProposalSchema.parse({
    schemaVersion: "agentlab.external-pull-request-replacement-draft-proposal.v1",
    publicationRunId: runId,
    runDigest,
    repositoryId: "riadmefti/agentlab",
    originalPullRequestNumber: 42,
    originalPullRequestUrl: "https://github.com/riadmefti/agentlab/pull/42",
    qualificationBundleDigest: qualificationDigest,
    expectedBaseBranch: "main",
    expectedBaseRevision: base,
    expectedOriginalHeadRevision: head,
    repairedPatchDigest: testDigest("8"),
    changeSet: {
      baseRevision: head,
      headRevision: null,
      changedPaths: ["tracked.txt"],
      binaryPaths: [],
      changedFiles: 1,
      changedLines: 2
    },
    branchName,
    title: "Qualified repair for external PR #42",
    body: `${replacementDraftMarker(runId, runDigest)}\n\nEvidence only.`,
    commitTitle: "repair: qualify external PR #42",
    createdAt: "2026-09-01T13:00:00.000Z",
    draft: true,
    maintainerCanModify: false
  });
}
