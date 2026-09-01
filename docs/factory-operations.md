# Local factory scheduler operations

This runbook covers the dormant one-shot discovery, scheduler, and canary-broker boundaries.
AgentLab does not install a timer, provision live policy, enable either authority switch, merge, or
release. It can discover bounded maintenance and derive pending broker work during explicit one-shot
commands. Use a dedicated non-shared worker OS account and retain the SQLite ledger; file ownership
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

## Autonomous maintenance intake

`agentlab.maintenance-discovery-policy.v1` pins exactly one `maintenance-scout` skill and profile.
The skill must be scheduled, R0, single-worker, read-only/offline/secretless, and have zero change
and repair budget. The policy also fixes R1-only change classes, confidence, scope, protected paths,
and finding/admission ceilings no greater than the schedule candidate/task ceilings. Keep the
policy, skill package, existing preparation grant/packages, and discovery config owner-only and
outside the repository. The discovery config is strict:

```json
{
  "schemaVersion": "agentlab.local-factory-maintenance-discovery.v1",
  "workerConfigPath": "/absolute/worker-v3.json",
  "repositoryRoot": "/absolute/source/agentlab",
  "repositoryId": "owner/agentlab",
  "conversationId": "00000000-0000-4000-8000-000000000000",
  "discoveryPolicyPath": "/absolute/maintenance-discovery-policy.json",
  "discoverySkillPackagePath": "/absolute/maintenance-discovery-skill.json",
  "preparationGrantPath": "/absolute/preparation-grant.json",
  "preparationSkillPackagePaths": [
    "/absolute/qualify.json",
    "/absolute/specify.json",
    "/absolute/plan.json",
    "/absolute/implement.json"
  ],
  "authorityLifetimeSeconds": 3600
}
```

The exact preparation package list must contain the complete reviewed grant DAG; the four paths are
only abbreviated examples. Verify the boundary without a model, then run one exact daily slot:

```text
agentlab factory maintenance-discovery-preflight --config /absolute/maintenance-discovery.json
agentlab factory maintenance-discovery-tick --config /absolute/maintenance-discovery.json --discovery-policy sha256:... --schedule-policy sha256:... --policy sha256:... --preparation-grant sha256:... --role-policy sha256:...
```

SQLite schema 18 records the immutable slot and append-only run/finding dispositions. The model
cannot create identity, authority, ledger evidence, or permission. Deterministic admission verifies
every evidence path against the exact Git base and rejects scope, protected-path, class, confidence,
or count violations before registering existing scheduled intake. Exact completed retries are
no-ops.

Automatic reservation requires `agentlab.local-factory-canary-admission.v2`, which adds a separate
owner-only `schedulePolicyPath` to the v1 trust pins. It consumes—never issues—the already human-
approved attested cohort:

```text
agentlab factory canary-admission-tick --config /absolute/canary-admission-v2.json --cohort sha256:... --candidate sha256:... --schedule-policy sha256:... --role-policy sha256:... --policy sha256:...
```

It operates only while scheduler authority is enabled, examines at most the candidate ceiling,
reserves at most the task ceiling, and retains the cohort's aggregate task/budget enforcement and
literal `autoMerge:false`/`release:false` limits.

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
  "schemaVersion": "agentlab.daily-cycle-manifest.v2",
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
  "maintenanceDiscoveryConfigPath": "/etc/agentlab/maintenance-discovery.json",
  "canaryAdmissionConfigPath": "/etc/agentlab/canary-admission.json",
  "expectedMaintenanceDiscoveryPolicyDigest": "sha256:...",
  "expectedPreparationGrantDigest": "sha256:...",
  "expectedCanaryCohortDigest": "sha256:...",
  "expectedCanaryCandidateDigest": "sha256:...",
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

The v2 JSON bundle pins the manifest, discovery/grant/cohort/candidate and existing policies, the
AgentLab executable, every unit, and the bundle itself. Its UTC `Persistent=false` timer runs
discovery → canary admission → scheduler → draft → bounded observe/repair/update rounds. Separate
numeric-UID services, fixed argv, bounded timeouts, `OnSuccess=` stop-on-failure links, a final
exact-head observation, and an incident target preserve separation. V1 remains supported and starts
at the scheduler. Every service verifies `executableVerification.checksumContent` with fixed
`/usr/bin/sha256sum` argv before AgentLab. Rendering never writes a unit/checksum, calls
`systemctl`, changes authority, or touches the ledger.

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

## External pull-request inventory

Use a separate GitHub App installation for read-only external pull-request discovery. Do not reuse
the draft/update broker App, its key, or its operating-system account. The installation token must
grant exactly `checks:read`, `contents:read`, and `pull_requests:read`. Keep the strict discovery
config, policy, schedule policy, and private key owner-only and pin both policy digests in the
config. A minimal policy has this shape:

