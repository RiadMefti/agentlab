# Local factory evaluation, attestation, and canary-authority operations

This runbook covers the dormant offline promotion ledger accepted by
[ADR 0007](decisions/0007-deterministic-evaluation-and-canary-authority.md) and the isolated signing
boundary in [ADR 0009](decisions/0009-isolated-eval-attestation.md). It does not run an eval
harness, consume a cohort, contact GitHub, merge, release, deploy, or roll back production.

## Trust boundary

Use distinct non-shared operating-system accounts for the external harness, key-bearing attestor,
credentialless evaluator/verifier, and human release controller. Only the attestor account receives
the private key. Only the evaluator and human authority receive sequential access to the durable
SQLite ledger. Keep all files outside the source repository.

Config, eval-run, signed-artifact, and canary-request files must be canonical owner-only regular
files with one link. Symlinks, hard links, group/world permissions, unstable reads, unknown fields,
and oversized input are rejected.

```text
install -d -m 700 /absolute/private/agentlab
chmod 600 /absolute/private/agentlab/*.{json,pem}
```

Runner and operator IDs are audit identities. Authentication comes from operating-system isolation,
file ownership, private-key custody, the pinned public-key ID, and the exclusive writer lease. A
signature authenticates exact bytes; it does not prove that the external harness honestly ran the
trials. Preserve raw runs, grader evidence, signed artifacts, public keys, and ledger backups under
the organization's retention policy.

## Provision one Ed25519 trust root

Generate keys under a restrictive umask. The SHA-256 key ID is the digest of the public SPKI DER
bytes and must be prefixed with `sha256:` in both configs.

```text
umask 077
openssl genpkey -algorithm ED25519 -out /absolute/private/attestor/eval-private.pem
openssl pkey -in /absolute/private/attestor/eval-private.pem \
  -pubout -out /absolute/private/evaluator/eval-public.pem
openssl pkey -pubin -in /absolute/private/evaluator/eval-public.pem -outform DER \
  | sha256sum
```

Transfer the public key without granting the evaluator access to the private-key directory. Record
the calculated key ID through a reviewed channel. Do not reuse provider, GitHub, SSH, or release
keys. Rotation requires a new key ID, fresh evaluation/signature, and an explicit later authority
decision; retained records still require their original trust root for re-verification.

## Strict configurations

`attestor.json` is `agentlab.local-factory-eval-attestor.v1` and belongs only to the signing
account:

```json
{
  "schemaVersion": "agentlab.local-factory-eval-attestor.v1",
  "runnerId": "trusted-eval-runner",
  "privateKeyPath": "/absolute/private/attestor/eval-private.pem",
  "keyId": "sha256:...",
  "attestationLifetimeSeconds": 3600,
  "maximumIssuanceDelaySeconds": 300
}
```

`evaluator.json` is `agentlab.local-factory-evaluator.v2`. Its independent limits may be narrower
than the signer's and can never exceed one day for issuance delay or seven days for lifetime:

```json
{
  "schemaVersion": "agentlab.local-factory-evaluator.v2",
  "databasePath": "/absolute/private/evaluator/agentlab.sqlite",
  "runnerId": "trusted-eval-runner",
  "trustedPublicKeyPath": "/absolute/private/evaluator/eval-public.pem",
  "trustedKeyId": "sha256:...",
  "maximumIssuanceDelaySeconds": 300,
  "maximumAttestationLifetimeSeconds": 3600
}
```

The eval harness must emit a complete `agentlab.eval-run.v1` with:

```text
schemaVersion, runId, suiteDigest, suite,
baselineCandidateDigest, baselineCandidate,
challengerCandidateDigest, challengerCandidate,
samples, actor, startedAt, completedAt, correlationId
```

The actor must be a `gate-runner` of kind `ci` or `control-plane`, and its ID must equal both
configs' `runnerId`. Candidate and suite digests hash AgentLab canonical JSON. Samples are ordered
exactly by suite case ID and trial 1..N. Each coordinate includes matched baseline/challenger
results, unique seed, stable per-case fixture, grader evidence, outputs, traces, cost, latency, task
and safety outcomes. Never substitute summaries for raw samples.

## Assess, sign, verify, and inspect

The evaluator first records the exact run and deterministic assessment:

```text
agentlab factory eval-assess \
  --config /absolute/private/evaluator/evaluator.json \
  --run /absolute/private/evaluator/eval-run.json \
  --confirm-assess
```

