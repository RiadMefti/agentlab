# Local factory scheduler operations

This runbook covers the dormant one-shot discovery, scheduler, PR-broker, merge-admission, and
merge-queue boundaries. AgentLab does not install a timer, provision live policy or identities,
enable any authority switch, merge a real PR, release, or deploy. Use dedicated non-shared worker,
PR-broker, merger, incident-controller, and eval-attestor OS accounts and retain the SQLite ledger;
file ownership plus reviewed policy digests form the local authorization boundary.

## Activation blocker: storage handoff

Do not activate the separated-UID daily chain. A live test on 2026-09-07 confirmed that its current
shared storage cannot pass from one runtime UID to another. The SQLite database and writer lease
force `0600`; artifact roots/shards force `0700`. Another UID cannot open the database or lease and
cannot perform the artifact store's chmod. Relaxing the disposable database's mode also fails on the
mandatory chmod, so group/ACL provisioning alone cannot make this implementation work.

Run `npm run test:factory-role-isolation` on Linux with unprivileged user namespaces, `unshare`,
`newuidmap`/`newgidmap`, Python 3, and assigned subordinate UID/GID ranges. It executes the real
built adapters under distinct mapped UIDs, creates only disposable test storage, and verifies these
denials. A second positive test starts the actual ledger owner as UID 1 and authenticates clients as
UIDs 2 and 3; both read their assigned immutable task, while UID 4 and forged privileged operations
are rejected. Neither proof is a complete software-factory handoff. The explicit command and hosted
`factory-sandbox` job run both tests; missing prerequisites fail rather than report successful
proof.

The accepted correction is a single-owner local ledger service with authenticated, role-limited
commands and verified evidence handoffs. Only its scoped read boundary is implemented; mutations,
artifact transfer, role migration, crash recovery, and a real brokered-PR canary remain outstanding.
See [ADR 0034](decisions/0034-single-owner-factory-ledger-boundary.md). The provisioning
instructions below remain reference material, not an executable activation recipe. Do not weaken
private storage, share role credentials, or rotate storage ownership between stages as a workaround.

## Reviewed inputs

Explicit manual work may use `agentlab.local-factory-worker.v3`; autonomous scheduling requires v4,
and the queue-backed merge path requires matching worker and broker v5 configs. All retain the
database, artifact/worktree, Git/flock, systemd, Bubblewrap, provider, gate, cost, and normalized
role-policy pins. V4 adds schedule and daily-quota coordinates. V5 adds repository ID, merge-policy
path/digest, and the compiled factory-policy v3 digest. Config and policy files must be owner-only
regular files. V1 and legacy v2 remain diagnostic/recovery inputs and cannot invoke new model work
without the identity policy.

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

The separate daily quota policy is also strict and command-free. It fixes `timeZone` to `UTC`, names
one `organizationId`, and contains exact repository profiles plus an organization profile. Every
profile has `maximumTasksPerDay`, `maximumDraftPullRequestsPerDay`, and the same complete
twelve-field budget shape shown above. A zero draft ceiling disables scheduled PR creation for that
profile.

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

4. Inspect all three switches and their append-only histories, then enable only scheduler authority
   with compare-and-set:

   ```text
   agentlab factory authority-status --config /absolute/authority.json
   agentlab factory scheduler-authority --config /absolute/authority.json --expected disabled --to enabled --reason "Approved bounded daily maintenance." --confirm-enable-scheduler
   ```

5. Invoke one slot with all reviewed execution and quota digests:

   ```text
   agentlab factory scheduler-tick --config /absolute/worker.json --schedule-policy sha256:... --daily-quota sha256:... --policy sha256:...
   ```

Exit 0 means completed or already completed. Exit 2 means policy-blocked or the start deadline was
missed; alert on it rather than retrying with changed pins. Operational failure exits 1. Output is
written only after worker cleanup.

Worker and broker config v4 must point to owner-only copies of the same canonical
`agentlab.daily-quota-policy.v1` and pin its digest. The policy uses UTC and gives every authorized
repository plus the organization task-count, draft-count, and complete budget ceilings. Every
repository governed as one local organization must share the same durable AgentLab database and
writer-lease domain. Separate databases or hosts are separate quota domains and must not reuse the
organization claim as if capacity were globally coordinated.

