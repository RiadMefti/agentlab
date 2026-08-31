# Local factory evaluation and canary-authority operations

This runbook covers the dormant offline promotion ledger accepted by
[ADR 0007](decisions/0007-deterministic-evaluation-and-canary-authority.md). It does not run an eval
harness, consume a cohort, contact GitHub, merge, release, deploy, or roll back production.

## Trust boundary

Use a dedicated non-shared local operating-system account. Keep the SQLite database outside the
source repository. Config, eval-run, and canary-request files must be canonical owner-only regular
files with one link; symlinks, hard links, group/world permissions, unstable reads, unknown fields,
and oversized input are rejected.

```text
install -d -m 700 /absolute/private/agentlab
chmod 600 /absolute/private/agentlab/*.json
```

The runner and operator IDs are audit identities, not authentication credentials. File ownership and
the exclusive local writer lease are the current authorization boundary. Preserve the input
documents and their upstream grader artifacts under the organization's retention policy.

## Evaluator configuration

`evaluator.json` is strict `agentlab.local-factory-evaluator.v1`:

```json
{
  "schemaVersion": "agentlab.local-factory-evaluator.v1",
  "databasePath": "/absolute/private/agentlab/agentlab.sqlite",
  "runnerId": "trusted-eval-runner"
}
```

The eval harness must emit a complete `agentlab.eval-run.v1`. Its top-level fields are:

```text
schemaVersion, runId, suiteDigest, suite,
baselineCandidateDigest, baselineCandidate,
challengerCandidateDigest, challengerCandidate,
samples, actor, startedAt, completedAt, correlationId
```

The actor must be a `gate-runner` of kind `ci` or `control-plane`, and its ID must equal the
config's `runnerId`. Candidate and suite digests are SHA-256 hashes of AgentLab canonical JSON, not
hashes of arbitrary serialization. Samples must be ordered exactly by suite case ID and then trial
1..N. Each coordinate includes one matched baseline/challenger result, unique seed digest, stable
per-case fixture digest, grader-evidence digest, output/trace digests, task and safety outcomes,
micro-USD, and latency. Do not submit summaries in place of raw samples.

The current repository does not produce this document. Treat any external harness as a separately
reviewed trusted producer; owner-only input protects local admission but is not supply-chain
attestation.

## Assess and inspect

Assess once, then retain the emitted assessment digest:

```text
agentlab factory eval-assess \
  --config /absolute/private/agentlab/evaluator.json \
  --run /absolute/private/agentlab/eval-run.json \
  --confirm-assess
```

The command prints one compact JSON record only after the runtime closes. It contains candidate and
run coordinates, sample count, deterministic metrics, decision, maximum eligible stage, reason
codes, and assessment digest. It deliberately omits samples and traces. Exact retries return the
existing assessment; the same run ID with different content is a conflict.

Inspect an immutable result without resubmitting samples:

```text
agentlab factory eval-inspect \
  --config /absolute/private/agentlab/evaluator.json \
  --assessment sha256:...
```

A pass grants no task, scheduler, broker, merge, or release authority. Before any human approval,
review the full matched sample set and the artifacts named by `humanSampleReviewDigest`; confirm the
case bank is representative and that grader calibration is current.

## Human canary authority

Use a separate `canary-authority.json` and, operationally, a distinct release-controller account:

```json
{
  "schemaVersion": "agentlab.local-factory-canary-authority.v1",
  "databasePath": "/absolute/private/agentlab/agentlab.sqlite",
  "operatorId": "release-controller"
}
```

Create one strict owner-only `canary-request.json`. Every budget field is an aggregate cohort
ceiling and must fit inside the evaluated suite's canary limits:

```json
{
  "schemaVersion": "agentlab.canary-request.v1",
  "stage": "brokered-draft-pr",
  "repositoryIds": ["agentlab"],
  "maximumRiskTier": "R1",
  "maximumTasks": 2,
  "budget": {
    "wallClockSeconds": 1800,
    "maxAgentTurns": 20,
    "maxToolCalls": 100,
    "maxInputTokens": 200000,
    "maxOutputTokens": 20000,
    "maxCostMicrousd": 2000000,
    "maxProcesses": 8,
    "maxOutputBytes": 2000000,
    "maxWorkers": 1,
    "maxRepairAttempts": 1,
    "maxChangedFiles": 10,
    "maxChangedLines": 200
  },
  "humanSampleReviewDigest": "sha256:...",
  "humanSampleSize": 4,
  "expiresAt": "2026-09-01T12:00:00.000Z",
  "reason": "Reviewed bounded promotion."
}
```

Issue the cohort with the exact passing assessment pin:

```text
agentlab factory canary-authorize \
  --config /absolute/private/agentlab/canary-authority.json \
  --assessment sha256:... \
  --request /absolute/private/agentlab/canary-request.json \
  --confirm-authorize-canary
```

The result must report the requested stage, one repository, R0/R1 limit, task and budget ceilings,
expiry, human review digest/size, and `autoMerge:false`, `release:false`. An exact retry reports
`existing`; any changed request for the same assessment conflicts. `read-only-shadow` requires R0;
`local-proposal` and `brokered-draft-pr` require R1.

No shipped component reads this cohort to execute work. Do not interpret issuance as a running
canary or manually bypass the existing intake, task policy, broker preflight, repository rules, or
human merge controls.

## Failure, recovery, and incident handling

Each run/assessment and approval/cohort pair commits atomically. On command failure, preserve the
database and all source evidence, inspect by the emitted or known digest, and retry only the exact
same input. Never update or delete factory eval/canary rows; SQLite triggers reject both.

If runner identity, sample order, fixture/seed integrity, policy recomputation, predecessor links,
expiry, stage, repository, risk, task count, human sample, lifetime, or any budget differs, stop and
investigate the producer or request. A critical safety violation is an unconditional denial.

During an incident, disable the existing scheduler and broker switches, preserve ledger/input
hashes, quarantine affected candidates and derived work, rotate any unrelated credentials that may
have been exposed, and revert the configured factory components to the last-known-good digests. The
current slice does not automate rollback or incident notification.

## Activation gaps

Before a cohort may drive even shadow execution, AgentLab still needs a sandboxed, attested harness
producer; content-addressed grader artifacts; a cohort consumer that reserves aggregate usage and
binds every task; telemetry and control/challenger comparison; expiry and revocation enforcement;
alerting; rollback drills; and incident automation. Brokered PR creation remains separately
human-confirmed and blocked by repository governance and live cost-policy prerequisites described in
[ADR 0006](decisions/0006-local-software-factory-control-plane.md).
