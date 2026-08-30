import { describe, expect, it } from "vitest";

import {
  factoryIntakeRequestSchema,
  factoryPlanSchema,
  factoryPreparationAuthoritySchema,
  factoryPreparationBundleSchema,
  factoryQualificationSchema
} from "@agentlab/contracts";

import { testFactoryPreparationFixture } from "../helpers/factory-preparation.js";

describe("factory preparation contracts", () => {
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
});
