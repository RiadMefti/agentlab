import {
  factoryExternalPullRequestRepairBundleSchema,
  factoryExternalPullRequestRepairExecutionEventSchema,
  factoryExternalPullRequestRepairExecutionPolicySchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { testExternalPullRequestRepairExecutionFixture } from "../helpers/factory-external-pull-request-repair-execution.js";
import { testDigest } from "../helpers/factory.js";

describe("external pull-request repair execution contracts", () => {
  it("requires an exact credentialless, one-attempt workspace grant", () => {
    const fixture = testExternalPullRequestRepairExecutionFixture();
    expect(fixture.executionPolicy).toMatchObject({
      maximumRiskTier: "R1",
      maximumRepairAttempts: 1,
      publicationMode: "replacement-draft",
      remoteWrite: false,
      autoMerge: false,
      release: false
    });
    expect(() =>
      factoryExternalPullRequestRepairExecutionPolicySchema.parse({
        ...fixture.executionPolicy,
        repairerProfile: {
          ...fixture.executionPolicy.repairerProfile,
          capabilities: {
            ...fixture.executionPolicy.repairerProfile.capabilities,
            network: { mode: "allowlist", hosts: ["github.com"] }
          }
        }
      })
    ).toThrow(/credentialless workspace-write grant/u);
  });

  it("allows recovery only before an agent starts", () => {
    const base = {
      schemaVersion: "agentlab.external-pull-request-repair-execution-event.v1",
      eventId: "95000000-0000-4000-8000-000000000020",
      repairRunId: "95000000-0000-4000-8000-000000000001",
      runDigest: testDigest("a"),
      sequence: 5,
      previousEventDigest: testDigest("b"),
      actor: {
        kind: "control-plane",
        role: "policy-engine",
        id: "agentlab/external-pull-request-repair-execution",
        sessionId: "95000000-0000-4000-8000-000000000001"
      },
      kind: "recovered",
      from: "repairer-active",
      to: "ready",
      occurredAt: "2026-09-01T12:26:00.000Z",
      reasonCode: "unsafe-retry",
      correlationId: "95000000-0000-4000-8000-000000000006"
    };
    expect(() => factoryExternalPullRequestRepairExecutionEventSchema.parse(base)).toThrow();
  });

  it("binds a non-empty patch, exact-head change set, and one repair attempt", () => {
    const fixture = testExternalPullRequestRepairExecutionFixture();
    expect(() =>
      factoryExternalPullRequestRepairBundleSchema.parse({
        schemaVersion: "agentlab.external-pull-request-repair-bundle.v1",
        repairRunId: "95000000-0000-4000-8000-000000000001",
        runDigest: testDigest("a"),
        repositoryId: fixture.executionPolicy.repositoryId,
        pullRequestNumber: 42,
        authorizationDigest: fixture.authorization.digest,
        repairExecutionPolicyDigest: fixture.executionPolicyDocument.digest,
        expectedHeadRevision: fixture.authorization.value.expectedHeadRevision,
        originalPatchDigest: fixture.authorization.value.patchDigest,
        repairerRequestDigest: testDigest("b"),
        repairerRecordDigest: testDigest("c"),
        executionId: "95000000-0000-4000-8000-000000000021",
        patchArtifact: {
          digest: testDigest("d"),
          mediaType: "application/vnd.git.patch",
          sizeBytes: 0
        },
        changeSet: {
          baseRevision: fixture.authorization.value.expectedHeadRevision,
          headRevision: null,
          changedPaths: [],
          binaryPaths: [],
          changedFiles: 0,
          changedLines: 0
        },
        usage: {
          wallClockSeconds: 1,
          agentTurns: 1,
          toolCalls: 1,
          inputTokens: 1,
          outputTokens: 1,
          costMicrousd: 1,
          processes: 1,
          outputBytes: 1,
          workers: 1,
          repairAttempts: 0,
          changedFiles: 0,
          changedLines: 0
        },
        usageComplete: true,
        repairAttempt: 1,
        publicationMode: "replacement-draft",
        remoteWrite: false,
        autoMerge: false,
        release: false,
        workspaceClosed: true,
        createdAt: "2026-09-01T12:26:00.000Z"
      })
    ).toThrow();
  });
});
