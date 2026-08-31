# Local factory scheduler operations

This runbook covers the dormant one-shot scheduler boundary. AgentLab does not install a timer,
provision live policy, enable either authority switch, open a PR automatically, merge, or release.
Use a dedicated non-shared OS account and retain the SQLite ledger; file ownership is the local
authorization boundary.

## Reviewed inputs

The worker must use `agentlab.local-factory-worker.v2`. It has the v1 database, artifact/worktree,
Git/flock, systemd, Bubblewrap, provider, gate, and cost-policy pins plus one normalized absolute
`schedulePolicyPath`. Config, cost policy, and schedule policy must be canonical owner-only regular
files. A v1 config cannot attach a schedule policy.

The schedule file is strict and command-free:

```json
{
  "schemaVersion": "agentlab.schedule-policy.v1",
  "id": "agentlab/daily-maintenance",
  "version": "1.0.0",
  "cadence": {
    "kind": "daily",
    "timeZone": "UTC",
    "at": "12:00",
    "startDeadlineSeconds": 1800
  },
  "maximumTasksPerTick": 2,
  "maximumCandidatesPerTick": 8,
  "tickBudget": {
    "wallClockSeconds": 7200,
    "maxAgentTurns": 200,
    "maxToolCalls": 1000,
    "maxInputTokens": 2000000,
    "maxOutputTokens": 200000,
    "maxCostMicrousd": 20000000,
    "maxProcesses": 64,
    "maxOutputBytes": 20000000,
    "maxWorkers": 4,
    "maxRepairAttempts": 4,
    "maxChangedFiles": 40,
    "maxChangedLines": 1000
  }
}
```

These values are examples, not production approval. The complete authority ceiling of each selected
task is reserved against every tick dimension. There is no optimistic cost estimate and no wildcard
provider rate.

## Admission ceremony

1. Run worker preflight and record its exact `schedulePolicyDigest` and `policyBundleDigest`:

   ```text
   agentlab factory worker-preflight --config /absolute/worker.json
   ```

2. Register only reviewed feature or bug reports for scheduled eligibility. The distinct
   confirmation becomes immutable request identity:

   ```text
   agentlab factory intake-register --config /absolute/intake.json --request /absolute/request.json --policy sha256:... --confirm-register-scheduled
   ```

3. Inspect both switches and their append-only histories, then enable only scheduler authority with
   compare-and-set:

   ```text
   agentlab factory authority-status --config /absolute/authority.json
   agentlab factory scheduler-authority --config /absolute/authority.json --expected disabled --to enabled --reason "Approved bounded daily maintenance." --confirm-enable-scheduler
   ```

4. Invoke one slot with both reviewed digests:

   ```text
   agentlab factory scheduler-tick --config /absolute/worker.json --schedule-policy sha256:... --policy sha256:...
   ```

Exit 0 means completed or already completed. Exit 2 means policy-blocked or the start deadline was
missed; alert on it rather than retrying with changed pins. Operational failure exits 1. Output is
written only after worker cleanup.

An owner-managed timer may invoke exactly that fixed-argument command at the policy's UTC time.
Duplicate invocation is safe: the SQLite key is `(schedulePolicyId, scheduledFor)`, while the run
also pins the exact policy digest. One writer lease prevents overlap, and a completed slot cannot
select work again. Changing a policy version cannot manufacture a second tick for the same schedule
ID and day; drift blocks for review. A late persistent timer may invoke the command, but a new stale
slot is refused after `startDeadlineSeconds`. An existing active slot can resume using its durable
task correlation, including after a UTC day boundary. The oldest open run always reconciles before a
new slot. Multiple open runs are treated as ledger corruption; schedule or factory policy drift on
an open run blocks new work until an operator investigates. A clock earlier than the open slot or
its latest journal event also blocks; correct the host clock without editing the ledger.

## Authority and incident stop

The scheduler ends at local `pr-proposed`; it has no GitHub credential. Draft creation remains a
separate broker preflight, switch, and literal-confirmation ceremony. Do not put broker enablement,
merge, release, or deployment into the scheduler timer.

To stop new or resumed scheduled work:

```text
agentlab factory scheduler-authority --config /absolute/authority.json --expected enabled --to disabled --reason "Incident stop." --confirm-disable-scheduler
```

Disabling does not erase evidence or fabricate completion. Preserve the database, artifact root,
worktrees, schedule output, and authority history. Investigate any `task-active` run through the
existing recovery path; re-enable only after the policy/config digest and host state are reviewed.

## Known operational gaps

No timer unit, live rate card, live worker/authority configuration, repository/day or
organization/day quota ledger, cross-repository coordinator, scheduler dashboard/alerts, autonomous
maintenance discovery, attested eval-harness producer, cohort consumer, auto-broker, merge,
telemetry-driven canary, rollback controller, or incident automation is shipped. A separate dormant
deterministic assessment and human non-release cohort ledger now exists, but it cannot schedule or
authorize work by itself. See
[Local factory evaluation operations](factory-evaluation-operations.md). Those remaining controls
are required before calling the factory self-maintaining.