An owner-managed timer may invoke exactly that fixed-argument command at the policy's UTC time.
Duplicate invocation is safe: the SQLite key is `(schedulePolicyId, scheduledFor)`, while the run
also pins the exact role-identity, schedule, daily-quota, and factory-policy digests. One writer
lease prevents overlap, and a completed slot cannot select work again. Changing a policy version
cannot manufacture a second tick for the same schedule ID and day; drift blocks for review. A late
persistent timer may invoke the command, but a new stale slot is refused after
`startDeadlineSeconds`. An existing active slot can resume using its durable task correlation,
including after a UTC day boundary. The oldest open run always reconciles before a new slot.
Multiple open runs are treated as ledger corruption; role, schedule, quota, or factory policy drift
on an open run blocks new work until an operator investigates. A clock earlier than the open slot or
its latest journal event also blocks; correct the host clock without editing the ledger.

The scheduler skips a candidate with no current executable canary reservation. Before a claim it
atomically appends a worst-case daily reservation for one task and one possible draft PR against the
repository and organization UTC-day ceilings. Each durable v3 claim and finish names both canary and
daily reservation digests, and the worker independently reloads them before every resumable phase. A
crash therefore retries the same claim, correlation, and authority. Daily reservations are never
released, so ambiguity consumes headroom rather than creating it; an expired or legacy unbound claim
stays blocked rather than running model work.

6. For a cohort authorized specifically for `brokered-draft-pr`, a separate broker consumer may
   submit the exact completed task. Broker config v4 must load the same cost, schedule, daily-quota,
   and role-identity policies and pin both expected policy digests:

   ```text
   agentlab factory broker-open-canary-draft --config /absolute/broker.json --task 00000000-0000-4000-8000-000000000000 --reservation sha256:... --schedule-policy sha256:... --role-policy sha256:... --policy sha256:...
   ```

   This command has no per-task confirmation because the exact evaluated reservation is its
   authority. It still requires clean broker preflight, an enabled broker switch, current authority,
   complete usage, and repository governance. It independently proves the completed v3 scheduler
   handoff and exact daily reservation before every durable dispatch phase. Exact retries are
   idempotent; changed coordinates fail closed.

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

## Autonomous R1 merge queue

This is the only automatic merge cohort: exact scheduled R1 canary work whose immutable task
contract was compiled with factory policy v3 and `approvals.merge.mode=automatic`. R0, R2–R4, manual
triggers, direct merge, and release remain forbidden. The owner-reviewed
`agentlab.autonomous-merge-policy.v1` pins the repository; distinct PR-broker and merger UIDs; exact
schedule, daily-quota, and role-policy digests; exact `verify` and `factory-sandbox` check producer
IDs; independent-review floor; observation/authorization/deadline limits; candidate/day ceilings;
and literal `deliveryMode=merge-queue`, `directMerge=false`, and `release=false`.

Provision the credentialless admission config under the worker UID and the merger config/private key
under a distinct merger UID. The merger GitHub App must be installed only on the governed
repository; its short-lived token requests the fixed contents-write/pull-requests-write profile.
Configure the protected branch to require the pinned checks and GitHub merge queue. Do not reuse the
PR-broker App, worker account, eval-attestor account, or incident-controller account.

