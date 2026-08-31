import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sha256DigestSchema, type Sha256Digest } from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  createConfiguredLocalFactoryCanaryAuthority,
  createLocalFactoryCanaryAuthority
} from "../../packages/runtime/src/local-factory-canary-authority.js";
import { createLocalFactoryEvalAttestor } from "../../packages/runtime/src/local-factory-eval-attestor.js";
import {
  createConfiguredLocalFactoryEvaluator,
  createLocalFactoryEvaluator
} from "../../packages/runtime/src/local-factory-evaluator.js";
import { loadLocalFactorySignedEvalAttestation } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-signed-eval-attestation.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import {
  TEST_CANARY_APPROVAL_ID,
  TEST_CANARY_COHORT_ID,
  TEST_EVAL_ASSESSMENT_ID,
  testEvalDigest,
  testFactoryEvalBudget,
  testFactoryEvalRun,
  testFactoryRoleIdentityPolicy
} from "../helpers/factory-evaluation.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("local factory evaluation compositions", () => {
  it("rejects unreviewed or wrong-process signer identity before opening a key", () => {
    const keyId = testEvalDigest(901);
    const wrongAttestorUserId = process.getuid?.() === 1 ? 2 : 1;
    const policy = testFactoryRoleIdentityPolicy({
      keyId,
      workerUserId: wrongAttestorUserId === 2 ? 3 : 2,
      attestorUserId: wrongAttestorUserId
    });
    const digest = new NodeFactoryDocumentCodec().roleIdentityPolicy(policy).digest;
    const options = {
      runnerId: "trusted-eval-runner",
      privateKeyPath: "/key-must-not-be-opened.pem",
      keyId,
      attestationLifetimeSeconds: 3_600,
      maximumIssuanceDelaySeconds: 300,
      roleIdentityPolicy: policy,
      expectedRoleIdentityPolicyDigest: digest
    } as const;

    expect(() =>
      createLocalFactoryEvalAttestor({
        ...options,
        expectedRoleIdentityPolicyDigest: testEvalDigest(999)
      })
    ).toThrow(/changed after review/u);
    expect(() => createLocalFactoryEvalAttestor(options)).toThrow(/process identity/u);
    expect(existsSync(options.privateKeyPath)).toBe(false);
  });

  it("rejects evaluator trust coordinates outside the reviewed identity policy", () => {
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testEvalDigest(901),
      workerUserId: 1001,
      attestorUserId: 1002
    });
    const digest = new NodeFactoryDocumentCodec().roleIdentityPolicy(roleIdentityPolicy).digest;
    const config = {
      schemaVersion: "agentlab.local-factory-evaluator.v2" as const,
      databasePath: "/database-must-not-be-opened.sqlite",
      runnerId: "trusted-eval-runner",
      trustedPublicKeyPath: "/key-must-not-be-opened.pem",
      trustedKeyId: testEvalDigest(901),
      roleIdentityPolicyPath: "/role-policy-must-not-be-opened.json",
      expectedRoleIdentityPolicyDigest: digest,
      maximumIssuanceDelaySeconds: 300,
      maximumAttestationLifetimeSeconds: 3_600,
      roleIdentityPolicy
    };

    expect(() =>
      createConfiguredLocalFactoryEvaluator({
        ...config,
        expectedRoleIdentityPolicyDigest: testEvalDigest(999)
      })
    ).toThrow(/changed after review/u);
    expect(() =>
      createConfiguredLocalFactoryEvaluator({ ...config, trustedKeyId: testEvalDigest(902) })
    ).toThrow(/trust coordinates/u);
    expect(existsSync(config.databasePath)).toBe(false);

    expect(() =>
      createConfiguredLocalFactoryCanaryAuthority({
        schemaVersion: "agentlab.local-factory-canary-authority.v1",
        databasePath: config.databasePath,
        operatorId: "release-controller"
      })
    ).toThrow(/cannot issue cohorts without verified eval attestations/u);
    expect(() =>
      createLocalFactoryCanaryAuthority({
        databasePath: config.databasePath,
        operatorId: "release-controller",
        runnerId: config.runnerId,
        trustedPublicKeyPath: config.trustedPublicKeyPath,
        trustedKeyId: testEvalDigest(902),
        maximumIssuanceDelaySeconds: config.maximumIssuanceDelaySeconds,
        maximumAttestationLifetimeSeconds: config.maximumAttestationLifetimeSeconds,
        roleIdentityPolicy,
        expectedRoleIdentityPolicyDigest: digest
      })
    ).toThrow(/trust coordinates/u);
    expect(existsSync(config.databasePath)).toBe(false);
  });

  it("assesses, signs in isolation, verifies immutably, then issues a separate non-release cohort", async () => {
    const databasePath = temporaryDatabase();
    const key = writeSigningKey(dirname(databasePath));
    const processUserId = process.getuid?.();
    if (processUserId === undefined || processUserId < 1) {
      throw new Error("This identity-bound composition test requires a non-root POSIX user.");
    }
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: key.keyId,
      workerUserId: processUserId === 1 ? 2 : 1,
      attestorUserId: processUserId
    });
    const roleIdentityPolicyDigest = new NodeFactoryDocumentCodec().roleIdentityPolicy(
      roleIdentityPolicy
    ).digest;
    const evaluatorIds = [TEST_EVAL_ASSESSMENT_ID, "10000000-0000-4000-8000-000000000006"];
    const evaluator = createLocalFactoryEvaluator({
      databasePath,
      runnerId: "trusted-eval-runner",
      trustedPublicKeyPath: key.publicPath,
      trustedKeyId: key.keyId,
      maximumIssuanceDelaySeconds: 300,
      maximumAttestationLifetimeSeconds: 3_600,
      roleIdentityPolicy,
      expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
      now: () => "2026-08-30T11:32:00.000Z",
      createId: () => evaluatorIds.shift() ?? "10000000-0000-4000-8000-000000000099"
    });
    expect(Object.keys(evaluator.commands).sort()).toEqual(["assess", "attest", "inspect"]);
    const evaluation = await evaluator.commands.assess(testFactoryEvalRun());
    await expect(
      evaluator.commands.inspect({ assessmentDigest: evaluation.assessmentDigest })
    ).resolves.toEqual(evaluation);

    const attestor = createLocalFactoryEvalAttestor({
      runnerId: "trusted-eval-runner",
      privateKeyPath: key.privatePath,
      keyId: key.keyId,
      attestationLifetimeSeconds: 3_600,
      maximumIssuanceDelaySeconds: 300,
      roleIdentityPolicy,
      expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
      now: () => "2026-08-30T11:31:00.000Z"
    });
    expect(Object.keys(attestor.commands)).toEqual(["sign"]);
    const signed = await attestor.commands.sign(evaluation.run);
    await attestor.close();
    await expect(attestor.commands.sign(evaluation.run)).rejects.toThrow(/runtime is closing/u);
    const signedPath = join(dirname(databasePath), "signed-attestation.json");
    writeFileSync(signedPath, JSON.stringify(signed), { mode: 0o600 });
    chmodSync(signedPath, 0o600);
    await expect(loadLocalFactorySignedEvalAttestation(signedPath)).resolves.toEqual(signed);
    const attestation = await evaluator.commands.attest({
      assessmentDigest: evaluation.assessmentDigest,
      signedAttestation: signed
    });
    expect(attestation).toMatchObject({
      status: "recorded",
      attestation: {
        assessmentDigest: evaluation.assessmentDigest,
        runDigest: evaluation.runDigest,
        keyId: key.keyId
      }
    });
    await evaluator.close();
    await expect(evaluator.commands.assess(testFactoryEvalRun())).rejects.toThrow(
      /runtime is closing/u
    );

    const ids = [TEST_CANARY_APPROVAL_ID, TEST_CANARY_COHORT_ID];
    const authority = createLocalFactoryCanaryAuthority({
      databasePath,
      operatorId: "release-controller",
      runnerId: "trusted-eval-runner",
      trustedPublicKeyPath: key.publicPath,
      trustedKeyId: key.keyId,
      maximumIssuanceDelaySeconds: 300,
      maximumAttestationLifetimeSeconds: 3_600,
      roleIdentityPolicy,
      expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
      now: () => "2026-08-30T12:00:00.000Z",
      createId: () => ids.shift() ?? "10000000-0000-4000-8000-000000000099"
    });
    expect(Object.keys(authority.commands)).toEqual(["authorize"]);
    const command = {
      attestationDigest: attestation.attestationDigest,
      request: {
        schemaVersion: "agentlab.canary-request.v1",
        stage: "brokered-draft-pr",
        repositoryIds: ["agentlab"],
        maximumRiskTier: "R1",
        maximumTasks: 2,
        budget: testFactoryEvalBudget(),
        humanSampleReviewDigest: testEvalDigest(902),
        humanSampleSize: 4,
        expiresAt: "2026-08-30T12:30:00.000Z",
        reason: "Reviewed bounded promotion."
      },
      confirmation: "authorize-canary"
    } as const;
    const result = await authority.commands.authorize(command);

    expect(result).toMatchObject({
      status: "authorized",
      approval: {
        schemaVersion: "agentlab.canary-approval.v2",
        attestationDigest: attestation.attestationDigest,
        roleIdentityPolicyDigest,
        actor: { kind: "human", role: "release-controller", id: "release-controller" }
      },
      cohort: {
        schemaVersion: "agentlab.canary-cohort.v2",
        attestationDigest: attestation.attestationDigest,
        roleIdentityPolicyDigest,
        stage: "brokered-draft-pr",
        maximumRiskTier: "R1",
        autoMerge: false,
        release: false
      }
    });
    await expect(authority.commands.authorize(command)).resolves.toEqual({
      ...result,
      status: "existing"
    });
    await authority.close();
    await expect(authority.close()).resolves.toBeUndefined();

    const expiredAuthority = createLocalFactoryCanaryAuthority({
      databasePath,
      operatorId: "release-controller",
      runnerId: "trusted-eval-runner",
      trustedPublicKeyPath: key.publicPath,
      trustedKeyId: key.keyId,
      maximumIssuanceDelaySeconds: 300,
      maximumAttestationLifetimeSeconds: 3_600,
      roleIdentityPolicy,
      expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
      now: () => "2026-08-30T12:31:00.000Z"
    });
    await expect(expiredAuthority.commands.authorize(command)).rejects.toThrow(/validity window/u);
    await expiredAuthority.close();
  });

  it("refuses ephemeral databases for both authority-bearing compositions", () => {
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testEvalDigest(901),
      workerUserId: 1001,
      attestorUserId: 1002
    });
    expect(() =>
      createLocalFactoryEvaluator({
        databasePath: ":memory:",
        runnerId: "trusted-eval-runner",
        trustedPublicKeyPath: "/private/eval-public.pem",
        trustedKeyId: testEvalDigest(901),
        maximumIssuanceDelaySeconds: 300,
        maximumAttestationLifetimeSeconds: 3_600,
        roleIdentityPolicy,
        expectedRoleIdentityPolicyDigest: new NodeFactoryDocumentCodec().roleIdentityPolicy(
          roleIdentityPolicy
        ).digest
      })
    ).toThrow(/durable SQLite/u);
    expect(() =>
      createLocalFactoryCanaryAuthority({
        databasePath: ":memory:",
        operatorId: "release-controller",
        runnerId: "trusted-eval-runner",
        trustedPublicKeyPath: "/private/eval-public.pem",
        trustedKeyId: testEvalDigest(901),
        maximumIssuanceDelaySeconds: 300,
        maximumAttestationLifetimeSeconds: 3_600,
        roleIdentityPolicy,
        expectedRoleIdentityPolicyDigest: new NodeFactoryDocumentCodec().roleIdentityPolicy(
          roleIdentityPolicy
        ).digest
      })
    ).toThrow(/durable SQLite/u);
  });
});

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-local-evaluation-"));
  temporaryRoots.push(root);
  return join(root, "agentlab.sqlite");
}

function writeSigningKey(root: string): {
  readonly privatePath: string;
  readonly publicPath: string;
  readonly keyId: Sha256Digest;
} {
  const pair = generateKeyPairSync("ed25519");
  const privatePath = join(root, "eval-private.pem");
  const publicPath = join(root, "eval-public.pem");
  writeFileSync(privatePath, pair.privateKey.export({ format: "pem", type: "pkcs8" }), {
    mode: 0o600
  });
  writeFileSync(publicPath, pair.publicKey.export({ format: "pem", type: "spki" }), {
    mode: 0o600
  });
  chmodSync(privatePath, 0o600);
  chmodSync(publicPath, 0o600);
  return { privatePath, publicPath, keyId: publicKeyId(pair.publicKey) };
}

function publicKeyId(publicKey: KeyObject): Sha256Digest {
  const der = publicKey.export({ format: "der", type: "spki" });
  return sha256DigestSchema.parse(`sha256:${createHash("sha256").update(der).digest("hex")}`);
}
