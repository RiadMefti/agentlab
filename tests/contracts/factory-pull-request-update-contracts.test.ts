import {
  factoryPullRequestAuthorityRecordSchema,
  factoryPullRequestUpdateEventSchema,
  factoryPullRequestUpdateProposalSchema,
  factoryPullRequestUpdateRecordSchema,
  factoryPullRequestUpdateRunSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { testDigest } from "../helpers/factory.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const updateId = "22222222-2222-4222-8222-222222222222";
const correlationId = "33333333-3333-4333-8333-333333333333";
const createdAt = "2026-08-30T13:00:00.000Z";
const baseRevision = "a".repeat(40);
const priorHeadRevision = "b".repeat(40);

const proposal = {
  schemaVersion: "agentlab.pull-request-update-proposal.v1" as const,
  taskId,
  contractDigest: testDigest("1"),
  policyBundleDigest: testDigest("2"),
  initialProposalDigest: testDigest("3"),
  priorPullRequestRecordDigest: testDigest("4"),
  repairAuthorizationDigest: testDigest("5"),
  repairRunDigest: testDigest("6"),
  repairedPatchProposalDigest: testDigest("7"),
  repairedPatchArtifactDigest: testDigest("8"),
  policyEvaluationDigest: testDigest("9"),
  changeSet: {
    baseRevision,
    headRevision: null,
    changedPaths: ["docs/example.md"],
    binaryPaths: [],
    changedFiles: 1,
    changedLines: 2
  },
  repositoryId: "example/agentlab",
  baseRevision,
  baseBranch: "main",
  branchName: `agentlab/${"c".repeat(64)}`,
  pullRequestNumber: 42,
  priorHeadRevision,
  brokerId: "github-app/test",
  contractRepairAttempt: 1,
  commitTitle: "fix: address authorized review feedback",
  createdAt
};

const run = {
  schemaVersion: "agentlab.pull-request-update.v1" as const,
  updateId,
  taskId,
  contractDigest: proposal.contractDigest,
  proposalDigest: testDigest("d"),
  proposal,
  brokerId: proposal.brokerId,
  createdAt,
  correlationId
};

const record = {
  schemaVersion: "agentlab.pull-request-update-record.v1" as const,
  taskId,
  contractDigest: proposal.contractDigest,
  initialProposalDigest: proposal.initialProposalDigest,
  updateProposalDigest: run.proposalDigest,
  priorPullRequestRecordDigest: proposal.priorPullRequestRecordDigest,
  repairAuthorizationDigest: proposal.repairAuthorizationDigest,
  repairRunDigest: proposal.repairRunDigest,
  repairedPatchProposalDigest: proposal.repairedPatchProposalDigest,
  repositoryId: proposal.repositoryId,
  number: proposal.pullRequestNumber,
  url: "https://github.com/example/agentlab/pull/42",
  baseRevision,
  priorHeadRevision,
  headRevision: "c".repeat(40),
  branchName: proposal.branchName,
  draft: true as const,
  brokerId: proposal.brokerId,
  contractRepairAttempt: 1,
  updatedAt: "2026-08-30T13:00:02.000Z"
};

describe("pull-request update contracts", () => {
  it("binds an exact repaired patch, prior authority record, and non-force parent", () => {
    expect(factoryPullRequestUpdateProposalSchema.parse(proposal)).toEqual(proposal);
    expect(factoryPullRequestUpdateRunSchema.parse(run)).toEqual(run);
    expect(
      factoryPullRequestUpdateProposalSchema.safeParse({
        ...proposal,
        changeSet: { ...proposal.changeSet, baseRevision: "f".repeat(40) }
      }).success
    ).toBe(false);
    expect(
      factoryPullRequestUpdateRunSchema.safeParse({
        ...run,
        proposal: { ...proposal, brokerId: "github-app/other" }
      }).success
    ).toBe(false);
  });

  it("accepts a strict authenticated update record while rejecting a non-advance", () => {
    expect(factoryPullRequestUpdateRecordSchema.parse(record)).toEqual(record);
    expect(factoryPullRequestAuthorityRecordSchema.parse(record)).toEqual(record);
    expect(
      factoryPullRequestUpdateRecordSchema.safeParse({
        ...record,
        headRevision: priorHeadRevision
      }).success
    ).toBe(false);
    expect(
      factoryPullRequestUpdateRecordSchema.safeParse({ ...record, merged: true }).success
    ).toBe(false);
  });

  it("requires the exact linked remote-update checkpoint shape", () => {
    const event = {
      schemaVersion: "agentlab.pull-request-update-event.v1" as const,
      eventId: "44444444-4444-4444-8444-444444444444",
      updateId,
      updateDigest: testDigest("e"),
      taskId,
      contractDigest: proposal.contractDigest,
      sequence: 3,
      previousEventDigest: testDigest("f"),
      actor: {
        kind: "broker" as const,
        role: "pr-broker" as const,
        id: proposal.brokerId,
        sessionId: null
      },
      occurredAt: record.updatedAt,
      reasonCode: "remote-draft-updated",
      summary: null,
      correlationId,
      kind: "remote-updated" as const,
      from: "update-active" as const,
      to: "remote-updated" as const,
      record,
      updated: true
    };
    expect(factoryPullRequestUpdateEventSchema.parse(event)).toEqual(event);
    expect(
      factoryPullRequestUpdateEventSchema.safeParse({
        ...event,
        previousEventDigest: null
      }).success
    ).toBe(false);
    expect(
      factoryPullRequestUpdateEventSchema.safeParse({ ...event, updated: "yes" }).success
    ).toBe(false);
  });
});
