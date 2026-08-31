import { describe, expect, it } from "vitest";

import {
  factoryIntakeRequestSchema,
  factoryIntakeSubmissionSchema,
  factoryPlanSchema,
  factoryPreparationAuthoritySchema,
  factoryPreparationBundleSchema,
  factoryPreparationEventSchema,
  factoryPreparationRunRecordSchema,
  factoryPreparationRunRequestSchema,
  factoryQualificationSchema
} from "@agentlab/contracts";

import { testFactoryPreparationFixture } from "../helpers/factory-preparation.js";

describe("factory preparation contracts", () => {
  it("strictly bounds owner-authored feature and bug submissions", () => {
    const submission = {
      schemaVersion: "agentlab.intake-submission.v1",
      kind: "bug",
      sourceRef: "local/bug-17",
      title: "Repair deterministic retry",
      body: "The same report must resolve to the same immutable preparation."
    };

    expect(factoryIntakeSubmissionSchema.parse(submission)).toEqual(submission);
    expect(factoryIntakeSubmissionSchema.safeParse({ ...submission, kind: "task" }).success).toBe(
      false
    );
    expect(
      factoryIntakeSubmissionSchema.safeParse({ ...submission, sourceRef: "bad\u0000ref" }).success
    ).toBe(false);
    expect(
      factoryIntakeSubmissionSchema.safeParse({ ...submission, authorityId: "forged" }).success
    ).toBe(false);
  });

  it("strictly validates intake and rejects control characters", () => {
    const { request } = testFactoryPreparationFixture();

    expect(factoryIntakeRequestSchema.parse(request)).toEqual(request);
    expect(
      factoryIntakeRequestSchema.safeParse({ ...request, mutableState: "qualified" }).success
    ).toBe(false);
    expect(
      factoryIntakeRequestSchema.safeParse({ ...request, title: "unsafe\u0000title" }).success
    ).toBe(false);
    expect(
      factoryIntakeRequestSchema.safeParse({
        ...request,
        requester: { ...request.requester, kind: "agent" }
      }).success
    ).toBe(false);
  });

  it("makes clarification and rejection dispositions structurally explicit", () => {
    const { qualification } = testFactoryPreparationFixture({
      qualificationDisposition: "needs-human"
    });

    expect(factoryQualificationSchema.parse(qualification)).toEqual(qualification);
    expect(
      factoryQualificationSchema.safeParse({ ...qualification, openQuestions: [] }).success
    ).toBe(false);
    expect(
      factoryQualificationSchema.safeParse({
        ...qualification,
        disposition: "ready",
        openQuestions: [],
        objective: null
      }).success
    ).toBe(false);
  });

  it("keeps policy controls outside model-authored plans", () => {
    const { plan } = testFactoryPreparationFixture();

    expect(factoryPlanSchema.parse(plan)).toEqual(plan);
    expect(
      factoryPlanSchema.safeParse({
        ...plan,
        approvals: { merge: { mode: "automatic" } }
      }).success
    ).toBe(false);
    expect(factoryPlanSchema.safeParse({ ...plan, selectedSkillIds: ["a", "a"] }).success).toBe(
      false
    );
  });

  it("rejects malformed authority graphs and unbound preparation runs", () => {
    const { authority, bundle } = testFactoryPreparationFixture();
    const brokenSkills = authority.skills.map((skill, index) =>
      index === 1 ? { ...skill, dependsOn: ["missing/skill"] } : skill
    );

    expect(
      factoryPreparationAuthoritySchema.safeParse({ ...authority, skills: brokenSkills }).success
    ).toBe(false);
    expect(
      factoryPreparationBundleSchema.safeParse({
        ...bundle,
        runs: bundle.runs.map((run, index) =>
          index === 0 ? { ...run, actor: { ...run.actor, kind: "human", sessionId: null } } : run
        )
      }).success
    ).toBe(false);
  });

  it("requires one read-only pinned preparation profile per phase", () => {
    const { authority } = testFactoryPreparationFixture();
    const duplicatePhase = authority.preparationProfiles.map((profile, index) =>
      index === 1 ? { ...profile, phase: "qualify" as const } : profile
    );
    const writable = authority.preparationProfiles.map((profile, index) =>
      index === 0
        ? {
            ...profile,
            capabilities: {
              ...profile.capabilities,
              filesystem: "workspace-write" as const,
              git: "worktree-write" as const
            }
          }
        : profile
    );

    expect(
      factoryPreparationAuthoritySchema.safeParse({
        ...authority,
        preparationProfiles: duplicatePhase
      }).success
    ).toBe(false);
    expect(
      factoryPreparationAuthoritySchema.safeParse({
        ...authority,
        preparationProfiles: writable
      }).success
    ).toBe(false);
    expect(
      factoryPreparationAuthoritySchema.safeParse({
        ...authority,
        schemaVersion: "agentlab.preparation-authority.v1"
      }).success
    ).toBe(false);
  });

  it("makes preparation run requests read-only and output records fail closed", () => {
    const fixture = testFactoryPreparationFixture();
    const request = fixture.documents.intakeRequest(fixture.request);
    const authority = fixture.documents.preparationAuthority(fixture.authority);
    const profile = fixture.authority.preparationProfiles[0];
    const skill = fixture.authority.skills[0];
    if (
      profile === undefined ||
      skill?.manifest.outputSchemaDigest === null ||
      skill?.manifest.outputSchemaDigest === undefined
    ) {
      throw new Error("Preparation fixture is incomplete.");
    }
    const artifact = { digest: request.digest, mediaType: "application/json", sizeBytes: 100 };
    const runRequest = factoryPreparationRunRequestSchema.parse({
      schemaVersion: "agentlab.preparation-run-request.v1",
      executionId: "11111111-1111-4111-8111-111111111111",
      taskId: fixture.request.taskId,
      requestDigest: request.digest,
      authorityDigest: authority.digest,
      phase: "qualify",
      attempt: 1,
      provider: profile.provider,
      model: profile.model,
      reasoning: profile.reasoning,
      repository: fixture.request.repository,
      skillId: skill.manifest.id,
      skillPackageDigest: skill.manifest.packageDigest,
      promptArtifact: artifact,
      inputArtifactDigests: [request.digest],
      outputSchemaDigest: skill.manifest.outputSchemaDigest,
      capabilities: profile.capabilities,
      budget: profile.budget
    });
    expect(factoryPreparationRunRequestSchema.parse(runRequest)).toEqual(runRequest);
    expect(
      factoryPreparationRunRequestSchema.safeParse({
        ...runRequest,
        capabilities: {
          ...runRequest.capabilities,
          filesystem: "workspace-write",
          git: "worktree-write"
        }
      }).success
    ).toBe(false);

    const runRecord = {
      schemaVersion: "agentlab.preparation-run-record.v1",
      executionId: runRequest.executionId,
      taskId: runRequest.taskId,
      requestDigest: runRequest.requestDigest,
      authorityDigest: runRequest.authorityDigest,
      phase: runRequest.phase,
      attempt: runRequest.attempt,
      provider: runRequest.provider,
      providerVersion: "1.0.0",
      harnessVersion: "test-harness-v1",
      model: runRequest.model,
      reasoning: runRequest.reasoning,
      providerSessionId: "session-1",
      status: "succeeded",
      startedAt: "2026-08-30T12:02:00.000Z",
      finishedAt: "2026-08-30T12:03:00.000Z",
      exitCode: 0,
      stdoutArtifact: artifact,
      stderrArtifact: artifact,
      finalOutputArtifact: artifact,
      outputDocumentArtifact: artifact,
      usage: {
        wallClockSeconds: 60,
        agentTurns: 1,
        toolCalls: 1,
        inputTokens: 100,
        outputTokens: 100,
        costMicrousd: 1_000,
        processes: 1,
        outputBytes: 100,
        workers: 1,
        repairAttempts: 0,
        changedFiles: 0,
        changedLines: 0
      },
      usageComplete: true,
      errorCode: null,
      isolation: {
        isolationId: runRequest.executionId,
        mechanism: { id: "systemd-run", version: "257" },
        scopeName: "agentlab-factory-11111111111141118111111111111111.scope",
        limits: { maxProcesses: 8, maxMemoryBytes: 1_073_741_824, cpuQuotaPercent: 100 }
      }
    } as const;
    expect(factoryPreparationRunRecordSchema.safeParse(runRecord).success).toBe(true);
    expect(
      factoryPreparationRunRecordSchema.safeParse({
        ...runRecord,
        outputDocumentArtifact: null
      }).success
    ).toBe(false);
  });

  it("rejects preparation events whose phase and state transition disagree", () => {
    const fixture = testFactoryPreparationFixture();
    const request = fixture.documents.intakeRequest(fixture.request);
    const authority = fixture.documents.preparationAuthority(fixture.authority);
    const event = {
      schemaVersion: "agentlab.preparation-event.v1",
      eventId: "11111111-1111-4111-8111-111111111111",
      taskId: fixture.request.taskId,
      sequence: 2,
      requestDigest: request.digest,
      authorityDigest: authority.digest,
      previousEventDigest: request.digest,
      kind: "phase-started",
      phase: "qualify",
      attempt: 1,
      executionId: "22222222-2222-4222-8222-222222222222",
      runRequestDigest: request.digest,
      from: "registered",
      to: "qualifying",
      skillId: "preparation/qualify",
      skillPackageDigest: fixture.authority.skills[0]?.manifest.packageDigest,
      workerProfileId: "preparation/qualify-worker",
      inputArtifactDigests: [request.digest],
      actor: {
        kind: "control-plane",
        role: "policy-engine",
        id: "local/factory-control-plane",
        sessionId: null
      },
      occurredAt: "2026-08-30T12:02:00.000Z",
      reasonCode: "qualify-started",
      summary: null,
      correlationId: "33333333-3333-4333-8333-333333333333"
    } as const;

    expect(factoryPreparationEventSchema.safeParse(event).success).toBe(true);
    expect(factoryPreparationEventSchema.safeParse({ ...event, to: "planning" }).success).toBe(
      false
    );
  });
});
