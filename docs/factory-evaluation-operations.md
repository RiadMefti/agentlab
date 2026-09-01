# Local factory evaluation, attestation, and canary-authority operations

This runbook covers the dormant offline promotion lane accepted by
[ADR 0007](decisions/0007-deterministic-evaluation-and-canary-authority.md) and the isolated signing
boundary in [ADR 0009](decisions/0009-isolated-eval-attestation.md), including the sandboxed
producer in [ADR 0022](decisions/0022-sandboxed-eval-evidence-production.md). It does not consume a
cohort, contact GitHub, merge, release, deploy, or roll back production.

## Trust boundary

Use distinct non-shared operating-system accounts for the offline producer, key-bearing attestor,
credentialless evaluator/verifier, and human release controller. Only the producer may execute
installed eval harnesses; only the attestor receives the private key. Give producer, evaluator, and
human authority sequential writer access to the durable SQLite ledger, never simultaneous access.
Keep all files outside the source repository.

Config, production-job, role-policy, eval-run, signed-artifact, and canary-request files must be
owner-only regular files with one link. Symlinks, hard links, group/world permissions, unstable
reads, unknown fields, and oversized input are rejected.

```text
install -d -m 700 /absolute/private/agentlab
chmod 600 /absolute/private/agentlab/*.{json,pem}
```

Runner and operator IDs are audit identities. Authentication comes from operating-system isolation,
file ownership, private-key custody, the pinned public-key ID, and the exclusive writer lease. A
signature authenticates exact bytes; sandboxing and lineage do not prove that an installed harness
or grader is honest. Preserve raw runs, subject traces, grader evidence, signed artifacts, public
keys, and ledger backups under the organization's retention policy.

## Produce one matched run offline

The producer is a separate credentialless process. Its owner-only
`agentlab.local-factory-eval-producer.v1` config names dedicated database, content-addressed
artifact, and ephemeral workspace roots; the roots must not overlap. It maps each reviewed harness
or grader descriptor digest to one absolute executable and exact executable digest:

```json
{
  "schemaVersion": "agentlab.local-factory-eval-producer.v1",
  "databasePath": "/absolute/private/producer/agentlab.sqlite",
  "artifactRoot": "/absolute/private/producer/artifacts",
  "workspaceRoot": "/absolute/private/producer/workspaces",
  "runnerId": "trusted-eval-runner",
  "executables": [
    {
      "descriptorDigest": "sha256:...",
      "executable": "/opt/agentlab-evals/baseline",
      "executableDigest": "sha256:...",
      "version": "1.0.0"
    },
    {
      "descriptorDigest": "sha256:...",
      "executable": "/opt/agentlab-evals/challenger",
      "executableDigest": "sha256:...",
      "version": "1.1.0"
    },
    {
      "descriptorDigest": "sha256:...",
      "executable": "/opt/agentlab-evals/grader",
      "executableDigest": "sha256:...",
      "version": "1.0.0"
    }
  ],
  "systemd": {
    "runExecutable": "/usr/bin/systemd-run",
    "controlExecutable": "/usr/bin/systemctl",
    "environmentExecutable": "/usr/bin/env",
    "version": "systemd 257"
  },
  "sandbox": {
    "bubblewrapExecutable": "/usr/bin/bwrap",
    "runtimeRoots": ["/opt/agentlab-evals"]
  }
}
```

The separate owner-only `agentlab.eval-production-job.v1` embeds the exact suite, case bank,
baseline/challenger candidates, their distinct harness descriptors, grader descriptor, budgets,
resource limits, runner, creation/deadline window, and correlation ID. Every embedded object has a
matching canonical digest. Fixtures are preloaded content-addressed artifacts. Case seeds are
unique, the matrix matches the suite exactly, and the aggregate budget reserves all three
invocations per trial. Review the canonical job out of band and pin its complete SHA-256 digest
before execution.

```text
agentlab factory eval-producer-preflight \
  --config /absolute/private/producer/producer.json \
  --job /absolute/private/producer/job.json \
  --job-digest sha256:...

agentlab factory eval-produce \
  --config /absolute/private/producer/producer.json \
  --job /absolute/private/producer/job.json \
  --job-digest sha256:...
```

Preflight revalidates every digest, fixture, executable binding, matrix, reservation, runner, and
validity window without starting a harness. Production launches fixed `subject`/`grade` protocols
sequentially in offline bubblewrap sandboxes inside bounded systemd scopes. The emitted terminal
result names the exact run artifact and digest; a failed result is final and nonzero. Exact
completed retries do not execute again. Copy the run artifact by digest to the evaluator account
through a reviewed read-only transfer and verify its SHA-256 before changing ownership or
permissions. Never give the producer provider, signing, GitHub, broker, or release credentials.

This lane is intentionally absent from the daily maintenance timer. A candidate cannot originate or
schedule its own qualification.

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

