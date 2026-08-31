import {
  factoryPullRequestDispatchEventSchema,
  factoryPullRequestDispatchRunSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { testDigest } from "../helpers/factory.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const dispatchId = "22222222-2222-4222-8222-222222222222";
const correlationId = "33333333-3333-4333-8333-333333333333";
const occurredAt = "2026-08-30T13:00:00.000Z";
const proposal = {
  schemaVersion: "agentlab.pull-request-proposal.v1" as const,
  taskId,
  contractDigest: testDigest("1"),
  patchProposalDigest: testDigest("2"),
  patchArtifactDigest: testDigest("3"),
  changeSet: {
    baseRevision: "a".repeat(40),
    headRevision: null,
    changedPaths: ["docs/example.md"],
    binaryPaths: [],
    changedFiles: 1,
    changedLines: 2
  },
  policyEvaluationDigest: testDigest("4"),
  deduplicationKey: testDigest("5"),
  repositoryId: "example/agentlab",
  baseRevision: "a".repeat(40),
  baseBranch: "main",
  branchName: `agentlab/${"5".repeat(64)}`,
  title: "docs: test durable dispatch",
  body: "Exact reviewed proposal.",
  draft: true as const,
  createdAt: occurredAt
};

const run = {
  schemaVersion: "agentlab.pull-request-dispatch.v1" as const,
  dispatchId,
  taskId,
  contractDigest: proposal.contractDigest,
  proposalDigest: testDigest("6"),
  proposal,
  brokerId: "github-app/test",
  createdAt: occurredAt,
  correlationId
};

const commonEvent = {
  schemaVersion: "agentlab.pull-request-dispatch-event.v1" as const,
  eventId: "44444444-4444-4444-8444-444444444444",
  dispatchId,
  dispatchDigest: testDigest("7"),
  taskId,
  contractDigest: proposal.contractDigest,
  sequence: 3,
  previousEventDigest: testDigest("8"),
  actor: {
    kind: "broker" as const,
    role: "pr-broker" as const,
    id: "github-app/test",
    sessionId: null
  },
  occurredAt: "2026-08-30T13:00:02.000Z",
  reasonCode: "remote-draft-created",
  summary: null,
  correlationId
};

describe("pull-request dispatch contracts", () => {
  it("binds one exact proposal to a strict immutable dispatch run", () => {
    expect(factoryPullRequestDispatchRunSchema.parse(run)).toEqual(run);
    expect(
      factoryPullRequestDispatchRunSchema.safeParse({
        ...run,
        proposal: { ...proposal, taskId: "99999999-9999-4999-8999-999999999999" }
      }).success
    ).toBe(false);
    expect(
      factoryPullRequestDispatchRunSchema.safeParse({ ...run, mutableState: "sent" }).success
    ).toBe(false);
  });

  it("accepts only a linked exact draft record at the remote-observed checkpoint", () => {
    const event = {
      ...commonEvent,
      kind: "remote-observed" as const,
      from: "dispatch-active" as const,
      to: "remote-open" as const,
      record: {
        schemaVersion: "agentlab.pull-request-record.v1" as const,
        taskId,
        contractDigest: proposal.contractDigest,
        proposalDigest: run.proposalDigest,
        repositoryId: proposal.repositoryId,
        number: 42,
        url: "https://github.com/example/agentlab/pull/42",
        baseRevision: proposal.baseRevision,
        headRevision: "b".repeat(40),
        branchName: proposal.branchName,
        draft: true as const,
        brokerId: run.brokerId,
        createdAt: "2026-08-30T13:00:01.000Z"
      },
      created: true
    };
    expect(factoryPullRequestDispatchEventSchema.parse(event)).toEqual(event);
    expect(
      factoryPullRequestDispatchEventSchema.safeParse({
        ...event,
        previousEventDigest: null
      }).success
    ).toBe(false);
    expect(
      factoryPullRequestDispatchEventSchema.safeParse({
        ...event,
        record: { ...event.record, draft: false }
      }).success
    ).toBe(false);
  });
});