The compact output contains run/candidate coordinates, sample count, deterministic metrics,
decision, maximum eligible stage, reason codes, and assessment digest. It omits samples and traces.
Exact retries return the existing assessment; changed content under one run ID conflicts.

Within the configured completion-to-issuance window, invoke signing under the isolated attestor
account. A restrictive umask ensures shell redirection creates an owner-only artifact:

```text
umask 077
agentlab factory eval-sign \
  --config /absolute/private/attestor/attestor.json \
  --run /absolute/private/attestor/eval-run.json \
  --confirm-sign \
  > /absolute/private/attestor/signed-attestation.json
chmod 600 /absolute/private/attestor/signed-attestation.json
```

Transfer the signed artifact—not the private key—to the evaluator account. Record it against the
exact assessment digest while it is valid:

```text
agentlab factory eval-attest \
  --config /absolute/private/evaluator/evaluator.json \
  --assessment sha256:... \
  --attestation /absolute/private/evaluator/signed-attestation.json \
  --confirm-attest
```

The verifier authenticates DSSE bytes with the configured public key, checks canonical statement and
envelope digests, binds the subject and predicate to the exact immutable run, independently checks
issuance delay/lifetime/current validity, binds the exact assessment, and appends one schema 13
record. The compact output includes attestation, assessment, run, key, issuance, expiry, and
verification coordinates; it omits the signature and embedded report. A second different artifact
for one run conflicts. Every service read re-verifies the signature and lineage.

Inspect the deterministic assessment separately:

```text
agentlab factory eval-inspect \
  --config /absolute/private/evaluator/evaluator.json \
  --assessment sha256:...
```

A passing assessment or valid attestation grants no task, scheduler, broker, merge, or release
authority. Review the full matched sample set and artifacts named by `humanSampleReviewDigest`;
confirm case-bank representativeness and grader calibration.

## Human canary authority remains dormant

Use a separate `canary-authority.json` and release-controller account:

```json
{
  "schemaVersion": "agentlab.local-factory-canary-authority.v1",
  "databasePath": "/absolute/private/evaluator/agentlab.sqlite",
  "operatorId": "release-controller"
}
```

The owner-only `agentlab.canary-request.v1` still contains stage, one repository, R0/R1 ceiling,
task count, complete aggregate budget, human-review digest/size, expiry, and reason. Its budget must
fit inside the evaluated suite limits. Issue only after independent human review:

```text
agentlab factory canary-authorize \
  --config /absolute/private/release/canary-authority.json \
  --assessment sha256:... \
  --request /absolute/private/release/canary-request.json \
  --confirm-authorize-canary
```

The result structurally fixes `autoMerge:false` and `release:false`. `read-only-shadow` requires R0;
`local-proposal` and `brokered-draft-pr` require R1. Important: the current canary-authority command
still resolves the deterministic assessment, not the attestation record. No shipped component reads
the cohort to execute work. Do not interpret issuance as a running canary or bypass intake, task
policy, broker preflight, repository governance, or human merge controls.

## Failure, recovery, and incident handling

Run/assessment and approval/cohort pairs commit atomically; an attestation is one immutable append.
On failure, preserve the database and source evidence and retry only exact input. SQLite rejects
updates and deletes. Stop if key ID, signature, payload, statement, run/assessment linkage, sample
order, fixture/seed integrity, policy recomputation, freshness, expiry, stage, repository, risk,
human sample, task count, or budget differs. A critical safety violation is unconditional denial.

For suspected key or harness compromise:

1. Disable scheduler and broker switches; stop evaluation, signing, and canary commands.
2. Preserve database/WAL, runs, artifacts, key IDs, grader evidence, and relevant logs read-only.
3. Quarantine affected candidates and all work derived from them; determine the first bad run.
4. Rotate the signing key and any independently exposed credentials. Never rewrite old records.
5. Repair the harness, rerun representative matched trials, sign with the new key, independently
   review, and require a fresh explicit authority decision.

The current slice does not automate revocation, rollback, notification, or incident paging.

## Activation gaps

Before any cohort drives even shadow work, AgentLab still needs a sandboxed harness producer;
content-addressed grader artifacts; stronger runner identity or hardware-backed key custody where
required; a crash-durable cohort consumer that requires a currently valid attestation, reserves
aggregate usage, and binds every task; telemetry/control comparison; expiry/revocation enforcement;
alerting; rollback drills; and incident automation. Brokered PR creation remains separately
human-confirmed and blocked by repository governance and live cost-policy prerequisites in
[ADR 0006](decisions/0006-local-software-factory-control-plane.md).
