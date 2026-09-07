import {
  factoryPullRequestObservationSchema,
  type FactoryPullRequestObservation
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { assessFactoryAutonomousMerge } from "../../packages/runtime/src/domain/factory-autonomous-merge.js";
import {
  TEST_MERGE_BASE_REVISION,
  TEST_MERGE_HEAD_REVISION,
  TEST_MERGE_REPOSITORY_ID,
  testFactoryAutonomousMergePolicy
} from "../helpers/factory-autonomous-merge.js";
import { TEST_FACTORY_TASK_ID, testDigest } from "../helpers/factory.js";

describe("assessFactoryAutonomousMerge", () => {
  it("admits only a fresh exact trusted-check set on an unchanged draft head", () => {
    const policy = testFactoryAutonomousMergePolicy();
    const observation = validObservation();

    expect(assessFactoryAutonomousMerge(observation, policy, "2026-09-01T12:04:00.000Z")).toEqual({
      status: "eligible",
      reasonCodes: []
    });
    expect(
      assessFactoryAutonomousMerge(
        { ...observation, remoteHeadRevision: "c".repeat(40) },
        policy,
        "2026-09-01T12:04:00.000Z"
      )
    ).toMatchObject({ status: "denied", reasonCodes: ["pull-request-head-drift"] });
  });

  it("fails closed on stale facts, extra checks, or nonliteral success", () => {
    const policy = testFactoryAutonomousMergePolicy();
    const observation = validObservation();

    expect(
      assessFactoryAutonomousMerge(observation, policy, "2026-09-01T12:09:00.000Z")
    ).toMatchObject({ status: "denied", reasonCodes: ["pull-request-observation-stale"] });
    expect(
      assessFactoryAutonomousMerge(
        {
          ...observation,
          trustedChecks: [
            ...observation.trustedChecks,
            { ...observation.trustedChecks[0], name: "unexpected" }
          ]
        } as FactoryPullRequestObservation,
        policy,
        "2026-09-01T12:04:00.000Z"
      ).reasonCodes
    ).toContain("trusted-check-set-mismatch");
    expect(
      assessFactoryAutonomousMerge(
        factoryPullRequestObservationSchema.parse({
          ...observation,
          trustedChecks: observation.trustedChecks.map((check, index) =>
            index === 0 ? { ...check, conclusion: "neutral" as const } : check
          )
        }),
        policy,
        "2026-09-01T12:04:00.000Z"
      ).reasonCodes
    ).toContain("trusted-check-not-successful");
  });
});

function validObservation(): FactoryPullRequestObservation {
  return factoryPullRequestObservationSchema.parse({
    schemaVersion: "agentlab.pull-request-observation.v1",
    taskId: TEST_FACTORY_TASK_ID,
    contractDigest: testDigest("4"),
    proposalDigest: testDigest("b"),
    pullRequestRecordDigest: testDigest("c"),
    repositoryId: TEST_MERGE_REPOSITORY_ID,
    pullRequestNumber: 42,
    url: "https://github.com/RiadMefti/agentlab/pull/42",
    brokerId: "github-app/agentlab-broker",
    authorizedBaseRevision: TEST_MERGE_BASE_REVISION,
    recordedHeadRevision: TEST_MERGE_HEAD_REVISION,
    remoteBaseRevision: TEST_MERGE_BASE_REVISION,
    remoteHeadRevision: TEST_MERGE_HEAD_REVISION,
    branchName: `agentlab/${"d".repeat(64)}`,
    state: "open",
    draft: true,
    merged: false,
    trustedChecks: [
      {
        name: "verify",
        producerId: "github-app/verify",
        status: "completed",
        runId: "701",
        conclusion: "success",
        url: "https://github.com/RiadMefti/agentlab/actions/runs/701",
        startedAt: "2026-09-01T12:00:00.000Z",
        completedAt: "2026-09-01T12:01:00.000Z"
      },
      {
        name: "factory-sandbox",
        producerId: "github-app/factory-sandbox",
        status: "completed",
        runId: "702",
        conclusion: "success",
        url: "https://github.com/RiadMefti/agentlab/actions/runs/702",
        startedAt: "2026-09-01T12:00:00.000Z",
        completedAt: "2026-09-01T12:02:00.000Z"
      }
    ],
    reviews: [
      {
        reviewId: "801",
        author: {
          externalId: "github-user/77",
          login: "reviewer",
          kind: "human",
          association: "member"
        },
        decision: "approved",
        headRevision: TEST_MERGE_HEAD_REVISION,
        untrustedBody: "",
        submittedAt: "2026-09-01T12:02:30.000Z",
        url: "https://github.com/RiadMefti/agentlab/pull/42#pullrequestreview-801"
      }
    ],
    reviewComments: [],
    conversationComments: [],
    observedAt: "2026-09-01T12:03:00.000Z"
  });
}
