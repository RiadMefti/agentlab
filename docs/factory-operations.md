# Local factory scheduler operations

This runbook covers the dormant one-shot scheduler and canary-broker boundaries. AgentLab does not
install a scheduler or broker timer, provision live policy, enable either authority switch, discover
maintenance work, merge, or release. It can derive pending broker work during an explicit one-shot
command. Use a dedicated non-shared worker OS account and retain the SQLite ledger; file ownership
plus the reviewed role-identity policy is the local authorization boundary.

## Reviewed inputs

The worker must use `agentlab.local-factory-worker.v3`. It has the v1 database, artifact/worktree,
Git/flock, systemd, Bubblewrap, provider, gate, and cost-policy pins plus normalized absolute
`roleIdentityPolicyPath`, an `expectedRoleIdentityPolicyDigest`, and—when scheduling—one
`schedulePolicyPath`. Config and policy files must be owner-only regular files. V3 may omit the
schedule path for manual work, but a scheduler tick requires it. V1 and legacy v2 remain
diagnostic/recovery inputs and cannot invoke new model work without the identity policy.

The exact policy content must match the independent attestor and evaluator copies. Replace example
UIDs and key ID through reviewed provisioning; root and a shared worker/attestor UID are invalid:

```json
{
  "schemaVersion": "agentlab.role-identity-policy.v1",
  "id": "agentlab/production-role-identities",
  "version": "1.0.0",
  "worker": { "kind": "posix-uid", "userId": 1001 },
  "evalAttestor": {
    "kind": "posix-uid",
    "userId": 1002,
    "runnerId": "trusted-eval-runner",
    "keyId": "sha256:..."
  }
}
```

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

1. Run worker preflight under the configured worker UID and record its exact
   `roleIdentityPolicyDigest`, `schedulePolicyDigest`, and `policyBundleDigest`:

   ```text
   agentlab factory worker-preflight --config /absolute/worker.json
   ```

2. Register only reviewed feature or bug reports for scheduled eligibility. The distinct
   confirmation becomes immutable request identity:

   ```text
   agentlab factory intake-register --config /absolute/intake.json --request /absolute/request.json --policy sha256:... --confirm-register-scheduled
   ```

3. Complete the evaluated-candidate, signed-attestation, and human cohort ceremony in
   [Local factory evaluation operations](factory-evaluation-operations.md), then reserve the exact
   scheduled task before its authority window can no longer fit the full wall-clock ceiling:

   ```text
   agentlab factory canary-reserve --config /absolute/canary-admission.json --task 00000000-0000-4000-8000-000000000000
   ```

4. Inspect both switches and their append-only histories, then enable only scheduler authority with
   compare-and-set:

   ```text
   agentlab factory authority-status --config /absolute/authority.json
   agentlab factory scheduler-authority --config /absolute/authority.json --expected disabled --to enabled --reason "Approved bounded daily maintenance." --confirm-enable-scheduler
   ```

5. Invoke one slot with both reviewed digests:

   ```text
   agentlab factory scheduler-tick --config /absolute/worker.json --schedule-policy sha256:... --policy sha256:...
   ```

Exit 0 means completed or already completed. Exit 2 means policy-blocked or the start deadline was
missed; alert on it rather than retrying with changed pins. Operational failure exits 1. Output is
written only after worker cleanup.

An owner-managed timer may invoke exactly that fixed-argument command at the policy's UTC time.
Duplicate invocation is safe: the SQLite key is `(schedulePolicyId, scheduledFor)`, while the run
also pins the exact role-identity, schedule, and factory-policy digests. One writer lease prevents
overlap, and a completed slot cannot select work again. Changing a policy version cannot manufacture
a second tick for the same schedule ID and day; drift blocks for review. A late persistent timer may
invoke the command, but a new stale slot is refused after `startDeadlineSeconds`. An existing active
slot can resume using its durable task correlation, including after a UTC day boundary. The oldest
open run always reconciles before a new slot. Multiple open runs are treated as ledger corruption;
role, schedule, or factory policy drift on an open run blocks new work until an operator
investigates. A clock earlier than the open slot or its latest journal event also blocks; correct
the host clock without editing the ledger.

The scheduler skips a candidate with no current executable reservation. Each durable v2 claim and
finish names the reservation digest, and the worker independently reloads it before every resumable
phase. A crash therefore retries the same claim and authority; an expired or legacy unbound claim
stays blocked rather than running model work.