Provision identical canonical copies of `agentlab.role-identity-policy.v1` under the worker,
attestor, and evaluator accounts. Each copy is owner-only; each config pins the same canonical
SHA-256 digest. The policy shape is shown in the scheduler runbook. Its attestor UID, runner ID, and
key ID must match the signing account and both eval configs, and its worker UID must be distinct.

`attestor.json` is `agentlab.local-factory-eval-attestor.v1` and belongs only to the signing
account:

```json
{
  "schemaVersion": "agentlab.local-factory-eval-attestor.v1",
  "runnerId": "trusted-eval-runner",
  "privateKeyPath": "/absolute/private/attestor/eval-private.pem",
  "keyId": "sha256:...",
  "roleIdentityPolicyPath": "/absolute/private/attestor/role-identities.json",
  "expectedRoleIdentityPolicyDigest": "sha256:...",
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
  "roleIdentityPolicyPath": "/absolute/private/evaluator/role-identities.json",
  "expectedRoleIdentityPolicyDigest": "sha256:...",
  "maximumIssuanceDelaySeconds": 300,
  "maximumAttestationLifetimeSeconds": 3600
}
```

The producer emits a complete `agentlab.eval-run.v1` with:

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
envelope digests, binds the subject and predicate to the exact immutable run and reviewed
role-policy digest, independently checks issuance delay/lifetime/current validity, binds the exact
assessment, and appends one schema 13 record. The compact output includes attestation, assessment,
run, key, issuance, expiry, and verification coordinates; it omits the signature and embedded
report. A second different artifact for one run conflicts. Every service read re-verifies the
signature and lineage.

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
  "schemaVersion": "agentlab.local-factory-canary-authority.v2",
  "databasePath": "/absolute/private/evaluator/agentlab.sqlite",
  "operatorId": "release-controller",
  "runnerId": "trusted-eval-runner",
  "trustedPublicKeyPath": "/absolute/private/release/eval-public.pem",
  "trustedKeyId": "sha256:...",
  "roleIdentityPolicyPath": "/absolute/private/release/role-identities.json",
  "expectedRoleIdentityPolicyDigest": "sha256:...",
  "maximumIssuanceDelaySeconds": 300,
  "maximumAttestationLifetimeSeconds": 3600
}
```

The public key and role-policy copy are owner-only but contain no signing secret. Their key, runner,
and policy digests must match the evaluator and attestor deployment. Config v1 remains parseable for
incident diagnosis but cannot issue new authority.

The owner-only `agentlab.canary-request.v1` still contains stage, one repository, R0/R1 ceiling,
task count, complete aggregate budget, human-review digest/size, expiry, and reason. Its budget must
fit inside the evaluated suite limits. Issue only after independent human review:

```text
agentlab factory canary-authorize \
  --config /absolute/private/release/canary-authority.json \
  --attestation sha256:... \
  --request /absolute/private/release/canary-request.json \
  --confirm-authorize-canary
```

The authority independently re-verifies the stored signature, run/assessment lineage, role-policy
digest, and current validity window. Approval and cohort v2 bind the exact attestation and cannot
outlive it. The result structurally fixes `autoMerge:false` and `release:false`. `read-only-shadow`
requires R0; `local-proposal` and `brokered-draft-pr` require R1. Issuance alone does not run work.

An owner-only `agentlab.local-factory-canary-admission.v1` config pins the database, trusted public
key and runner, role-policy digest, cohort, candidate, schedule policy, factory policy, and
attestation timing limits. After a scheduled intake and preparation record exist, reserve one exact
task:

```text
agentlab factory canary-reserve \
  --config /absolute/private/release/canary-admission.json \
  --task 00000000-0000-4000-8000-000000000000