GitHub currently makes merge queues available for public organization-owned repositories, or private
organization-owned repositories on Enterprise Cloud; personal repositories are not eligible. See
[GitHub's merge-queue requirements](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).
As checked on 2026-09-07, `RiadMefti/agentlab` is personally owned and has no merge queue. Keep its
automatic merge switch disabled. An ownership transfer or another delivery mode requires a separate
explicit decision; do not substitute direct merging or bypass branch protection.

Before enabling anything, validate both boundaries without issuing authority or mutating GitHub:

```text
agentlab factory merge-admission-preflight --config /etc/agentlab/merge-admission.json
agentlab factory merger-preflight --config /etc/agentlab/merger/config.json
```

Human activation requires three independent compare-and-set switches. Enable merge broker last, only
after scheduler and PR broker, and preserve each JSON result:

```text
agentlab factory merge-authority --config /etc/agentlab/authority.json --expected disabled --to enabled --reason "Approved scheduled R1 merge-queue canary." --confirm-enable-autonomous-merge
```

The daily admission tick derives the latest exact-head observation and reservation from canonical
local evidence. It has no GitHub credential. Manual diagnosis may use `merge-admit`, but production
daily operation uses only the bounded tick:

```text
agentlab factory merge-admission-tick --config /etc/agentlab/merge-admission.json --merge-policy sha256:... --policy sha256:... --schedule-policy sha256:... --daily-quota sha256:... --role-policy sha256:...
agentlab factory merger-tick --config /etc/agentlab/merger/config.json --merge-policy sha256:... --policy sha256:... --schedule-policy sha256:... --daily-quota sha256:... --role-policy sha256:...
```

Admission requires a live canary reservation, complete usage and patch evidence, the exact latest
clear PR observation, precisely the policy-bound successful checks, the independent-review floor,
and all three authority switches. It issues one short-lived single-use authorization and transitions
`pr-open → merge-ready`. The merger persists intent before ready-for-review and enqueue mutations,
passes the authorized head as GitHub `expectedHeadOid`, and never calls direct merge. It reconciles
ambiguous results and advances only after exact queue-backed merged readback:

```text
ready → ready-intent-recorded → ready-for-review → enqueue-intent-recorded → enqueued
  → merged → merge-evidence-recorded → completed
```

Any pre-merge coordinate drift becomes `stale` or `quarantined`. Preserve SQLite and evidence; never
delete or edit a journal, reuse an authorization, force-push the branch, or manually direct merge
it. `pending` is a normal merger-tick result while GitHub's queue owns progress.

The daily merge limit reserves capacity when the immutable merge run is registered, atomically
before remote writes. It counts registrations and observed merges for the UTC day plus unresolved
carryover, once per run and across policy versions. Retries do not allocate another slot. Exhaustion
reports `merge-daily-capacity-exhausted` and stops new admission, but still permits reconciliation
of existing queued work. A pre-enqueue terminal failure consumes its registration-day allowance; an
uncertain enqueue retains capacity across days, even if quarantined. Preserve its journal for
incident handling; neither midnight nor changing policy clears that uncertainty. There is no
operator counter-reset command.

An explicit `merger-tick` still reconciles queued work when an authority switch is disabled. The
service checks switches before every new remote mutation; disabling them does not cancel entries
already owned by GitHub's queue. Inspect those entries during containment and remove them through
the repository's operator controls if needed. The daily chain stops at containment, so recovery
ticks after an incident must be invoked separately to preserve observed results and evidence.

Queue reconciliation can also outlive the task contract. Expiry prohibits new actions, but the
control plane accepts the read-only `merge-queued → merged` bookkeeping transition when a
broker-authenticated merge record matches the queued event's exact authorization. A restart after
evidence publication resumes from that journal checkpoint; it does not enqueue again. Keep the
conversation active until reconciliation finishes.

## Render the dormant daily cycle

After all identities, configs, policies, costs, governance, and preflights are ready, a provisioning
operator may render—not install—the separated systemd chain. The owner-only manifest is strict and
contains no command or credential:

```json
{
  "schemaVersion": "agentlab.daily-cycle-manifest.v5",
  "id": "agentlab/daily-software-factory",
  "version": "1.0.0",
  "agentlabExecutable": {
    "path": "/opt/agentlab/bin/agentlab",
    "digest": "sha256:..."
  },
  "executableChecksumPath": "/etc/agentlab/factory-executable.sha256",
  "worker": { "userId": 1001, "configPath": "/etc/agentlab/worker.json" },
  "broker": { "userId": 1003, "configPath": "/etc/agentlab/broker.json" },
  "incident": { "userId": 1004, "configPath": "/etc/agentlab/incident.json" },
  "merger": { "userId": 1005, "configPath": "/etc/agentlab/merger/config.json" },
  "schedulePolicyPath": "/etc/agentlab/schedule.json",
  "dailyQuotaPolicyPath": "/etc/agentlab/daily-quota.json",
  "operationsHealthPolicyPath": "/etc/agentlab/operations-health-policy.json",
  "mergePolicyPath": "/etc/agentlab/autonomous-merge-policy.json",
  "roleIdentityPolicyPath": "/etc/agentlab/role-identities.json",
  "expectedSchedulePolicyDigest": "sha256:...",
  "expectedDailyQuotaPolicyDigest": "sha256:...",
  "expectedOperationsHealthPolicyDigest": "sha256:...",
  "expectedMergePolicyDigest": "sha256:...",
  "expectedRoleIdentityPolicyDigest": "sha256:...",
  "expectedFactoryPolicyBundleDigest": "sha256:...",
  "maintenanceDiscoveryConfigPath": "/etc/agentlab/maintenance-discovery.json",
  "canaryAdmissionConfigPath": "/etc/agentlab/canary-admission.json",
  "mergeAdmissionConfigPath": "/etc/agentlab/merge-admission.json",
  "expectedMaintenanceDiscoveryPolicyDigest": "sha256:...",
  "expectedPreparationGrantDigest": "sha256:...",
  "expectedCanaryCohortDigest": "sha256:...",
  "expectedCanaryCandidateDigest": "sha256:...",
  "maximumRepairRounds": 2,
  "workerCommandTimeoutSeconds": 7500,
  "brokerCommandTimeoutSeconds": 900,
  "incidentCommandTimeoutSeconds": 120,
  "mergeAdmissionCommandTimeoutSeconds": 300,
  "mergerCommandTimeoutSeconds": 900
}
```

`maximumRepairRounds` cannot exceed the schedule tick's repair-attempt ceiling. The worker timeout
must exceed its complete aggregate wall-clock ceiling by at least 30 seconds. Render to stdout:

```text
agentlab factory orchestration-render --config /absolute/orchestration.json
```

The v5 JSON bundle pins the manifest, discovery/grant/cohort/candidate, quota/health/merge policies,
the AgentLab executable, every unit, and the bundle itself. Its UTC `Persistent=false` timer runs
incident containment → discovery → canary admission → scheduler → draft → bounded
observe/repair/update rounds → final exact-head observation → credentialless merge admission →
isolated merger. Only exit zero continues. Separate numeric-UID services, fixed argv, bounded
timeouts, `OnSuccess=` links, and an incident target preserve separation. Legacy manifests remain
readable for audit but cannot render an executable autonomous cycle. Every service verifies
`executableVerification.checksumContent` with fixed `/usr/bin/sha256sum` argv before AgentLab.
Rendering never writes a unit/checksum, calls `systemctl`, changes authority, or touches the ledger.

Owner provisioning is deliberately outside AgentLab. Materialize the exact checksum content at
`executableVerification.checksumFilePath` and the exact unit contents under `/etc/systemd/system`.
Before activation, independently re-hash the executable and every artifact, ensure the worker,
broker, merger, and incident accounts own only their respective private configs or credentials, and
ensure no runtime UID owns the AgentLab executable or can write it through group/other permissions.
Keep the fixed checksum root-owned and non-writable under `/etc/agentlab`. The current storage
implementation cannot provide the required cross-role ledger/artifact handoff; this step is blocked
pending the storage-boundary correction above. Once that correction is implemented and verified,
enable the worker's user manager/linger required by its transient scopes. Runtime configs for
distinct UIDs require role-owned copies of the schedule and identity policies with identical
reviewed digests; they cannot share one owner-only file. Run `/usr/bin/sha256sum --status --check`
on the materialized checksum and `systemd-analyze verify` over the complete unit bundle. Only after
every role preflight, governance, monitored incident response, and the three human-controlled
authority switches are ready should an operator enable `agentlab-factory-daily.timer`.

Monitor failed stage units and `agentlab-factory-incident.target`. The target is a durable systemd
signal, not an automatic authority mutation and not a retry latch. On any signal, disable all three
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
becomes `human-review-required`. Treat all three as local evidence only. Only the separately
configured feedback publisher below may translate a completed bundle into an advisory GitHub
comment; no result grants approval, branch write, merge, deployment, or release authority.

On interruption, preserve SQLite schema v21, the artifact root, and worktree root. The next tick
proves exact recorded systemd scopes inactive and removes only the journal-owned worktree before a
bounded retry. If it cannot prove inactivity or cleanup, stop the lane and investigate; never delete
the journal or reuse an execution/session identity. No live config, timer, skill inventory, rate
card, provider account, or object-mirroring service is installed by this repository.

## External pull-request feedback publication

Use a third GitHub App and operating-system account for feedback publication. Do not reuse the
read-only discovery App, model-bearing reviewer UID, or draft/update broker App. The installation
token must request exactly `pull_requests:write`; GitHub may add implicit `metadata:read`. The App
must have no contents, checks, administration, actions, deployment, merge, or release permission.

The policy is strict and comment-only:

```json
{
  "schemaVersion": "agentlab.external-pull-request-feedback-policy.v1",
  "id": "agentlab/external-pull-request-feedback",
  "version": "1.0.0",
  "repositoryId": "owner/repository",
  "reviewPolicyDigest": "sha256:...",
  "publisherId": "external-review-feedback-broker",
  "publisherUserId": 123456,
  "publicationMode": "comment-only",
  "maximumPublicationsPerTick": 3,
  "maximumReviewAgeHours": 24,
  "maximumBodyBytes": 16000,
  "operationDeadlineSeconds": 300,
  "maximumRecoveryAttempts": 1
}
```

`publisherUserId` is the numeric GitHub App bot identity. The owner-only config schema
`agentlab.local-factory-external-pull-request-feedback.v1` separately pins the database and artifact
paths, repository owner/name and numeric ID, the dedicated `processUserId`, feedback policy
path/digest, and App client ID, installation ID, and private-key path. Keep every file owner-only
and run:

```text
agentlab factory external-pr-feedback-preflight --config /absolute/external-pr-feedback.json
agentlab factory external-pr-feedback-tick --config /absolute/external-pr-feedback.json --feedback-policy sha256:... --review-policy sha256:...
```

Preflight verifies repository/App identity and reports whether the existing broker kill switch is
enabled; it writes nothing. A tick recovers incomplete journals first and admits a bounded page of
completed review bundles. It rechecks the exact open, unmerged base/head, posts only a deterministic
`COMMENT` review, and records the authenticated response. It never publishes contributor title/body
or a GitHub approval/change-request decision. If POST may have succeeded without a durable response,
preserve schema v22 and run the next tick: it searches for the exact digest marker from the pinned
App identity and never blindly posts again. `attention-required` means an operator must inspect the
remote PR and immutable journal; do not manually delete rows or repeat the comment.

Disabling `pr-broker` prevents new feedback writes and cancels a journal whose intent is durable but
whose POST has not started. Read-only reconciliation of a potentially completed POST remains
permitted so evidence is not lost. No timer, account, App, policy, or authority switch is installed
or enabled by AgentLab.

## External pull-request repair admission

Run deterministic repair admission under a separate non-root account. Its owner-only config schema
is `agentlab.local-factory-external-pull-request-repair-admission.v1` and contains only the durable
database path, exact repository, `processUserId`, admission-policy path, and expected canonical
digest. It has no GitHub App or provider configuration. A minimal policy is:

```json
{
  "schemaVersion": "agentlab.external-pull-request-repair-admission-policy.v1",
  "id": "agentlab/external-pull-request-repair-admission",
  "version": "1.0.0",
  "repositoryId": "owner/repository",
  "reviewPolicyDigest": "sha256:...",
  "feedbackPolicyDigest": "sha256:...",
  "repairExecutionPolicyDigest": "sha256:...",
  "costPolicyDigest": "sha256:...",
  "roleIdentityPolicyDigest": "sha256:...",
  "gateProfileDigest": "sha256:...",
  "skillPackageDigests": ["sha256:..."],
  "allowedAuthorAssociations": ["owner", "member", "collaborator", "contributor"],
  "allowForks": false,
  "minimumFindingSeverity": "high",
  "maximumFindings": 8,
  "maximumChangedFiles": 20,
  "maximumChangedLines": 500,
  "maximumReviewAgeHours": 24,
  "authorizationTtlSeconds": 900,
  "maximumCandidatesPerTick": 3,
  "maximumRiskTier": "R1"
}
```

```text
agentlab factory external-pr-repair-admission-preflight --config /absolute/external-pr-repair-admission.json
agentlab factory external-pr-repair-admission-tick --config /absolute/external-pr-repair-admission.json --admission-policy sha256:... --review-policy sha256:... --feedback-policy sha256:... --repair-execution-policy sha256:... --cost-policy sha256:... --role-policy sha256:... --gate-profile sha256:...
```

Preflight reports all transitive pins and the scheduler switch without writing. A tick considers
only schema-v21 review bundles whose exact schema-v22 feedback journal completed. SQLite schema v23
atomically records authorized and denied decisions. Authorizations contain finding IDs and evidence
digests, not model or contributor prose, permit one future credentialless attempt, and require a
replacement draft. They grant no remote write, merge, deployment, or release authority. Disable the
scheduler to stop new admissions; existing immutable decisions remain evidence and must not be
deleted or edited.

## External pull-request repair execution

Run repair execution under a dedicated non-root worker account, never the discovery, feedback, or
branch-write GitHub App account. The owner-only config schema is
`agentlab.local-factory-external-pull-request-repair-execution.v1`. It pins the execution,
admission, cost, and role-policy files and digests; ordered repair skill packages; exact repository,
artifact, database, and non-overlapping worktree roots; Git/flock/systemd executables; and the
reviewed provider executable digest and version. It contains no GitHub key or token. The configured
local repository must already contain the authorized base and head objects; this command never
fetches.

The execution policy must use schema `agentlab.external-pull-request-repair-execution-policy.v1`,
R1, one worker, one repair attempt, `replacement-draft`, and false remote-write/auto-merge/release
flags. Its repairer grant is exactly workspace-write, worktree-write, sandboxed process, network
off, no commands, no secrets, and no remote repository access. Keep protected paths and file, line,
patch, prompt, cost, token, process, memory, CPU, deadline, per-tick, and recovery ceilings narrow.

```text
agentlab factory external-pr-repair-execution-preflight --config /absolute/external-pr-repair-execution.json
agentlab factory external-pr-repair-execution-tick --config /absolute/external-pr-repair-execution.json --repair-execution-policy sha256:... --admission-policy sha256:... --review-policy sha256:... --feedback-policy sha256:... --cost-policy sha256:... --role-policy sha256:... --gate-profile sha256:...
```

Preflight does not create a worktree or run a model. A tick consumes at most the reviewed candidate
limit, rechecks the scheduler before each new candidate and immediately before model execution, and
stores canonical prompt, request, execution record, patch, and bundle artifacts. SQLite schema v24
is append-only. Existing journals reconcile before scheduler/provider blockers stop fresh work.
Recovery can discard and recreate only pre-agent workspaces within the policy limit. Treat
`repairer-active` without a provable outcome as quarantined; do not delete its journal, reuse its
authorization, or manually retry it. Disable the scheduler to stop new executions, preserve the
database/artifacts/worktree evidence during incident analysis, and rotate policy or issue a newly
reviewed authorization for any later attempt.

A completed bundle is local evidence, not publication authority. Do not push it manually. Strict
post-repair gates, an independent reviewer, authenticated replacement-draft lineage, and a separate
credential-bearing broker are still required before external repaired code can become a PR.

## External pull-request repair qualification

Run qualification under a dedicated non-root worker account with no GitHub credential. The
owner-only config schema is `agentlab.local-factory-external-pull-request-repair-qualification.v1`.
It pins the exact qualification and repair-execution policy files and digests, cost and role
policies, reviewer skill packages, provider executables, repository and storage roots,
Git/flock/systemd/bubblewrap tools, and read-only runtime mounts. The qualification policy embeds
the exact ordered seven-gate profile; the config loader hashes every gate executable and rejects any
path, content, or digest drift.

The policy must reserve the complete gate and selected-reviewer ceilings inside both its aggregate
budget and operation deadline. Codex reviewer grants use filesystem/Git read, sandboxed process,
network off, no secrets, no command allowlist, and no remote repository. Claude reviewer grants use
the same restrictions with process set to none. Reviewer IDs must differ from the repairer; durable
provider sessions and execution IDs must also be distinct.

```text
agentlab factory external-pr-repair-qualification-preflight --config /absolute/external-pr-repair-qualification.json
agentlab factory external-pr-repair-qualification-tick --config /absolute/external-pr-repair-qualification.json --qualification-policy sha256:... --repair-execution-policy sha256:... --cost-policy sha256:... --role-policy sha256:... --gate-profile sha256:...
```

Preflight hashes and validates inputs but creates no worktree and starts no gate or model. A tick
consumes only completed schema-v24 repair bundles, reconstitutes the exact patch at the recorded
head without fetching, and runs format, architecture, typecheck, lint, test, build, and secret-scan
in order. Gate failure records a rejected bundle without reviewer execution. Passing gates require
the complete independent reviewer quorum before SQLite v25 can record `qualified`, `rejected`, or
`human-review-required`.

Each gate and reviewer intent is durable before its process starts. Stable interrupted states may
rebuild the exact worktree within the policy recovery limit. Treat `gate-active` or
`reviewer-active` without a recoverable completed result as quarantined; never rerun it under the
same qualification run. Disable the scheduler to stop fresh work, preserve SQLite, artifact, and
worktree evidence, and investigate the recorded isolation ID. A qualified bundle is still local
evidence, not GitHub authority: do not push or open a replacement draft manually.

## External pull-request replacement-draft publication

Run publication under its own non-root broker account, distinct from worker and eval-attestor
accounts. The owner-only config schema is
`agentlab.local-factory-external-pull-request-replacement-draft.v1`. It pins the durable database,
artifact, temporary-workspace, and source-repository roots; repository owner/name and numeric ID;
publication, qualification, and role-policy paths and digests; Git executable; broker App client,
installation, private-key path, numeric publisher user ID; and exact App IDs for `verify` and
`factory-sandbox`. The App installation-token profile is fixed to checks-read, contents-write, and
pull-requests-write for that one repository.

The publication policy must structurally require R1, draft-only, no contributor-branch write, no
force push, no approval, no auto-merge, and no release. Its patch ceiling must equal qualification;
its broker UID must differ from worker and attestor UIDs; and its opaque publisher identity must
match `github-user/<publisherUserId>`.

```text
agentlab factory external-pr-replacement-draft-preflight --config /absolute/external-pr-replacement-draft.json
agentlab factory external-pr-replacement-draft-tick --config /absolute/external-pr-replacement-draft.json --publication-policy sha256:... --qualification-policy sha256:... --role-policy sha256:...
```

Preflight validates identities, pins, and both authority switches without running a model or writing
GitHub. A tick recovers active schema-v26 journals first, then consumes a bounded page of completed
`qualified` schema-v25 bundles. Immediately before push and PR creation it requires the original
PR's exact open URL, base/head, and protected-branch governance. It creates one commit above the
qualified original head, normally pushes it to a deterministic new base-repository branch, and opens
a draft targeting the original base. It never writes the contributor or fork branch.

Branch and PR intents are durable before remote effects. Retry accepts only the exact branch commit
and exact draft coordinates, digest marker, and pinned App user. Original movement is recorded
`stale`; conflicting branch/PR/publisher evidence or failed final verification is `quarantined`.
Preserve the branch, SQLite, artifacts, and journal for investigation. Disable either `scheduler` or
`pr-broker` to stop the next mutation. Do not delete rows, force-push, manually reuse the branch,
approve, merge, deploy, or release from this account. No App, account, key, policy, switch, timer,
or live config is provisioned or enabled by AgentLab.

## Query-only operations health

Run health inspection from a distinct credentialless account with read permission to the ledger and
owner-only policy/config files. The command never acquires a writer lease and has no control,
provider, GitHub, worker, broker, merge, or release capability.

```json
{
  "schemaVersion": "agentlab.operations-health-policy.v1",
  "id": "agentlab/operations-health",
  "version": "1.0.0",
  "lookbackSeconds": 86400,
  "maximumScheduleOverrunSeconds": 300,
  "maximumInFlightSilenceSeconds": 3600,
  "quotaWarningBasisPoints": 8000,
  "maximumRecordsPerSection": 1000
}
```

```json
{
  "schemaVersion": "agentlab.local-factory-operations-health.v1",
  "databasePath": "/var/lib/agentlab/factory.sqlite",
  "observerId": "operations-observer",
  "healthPolicyPath": "/etc/agentlab/operations-health-policy.json",
  "expectedHealthPolicyDigest": "sha256:...",
  "dailyQuotaPolicyPath": "/etc/agentlab/daily-quota-policy.json",
  "expectedDailyQuotaPolicyDigest": "sha256:..."
}
```

```text
agentlab factory operations-health --config /etc/agentlab/operations-health.json
```

The single-line output contains `report` and `reportDigest`. Exit 0 is healthy, 2 is degraded, and 3
is critical. Critical means the report recommends containment; it does not change either switch.
Capture the complete line in an append-only monitoring destination before acting on it. A failed
projection, unsupported database schema, policy drift, invalid canonical/materialized join, or
record-limit truncation fails closed. No health timer, dashboard, alert transport, or automatic
incident action is installed by AgentLab.

## Disable-only incident containment

Run containment under a third non-root UID, distinct from worker, broker, and eval attestor. Its
owner-only config contains no credential and pins the same health and daily-quota policy bytes:

```json
{
  "schemaVersion": "agentlab.local-factory-incident-containment.v1",
  "databasePath": "/var/lib/agentlab/factory.sqlite",
  "controllerId": "incident-controller",
  "controllerUserId": 1004,
  "healthPolicyPath": "/etc/agentlab/incident/operations-health-policy.json",
  "expectedHealthPolicyDigest": "sha256:...",
  "dailyQuotaPolicyPath": "/etc/agentlab/incident/daily-quota-policy.json",
  "expectedDailyQuotaPolicyDigest": "sha256:..."
}
```

```text
agentlab factory incident-containment --config /etc/agentlab/incident/containment.json --health-policy sha256:... --daily-quota sha256:...
```

The command does not accept a report. It recomputes health internally, verifies both command-line
pins against config, and has no enable operation. Healthy exits 0 without writing. Degraded exits 2
without writing so a v5 daily chain stops before work. Critical exits 3: SQLite schema 31 disables
any enabled merge-broker, PR-broker, and scheduler switches in that order and appends canonical
containment evidence inside one compare-and-disable transaction; if all three were already off, it
reports `already-contained`. Any race or partial insert rolls back. Preserve the one-line result and
SQLite ledger. Re-enable only through the human commands below after investigation. AgentLab does
not install or invoke this command outside a separately provisioned v5 cycle.

## Authority and incident stop

The worker still ends at local `pr-proposed`; it has no GitHub credential. Draft publication,
credentialless merge admission, and queue-only merger are separate processes and switches. Manual
draft creation still requires literal confirmation; scheduled canary publication and merge require
the exact reservation and scheduler lineage. Never put authority enablement, direct merge, release,
or deployment into a timer.

To stop new or resumed scheduled and broker work:

```text
agentlab factory merge-authority --config /absolute/authority.json --expected enabled --to disabled --reason "Incident stop." --confirm-disable-autonomous-merge
agentlab factory broker-authority --config /absolute/authority.json --expected enabled --to disabled --reason "Incident stop." --confirm-disable-draft-broker
agentlab factory scheduler-authority --config /absolute/authority.json --expected enabled --to disabled --reason "Incident stop." --confirm-disable-scheduler
```

Disabling does not erase evidence or fabricate completion. Preserve the database, artifact root,
worktrees, schedule output, and authority history. Investigate any `task-active` run through the
existing recovery path; re-enable only after the policy/config digest and host state are reviewed.

## Known operational gaps

No OS accounts or GitHub Apps, installed timer, live rate card/config/cohort/quota/health/merge
policy, reviewed case bank or installed eval harness, cross-host/global quota coordinator, installed
dashboard/alert delivery, secretless hosted-provider eval gateway, owner-provisioned activation,
release/deployment controller, telemetry-driven canary, rollback controller, or incident
coordination is shipped. A separate offline sandboxed eval producer with content-addressed evidence
now exists. Durable read-only maintenance discovery, bounded consumption of a human non-release
cohort, host-local repository/day and organization/day quota enforcement, reservation-bound
scheduled execution/draft dispatch, slot-bound PR observation/repair, brokered repaired-branch
publication, bounded read-only external pull-request inventory, credentialless isolated external
review evidence, feedback-only external review publication, deterministic external repair admission,
credentialless one-attempt external repair execution, credentialless strict post-repair
qualification, a separately credentialed contributor-safe replacement-draft publisher, a
credentialless exact-head merge admission plane, a separate recovery-first merge-queue broker, a
content-addressed separated-service renderer, and a query-only content-addressed operations-health
report plus credentialless disable-only incident containment exist but are not provisioned or
activated. See [Local factory evaluation operations](factory-evaluation-operations.md). Those
remaining controls are required before calling the factory self-maintaining.
