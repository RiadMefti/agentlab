import {
  factoryDsseEnvelopeSchema,
  factoryEvalAttestationRecordSchema,
  factoryEvalAttestationStatementSchema,
  factorySignedEvalAttestationSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testEvalDigest, testFactoryEvalRun } from "../helpers/factory-evaluation.js";

const documents = new NodeFactoryDocumentCodec();
const attestationId = "10000000-0000-4000-8000-000000000006";

describe("factory eval-attestation contracts", () => {
  it("accepts one exact in-toto statement and rejects substituted lineage or time", () => {
    const { statement } = fixture();

    expect(factoryEvalAttestationStatementSchema.parse(statement)).toEqual(statement);
    expect(
      factoryEvalAttestationStatementSchema.safeParse({
        ...statement,
        predicate: { ...statement.predicate, unexpected: true }
      }).success
    ).toBe(false);
    expect(
      factoryEvalAttestationStatementSchema.safeParse({
        ...statement,
        subject: [{ ...statement.subject[0], digest: { sha256: "f".repeat(64) } }]
      }).success
    ).toBe(false);
    expect(
      factoryEvalAttestationStatementSchema.safeParse({
        ...statement,
        predicate: {
          ...statement.predicate,
          issuedAt: "2026-08-30T11:29:59.000Z"
        }
      }).success
    ).toBe(false);
    expect(
      factoryEvalAttestationStatementSchema.safeParse({
        ...statement,
        predicate: {
          ...statement.predicate,
          expiresAt: statement.predicate.issuedAt
        }
      }).success
    ).toBe(false);
  });

  it("requires one canonical Ed25519 DSSE signature", () => {
    const { envelope } = fixture();
    const signature = envelope.signatures[0];
    if (signature === undefined) throw new Error("Fixture requires one signature.");

    expect(factoryDsseEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(
      factoryDsseEnvelopeSchema.safeParse({
        ...envelope,
        signatures: [signature, { ...signature, keyid: testEvalDigest(901) }]
      }).success
    ).toBe(false);
    expect(
      factoryDsseEnvelopeSchema.safeParse({
        ...envelope,
        signatures: [{ ...signature, sig: signature.sig.replace(/==$/u, "") }]
      }).success
    ).toBe(false);
    expect(
      factoryDsseEnvelopeSchema.safeParse({ ...envelope, payload: `${envelope.payload}\n` }).success
    ).toBe(false);
    expect(
      factoryDsseEnvelopeSchema.safeParse({
        ...envelope,
        payloadType: "application/json"
      }).success
    ).toBe(false);
  });

  it("keeps the portable artifact and immutable verifier record strict and time-bound", () => {
    const { record, signed } = fixture();

    expect(factorySignedEvalAttestationSchema.parse(signed)).toEqual(signed);
    expect(factorySignedEvalAttestationSchema.safeParse({ ...signed, mutable: true }).success).toBe(
      false
    );
    expect(factoryEvalAttestationRecordSchema.parse(record)).toEqual(record);
    expect(
      factoryEvalAttestationRecordSchema.safeParse({
        ...record,
        verifier: { ...record.verifier, id: "forged-verifier" }
      }).success
    ).toBe(false);
    expect(
      factoryEvalAttestationRecordSchema.safeParse({
        ...record,
        verifiedAt: signed.statement.predicate.expiresAt
      }).success
    ).toBe(false);
    expect(
      factoryEvalAttestationRecordSchema.safeParse({
        ...record,
        runDigest: testEvalDigest(999)
      }).success
    ).toBe(false);
  });
});

function fixture() {
  const run = documents.evalRun(testFactoryEvalRun());
  const statement = documents.evalAttestationStatement({
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: "agentlab.eval-run",
        digest: { sha256: run.digest.slice("sha256:".length) }
      }
    ],
    predicateType: "https://agentlab.dev/attestations/eval-run/v1",
    predicate: {
      schemaVersion: "agentlab.eval-run-attestation-predicate.v1",
      runnerId: run.value.actor.id,
      runId: run.value.runId,
      runDigest: run.digest,
      suiteDigest: run.value.suiteDigest,
      caseBankDigest: run.value.suite.caseBankDigest,
      baselineHarnessDigest: run.value.baselineCandidate.harnessDigest,
      challengerHarnessDigest: run.value.challengerCandidate.harnessDigest,
      baselineCandidateDigest: run.value.baselineCandidateDigest,
      challengerCandidateDigest: run.value.challengerCandidateDigest,
      startedAt: run.value.startedAt,
      completedAt: run.value.completedAt,
      issuedAt: "2026-08-30T11:31:00.000Z",
      expiresAt: "2026-08-30T12:31:00.000Z"
    }
  });
  const keyId = testEvalDigest(900);
  const envelope = documents.dsseEnvelope({
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(statement.json, "utf8").toString("base64"),
    signatures: [{ keyid: keyId, sig: Buffer.alloc(64, 7).toString("base64") }]
  });
  const signed = documents.signedEvalAttestation({
    schemaVersion: "agentlab.signed-eval-attestation.v1",
    statementDigest: statement.digest,
    statement: statement.value,
    envelopeDigest: envelope.digest,
    envelope: envelope.value
  });
  const record = documents.evalAttestationRecord({
    schemaVersion: "agentlab.eval-attestation-record.v1",
    attestationId,
    assessmentDigest: testEvalDigest(902),
    runId: run.value.runId,
    runDigest: run.digest,
    signedAttestationDigest: signed.digest,
    statementDigest: statement.digest,
    envelopeDigest: envelope.digest,
    keyId,
    verifiedAt: "2026-08-30T11:32:00.000Z",
    verifier: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab-eval-attestation",
      sessionId: null
    },
    signedAttestation: signed.value
  });
  return {
    envelope: envelope.value,
    record: record.value,
    signed: signed.value,
    statement: statement.value
  };
}