```

Admission re-verifies the v2 signature and full lineage after every retry, rechecks freshness after
verification, and atomically records the task's complete ceiling against cohort task and budget
limits. Exact retries return the immutable reservation. It executes no model and grants no PR,
merge, or release authority. Do not interpret a cohort or reservation as a running canary or bypass
intake, task policy, broker preflight, repository governance, or human merge controls.

Config `agentlab.local-factory-canary-admission.v2` adds a separate owner-only `schedulePolicyPath`.
Under the reviewed worker UID, its bounded consumer may reserve a page of scheduled preparations
inside that same already-issued cohort:

```text
agentlab factory canary-admission-tick --config /absolute/private/release/canary-admission-v2.json --cohort sha256:... --candidate sha256:... --schedule-policy sha256:... --role-policy sha256:... --policy sha256:...
```

The scheduler switch must already be enabled. The command cannot issue or widen cohort authority; it
uses the schedule candidate/task ceilings and routes every task through the same signature, lineage,
freshness, risk, task-count, and aggregate-budget checks as manual reservation. Cohort capacity or
per-task denial is reported as a skipped candidate. No model, broker, merge, or release capability
is reachable.

`scheduler-tick` skips scheduled candidates without an exact current reservation. A claim and its
finish event carry the reservation digest; SQLite checks task, request, preparation authority,
schedule/factory/role policies, executable stage, full budget, and enough remaining lifetime before
the claim commits. On every process retry, the worker reloads that digest and repeats the same
task/configuration and time-window checks before each resumable phase. A legacy unbound active claim
stays blocked for operator recovery. Manual `worker-run` cannot consume a canary reservation.

For `brokered-draft-pr`, the separate broker config v3 loads the same schedule and role policies.
`broker-open-canary-draft` requires their exact digests plus the reservation and factory-policy
digests. It independently resolves the completed v2 scheduler handoff, rejects manual/scheduled
authority substitution, rechecks expiry before every resumable broker phase, records a v2 dispatch,
and binds the reservation digest into authenticated PR evidence. The reservation replaces only the
per-task draft confirmation; broker enablement, cost policy, repository governance, human merge, and
the structural `autoMerge:false` and `release:false` limits still apply.

`broker-canary-tick` can derive and reconcile a bounded page of these exact completed handoffs. It
uses the existing durable dispatch journal for recovery, prioritizes incomplete dispatches within
the current-authority class, and does not create another mutable queue. Exact policy pins, broker
preflight, expiry, and all inner draft checks remain authoritative.

`broker-pr-maintenance-tick` derives a bounded page of the resulting exact open canary PR heads. For
one resolved daily slot it publishes authenticated CI/review evidence and may create the existing
deterministic repair authorization. The reservation and all three policy digests are checked before
the remote read and again before admission. Its observation evidence is the crash checkpoint, so an
exact retry does not reread the same head. It cannot execute repair, update the PR, merge, or
release.

`worker-pr-repair-tick` consumes only the resulting exact authorization in the credentialless worker
plane. Recoverable journals sort ahead of fresh work and remain cleanable under normal-work
blockers. Fresh execution requires ready worker preflight, the scheduler switch, current reservation
authority, all three policy pins, and both task and aggregate tick budgets. The existing isolated
repair, strict gates, independent review, and cumulative accounting produce only a local
`pr-proposed` checkpoint.

`broker-pr-update-tick` consumes only completed proposals from that scheduled repair lane. Its
projection recovers an existing update journal before selecting a fresh exact maintenance,
authorization, repair-run, reservation, scheduler-handoff, current-head, broker, and policy chain.
Fresh work requires ready repository governance and enabled broker authority; the existing durable
non-force update service remains the sole remote-write path. Success returns the task to `pr-open`
so a later maintenance slot can observe the new head. The command has no model, merge, release, or
authority-mutation capability.

## Failure, recovery, and incident handling

Production records a start event before each harness launch. If the process dies, retry only the
same job and digest. An exact active or uncertain systemd scope blocks without changing evidence;
confirmed inactive scope without terminal evidence records `interrupted-execution` and is never
rerun. Do not delete its workspace, edit the journal, reuse its job ID, or splice samples from a new
job. A normal restart may reuse only already finished canonical subject evidence. Deadline, budget,
executable drift, malformed or incomplete usage, artifact substitution, unsafe output metadata, and
unconfirmed cleanup all fail closed. Unconfirmed cleanup deliberately leaves the active checkpoint
and workspace intact until exact scope state can be established. Launched failures retain bounded
stdout/stderr and either complete reported usage or the full reserved invocation ceiling; unknown
consumption is never treated as zero.

Run/assessment and approval/cohort pairs commit atomically; an attestation is one immutable append.
On failure, preserve the database and source evidence and retry only exact input. SQLite rejects
updates and deletes. Stop if key ID, signature, payload, statement, run/assessment linkage, sample
order, fixture/seed integrity, policy recomputation, freshness, expiry, stage, repository, risk,
human sample, task count, or budget differs. A critical safety violation is unconditional denial.

For suspected key, harness, grader, sandbox-host, or artifact compromise:

1. Disable scheduler and broker switches; stop evaluation, signing, and canary commands.
2. Preserve database/WAL, jobs, runs, subject/grader artifacts, scope state, executable digests, key
   IDs, and relevant logs read-only.
3. Quarantine affected candidates and all work derived from them; determine the first bad run.
4. Rotate the signing key and any independently exposed credentials. Never rewrite old records.
5. Repair the harness, rerun representative matched trials, sign with the new key, independently
   review, and require a fresh explicit authority decision.

The current slice does not automate revocation, rollback, notification, or incident paging.

## Activation gaps

Before production activation, AgentLab still needs reviewed case banks and installed offline
harnesses, or a secretless broker for hosted-provider evals; a brokered multi-account storage
boundary for the shared ledger; stronger runner identity or hardware-backed key custody where
required; owner-installed timers; telemetry/control comparison; revocation enforcement; alerting;
rollback drills; and incident automation. The producer and its content-addressed subject/grader
evidence exist but no account, config, fixture, executable, candidate, or job is provisioned. Manual
PR creation remains separately human-confirmed; evaluated canary PR creation, slot-bound
maintenance, credentialless repair consumption, and brokered repair publication are
reservation-bound but unprovisioned and blocked by repository governance and live policy/config/key
prerequisites in [ADR 0006](decisions/0006-local-software-factory-control-plane.md).