```json
{
  "schemaVersion": "agentlab.external-pull-request-discovery-policy.v1",
  "policyId": "external-pr-inventory",
  "revision": 1,
  "maximumPullRequestsPerTick": 10,
  "maximumChangedFilesPerPullRequest": 50,
  "allowDrafts": false,
  "allowForks": false,
  "agentReviewLabels": ["agent-review"],
  "humanReviewLabels": ["security", "release"]
}
```

The owner-only config uses schema `agentlab.local-factory-external-pull-request-discovery.v1` and
supplies the database and artifact paths, exact repository owner/name/ID, observer ID, policy and
schedule paths with expected digests, and the reader App client ID, installation ID, and private-key
path. Preflight acquires a short-lived read-only installation token and verifies the remote
repository identity; it does not write a discovery run. Then run one resolved daily slot:

```text
agentlab factory external-pr-discovery-preflight --config /absolute/external-pr-discovery.json
agentlab factory external-pr-discovery-tick --config /absolute/external-pr-discovery.json --discovery-policy sha256:... --schedule-policy sha256:...
```

Exit zero means the immutable snapshot was completed or replayed exactly. A nonzero exit records a
redacted failed run when persistence is available. An `agent-review-candidate` result is only a
queue classification: this lane does not review, check out, repair, comment, approve, merge,
release, issue authority, or install a timer.

## External pull-request review evidence

Run external review under the reviewed non-root worker UID, never the read-only GitHub App or
write-broker UID. Before a tick, an administrator-controlled local repository must already contain
the exact base and head commit objects recorded by discovery. This process never fetches and no
remote credential belongs in its environment. Keep its database, artifact root, worktree root, and
source repository pairwise disjoint.

The owner-only config schema is `agentlab.local-factory-external-pull-request-review.v1`. It pins
`repositoryId` and local `repositoryRoot`; database/artifact/workspace roots; review, cost, and
role-identity policy paths and expected canonical digests; exact reviewed skill-package paths;
Git/flock/systemd executables; and provider executable hashes, versions, and IDs. The review policy
schema is `agentlab.external-pull-request-review-policy.v1`; it pins the ADR-0023 discovery-policy
digest, ordered reviewer profiles and skill digests, quorum, candidate/patch/prompt ceilings,
individual and aggregate token/tool/time/process/output/cost/change budgets, cgroup
memory/CPU/process limits, and recovery attempts. Every profile must grant exactly read-only
filesystem/Git with no remote repository, network, secrets, command allowlist, or workspace write.

```text
agentlab factory external-pr-review-preflight --config /absolute/external-pr-review.json
agentlab factory external-pr-review-tick --config /absolute/external-pr-review.json --review-policy sha256:... --discovery-policy sha256:... --cost-policy sha256:...
```

Preflight resolves and publishes the exact skill inventory, verifies pinned provider binaries and
exact-model cost rules, and checks capability availability without running a model or recording a
review. A tick first recovers active journal-owned scopes/worktrees, then admits a bounded candidate
page. Missing local objects, changed-path disagreement, incomplete usage, invalid strict JSON,
provider-session reuse, budget exhaustion, or uncertain cleanup fails closed. Workspace mutation is
quarantined. Only unanimous verdicts aggregate to `approved` or `changes-requested`; disagreement
becomes `human-review-required`. Treat all three as local evidence only. Do not translate them into
a GitHub review, comment, branch write, merge, deployment, or release without a separately designed
and approved authority boundary.

On interruption, preserve SQLite schema v21, the artifact root, and worktree root. The next tick
proves exact recorded systemd scopes inactive and removes only the journal-owned worktree before a
bounded retry. If it cannot prove inactivity or cleanup, stop the lane and investigate; never delete
the journal or reuse an execution/session identity. No live config, timer, skill inventory, rate
card, provider account, or object-mirroring service is installed by this repository.

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

No OS accounts, installed timer, live rate card/config/cohort, reviewed case bank or installed eval
harness, repository/day or organization/day quota ledger, cross-repository coordinator, scheduler
dashboard/alerts, secretless hosted-provider eval gateway, owner-provisioned activation, merge,
telemetry-driven canary, rollback controller, or incident automation is shipped. A separate offline
sandboxed eval producer with content-addressed evidence now exists. Durable read-only maintenance
discovery, bounded consumption of a human non-release cohort, reservation-bound scheduled
execution/draft dispatch, slot-bound PR observation/repair, brokered repaired-branch publication,
bounded read-only external pull-request inventory, credentialless isolated external review evidence,
and a content-addressed separated-service renderer exist but are not provisioned or activated.
External review feedback publication and repair admission are not yet implemented. See
[Local factory evaluation operations](factory-evaluation-operations.md). Those remaining controls
are required before calling the factory self-maintaining.