6. For a cohort authorized specifically for `brokered-draft-pr`, a separate broker consumer may
   submit the exact completed task. Broker config v3 must load the same cost, schedule, and
   role-identity policies and pin the expected role-policy digest:

   ```text
   agentlab factory broker-open-canary-draft --config /absolute/broker.json --task 00000000-0000-4000-8000-000000000000 --reservation sha256:... --schedule-policy sha256:... --role-policy sha256:... --policy sha256:...
   ```

   This command has no per-task confirmation because the exact evaluated reservation is its
   authority. It still requires clean broker preflight, an enabled broker switch, current authority,
   complete usage, and repository governance. It independently proves the completed v2 scheduler
   handoff before every durable dispatch phase. Exact retries are idempotent; changed coordinates
   fail closed.

   For normal bounded consumption, invoke the one-shot reconciler with the reviewed policy pins:

   ```text
   agentlab factory broker-canary-tick --config /absolute/broker.json --schedule-policy sha256:... --role-policy sha256:... --policy sha256:...
   ```

   It derives work from completed immutable scheduler handoffs and incomplete dispatch journals;
   there is no second queue to repair. It handles current authority before expired work and recovers
   existing dispatches before starting new ones within either class. It obeys
   `maximumCandidatesPerTick` and `maximumTasksPerTick`, and exits 2 on blocked or
   attention-required results. Alert on expiry or denial. An owner-managed broker timer may invoke
   only this fixed-argument command, and only while the separately controlled broker switch is
   intentionally enabled.

7. To reconcile CI/review state for the resulting scheduled canary PRs, invoke the separate one-shot
   maintenance consumer with the same reviewed policy pins:

   ```text
   agentlab factory broker-pr-maintenance-tick --config /absolute/broker.json --schedule-policy sha256:... --role-policy sha256:... --policy sha256:...
   ```

   It observes each exact current PR head at most once for the resolved daily slot and creates a
   repair authorization only from deterministic actionable facts. If interrupted after observation,
   the next exact tick resumes admission from durable evidence without rereading GitHub. It obeys
   the schedule policy's candidate and attempt ceilings and exits 2 for blocked or
   attention-required results. It does not execute the authorized repair or update the remote
   branch.

8. Run the credentialless worker consumer with the same reviewed policy pins:

   ```text
   agentlab factory worker-pr-repair-tick --config /absolute/worker.json --schedule-policy sha256:... --role-policy sha256:... --policy sha256:...
   ```

   It reconciles interrupted repair journals before considering fresh work, including when normal
   work is blocked. Fresh execution requires the scheduler switch, ready host and cost policy,
   current canary reservation, and the exact maintenance-issued authorization. Candidate, action,
   and aggregate tick ceilings remain authoritative. It runs no GitHub adapter and stops at a local
   `pr-proposed` checkpoint. Exit 2 requires operator attention; do not publish the repair manually
   unless its exact evidence and broker ceremony are reviewed.

9. Publish completed repairs through the separate credential-bearing broker consumer:

   ```text
   agentlab factory broker-pr-update-tick --config /absolute/broker.json --schedule-policy sha256:... --role-policy sha256:... --policy sha256:...
   ```

   It reconciles nonterminal update journals before considering fresh work. Fresh publication
   requires the exact completed repair, actionable maintenance lineage, current reservation and PR
   head, all policy pins, ready repository governance, and enabled broker authority. It routes every
   candidate through the existing crash-durable non-force update service and returns successful work
   to `pr-open`; the next maintenance tick observes the new exact head. Candidate and action
   ceilings remain authoritative. Exit 2 requires operator attention. It cannot run a model, merge,
   release, deploy, install a timer, or change authority.

## Render the dormant daily cycle

After all identities, configs, policies, costs, governance, and preflights are ready, a provisioning
operator may render—not install—the separated systemd chain. The owner-only manifest is strict and
contains no command or credential:

```json
{
  "schemaVersion": "agentlab.daily-cycle-manifest.v1",
  "id": "agentlab/daily-software-factory",
  "version": "1.0.0",
  "agentlabExecutable": {
    "path": "/opt/agentlab/bin/agentlab",
    "digest": "sha256:..."
  },
  "executableChecksumPath": "/etc/agentlab/factory-executable.sha256",
  "worker": { "userId": 1001, "configPath": "/etc/agentlab/worker.json" },
  "broker": { "userId": 1003, "configPath": "/etc/agentlab/broker.json" },
  "schedulePolicyPath": "/etc/agentlab/schedule.json",
  "roleIdentityPolicyPath": "/etc/agentlab/role-identities.json",
  "expectedSchedulePolicyDigest": "sha256:...",
  "expectedRoleIdentityPolicyDigest": "sha256:...",
  "expectedFactoryPolicyBundleDigest": "sha256:...",
  "maximumRepairRounds": 2,
  "workerCommandTimeoutSeconds": 7500,
  "brokerCommandTimeoutSeconds": 900
}
```

