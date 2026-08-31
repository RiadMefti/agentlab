import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FactoryIntakeOperator } from "../../packages/runtime/src/application/factory-intake-operator.js";
import { FactoryPreparationIntakeService } from "../../packages/runtime/src/application/factory-preparation-intake-service.js";
import { FactorySkillPackagePublisher } from "../../packages/runtime/src/application/factory-skill-package-publisher.js";
import { FactoryCostAccountant } from "../../packages/runtime/src/domain/factory-cost-accounting.js";
import { FactoryPreparationAuthorityIssuer } from "../../packages/runtime/src/domain/factory-preparation-authority.js";
import {
  defaultFactoryPolicyBundle,
  FactoryPolicyEngine
} from "../../packages/runtime/src/domain/factory-policy.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { CanonicalFactoryIntakeDeduplicator } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-intake-deduplicator.js";
import { SqliteFactoryPreparationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-preparation-repository.js";
import { TEST_FACTORY_CONVERSATION_ID } from "../helpers/factory.js";
import { testFactoryIntakePolicyFixture } from "../helpers/factory-intake.js";

const repositoryId = "riadmefti/agentlab";
const repositoryRoot = "/work/agentlab";
const policyDigestMismatch = `sha256:${"f".repeat(64)}` as const;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("FactoryIntakeOperator", () => {
  it("derives immutable identity and returns the original task on an exact retry", async () => {
    let revision = "a".repeat(40);
    const harness = intakeHarness(() => revision);
    try {
      await expect(harness.operator.preflight()).resolves.toMatchObject({
        status: "ready",
        repository: { repositoryId, baseRevision: revision },
        conversation: { active: true, workspaceMatches: true },
        reasonCodes: []
      });
      const first = await harness.operator.register(command(harness.policyBundleDigest));
      revision = "b".repeat(40);
      const retried = await harness.operator.register(command(harness.policyBundleDigest));

      expect(first).toMatchObject({
        status: "registered",
        state: "registered",
        requestKind: "bug",
        repository: { repositoryId, baseRevision: "a".repeat(40) }
      });
      expect(retried).toEqual({ ...first, status: "existing" });
      await expect(harness.repository.findById(first.taskId)).resolves.toMatchObject({
        request: {
          requestSources: [{ kind: "local", ref: "bug:local/bug-17" }],
          requester: { kind: "human", id: "maintainer/riad" },
          repository: { id: repositoryId, baseRevision: "a".repeat(40) }
        },
        authority: { policyBundleDigest: harness.policyBundleDigest }
      });
    } finally {
      harness.repository.close();
    }
  });

  it("conflicts on changed content or an unreviewed policy digest", async () => {
    const harness = intakeHarness(() => "a".repeat(40));
    try {
      await harness.operator.register(command(harness.policyBundleDigest));
      await expect(
        harness.operator.register({
          ...command(harness.policyBundleDigest),
          submission: { ...submission(), body: "Different immutable report text." }
        })
      ).rejects.toThrow(/different immutable content/u);
      await expect(harness.operator.register(command(policyDigestMismatch))).rejects.toThrow(
        /policy digest changed/u
      );
    } finally {
      harness.repository.close();
    }
  });

  it("blocks inactive ownership and incomplete exact-model cost policy", async () => {
    const harness = intakeHarness(() => "a".repeat(40), { active: false, emptyCosts: true });
    try {
      await expect(harness.operator.preflight()).resolves.toMatchObject({
        status: "blocked",
        reasonCodes: ["conversation-not-active", "cost-policy-incomplete"]
      });
      await expect(harness.operator.register(command(harness.policyBundleDigest))).rejects.toThrow(
        /intake is blocked/u
      );
    } finally {
      harness.repository.close();
    }
  });
});

function intakeHarness(
  revision: () => string,
  options: { readonly active?: boolean; readonly emptyCosts?: boolean } = {}
) {
  const fixture = testFactoryIntakePolicyFixture();
  const costPolicy = options.emptyCosts ? { ...fixture.costPolicy, rules: [] } : fixture.costPolicy;
  const documents = new NodeFactoryDocumentCodec();
  const policyBundle = encodeCanonicalDocument({ ...defaultFactoryPolicyBundle, costPolicy });
  const policy = new FactoryPolicyEngine(policyBundle.digest, policyBundle.value);
  const issuer = new FactoryPreparationAuthorityIssuer(documents, policy, fixture.grant);
  const repository = new SqliteFactoryPreparationRepository(":memory:", { documents });
  const artifacts = new FileFactoryArtifactStore(temporaryRoot());
  const skills = new FactorySkillPackagePublisher(
    documents,
    artifacts,
    fixture.grant,
    fixture.packages
  );
  const ids = [
    "10000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
    "30000000-0000-4000-8000-000000000003"
  ];
  const intake = new FactoryPreparationIntakeService(documents, issuer, repository, artifacts, {
    controlPlaneActorId: "agentlab-intake-policy",
    createEventId: () => requiredId(ids)
  });
  const operator = new FactoryIntakeOperator({
    repositoryId,
    repositoryRoot,
    conversationId: TEST_FACTORY_CONVERSATION_ID,
    operatorId: "maintainer/riad",
    authorityLifetimeSeconds: 3_600,
    policyBundleDigest: policyBundle.digest,
    grant: fixture.grant,
    supportedProviders: ["codex", "claude"],
    conversations: {
      findById: () =>
        Promise.resolve({
          id: TEST_FACTORY_CONVERSATION_ID,
          title: "AgentLab",
          workspacePath: repositoryRoot,
          provider: "codex" as const,
          model: "gpt-5.4",
          reasoning: "high",
          captainSessionName: "agentlab-captain",
          createdAt: "2026-08-31T10:00:00.000Z",
          updatedAt: "2026-08-31T10:00:00.000Z",
          lifecycleState: options.active === false ? ("deleting" as const) : ("active" as const),
          ownershipMode: "nonce" as const,
          ownershipNonce: "40000000-0000-4000-8000-000000000004"
        })
    },
    revisions: { currentRevision: () => Promise.resolve(revision()) },
    preparations: repository,
    deduplicator: new CanonicalFactoryIntakeDeduplicator(),
    skills,
    authorityIssuer: issuer,
    intake,
    costAccounting: new FactoryCostAccountant(policyBundle.digest, costPolicy),
    now: () => "2026-08-31T12:00:00.000Z",
    createId: () => requiredId(ids)
  });
  return { operator, repository, policyBundleDigest: policyBundle.digest };
}

function submission() {
  return {
    schemaVersion: "agentlab.intake-submission.v1" as const,
    kind: "bug" as const,
    sourceRef: "local/bug-17",
    title: "Repair deterministic retry",
    body: "The same report must resolve to the same immutable preparation."
  };
}

function command(policyBundleDigest: string) {
  return {
    submission: submission(),
    expectedPolicyBundleDigest: policyBundleDigest,
    confirmation: "register-request"
  };
}

function requiredId(ids: string[]): string {
  const id = ids.shift();
  if (id === undefined) throw new Error("Test exhausted deterministic IDs.");
  return id;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-intake-operator-"));
  temporaryRoots.push(root);
  return root;
}
