import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sha256DigestSchema, type Sha256Digest } from "@agentlab/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FactoryEvalAttestationService } from "../../packages/runtime/src/application/factory-eval-attestation-service.js";
import { FactoryEvalAttestorService } from "../../packages/runtime/src/application/factory-eval-attestor-service.js";
import type { FactoryEvalAttestationKeySource } from "../../packages/runtime/src/domain/factory-eval-attestation-crypto.js";
import { NodeFactoryDsseSigner } from "../../packages/runtime/src/infrastructure/crypto/node-factory-dsse-signer.js";
import { NodeFactoryDsseVerifier } from "../../packages/runtime/src/infrastructure/crypto/node-factory-dsse-verifier.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryCanaryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-canary-repository.js";
import { SqliteFactoryEvalAttestationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-eval-attestation-repository.js";
import { SqliteFactoryEvaluationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-evaluation-repository.js";
import {
  TEST_ROLE_IDENTITY_POLICY_DIGEST,
  testEvalDigest,
  testFactoryCanaryDocuments,
  testFactoryEvalDocuments
} from "../helpers/factory-evaluation.js";

const documents = new NodeFactoryDocumentCodec();
const attestationId = "10000000-0000-4000-8000-000000000006";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryEvalAttestationRepository", () => {
  it("persists, reloads, and re-verifies one immutable assessment-bound attestation", async () => {
    const databasePath = temporaryDatabase();
    const evaluation = testFactoryEvalDocuments();
    const evaluations = new SqliteFactoryEvaluationRepository(databasePath);
    await evaluations.record(evaluation.run, evaluation.assessment);
    const key = signingKey();
    const verifier = new NodeFactoryDsseVerifier(new StaticKeySource(key.publicPem), key.keyId);
    const attestations = new SqliteFactoryEvalAttestationRepository(databasePath, {
      evaluations,
      verifier,
      expectedRoleIdentityPolicyDigest: TEST_ROLE_IDENTITY_POLICY_DIGEST,
      documents
    });
    const attestor = new FactoryEvalAttestorService({
      runnerId: "trusted-eval-runner",
      attestationLifetimeSeconds: 3_600,
      maximumIssuanceDelaySeconds: 300,
      roleIdentityPolicyDigest: TEST_ROLE_IDENTITY_POLICY_DIGEST,
      signer: new NodeFactoryDsseSigner(new StaticKeySource(key.privatePem), key.keyId),
      documents,
      now: () => "2026-08-30T11:31:00.000Z"
    });
    const signed = await attestor.attest(evaluation.run.value);
    const service = new FactoryEvalAttestationService({
      evaluations,
      attestations,
      verifier,
      maximumIssuanceDelaySeconds: 300,
      maximumAttestationLifetimeSeconds: 3_600,
      expectedRoleIdentityPolicyDigest: TEST_ROLE_IDENTITY_POLICY_DIGEST,
      documents,
      now: () => "2026-08-30T11:32:00.000Z",
      createId: vi.fn(() => attestationId)
    });

    const recorded = await service.record({
      assessmentDigest: evaluation.assessment.digest,
      signedAttestation: signed
    });
    const expected = {
      attestation: recorded.attestation,
      attestationDigest: recorded.attestationDigest
    };
    await expect(attestations.findByRunDigest(evaluation.run.digest)).resolves.toEqual(expected);
    await expect(attestations.findByAttestationDigest(recorded.attestationDigest)).resolves.toEqual(
      expected
    );
    const canonical = documents.evalAttestationRecord(recorded.attestation);
    await expect(attestations.record({ ...canonical, json: "{}" })).rejects.toThrow(
      /not canonical/u
    );
    const wrongAssessment = documents.evalAttestationRecord({
      ...recorded.attestation,
      assessmentDigest: testEvalDigest(997)
    });
    await expect(attestations.record(wrongAssessment)).rejects.toThrow(/exact assessment and run/u);

    const canaries = new SqliteFactoryCanaryRepository(databasePath, {
      evaluations,
      attestations,
      documents
    });
    const authority = testFactoryCanaryDocuments(evaluation.snapshot, {
      attestation: expected,
      expiresAt: "2026-08-30T12:30:00.000Z"
    });
    const wrongApproval = documents.canaryApproval({
      ...authority.approval.value,
      roleIdentityPolicyDigest: testEvalDigest(999)
    });
    const wrongCohort = documents.canaryCohort({
      ...authority.cohort.value,
      approvalDigest: wrongApproval.digest,
      roleIdentityPolicyDigest: testEvalDigest(999)
    });
    await expect(canaries.authorize(wrongApproval, wrongCohort)).rejects.toThrow(
      /verified attestation/u
    );
    const canarySnapshot = await canaries.authorize(authority.approval, authority.cohort);
    await expect(canaries.findByCohortDigest(authority.cohort.digest)).resolves.toEqual(
      canarySnapshot
    );
    canaries.close();
    attestations.close();
    evaluations.close();

    const reopenedEvaluations = new SqliteFactoryEvaluationRepository(databasePath);
    const wrongKey = signingKey();
    const wrongVerifierRepository = new SqliteFactoryEvalAttestationRepository(databasePath, {
      evaluations: reopenedEvaluations,
      verifier: new NodeFactoryDsseVerifier(
        new StaticKeySource(wrongKey.publicPem),
        wrongKey.keyId
      ),
      expectedRoleIdentityPolicyDigest: TEST_ROLE_IDENTITY_POLICY_DIGEST,
      documents
    });
    await expect(
      wrongVerifierRepository.findByAttestationDigest(recorded.attestationDigest)
    ).rejects.toThrow(/verification failed/u);
    wrongVerifierRepository.close();
    reopenedEvaluations.close();

    const database = new DatabaseSync(databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE factory_eval_attestations SET verified_at = verified_at").run()
      ).toThrow(/immutable/u);
      expect(() => database.prepare("DELETE FROM factory_eval_attestations").run()).toThrow(
        /immutable/u
      );
      expect(
        database
          .prepare(
            `SELECT attestation_digest, role_identity_policy_digest
             FROM factory_canary_cohorts`
          )
          .get()
      ).toEqual({
        attestation_digest: recorded.attestationDigest,
        role_identity_policy_digest: TEST_ROLE_IDENTITY_POLICY_DIGEST
      });
      const row = database.prepare("SELECT * FROM factory_eval_attestations").get() as
        AttestationSqlRow | undefined;
      if (row === undefined) throw new Error("Expected one stored factory eval attestation.");
      expect(() =>
        database
          .prepare(
            `INSERT INTO factory_eval_attestations (
              attestation_id, attestation_digest, assessment_digest, run_id, run_digest,
              signed_attestation_digest, statement_digest, envelope_digest, key_id,
              issued_at, expires_at, verified_at, attestation_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "10000000-0000-4000-8000-000000000099",
            testEvalDigest(990),
            row.assessment_digest,
            row.run_id,
            row.run_digest,
            row.signed_attestation_digest,
            row.statement_digest,
            row.envelope_digest,
            row.key_id,
            row.issued_at,
            row.expires_at,
            row.verified_at,
            row.attestation_json
          )
      ).toThrow(/identity mismatch/u);
    } finally {
      database.close();
    }
  });

  it("migrates a version-12 evaluation ledger without changing its assessment", async () => {
    const databasePath = temporaryDatabase();
    const evaluation = testFactoryEvalDocuments();
    const evaluations = new SqliteFactoryEvaluationRepository(databasePath);
    await evaluations.record(evaluation.run, evaluation.assessment);
    evaluations.close();
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        DROP TRIGGER factory_pull_request_dispatches_canary_guard;
        DROP INDEX factory_pull_request_dispatches_canary_idx;
        ALTER TABLE factory_pull_request_dispatches DROP COLUMN canary_reservation_digest;
        DROP TRIGGER factory_schedule_events_canary_finish_guard;
        DROP TRIGGER factory_schedule_events_canary_claim_guard;
        DROP TABLE factory_canary_task_reservations;
        DROP INDEX factory_canary_approvals_attestation_idx;
        DROP INDEX factory_canary_cohorts_attestation_idx;
        DROP TRIGGER factory_canary_approvals_identity_guard;
        DROP TRIGGER factory_canary_cohorts_identity_guard;
        ALTER TABLE factory_canary_approvals DROP COLUMN role_identity_policy_digest;
        ALTER TABLE factory_canary_approvals DROP COLUMN attestation_digest;
        ALTER TABLE factory_canary_cohorts DROP COLUMN role_identity_policy_digest;
        ALTER TABLE factory_canary_cohorts DROP COLUMN attestation_digest;
        DROP TABLE factory_eval_attestations;
        PRAGMA user_version = 12;
      `);
    } finally {
      legacy.close();
    }

    const migrated = new SqliteFactoryEvaluationRepository(databasePath);
    try {
      await expect(migrated.findByRunId(evaluation.run.value.runId)).resolves.toEqual(
        evaluation.snapshot
      );
      const inspected = new DatabaseSync(databasePath);
      try {
        expect(
          (inspected.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
        ).toBe(latestSchemaVersion);
        expect(
          inspected.prepare("SELECT COUNT(*) AS count FROM factory_eval_attestations").get()
        ).toEqual({ count: 0 });
      } finally {
        inspected.close();
      }
    } finally {
      migrated.close();
    }
  });
});

class StaticKeySource implements FactoryEvalAttestationKeySource {
  public constructor(private readonly material: Uint8Array) {}

  public load(): Promise<Uint8Array> {
    return Promise.resolve(Uint8Array.from(this.material));
  }
}

interface AttestationSqlRow {
  readonly assessment_digest: string;
  readonly run_id: string;
  readonly run_digest: string;
  readonly signed_attestation_digest: string;
  readonly statement_digest: string;
  readonly envelope_digest: string;
  readonly key_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly verified_at: string;
  readonly attestation_json: string;
}

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-factory-eval-attestation-"));
  temporaryRoots.push(root);
  return join(root, "agentlab.sqlite");
}

function signingKey(): {
  readonly privatePem: Uint8Array;
  readonly publicPem: Uint8Array;
  readonly keyId: Sha256Digest;
} {
  const pair = generateKeyPairSync("ed25519");
  return {
    privatePem: Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" })),
    publicPem: Buffer.from(pair.publicKey.export({ format: "pem", type: "spki" })),
    keyId: keyId(pair.publicKey)
  };
}

function keyId(publicKey: KeyObject): Sha256Digest {
  const der = publicKey.export({ format: "der", type: "spki" });
  return sha256DigestSchema.parse(`sha256:${createHash("sha256").update(der).digest("hex")}`);
}