`maximumRepairRounds` cannot exceed the schedule tick's repair-attempt ceiling. The worker timeout
must exceed its complete aggregate wall-clock ceiling by at least 30 seconds. Render to stdout:

```text
agentlab factory orchestration-render --config /absolute/orchestration.json
```

The JSON bundle pins the manifest, policies, AgentLab executable, every unit, and the bundle itself.
It contains one UTC `Persistent=false` timer, separate numeric-UID services, fixed argv, bounded
timeouts, an `OnSuccess=` chain, a final exact-head observation, and an incident target activated by
any failed step. It also emits `executableVerification.checksumContent`; every service verifies the
installed executable against that exact record with fixed `/usr/bin/sha256sum` argv before starting
AgentLab. It never writes a unit or checksum file, calls `systemctl`, changes an authority switch,
or touches the ledger.

Owner provisioning is deliberately outside AgentLab. Materialize the exact checksum content at
`executableVerification.checksumFilePath` and the exact unit contents under `/etc/systemd/system`.
Before activation, independently re-hash the executable and every artifact, ensure the worker and
broker accounts own only their respective private configs/credentials, and ensure neither runtime
UID owns the AgentLab executable or can write it through group/other permissions. Keep the fixed
checksum root-owned and non-writable under `/etc/agentlab`. Arrange least-privilege shared
ledger/artifact access, and enable the worker's user manager/linger required by its transient
scopes. Runtime configs for distinct UIDs require role-owned copies of the schedule and identity
policies with identical reviewed digests; they cannot share one owner-only file. Run
`/usr/bin/sha256sum --status --check` on the materialized checksum and `systemd-analyze verify` over
the complete unit bundle. Only after both role preflights, governance, monitored incident response,
and the two human-controlled authority switches are ready should an operator enable
`agentlab-factory-daily.timer`.

Monitor failed stage units and `agentlab-factory-incident.target`. The target is a durable systemd
signal, not an automatic authority mutation and not a retry latch. On any signal, disable both
switches with the commands below, preserve evidence, investigate, then stop the target and reset
failed units only after review. Upstream semantics are documented for
[`OnSuccess=`/`OnFailure=`](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#OnSuccess=),
[`OnCalendar=`/`Persistent=`](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html#OnCalendar=),
and
[`systemd-analyze verify`](https://www.freedesktop.org/software/systemd/man/latest/systemd-analyze.html#systemd-analyze%20verify%20FILE%E2%80%A6).

## Authority and incident stop

The scheduler ends at local `pr-proposed`; it has no GitHub credential. Draft creation remains a
separate broker preflight and switch. Manual draft creation still requires literal confirmation;
scheduled canary draft creation and repaired-branch publication require the exact reservation and
scheduler handoff instead. Do not put broker enablement, merge, release, or deployment into a worker
or broker timer. Keep the credentialless repair consumer and credential-bearing broker in separate
processes and accounts.

To stop new or resumed scheduled and broker work:

```text
agentlab factory scheduler-authority --config /absolute/authority.json --expected enabled --to disabled --reason "Incident stop." --confirm-disable-scheduler
agentlab factory broker-authority --config /absolute/authority.json --expected enabled --to disabled --reason "Incident stop." --confirm-disable-draft-broker
```

Disabling does not erase evidence or fabricate completion. Preserve the database, artifact root,
worktrees, schedule output, and authority history. Investigate any `task-active` run through the
existing recovery path; re-enable only after the policy/config digest and host state are reviewed.

## Known operational gaps

No OS accounts, installed timer, live rate card, live worker/authority configuration, repository/day
or organization/day quota ledger, cross-repository coordinator, scheduler dashboard/alerts,
autonomous maintenance discovery, attested eval-harness producer, owner-provisioned activation,
merge, telemetry-driven canary, rollback controller, or incident automation is shipped.
Deterministic assessment, human non-release cohorts, task reservation, reservation-bound scheduled
execution and draft dispatch, slot-bound PR observation/repair admission, credentialless repair
consumption, and brokered repaired-branch publication plus a content-addressed separated-service
renderer exist but are not provisioned or activated. See
[Local factory evaluation operations](factory-evaluation-operations.md). Those remaining controls
are required before calling the factory self-maintaining.
