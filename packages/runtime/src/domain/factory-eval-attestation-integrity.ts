import type {
  FactoryEvalAttestationRecord,
  FactoryEvalRun,
  FactorySignedEvalAttestation,
  Sha256Digest
} from "@agentlab/contracts";

import type { FactoryDsseVerificationResult } from "./factory-eval-attestation-crypto.js";
import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";

type AttestationDocuments = Pick<
  FactoryDocumentCodec,
  "evalAttestationStatement" | "dsseEnvelope" | "signedEvalAttestation" | "evalAttestationRecord"
>;

export function assertFactorySignedEvalAttestation(
  run: CanonicalFactoryDocument<FactoryEvalRun>,
  signed: CanonicalFactoryDocument<FactorySignedEvalAttestation>,
  verification: FactoryDsseVerificationResult,
  documents: AttestationDocuments
): void {
  const statement = documents.evalAttestationStatement(signed.value.statement);
  const envelope = documents.dsseEnvelope(signed.value.envelope);
  if (
    statement.digest !== signed.value.statementDigest ||
    envelope.digest !== signed.value.envelopeDigest ||
    verification.payload !== statement.json ||
    !envelope.value.signatures.some(({ keyid }) => keyid === verification.keyId)
  ) {
    throw new Error("Signed factory eval attestation failed canonical DSSE validation.");
  }
  const predicate = statement.value.predicate;
  if (
    predicate.runnerId !== run.value.actor.id ||
    predicate.runId !== run.value.runId ||
    predicate.runDigest !== run.digest ||
    predicate.suiteDigest !== run.value.suiteDigest ||
    predicate.caseBankDigest !== run.value.suite.caseBankDigest ||
    predicate.baselineHarnessDigest !== run.value.baselineCandidate.harnessDigest ||
    predicate.challengerHarnessDigest !== run.value.challengerCandidate.harnessDigest ||
    predicate.baselineCandidateDigest !== run.value.baselineCandidateDigest ||
    predicate.challengerCandidateDigest !== run.value.challengerCandidateDigest ||
    predicate.startedAt !== run.value.startedAt ||
    predicate.completedAt !== run.value.completedAt
  ) {
    throw new Error("Signed factory eval attestation does not match its exact eval run.");
  }
}

export function assertFactoryEvalAttestationRecord(
  run: CanonicalFactoryDocument<FactoryEvalRun>,
  assessmentDigest: Sha256Digest,
  record: CanonicalFactoryDocument<FactoryEvalAttestationRecord>,
  signedDigest: Sha256Digest,
  verification: FactoryDsseVerificationResult,
  documents: AttestationDocuments
): void {
  const signed = documents.signedEvalAttestation(record.value.signedAttestation);
  assertFactorySignedEvalAttestation(run, signed, verification, documents);
  const expected = documents.evalAttestationRecord({
    ...record.value,
    assessmentDigest,
    runId: run.value.runId,
    runDigest: run.digest,
    signedAttestationDigest: signedDigest,
    statementDigest: signed.value.statementDigest,
    envelopeDigest: signed.value.envelopeDigest,
    keyId: verification.keyId,
    verifier: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab-eval-attestation",
      sessionId: null
    }
  });
  if (expected.digest !== record.digest || expected.json !== record.json) {
    throw new Error("Factory eval attestation record failed deterministic integrity validation.");
  }
}
