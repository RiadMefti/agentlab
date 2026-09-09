# Architecture

This document is the normative product architecture. Durable changes require an ADR, updated fitness
functions, and focused compatibility/failure tests in the same change. Directory names and prose
never substitute for executable boundaries.

## Product boundary

The UI presents each saved conversation as a project: a user-defined name plus one canonical local
folder. Every project owns exactly one captain. The captain may create zero or more independent
workers, and the user may enter any exact session directly.

```text
project / conversation
└── captain (exactly one, pinned)
    ├── worker
    ├── worker
    └── ...
```

The interactive product is local-only and single-process. Optional factory operations use separate,
short-lived local compositions: a credentialless model-bearing worker, a human-only local switch
operator, a credential-bearing draft-PR broker, credentialless governed intake and maintenance
discovery operators, an offline sandboxed eval producer, a credentialless deterministic
evaluator/verifier, an isolated key-bearing eval attestor, a separate human canary-authority
operator, a credentialless canary-admission operator, and a read-only unit renderer. Only the broker
may make explicit GitHub API calls; none is loaded into the interactive runtime. AgentLab has no
HTTP server, WebSocket gateway, browser renderer, desktop shell, remote mode, app command language,
MCP bridge, or provider-session translation layer.

[ADR 0034](decisions/0034-single-owner-factory-ledger-boundary.md) additionally accepts one optional
long-lived, credentialless local ledger owner. Its Unix peer-authenticated surface provides scoped
reads, separately granted idempotent human switch operations, task-bound artifact transfers, and
immutable one-shot worker job claims and result receipts; it is not loaded by the interactive
runtime. Only the trusted owner can enqueue a journal-bound operation. Existing one-shot factory
writers have not yet migrated behind it; the separated-UID daily chain remains disabled.

## Two paths

```text
Agent orchestration
captain ── raw tmux/provider CLI commands ──▶ workers

User observation and interaction
OpenTUI terminal ◀── one Bun PTY ──▶ selected exact tmux session

Explicit user lifecycle
OpenTUI actions ── validated application commands ──▶ provider launcher + tmux
```

The observation path never carries captain-to-worker instructions. The explicit lifecycle path lets
the user add a project folder, start a worker with an initial task, or remove managed state; it does
not mediate later agent communication.

## Software-factory safety kernel

[ADR 0006](decisions/0006-local-software-factory-control-plane.md) accepts an additive local-first
software-factory control plane. A factory task belongs to one existing conversation, its agent
attempts remain workers beneath that conversation's single captain, and provider-specific execution
stays behind ports. Deterministic code—not captain instructions—owns task state, capabilities,
budgets, gates, evidence, and remote authority.

The source tree now contains the dormant stages 1–4 safety path, bounded local scheduler admission,
and a dormant eval-production/promotion lane: strict contracts; immutable SQLite task/evidence/eval
journals; deterministic risk and promotion policy; kill switches; content-addressed artifacts;
exact-base disposable worktrees; bounded provider-native implement, repair, and independent-review
adapters; sandboxed deterministic gates; authenticated evidence channels; and a separate GitHub
adapter that can reconstruct one exact patch and request only a draft PR after rechecking repository
governance. Factory policy 1.3 conservatively classifies the complete allowed write scope before
execution, binds preparation evidence to the compiled contract, and pins per-tier process-tree
limits. Every agent or gate executor requires an injected OS isolator; the Linux adapter creates a
unique transient systemd user scope with cgroup CPU, memory, swap, and task ceilings and has no
unbounded fallback. The wrapper strips its user-manager environment before starting the target.
Deterministic gates run Bubblewrap inside that scope. The model-bearing subprocess environment is
allowlisted and excludes repository, cloud, and package credentials. The broker credential is
acquired only at the separate broker boundary.

That broker boundary has a fixed-purpose GitHub App adapter. It issues a bounded RS256 App JWT and
requests an installation token for one configured numeric repository ID with only `checks:read`,
`contents:write`, and `pull_requests:write`. The response must name that exact selected repository,
must not widen the permission map, and must expire within the bounded installation-token window.
Tokens coalesce in memory, refresh before expiry, and are invalidated on authentication or push
failure. Neither the App key nor installation token crosses into a model-bearing process. The exact
`@agentlab/runtime/factory-broker` package subpath is the only public composition entry for this
authority plane; the interactive `@agentlab/runtime` entry does not re-export it. Its strict
owner-only configuration points to a canonical owner-only App-key file and pins the trusted GitHub
App ID for each required `verify` and `factory-sandbox` context. Config v1 remains compatible and
cost-blocked. Config v2 additionally points to a separate canonical owner-only cost-policy file so
future broker and worker processes can load the same rate card without sharing credentials. The
loader strictly parses `agentlab.cost-policy.v1` before runtime construction. Config v3 additionally
loads the same separately protected schedule and role-identity policies as the worker. Config v4 is
required for scheduled canary dispatch and also loads and pins the reviewed daily aggregate quota
policy. Config v5 adds the exact repository and autonomous-merge policy coordinates used by the
credentialless admission and distinct merger. A matching check name from another App does not count.
Config, policies, and key reject symlinks, hard links, non-owner permissions, unstable metadata,
non-canonical paths, and oversized input. Each key read returns fresh mutable bytes that the signer
erases after one signature.

Human enablement is a fourth exact runtime package entry, `@agentlab/runtime/factory-authority`. Its
strict owner-only `agentlab.local-factory-authority.v1` config contains only a durable database path
and a pinned operator identifier. The composition can inspect all three switches and atomically
compare-and-set `scheduler`, `pr-broker`, or `merge-broker` through distinct commands and
confirmations, recording a canonical append-only human control event for each switch. It exposes no
scheduler execution, task execution, process runner, provider, GitHub, tmux, terminal, broker, or
interactive runtime capability. SQLite's single-writer lease and `BEGIN IMMEDIATE` make the
expected-state check and append one transaction. OS file ownership is the local authorization
boundary; the configured operator identifier is audit metadata, not independent proof of a person,
so production use requires a dedicated non-shared operating-system account.

The product CLI exposes separate authority inspection, broker and worker preflight, manual and
scheduled worker commands, and independent scheduler/PR-broker/merge-broker authority
compare-and-set commands. Each loads only its exact runtime, emits one deterministically ordered
non-secret JSON record after clean shutdown, and exits with 0 for success/ready, 2 for a
policy-blocked preflight, or 1 for an operational failure. Authority mutation requires the exact
expected and desired opposite states, a bounded reason, and the matching literal enable/disable
confirmation. The explicit `broker-open-draft` command additionally requires a task UUID, the
operator's expected policy digest, and the literal `--confirm-draft`. It never calls the write port
unless broker preflight is clean and the digest matches. The service then rechecks the exact task,
policy, evidence, complete usage, base revision, remote governance, and kill switch around its
durable idempotent dispatch. The broker command port deliberately has no authority-switch command,
and the authority port has no remote-write command, so broker and human enablement duties remain
separate. Scheduler authority has its own exact CLI path, but that runtime cannot execute work. All
switches remain default-off. An empty rate card adds `cost-policy-unconfigured` to preflight and
independently denies draft mutation, so readiness is not merely advisory. The safe manual ceremony
is: inspect; require broker preflight to report only `pr-broker-disabled`; enable with
compare-and-set; issue the exact draft command; then compare-and-set disable even when the draft
attempt fails. The broker's immediate preflight and inner rechecks remain authoritative throughout.

The distinct `broker-open-canary-draft` command replaces the per-task confirmation only for a
scheduled task with an exact `brokered-draft-pr` reservation. It requires broker config v4 plus the
reservation, schedule-policy, role-policy, and factory-policy digests. The broker independently
proves the unexpired canary and daily quota reservations and exact completed scheduler handoff
before dispatch and every resumable checkpoint. Scheduled tasks cannot use the manual command, and
non-scheduled tasks cannot present canary authority. This command does not enable the broker,
discover work, install a timer, merge, or release.

The separate one-shot `broker-canary-tick` command projects pending work by joining immutable
completed scheduler handoffs to absent or incomplete dispatch journals. It does not create a second
mutable queue. Config v4 and exact schedule, daily-quota, role, and factory-policy pins are
mandatory. One tick inspects at most `maximumCandidatesPerTick`, attempts at most
`maximumTasksPerTick`, prioritizes current authority and then crash recovery within that class, and
routes every candidate through the same reservation-revalidating draft service. Expiry and
deterministic denial produce attention output; a denial stops the remaining page. The command cannot
enable authority, install a timer, merge, or release.

The separate one-shot `broker-pr-maintenance-tick` command projects exact open schema-v2 canary PR
heads from completed scheduler handoffs, latest durable PR lineage, and append-only evidence. One
resolved daily slot, the reservation, current PR record and head, broker, and exact schedule, role,
and factory-policy digests form the immutable maintenance identity. The schedule policy bounds both
inspection and attempts. A new observation rechecks canary authority before its credentialed read;
an actionable observation rechecks it again before existing deterministic repair admission. The
slot-bound observation is the crash checkpoint, so admission can resume without another remote read.
Clear or pending facts create no repair authority; unsafe, denied, expired, or regressed work
reports attention. The command cannot execute repair, update the branch, enable authority, merge, or
release.

The separate `broker-observe-pr` command binds the same owner-only config, task UUID, policy digest,
clean preflight, and literal `--confirm-observe`, but calls only a credentialed read port plus the
local append-only evidence ingress. It resolves the completed durable dispatch itself and binds the
exact repository, PR number, broker, recorded head, and observation digest. The GitHub adapter reads
less than one full bounded page each of formal reviews, inline review comments, and PR conversation
comments, plus one bounded page of check runs for the observed head. Only check names paired with
their configured App IDs count as trusted; ambiguous or truncated pages fail closed. Review bodies
remain explicitly untrusted fields inside the content-addressed artifact, while the CLI emits only
counts, revisions, digests, and a deterministic facts-only disposition. The command cannot update
the branch, invoke a provider, transition into repair, merge, or release.

The separate `external-pr-discovery-tick` command inventories bounded external pull requests through
`@agentlab/runtime/factory-external-pull-request-discovery`. Its dedicated GitHub App token requests
exactly `checks:read`, `contents:read`, and `pull_requests:read`; the composition has no provider,
process, checkout, broker-write, merge, or release port. One policy-pinned daily slot reads no more
than its configured pull-request and changed-file ceilings, checks the repository identity, and
re-reads each pull request after its files so a mutable head, base, state, or detail fails closed.
Titles, bodies, and file paths remain untrusted fields in a canonical content-addressed snapshot.
SQLite schema v20 appends immutable run, event, snapshot, and candidate records. Deterministic
dispositions only create inventory for a future review stage; they confer no execution or GitHub
write authority.

The separate `external-pr-review-tick` command consumes only those immutable
`agent-review-candidate` records through `@agentlab/runtime/factory-external-pull-request-review`.
This composition is model-capable but credentialless: architecture rules permit pinned provider
adapters, systemd process isolation, local Git, SQLite, and artifacts while forbidding every GitHub,
broker, tmux, interactive, merge, and release path. It never fetches. Exact base/head objects must
already exist in the configured local repository; a detached head worktree reconstructs the
merge-base patch and its changed paths must equal the authenticated discovery inventory. Ordered,
skill-pinned reviewer profiles run with read-only filesystem/Git, no network, secrets, commands, or
remote repository capability. Distinct provider sessions, complete exact-model cost accounting,
aggregate budgets, cgroup ceilings, strict JSON, and a clean worktree are mandatory. SQLite schema
v21 journals recovery-bounded state and a content-addressed quorum bundle. Split verdicts route to a
human; no result grants GitHub authority.

The separate `external-pr-feedback-tick` command consumes only completed v21 review bundles through
`@agentlab/runtime/factory-external-pull-request-feedback`. It runs under a distinct pinned non-root
UID and a dedicated selected-repository GitHub App whose token requests only `pull_requests:write`;
it does not reuse discovery or branch-write credentials. The composition has no provider, process
runner, checkout, content write, draft, repair, merge, deployment, or release port. A deterministic
sanitized body omits contributor title/body, neutralizes mentions and Markdown controls, declares
itself advisory, and embeds the exact bundle digest. The adapter can submit only a `COMMENT` review
on the exact open, unmerged base/head; it cannot express GitHub approval or change-request state.
New publication requires the default-off broker switch before intent and again immediately before
POST. SQLite schema v22 stores immutable publication runs, append-only events, and authenticated
remote records. Durable intent precedes POST; an uncertain outcome is reconciled only by the exact
body marker, reviewed head, and configured App user ID. Blind POST retry is forbidden, and
unresolved or conflicting remote evidence reports attention. See
[ADR 0025](decisions/0025-feedback-only-external-pull-request-review-publication.md).

The fourth external-PR plane is deterministic repair admission through
`@agentlab/runtime/factory-external-pull-request-repair-admission`. It runs under another exact
non-root UID and has no provider, process, workspace, GitHub, credential, branch mutation, merge,
deployment, or release path. A schema-v23 decision must join one completed review bundle to its
exact completed feedback publication and a canonical admission policy that transitively pins future
repair execution, cost, role, gate, and skill authority. Only unanimous `changes-requested` results
within reviewed author/fork, age, severity, finding, file, and line limits can receive one expiring
R1 authorization. The capability carries evidence digests and finding selectors, never contributor
or review prose, and fixes publication to a future replacement draft with remote write, auto-merge,
and release disabled. Denials are immutable too, exact retries are idempotent, and scheduler
revocation before the transaction prevents authority creation. See
[ADR 0026](decisions/0026-deterministic-external-pull-request-repair-admission.md).

The fifth external-PR plane is credentialless repair execution through
`@agentlab/runtime/factory-external-pull-request-repair-execution`. Its owner-only configuration
pins the canonical execution and admission policies, cost and role policies, ordered skill packages,
provider executable identity, repository, artifact root, worktree root, and systemd isolation tools.
The composition can run a pinned provider and write one isolated worktree, but it contains no GitHub
client, App key, remote-repository write, broker, merge, deployment, release, tmux, or interactive
port. It never fetches: the exact authorized base/head objects and original patch must already be
present locally and must reproduce the authenticated discovery inventory.

One schema-v23 authorization creates one schema-v24 repair run. The repairer receives exact finding
selectors resolved from the bound review bundle; all finding prose and repository content are
delimited as untrusted data. Network, secrets, command allowlists, commits, pushes, publication,
merge, and release are forbidden. Changed files, lines, patch bytes, prompt bytes, cost, tokens,
processes, wall time, protected paths, deadline, and recovery attempts are bounded by the immutable
policy. SQLite enforces immutable runs, append-only legal transitions, and immutable patch bundles.
The scheduler is checked before admission and again before the agent starts. Existing journals are
reconciled before readiness or scheduler blockers can stop fresh execution. Recovery may retry
workspace setup only before `repairer-started`; any inactive or uncertain post-start outcome is
quarantined so the same authorization can never silently run a second model attempt. Success closes
the worktree before recording a content-addressed replacement-draft patch bundle with
`remoteWrite:false`, `autoMerge:false`, and `release:false`. This plane does not run the final
strict gate/review floor and cannot publish the bundle; those are separate authority stages. See
[ADR 0027](decisions/0027-credentialless-external-pull-request-repair-execution.md).

The sixth external-PR plane is credentialless post-repair qualification through
`@agentlab/runtime/factory-external-pull-request-repair-qualification`. Its owner-only configuration
mutually pins the qualification and repair-execution policies, cost and role policies, exact review
skills, provider binaries, repository and storage roots, and an inline content-addressed gate
profile. Before runtime construction the loader hashes every canonical gate executable and rejects
drift or conflicting digests. The composition has no GitHub client, token, remote-repository port,
broker, merge, deployment, release, tmux, terminal, or interactive path.

One completed schema-v24 repair bundle creates one immutable schema-v25 qualification run. The
worker reconstructs the exact repaired patch at the authenticated head without fetching and proves
the patch digest and change set before work starts. It then journals intent and runs the exact
ordered format → architecture → typecheck → lint → test → build → secret-scan floor in an offline
bubblewrap/systemd boundary. Every gate executable, argument vector, timeout, output ceiling,
evidence kind, and isolation record is policy-bound. A failed gate deterministically rejects the
repair. Passing gates are followed by the configured independent review quorum in sessions distinct
from the repairer and from each other. Codex review is read-only with a sandboxed process; Claude
review is read-only with no process capability. Both have network off, no secrets, no command
allowlist, and no remote authority. Aggregate work is reserved inside the immutable budget and
deadline.

SQLite v25 stores immutable runs and bundles plus an append-only legal event chain. Intent is
durable before every gate or reviewer process. Stable pre-process states may rebuild the exact
worktree within the recovery limit; an interrupted active process is reconciled and quarantined,
never blindly rerun. Artifact digests are re-read on recovery, repairer/reviewer identity is checked
at the persistence boundary, and a final `qualified`, `rejected`, or `human-review-required` bundle
is recorded only after every required observation is complete and the unchanged worktree is closed.
The result fixes publication mode to `replacement-draft` and keeps remote write, auto-merge, and
release false. Replacement-draft publication remains a separate broker authority. See
[ADR 0028](decisions/0028-credentialless-external-pull-request-repair-qualification.md).

The seventh external-PR plane is the separately credentialed publication composition
`@agentlab/runtime/factory-external-pull-request-replacement-draft`. It runs under a policy-pinned
broker UID distinct from worker and attestor identities and uses a separate repository-scoped GitHub
App with only checks-read, contents-write, and pull-requests-write. The architecture closure
contains no provider, agent, gate, approval, merge, deployment, release, terminal, or tmux path.

Only a completed schema-v25 `qualified` bundle can create an immutable schema-v26 publication run.
Before each mutation the adapter re-reads the original open PR and requires its exact URL, base
branch/revision, qualified head, and the full governance floor. The repaired commit is
deterministic, has the original qualified head as its sole parent, and is normally pushed without
force to `agentlab/external-repair/pr-<number>-<qualification-prefix>` in the base repository. No
contributor or fork branch can be named as a push destination.

SQLite records branch and PR intents before their remote effects. Recovery accepts only the exact
branch SHA and reconciles a draft by exact base/head/title/body marker plus the pinned GitHub App
user ID. Original movement becomes terminal stale; conflicting remote identity or final drift is
quarantined. The immutable record links the original PR, replacement PR, proposal, qualification,
branch, commit, broker, and publisher. The plane can only create and verify a draft; it cannot
approve, merge, release, deploy, or activate itself. See
[ADR 0029](decisions/0029-brokered-external-pull-request-replacement-drafts.md).

The separate `broker-authorize-repair` command adds an explicit local admission boundary after
observation. It requires clean broker preflight, an exact observation digest, the policy pin, and
literal `--confirm-repair`. The application revalidates the task, completed dispatch, canonical PR
record, broker-authenticated observation evidence, deterministic actionable disposition, and
complete initial usage. It then reserves at most one remaining `maxRepairAttempts` slot in canonical
`agentlab.pull-request-repair-authorization.v1` evidence. The artifact contains only immutable
coordinates, selected review/comment IDs from trusted human repository associations, and exact
failing check identities; raw bodies remain only in the separately bound untrusted observation
artifact. An existing exact authorization is replayed idempotently, while another outstanding
authorization blocks a second reservation. This broker composition still has no
provider/model/process port, and admission neither changes task state nor updates the PR.

The separate `worker-repair-pr` command consumes one exact authorization through the credentialless
worker composition. It requires the owner-only worker config, task UUID, authorization digest,
policy digest, and literal `--confirm-repair`; scheduler-disabled alone is ignored for this explicit
manual operation. The worker revalidates the completed dispatch, latest exact observation,
authorization, prior patch, cumulative usage, contract, policy, repository/base commit, and pinned
repair skill before creating an immutable repair-run record. SQLite version 9 stores that record and
its append-only execution-event chain before a model starts. One fresh exact-base worktree reapplies
the prior patch, one repairer sees only the selected feedback bodies marked as untrusted data, all
strict gates run again, and a distinct read-only reviewer must approve. The attempt cannot retry
under the same authorization, every resource counter remains cumulative, and interruption is
reconciled from exact journal-owned process/worktree coordinates before abandonment and a safe task
terminal state. Success returns to a local `pr-proposed` checkpoint. The composition still has no
GitHub, broker credential, authority-control, merge, or release port; publishing the repaired branch
is a separately authorized broker operation.

The one-shot `worker-pr-repair-tick` command automates only that credentialless execution handoff.
Its read projection prioritizes any nonterminal repair journal over fresh work, including across
scheduler, cost, identity, or host-readiness blockers. Fresh entries must join an exact actionable
slot-bound canary observation and authorization to current schema-v2 PR lineage, scheduler handoff,
reservation, broker, and schedule/quota/role/factory policies. Config v4 and caller pins are
mandatory. Before model work, the command requires ready worker preflight and current canary
authority, and conservatively reserves the task's complete contract budget against the schedule tick
budget. The existing repair journal, isolation, gates, distinct reviewer, cumulative task budget,
and no-retry semantics remain authoritative. It stops at `pr-proposed` and cannot reach GitHub or
mutate authority.

The one-shot `broker-pr-update-tick` command closes the scheduled repair handoff without weakening
the broker boundary. Its read projection places every nonterminal update journal before fresh work.
Fresh candidates must join an exact completed repair to its maintenance observation and
authorization, current schema-v2 PR head, canary and daily quota reservations, completed scheduler
handoff, scheduled R1 task, broker, and schedule/quota/role/factory policy pins. The existing update
service remains the sole write path: it journals before mutation, performs a deterministic non-force
child update, verifies and authenticates the new head, and returns the task to `pr-open` for another
slot-bound observation. Candidate and action counts are schedule-bounded. The command has no model,
authority-mutation, merge, release, deployment, or timer-installation port.

The separate `broker-update-draft` command binds the owner-only broker config, task UUID, exact
repair-authorization digest, policy digest, and literal `--confirm-update`. The broker revalidates
the completed repair journal and evidence, exact repaired patch and complete cumulative usage,
current policy, repository/base/governance, authenticated PR lineage, and kill switch. It prepares
the repaired tree from the immutable contract base, fetches the recorded PR branch, creates a
deterministic commit whose sole parent is the prior authenticated head, and performs a normal
non-force push. SQLite version 10 stores the proposal before remote mutation and appends:

```text
ready → update-active → remote-updated → evidence-recorded → completed
```

If the remote fast-forward succeeds before its checkpoint is durable, retry reconstructs the same
commit, accepts only that exact already-applied head, and performs no second branch mutation. The
broker then verifies the live draft, records authenticated proposal/record/policy evidence, changes
only `pr-proposed → pr-open`, and makes later observation and repair admission resolve the new head.
The model-bearing worker never receives the GitHub credential; the broker cannot run a provider.

The explicit `worker-run` command likewise binds an owner-only worker config, task UUID, expected
policy digest, generated correlation UUID, and literal `--confirm-run`. Scheduler-disabled and an
unconfigured schedule policy are not manual-work denials; every other preflight reason remains
blocking. Under the worker's existing single-writer queue, a resumable application runner reconciles
interrupted preparation and execution journals, advances the bounded qualify/specify/plan chain,
atomically materializes the contract, rechecks execution admission, and invokes the existing
implement/gate/review/repair service. Durable identity disagreement fails closed. The command stops
at `pr-proposed`, emits only a compact non-secret report, and cannot reach GitHub, broker
credentials, control mutation, merge, or release capability.

The `scheduler-tick` command is a one-shot local reconciliation operation, not an embedded daemon.
It requires the exact loaded schedule-policy, daily-quota-policy, and factory-policy digests. The
scheduler resolves the latest daily UTC slot, refuses to create a run beyond its bounded start
deadline, but may resume an already-created run after that deadline. Before resolving a new slot, it
reconciles the single oldest open run even across a UTC day boundary. More than one open run is an
integrity failure, and an open run pinned to different schedule or factory policy blocks new work
for operator recovery. A wall clock behind the open run or its latest event also blocks before
worker execution. SQLite version 11 gives each stable schedule ID/slot pair one immutable run and
this append-only chain:

```text
registered/ready
  ├─ task-skipped ───────────────────────────────┐
  └─ task-claimed/task-active → task-finished ──┤
                                                 └─ completed
```

Only intake requests whose immutable trigger is `scheduled` are eligible. Before selection,
preflight requires the scheduler switch, exact role-identity, schedule, daily-quota, and factory
policy pins, complete cost policy, and a healthy isolated worker host. Each claim durably binds the
request and authority digests, first reserves the task's complete authority budget ceiling plus one
possible draft against repository/day and organization/day ceilings, reserves the same budget
against the per-tick aggregate quota, and records a durable task correlation before any model work.
Daily reservations are append-only and never released. A crash or lost result leaves `task-active`;
retry invokes the existing journal-aware task runner with that same correlation. Duplicate ticks
read the completed slot without selecting or running work again. The single SQLite writer lease
prevents overlapping local schedulers, and database uniqueness remains the final idempotency guard.
The scheduler has no broker, remote credential, authority mutation, merge, or release capability and
stops every successful task at `pr-proposed`. AgentLab does not install a timer; an owner-governed
system timer must invoke this one-shot command with the reviewed digests. Scheduled activation
requires worker config v4, a separately reviewed daily quota policy, and a canonical role policy
that proves a non-root worker UID distinct from the eval-attestor UID before persistence is opened;
preflight rechecks and reports both policy digests, and schedule-run/event v3 persists the quota
reservation across crashes. SQLite schema 27 atomically enforces exact canary/run/repository/budget
linkage and all repository and organization UTC-day ceilings. The broker independently proves that
same reservation before scheduled remote writes. See
[ADR 0011](decisions/0011-enforced-signer-worker-identities.md) and
[ADR 0030](decisions/0030-durable-daily-aggregate-quotas.md) and
[Local factory scheduler operations](factory-operations.md).

Configuration promotion is a separate four-process boundary accepted by
[ADR 0007](decisions/0007-deterministic-evaluation-and-canary-authority.md) and
[ADR 0009](decisions/0009-isolated-eval-attestation.md), with offline evidence production defined by
[ADR 0022](decisions/0022-sandboxed-eval-evidence-production.md). The exact
`@agentlab/runtime/factory-eval-producer` composition accepts one digest-pinned immutable production
job and runs only administrator-installed baseline, challenger, and grader executables. Each exact
executable is re-hashed before use and after execution. Fixed protocols run sequentially in
no-network, empty-home bubblewrap sandboxes inside resource-bounded systemd user scopes. Fixtures,
outputs, traces, stdout/stderr, grader evidence, requests, isolation, timings, and complete usage
are content-addressed. SQLite version 19 stores the immutable job and append-only pre/post-execution
journal; a dangling active scope is never rerun and becomes terminal only after exact systemd
inactivity is confirmed. Only a complete matched matrix emits `agentlab.eval-run.v1`. The producer
has no provider secret, evaluator, signer, human authority, scheduler, broker, GitHub, merge, or
release capability, and is intentionally absent from the daily maintenance chain.

The exact `@agentlab/runtime/factory-evaluator` composition is credentialless: it ingests one strict
owner-only matched eval report from a pinned gate-runner ID, computes conservative deterministic
metrics from raw samples, and records one pass/deny assessment. Config v2 also pins one Ed25519
public key and independent freshness/lifetime limits. The evaluator can verify a canonical DSSE
in-toto statement against the exact immutable run and assessment and append one attestation record.
It has no signer, provider executor, process runner, worktree, GitHub, authority switch, merge, or
release port. The producer's run grants no authority and must traverse this evaluator boundary.

The exact `@agentlab/runtime/factory-eval-attestor` composition receives only the same strict run,
runner identity, private-key coordinate, key ID, role-identity policy, and timing bounds. It proves
the configured non-root signer UID before key access, emits one portable signed artifact, and has no
database, verifier ledger, provider, process, repository, GitHub, broker, authority, merge, release,
or canary port. Signing and verification are separate crypto modules and separate transitive
executable allowlists. A signature authenticates exact bytes and key custody; the sandboxed producer
proves recorded lineage and isolation, not that an installed harness or grader was honest. Each
predicate binds the shared role-policy digest, and the evaluator independently pins it; this
prevents a valid signer key from silently authenticating a different signer/worker deployment.

The distinct `@agentlab/runtime/factory-canary-authority` composition accepts only an exact verified
attestation digest and one strict owner-only human request. Config v2 independently pins and
re-verifies the public key, runner, timing limits, and role-identity policy before it can issue one
expiring cohort for exactly one repository, R0/R1, a bounded task count, and a complete aggregate
budget capped by the evaluated suite and attestation lifetime. The only stages are
`read-only-shadow`, `local-proposal`, and `brokered-draft-pr`; `autoMerge` and `release` are literal
`false`. SQLite version 14 atomically stores immutable run/assessment, verified-attestation, and
approval/cohort records; v2 authority directly binds the attestation and role-policy digests. Legacy
v1 authority remains readable but cannot be newly issued or consumed autonomously. No composition
runs a canary. The separate `@agentlab/runtime/factory-canary-admission` composition re-verifies an
exact v2 cohort, signature, role-policy, evaluated candidate, schedule/policy/skill pins,
repository, R0/R1 ceiling, preparation authority, and current validity before atomically reserving a
scheduled task's complete budget. SQLite version 15 makes reservations immutable and enforces
aggregate cohort task and budget ceilings inside the insert transaction. Admission has no model,
process, GitHub, broker, merge, or release capability. New schedule claims are schema-v3 events
carrying the exact canary and daily quota reservation digests. SQLite version 16 rejects missing,
mismatched, read-only, expired, or insufficient-lifetime claims and binds completion to the same
digest. The worker independently reloads and validates the reservation before every resumable
preparation or execution phase. SQLite version 27 additionally binds the quota reservation before
model work and through completion. Legacy unbound active claims cannot resume. SQLite version 17
extends the same chain through the credential boundary: every scheduled initial dispatch is schema
v2, stores the reservation plus schedule and role-policy digests, requires the exact completed
`ready-for-broker` scheduler handoff, and is revalidated before each broker checkpoint. Manual
dispatch remains schema v1. See [ADR 0012](decisions/0012-attested-canary-authority.md),
[ADR 0013](decisions/0013-durable-canary-task-admission.md),
[ADR 0014](decisions/0014-canary-bound-scheduled-execution.md),
[ADR 0015](decisions/0015-canary-bound-draft-pr-dispatch.md),
[ADR 0016](decisions/0016-bounded-canary-broker-reconciliation.md),
[ADR 0017](decisions/0017-slot-bound-canary-pr-maintenance.md),
[ADR 0018](decisions/0018-recovery-first-canary-pr-repair-consumer.md),
[ADR 0019](decisions/0019-recovery-first-canary-pr-update-consumer.md), and
[Local factory evaluation operations](factory-evaluation-operations.md).

The separate `@agentlab/runtime/factory-maintenance-discovery` composition closes scheduled intake
without widening authority. A repository-owned policy pins one provider-neutral read-only scout
skill/profile, exact budgets, R1-only maintenance classes, confidence, scope/protected paths, and
daily count ceilings. The provider receives an exact-base isolated worktree with read-only Git and
filesystem, offline tools, no secrets, one worker, and zero change/repair budget. Its strict output
is untrusted. Trusted admission independently proves every evidence/affected path is tracked at the
exact base, applies class/confidence/scope/protected/count rules, derives identity and authority,
and registers only existing scheduled preparation intake under a reviewed R1 grant. SQLite version
18 stores one immutable policy/day run and an append-only execution/finding journal. This
composition cannot reserve, execute, contact GitHub, mutate switches, merge, or release.

Canary-admission config v2 adds the exact schedule policy and a bounded consumer. While the
scheduler switch is enabled it examines at most the schedule candidate ceiling and reserves at most
the task ceiling, but every task still passes the existing independently signed, human-issued cohort
and aggregate-budget service. Daily-cycle manifest v2 pins the discovery, preparation-grant, cohort,
and candidate coordinates and prepends discovery → canary admission to the existing scheduler/broker
chain. Manifest v1 remains supported. The renderer still cannot install or enable anything. See
[ADR 0021](decisions/0021-durable-maintenance-discovery-and-canary-consumption.md).

Evidence append is not a general control-plane command. Bootstrap registers exact in-memory object
capabilities for the control plane, execution observer, gate observer, and one named PR broker. The
ingress rejects an unknown capability, cross-channel producer impersonation, a mismatched artifact,
or resource-isolation claims that do not match their canonical record, contract, policy, execution,
and cgroup identity. Untrusted workers never receive any of those capabilities.

The pre-contract boundary is explicit too. Strict canonical schemas represent raw intake,
qualification, specification, plan, task-scoped preparation authority, phase run requests/records,
an append-only preparation event chain, and a three-run preparation bundle. Every derived artifact
links the exact predecessor digest. A trusted repository grant—not request or model text—issues
authority for the exact task, request, repository/base commit, predecessor contract, active policy,
skill packages/DAG, read-only preparation profiles, execution worker profiles, include-path
allowlist, protected paths, maximum risk, capability/budget ceilings, attempt count, evidence floor,
approval roles, and validity window.

The production entry for that boundary is the separate `@agentlab/runtime/factory-intake`
composition. Its strict owner-only `agentlab.local-factory-intake.v1` config pins a durable
database, content-addressed artifact root, canonical repository root and identity, active
conversation, operator, fixed Git/flock executables, separately reviewed cost policy and preparation
grant, exact skill-package files, and authority lifetime. The owner-authored request is a separate
strict `agentlab.intake-submission.v1` document containing only `feature|bug`, a stable source
reference, title, and body. The boundary—not the request—derives UUIDs, timestamps, human actor,
current Git commit, policy digest, deduplication key, and task-scoped authority. Stable
repository/kind/source identity makes retry idempotent; changed report text or current authority
conflicts rather than silently creating or rewriting a task. Exact retries return the original
pinned base even if HEAD has since advanced.

Before registration, intake requires an active conversation whose workspace exactly matches the
configured repository, an R1-only grant supported by the credentialless worker, an exact cost rule
for every preparation and execution provider/model, and a one-to-one match between every grant
manifest and canonical skill-package digest. Packages, request, and authority are published to the
immutable artifact store; the request, authority, and first event are then inserted atomically under
the SQLite writer lease. CLI registration requires a prior policy digest and literal
`--confirm-register` for manual work or `--confirm-register-scheduled` for scheduler-eligible work;
the trigger is immutable and participates in exact-retry identity. Intake has no provider/model
adapter, GitHub credential, broker, scheduler switch, gate executor, tmux, terminal, or
interactive-runtime path; executable closure allowlists enforce that separation.

The dormant preparation application advances exactly one `qualify`, `specify`, or `plan` checkpoint
at a time through a provider-neutral execution port. Codex and Claude adapters advertise these
phases only as local, offline, no-secret, read-only work. A phase-start event and canonical run
request are durable before a worktree or provider starts. Bounded output, usage, provider session,
process isolation, canonical phase document, and run record are stored before a result event.
Invalid output, incomplete usage, excess budget, missing identity, capability mismatch, cleanup
uncertainty, replay, and artifact substitution fail closed. Retry count is authority-bound;
`needs-human`, rejection, exhaustion, cancellation, and expiry are explicit terminal outcomes. The
durable execution ID is also the exact systemd-scope and disposable-worktree identity. Every
worktree Git command holds the kernel lock on its canonical task directory, including an orphaned
child after a control-plane crash. A local Linux reconciler may append abandonment only after
repeated systemd proof that the exact scope is inactive, non-blocking acquisition of that lock,
canonical source-repository and base-commit proof, exact factory-owned workspace cleanup, and
post-cleanup proof that both process and Git/filesystem state are absent. Malformed, changing,
symlinked, overlapping, locked, or otherwise ambiguous state remains in-flight and fails closed.
Workspace creation failure and unconfirmed process-tree cleanup likewise leave the durable phase
running.

Cost admission is a domain policy boundary, not provider-adapter discretion. Factory policy bundle
v2 embeds a strict `agentlab.cost-policy.v1` rate card whose rules bind one exact provider/model
coordinate to either deterministic token rates or explicitly trusted provider-reported cost. There
is no wildcard or fallback rate. The application calls the accounting preflight before persisting a
run-start event, and the local executor repeats it before isolation or process spawn; a null/unknown
model or mismatched policy digest fails closed. Adapters return raw measurements with zero authority
over the final cost. The accountant validates usage and overwrites cost using integer micro-USD
arithmetic rounded upward. Claude accounting uses its aggregate per-model usage, including cached
input, and refuses an explicitly unknown pricing basis. Incomplete measurements or missing reported
cost remain `usageComplete=false`, which policy already rejects. Execution evidence records the
pinned policy digest, completeness, and final micro-USD amount without changing the immutable v1 run
request/record schemas.

The implementation/review path now applies the same crash invariant. One immutable execution-run
header binds the task contract, repository/base commit, correlation ID, and contract-derived attempt
ceiling. Its append-only, digest-chained journal persists an exact workspace ID before worktree
creation and an exact operation ID before every agent or deterministic gate process. Agent run
requests are canonical artifacts; gate callers—not adapters—own the isolation ID. A process result
becomes complete only after cleanup is confirmed, its canonical observation is published, and the
matching operation-finished event is appended. Worktree cleanup is positively confirmed before
attempt closure. A crash or append failure therefore leaves either no external resource or one exact
recoverable workspace/process coordinate; it can never manufacture completion. The shared Linux
reconciler checks every active journal-owned systemd scope, obtains the same non-blocking worktree
lock, verifies repository/base identity, removes only the derived workspace, and repeats absence
checks. Proven interruption becomes an append-only abandonment plus a safe terminal task transition;
uncertain host state remains active for a later recovery pass.

Draft-PR authority now has its own crash-durable boundary as well. SQLite version 8 stores one
immutable dispatch containing the exact canonical proposal and configured broker identity, followed
by an append-only chain:

```text
ready → dispatch-active → remote-open → evidence-recorded → completed
```

The proposal is durable before a branch push or GitHub API write. Recovery replays those exact bytes
and timestamps, so the deterministic commit SHA is unchanged. The GitHub adapter may reuse only the
exact derived branch head and exact matching open draft; an existing different branch, PR, base,
title, body, or head fails closed. A branch left after a crash between push and PR creation is
reused without another push, and a PR whose successful create response was lost is found through
bounded readback. The remote record, authenticated evidence bundle, and exact `pr-open` task event
are then recorded as separate checkpoints. A crash after any one of them resumes at the next
checkpoint without creating a second PR or manufacturing completion. A checkpoint that observes
broker revocation performs no new write. If revocation races an already in-flight remote call, its
exact result is journaled but the task cannot advance; the dispatch remains recoverable.

Manual dispatch uses `agentlab.pull-request-dispatch.v1`. Scheduled dispatch uses v2 and binds the
exact canary reservation, schedule policy, and role policy. SQLite version 17 rejects a scheduled v1
run or a v2 run without the matching R1 `brokered-draft-pr` reservation and completed scheduler
handoff. The broker reloads that authority before every phase, and PR evidence records its digest.
The canary broker read model derives desired work from that immutable handoff and observed progress
from the dispatch journal. Current reservations sort before expired ones; within each class,
recoverable dispatches sort before new work. Completed dispatches disappear from the projection,
while the existing five checkpoints remain the sole write-side recovery record.

Post-PR repair uses a different SQLite version 9 journal rather than reopening the terminal initial
execution journal. Its immutable header binds the authorization, observation, prior patch, task
contract, policy, repository/base, cumulative repair slot, and correlation ID. The shared execution
event vocabulary records the exact worktree plus every repairer, gate, and reviewer operation, while
database constraints allow only one run per authorization and per contract repair attempt. This
keeps initial implementation history immutable and makes authorization consumption independently
auditable.

Repaired-branch publication uses the separate SQLite version 10 update journal rather than changing
either execution journal. Its immutable header binds the exact repair authorization and repair-run
digests, repaired patch proposal/artifact, policy decision, prior PR authority-record digest and
head, repository/base/branch/PR coordinates, broker identity, repair slot, and correlation ID.
Database guards require the prerequisite repair row and contiguous completed PR-head lineage;
headers are immutable and events append-only. A completed update record becomes the sole authority
record for observation and any later repair cycle.

The supported Linux-host preflight is a distinct required `factory-sandbox` CI job. It executes the
live systemd/cgroup resource tests, memory-limit kill test, preparation and execution crash
recovery, and a Bubblewrap probe that proves the source checkout is hidden, dependencies are
read-only, the worktree remains writable, and the child occupies a distinct network namespace.
Branch protection requires this exact GitHub Actions check alongside `verify`; ordinary unit tests
do not satisfy the host proof. The credentialless ephemeral CI runner explicitly permits
unprivileged user namespaces; production hosts must meet the same Bubblewrap precondition through
their governed host configuration.

A pure compiler recanonicalizes the whole source chain. Its authority is supplied only at the
trusted construction boundary and is absent from agent output. It rejects unresolved requests or
substitutions, permits only narrowing, raises risk from the complete prospective scope, derives
gates/reviews/approvals from policy, and emits the existing immutable task contract. One SQLite
transaction creates that contract, the complete `intake → qualified → specified → planned` task
history, initial preparation evidence, deterministic `contract-validation`, `scope-validation`, and
`policy-validation` gate claims, and the preparation `prepared` marker. Those gate claims are
derived by the trusted compiler/materializer and are never accepted from model output. A late
failure rolls all of them back; a lost response can be retried idempotently. Model output never
authors identity, timestamps, digests, authority, policy, ledger events, evidence assertions, or
approvals.

Execution admission is a separate deterministic application service. It accepts only a task UUID,
loads the planned immutable contract and its active conversation, and reads the repository's current
commit through a hardened Git adapter; a caller cannot supply the revision used for policy. It
evaluates the execution stage with zero pre-execution usage and an empty change set, queues only an
allowed R1 task, and otherwise leaves the task planned with the denial recorded as evidence.
Already-queued work is idempotent. The service cannot enable scheduler or broker authority.

The worker's local configuration remains backward-compatible as an owner-only v1 document. It pins
the database, artifact/worktree roots, hardened Git tools, systemd isolation identity,
Bubblewrap/runtime mounts, the exact seven external R1 gate commands and evidence kinds, and one or
more supported provider executables by canonical path, SHA-256 digest, and exact `--version` output.
Its separately protected cost policy is loaded through the same fail-closed rate-card boundary as
broker config v2. Owner-only worker config v2 adds one canonical separately protected
`agentlab.schedule-policy.v1` file. That policy fixes the daily UTC time, bounded start deadline,
candidate and task limits, and aggregate reservation ceiling for one tick; it contains no command,
credential, merge, or release field. Provider resolution rechecks file identity/digest and version
for each use under a fixed environment that contains no GitHub, package-registry, or cloud
credential variables. The schema has no GitHub App, remote-repository, or authority-control field,
and the sandbox refuses `/` as a runtime mount.

The worker path is now composed only through the separate `@agentlab/runtime/factory-worker`
subpath; it is not reachable from `local-runtime.ts`. No live v2 config, schedule policy, timer, or
scheduler authority is provisioned, deployed, or enabled. Its read-only host preflight revalidates
canonical executable and runtime paths, owner-only artifact/worktree roots, exact systemd/provider
identities, credentialless fixed-argv probes, cost readiness, user-manager reachability, the
schedule-policy digest, and the observed scheduler switch. A maximum of 32 admitted commands execute
serially against one SQLite writer lease. Recovery remains callable when normal work is cost- or
host-blocked, and close drains admitted work and proves process cleanup before repositories and the
lease are released. The port exposes no intake-authority issuer, control switch, GitHub adapter, or
broker credential. An explicit policy-pinned `worker-run` command can resume one already registered
task through those existing services and stops at broker readiness; it does not enable the scheduler
or perform a remote write. The authorization-bound `worker-repair-pr` command uses the same closure
for one fresh post-PR attempt, repeats the gate/review floor, and stops at a new local proposal. A
separate broker composition, owner-only key source, readiness command, and explicit draft-only
command also exist. The isolated human authority composition and non-interactive CLI can change only
the scheduler, PR-broker, or merge-broker switch through distinct compare-and-set methods; the
normal TUI cannot invoke factory authority, worker, or broker commands. Current branch protection
requires exact `verify` and `factory-sandbox` checks, dismisses stale reviews, enforces
administrators, and forbids force-push and deletion. It still has zero required approvals, does not
require approval of the latest push, and has neither a CODEOWNERS policy nor required code-owner
review. Preflight therefore reports blocked for those controls and `cost-policy-unconfigured`. The
cost-accounting mechanism exists, but the repository ships no live config or provider/model rates.
Config v5 can additionally pin the autonomous-merge policy and compiled factory-policy v3 digest
from worker through PR broker, credentialless admission, and the separate merger; actual rates,
authority config, and broker/merger-key provisioning remain activation prerequisites. An incomplete
usage record already denies PR creation, and each explicit write command refuses a blocked preflight
or unexpected policy digest. Governed intake is implemented but no live intake configuration or task
has been provisioned. No live agent task or PR has been created by this code. Bounded PR-head
observation and durable feedback evidence plus deterministic repair admission and fresh
credentialless repair execution are implemented. Brokered repaired-branch update, crash
reconciliation, authenticated head-lineage advancement, and re-observation are implemented. A
bounded daily-slot consumer joins scheduled canary PRs to authenticated observations and
deterministic repair admission, and a recovery-first credentialless consumer now turns exact
authorizations into gated local repair proposals. A separate recovery-first broker consumer
publishes those proposals through the existing durable non-force update service and returns them to
exact-head observation. Durable bounded daily maintenance discovery, automatic consumption of
pre-existing human cohort authority, and a separate offline sandboxed eval producer are implemented.
A separate bounded external pull-request inventory now journals stable heads and changed paths with
a read-only App. A separate credentialless consumer can reconstruct exact locally present patches,
run independent reviewed skills in isolated provider sessions, and journal complete local review
evidence, but it cannot fetch, approve, repair, push, merge, or release. A third, feedback-only
broker can publish an exact completed bundle as deterministic `COMMENT` feedback and reconcile an
uncertain write without granting approval, repair, branch mutation, merge, or release authority. A
fourth credentialless plane can make a bounded immutable repair-admission decision from that
completed feedback. A fifth credentialless plane consumes that exact selectors-only authorization
once and records a bounded local patch bundle after closing its isolated workspace. Strict
post-repair gates and independent review are implemented in a sixth credentialless plane; a seventh
separately credentialed plane can publish only qualified repairs as contributor-safe replacement
drafts. None of the external-PR stages is part of the daily chain or provisioned with live policy,
skills, rates, object mirroring, or accounts. The eval producer has no provisioned harness, fixture,
candidate, job, or account. Host-local repository/day and organization/day quotas are implemented in
the shared SQLite control plane; cross-host/global coordination, a secretless hosted-provider eval
gateway, owner-provisioned activation, telemetry-driven canary comparison, release, deployment,
rollback, alert delivery, and incident coordination remain later stages. A credentialless
merge-admission plane can issue one short-lived authorization only for a scheduled R1 task whose
immutable contract opted into automatic merge and whose latest exact-head observation proves the
policy-bound trusted checks and independent-review floor. A separate merger UID and
selected-repository GitHub App can mark that exact draft ready and enqueue its exact head through
GitHub's merge queue. It has no direct-merge or release operation, persists intent before each
remote mutation, reconciles ambiguous outcomes, and records exact merge readback before
transitioning the task to `merged`.

The separated-UID deployment has a confirmed storage handoff blocker. `openSqliteDatabase` and its
writer lease chmod their files to `0600`; the artifact store chmods directories to `0700`. A second
UID cannot open these stores, and broadening a disposable database's mode still fails its mandatory
ownership-only chmod. This is not solved by the documented provisioning step. Existing same-user
service integration and systemd unit verification do not exercise this cross-UID handoff. Keep the
daily factory disabled until an authenticated storage-authority boundary replaces direct shared
access. [ADR 0034](decisions/0034-single-owner-factory-ledger-boundary.md) accepts a single-owner
service. The implemented `factory-ledger` and `factory-ledger-client` public entries support
expiring UID-authorized authority/task reads, with strict policy and immutable identity checks.
Config v2 and the separate `factory-ledger-operator` entry add explicitly granted operator switch
changes with a 120-second command ceiling, exact event-digest CAS, and atomic append-only receipts.
Expired commands can be reconciled without mutation through a separately authorized receipt query.
Positive real cross-UID tests prove those reads and reject direct storage access and forged
mutations; transport tests bound frames, deadlines, shutdown, and peer identity. Source-graph rules
exclude provider/GitHub/arbitrary-command capabilities from the owner and persistence from clients.
Config v3 and the storage-free `factory-ledger-artifacts` entry transfer digest-verified bytes using
separate producer/reader grants. Submissions bind the active task and execution operation, both
policy pins, a short deadline, and an immutable idempotency key. Schema 33 reserves task/global byte
and object quotas before publication; interrupted reservations remain charged and reconcile without
accepting new evidence authority. Files and publication directories are synchronized before storage
is acknowledged. Existing canonical evidence can authorize task-scoped reads. This does not yet move
task mutations, worker execution, or broker intents behind the service. The optional Linux transport
requires a pinned isolated Python installation and owner-controlled filesystem provisioning; see the
ADR for its limits and activation criteria.

An internal operation-worker adapter stages the next execution boundary. Strict canonical job
documents bind task/run/operation, assigned role, policies, exact base/seed patch, provider or named
gate, and limits. Each operation reconstructs a fresh private worktree; reviews and gates cannot
change its candidate. Result claims are returned only after verified identity checks and workspace
closure. Uncertain process or construction cleanup blocks new work until exact recovery succeeds.
Installed gate limits can be narrowed by a job, never widened. Real-worktree tests cover this
executor with injected process outputs; durable remote claims and the orchestration bridge are still
absent. Nothing composes this adapter into the interactive product or enables factory work.

The read-only daily-cycle compiler accepts v4/v5 owner-only manifests and verifies reviewed policy
digests, including daily aggregate quotas, operations health, and autonomous merge, plus the
AgentLab executable digest; distinct worker, PR-broker, merger, incident-controller, and attestor
UIDs; repair ceilings; and timeouts. It emits a content-addressed system-level systemd bundle whose
non-persistent UTC timer chains fixed-argv one-shot services across separate UIDs, begins with
disable-only containment, stops on any nonzero result, performs a final exact-head observation, then
runs merge admission and the merger. Every stage first runs fixed `/usr/bin/sha256sum` argv against
the generated exact executable check record, so binary drift stops before AgentLab runs. The
renderer cannot write or install artifacts, call the service manager, change authority, or touch the
ledger. The scheduled R1 service logic through queue-backed merge exists, but its cross-UID storage
handoff is broken and the deployment is unprovisioned, disabled by default, and unactivated; release
and deployment remain outside it.

The separate `@agentlab/runtime/factory-operations-health` composition opens that ledger with SQLite
read-only and `query_only`, pins strict owner-reviewed health and daily-quota policies, and
revalidates canonical control, schedule, task, and quota documents against materialized columns. It
emits one content-addressed healthy/degraded/critical report covering authority state, recent/open
schedules, recent/active tasks, and current UTC-day quota utilization. Its architecture closure has
no writer lease, agent/provider, GitHub, authority mutation, worker, broker, terminal, tmux, merge,
release, deployment, rollback, or incident port. No monitor unit, alert delivery, automatic
containment, or report archive is provisioned.

The separate `@agentlab/runtime/factory-incident-containment` composition retains the query-only
health source but adds only a disable-only incident repository under an isolated reviewed UID. It
recomputes health internally. On critical health, SQLite schema 31 compare-and-disables merge
broker, PR broker, then scheduler inside one transaction and appends the canonical report,
containment record, and three control-event digest bindings. It cannot accept an external report and
has no enable, provider, GitHub, model, release, or deployment port. Daily-cycle v5 runs this
command first; degraded or critical exit codes stop the chain. The command and rendered units remain
dormant and unprovisioned.

The merge boundary is exposed only through `@agentlab/runtime/factory-autonomous-merge-admission`
and `@agentlab/runtime/factory-autonomous-merger`. The first has local policy/evidence authority but
no remote credential. The second owns only merge-queue reconciliation and an ephemeral dedicated App
token; it has no provider or worker executor. SQLite schemas 29–31 keep merge authority, run, event,
authorization, and result material append-only and cross-bound to canonical digests. See
[ADR 0033](decisions/0033-policy-bound-autonomous-r1-merge-queue.md).

## Dependency map

Arrows are compile-time dependencies. Runtime control flow may travel in the opposite direction
through an injected port.

```text
interactive TUI ──▶ @agentlab/runtime ───────────────▶ local-runtime composition
intake operator ───▶ @agentlab/runtime/factory-intake ▶ local-factory-intake composition
broker preflight ─▶ @agentlab/runtime/factory-broker ▶ local-factory-broker composition
worker operator ───▶ @agentlab/runtime/factory-worker ▶ local-factory-worker composition
human operator ────▶ @agentlab/runtime/factory-authority ▶ local-factory-authority composition
eval producer ──────▶ @agentlab/runtime/factory-eval-producer ▶ local-factory-eval-producer composition
eval runner ────────▶ @agentlab/runtime/factory-evaluator ▶ local-factory-evaluator composition
eval signer ────────▶ @agentlab/runtime/factory-eval-attestor ▶ local-factory-eval-attestor composition
release controller ▶ @agentlab/runtime/factory-canary-authority ▶ local-factory-canary-authority composition
canary admission ───▶ @agentlab/runtime/factory-canary-admission ▶ local-factory-canary-admission composition
incident controller ▶ @agentlab/runtime/factory-incident-containment ▶ disable-only containment composition
merge admission ─────▶ @agentlab/runtime/factory-autonomous-merge-admission ▶ credentialless exact-head admission
merge broker ────────▶ @agentlab/runtime/factory-autonomous-merger ▶ merge-queue-only GitHub composition
maintenance scout ──▶ @agentlab/runtime/factory-maintenance-discovery ▶ local-factory-maintenance-discovery composition
external PR reader ──▶ @agentlab/runtime/factory-external-pull-request-discovery ▶ read-only discovery composition
external PR reviewer ▶ @agentlab/runtime/factory-external-pull-request-review ▶ credentialless review composition
external PR feedback ▶ @agentlab/runtime/factory-external-pull-request-feedback ▶ feedback-only publisher composition
external PR admission ▶ @agentlab/runtime/factory-external-pull-request-repair-admission ▶ deterministic admission composition
external PR repairer ▶ @agentlab/runtime/factory-external-pull-request-repair-execution ▶ credentialless repair composition
unit renderer ─────▶ @agentlab/runtime/factory-orchestration ▶ local-factory-orchestration compiler
                                                         │              │
                                                         ▼              ▼
                                                   application     infrastructure
                                                         └────▶ domain ◀────┘
                                                                 │
                                                                 ▼
                                                             contracts

launcher (distribution only; independent source graph)
```

| Area                      | Owns                                                                                                             | May depend on workspace areas                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `packages/contracts`      | Zod schemas and stable shared data shapes                                                                        | contracts                                      |
| `runtime/domain`          | Invariants, value objects, errors, and ports                                                                     | domain, contracts                              |
| `runtime/application`     | Typed use cases, validated commands, coordination, ownership                                                     | application, domain, contracts                 |
| `runtime/infrastructure`  | SQLite, filesystem, provider, process, tmux, and PTY adapters                                                    | infrastructure, domain, contracts              |
| runtime composition roots | Interactive, intake, worker, eval producer/evaluator, admission, authorities, broker, and dormant unit rendering | runtime layers, contracts                      |
| `apps/tui`                | Rendering, input, dialogs, and bounded CLI presentation                                                          | TUI, contracts, registered runtime public APIs |
| `packages/launcher`       | Binary acquisition, verification, and process handoff                                                            | launcher                                       |

The product-source rules are executable and fail closed:

- Cross-package imports use declared package entry points, never relative paths or deep package
  imports.
- Domain and application code cannot import outward into infrastructure or presentation.
- Infrastructure implements domain ports and cannot depend on application use cases.
- TUI and CLI code see runtime modules only through registered package entry points. The intake,
  broker, worker, eval-producer, evaluator, eval-attestor, switch-authority, canary-authority,
  canary-admission, incident-containment, autonomous-merge-admission, autonomous-merger,
  maintenance-discovery, and orchestration-renderer subpaths are exact; every runtime deep import
  fails.
- The broker composition closure cannot reach provider, tmux, terminal, or interactive-composition
  modules. The worker closure can reach only its explicit pinned factory-provider allowlist and
  cannot reach GitHub, broker, tmux, terminal, dynamic discovery, or interactive composition. The
  interactive closure cannot reach any factory composition or GitHub authority modules. The human
  authority closure has an explicit application/infrastructure allowlist and cannot reach remote,
  model, process-execution, worker, broker, tmux, terminal, or interactive capabilities.
- Autonomous merge admission and merger have disjoint exact allowlists. Admission may read canonical
  task, policy, reservation, PR-lineage, and evidence state but has no GitHub credential or remote
  adapter. The merger may reach only its merge journal, evidence publisher, fixed GitHub App token
  source, and merge-queue adapter; it cannot reach providers, workers, direct merge, release, tmux,
  terminal, or the interactive runtime.
- Intake has its own exact allowlist and can reach only local persistence, immutable artifacts, and
  fixed-argv Git revision observation—not providers, gates, GitHub, broker, or control mutation.
- Eval-producer, evaluator, eval-attestor, canary-authority, and canary-admission closures have
  separate exact allowlists. The producer may reach only its offline sandbox/process, artifact, and
  production-ledger adapters; it cannot reach providers, secrets, evaluation/signing/authority,
  scheduler, broker, GitHub, merge, release, tmux, terminal, or interactive modules. The remaining
  promotion closures cannot reach provider or process execution. The evaluator cannot reach signing
  or human canary issuance; the attestor cannot reach the evaluator, SQLite, or any authority.
  Canary admission cannot issue human authority or execute the task it reserves.
- Maintenance discovery has its own exact allowlist. It may reuse read-only provider, isolated
  worktree, immutable artifact, scheduled-intake, and policy modules, but cannot reach the execution
  worker composition, broker/GitHub, human authority, merge/release, terminal, tmux, or interactive
  runtime.
- External PR discovery, review, feedback, repair admission, repair execution, and repair
  qualification each have separate closed allowlists. Discovery can only read GitHub, review can run
  pinned credentialless providers against local objects, and feedback can only read the exact PR and
  submit a comment review through its dedicated App. Admission can only read completed local
  evidence and write a bounded selectors-only capability. Repair execution can run one
  workspace-writing provider against authenticated local objects but has no credential or remote
  port and emits only a closed-workspace patch bundle. Qualification can run only the pinned offline
  gate floor and read-only independent reviewers over that exact bundle. No one closure can combine
  model execution, a credential, remote branch mutation, merge, or release authority.
- The product source graph must remain acyclic.
- The root workspace manifest inventories every workspace. A checked architecture registry must
  classify every workspace manifest and production source root exactly once; unknown roots,
  symlinked workspace entries, and symbolic links inside production roots fail.
- Manifest dependencies, public exports, source imports, and the dependency graph must agree.
- Each layer has an explicit external-capability allowlist. Server frameworks are forbidden in all
  current product layers.
- Unsupported, reflective, computed, or non-static loader forms fail instead of disappearing from
  the graph. Ambiguous computed `Object`/`Reflect` access and the `node:vm`/`vm` code-generation
  modules fail closed. Triple-slash references and string-literal module augmentations are edges
  too. Inner-layer runtime globals such as process, Bun, timers, network APIs, randomness, and wall
  clocks are rejected even when aliasing, computed access, or ambient declarations hide their
  spelling.
- Bun-test discovery is recursive without a count threshold and rejects symbolic links in included
  test-bearing trees; generated, vendor, fixture, and duplicate tool-alias trees are explicit
  exclusions.

`npm run architecture:check` parses TypeScript imports and exports, checks those rules, and runs
inside `npm run verify`. ESLint independently reinforces inner-layer restrictions. `scripts/**` and
`tests/**` are explicit outer tooling/test scopes, not product layers; their narrow exclusions can
never exclude workspace production source.

## Placement guide

| Change                                                       | Location                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Shared external input or persisted data shape                | `packages/contracts`                                                           |
| Pure invariant, identity, value, error, or adapter interface | `packages/runtime/src/domain`                                                  |
| Product use case or coordination policy                      | `packages/runtime/src/application`                                             |
| Operating-system, database, tmux, PTY, or provider behavior  | `packages/runtime/src/infrastructure`                                          |
| Interactive object construction and resource lifetime        | `packages/runtime/src/local-runtime.ts`                                        |
| Broker-only object construction and resource lifetime        | `packages/runtime/src/local-factory-broker.ts`                                 |
| Worker-only object construction and resource lifetime        | `packages/runtime/src/local-factory-worker.ts`                                 |
| Human control construction and resource lifetime             | `packages/runtime/src/local-factory-authority.ts`                              |
| Intake-only object construction and resource lifetime        | `packages/runtime/src/local-factory-intake.ts`                                 |
| Eval-only object construction and resource lifetime          | `packages/runtime/src/local-factory-evaluator.ts`                              |
| Eval-production object construction and resource lifetime    | `packages/runtime/src/local-factory-eval-producer.ts`                          |
| Eval-signing object construction and resource lifetime       | `packages/runtime/src/local-factory-eval-attestor.ts`                          |
| Human canary construction and resource lifetime              | `packages/runtime/src/local-factory-canary-authority.ts`                       |
| Canary admission construction and resource lifetime          | `packages/runtime/src/local-factory-canary-admission.ts`                       |
| Maintenance discovery construction and resource lifetime     | `packages/runtime/src/local-factory-maintenance-discovery.ts`                  |
| External PR review construction and resource lifetime        | `packages/runtime/src/local-factory-external-pull-request-review.ts`           |
| External PR feedback construction and resource lifetime      | `packages/runtime/src/local-factory-external-pull-request-feedback.ts`         |
| External PR admission construction and resource lifetime     | `packages/runtime/src/local-factory-external-pull-request-repair-admission.ts` |
| External PR repair construction and resource lifetime        | `packages/runtime/src/local-factory-external-pull-request-repair-execution.ts` |
| Terminal rendering, input, or interaction state              | `apps/tui`                                                                     |
| Installer, cache, or binary handoff                          | `packages/launcher`                                                            |

Supported providers are a deliberately closed compile-time set. Provider neutrality means native
launch/capability adapters behind stable ports, not runtime plugins or a flattened provider-session
protocol. Adding a supported provider requires compatible contract/persistence registration plus
infrastructure adapters, but must not add provider conditionals to lifecycle rules. Presentation
uses capability data rather than provider-ID switches. New presentation surfaces call the validated
command port and must not reach into concrete adapters.

## Terminal ownership

Tmux is the durable session store. It retains each agent's pane and terminal history even while the
UI is closed. The center pane owns exactly one ephemeral PTY client:

1. Selection resolves to a strictly managed session owned by the selected project conversation.
2. The runtime validates the conversation ID, exact session name, saved folder, terminal dimensions,
   and ownership mode. It resolves that name once to a target containing tmux's session ID, server
   PID/start generation, exact resolved name, and expected ownership. For a nonce row it proves the
   nonce against that target.
3. The runtime reads up to 20,000 retained tmux lines through a tmux-side generation/ownership
   guard, then re-resolves and proves the same target immediately before PTY creation. The PTY runs
   a guarded `attach-session` action in the same tmux server command. Name reuse or a restarted
   server reusing `$0` cannot redirect history, destruction, or attachment to a foreign session.
4. Live PTY events are buffered behind a 1 MiB pre-release cap until a fresh native VT parser has
   replayed the older history, then released in arrival order. An overrun closes only the ephemeral
   client and invites a clean reattach from tmux instead of replaying a partial escape stream.
5. OpenTUI forwards input bytes unchanged, including split UTF-8 and arbitrary control bytes, plus
   resize events, paste, mouse selection, ANSI state, and cursor state.
6. Changing selection or closing the UI kills only the client PTY. The tmux session stays alive.

The selected panel owns normal attachment replacement; the runtime registers each spawned PTY before
fallible listener setup, and adapters register any child created before their own validation can
fail. Process shutdown therefore closes even a partially constructed client. A close is confirmed
only after the tmux client process exits; a failed signal or ambiguous exit remains owned and
retryable, so it cannot permit early writer-lease release. Pre-listener PTY output, ordered
pre-release output, the ingestion pump, and terminal scrollback all have explicit byte bounds. Any
pre-listener overflow discards the whole buffered stream and closes the ephemeral client rather than
replaying an ANSI suffix. OpenTUI receives a 16 MiB scrollback byte budget; unlike tmux's separate
20,000-line history limit, the number of retained emulator lines varies with their encoded content.
During replacement, React keys the native terminal by conversation and session, so the new
attachment cannot inherit the old VT, selection, cursor, or mouse state. History and live output are
drained in order and one full invalidation follows history seeding. UI polling stores session
snapshots under their conversation ID, so returning to a project immediately restores its agent list
and late responses cannot display another conversation's agents. Metadata-only polling changes do
not reopen the PTY.

Target-aware terminal factory and history ports are the supported extension seam for nonce-owned
sessions. The original name-only hooks remain source-compatible solely for migrated `legacy-name`
rows; they reject nonce-owned targets before invoking user code because a name cannot preserve the
resolved runtime ID, server generation, and nonce proof.

Runtime commands share an admission gate. Every spawned command tree, provider control process/SDK
query, and PTY is registered immediately with one retryable runtime resource owner. Shutdown stops
new work and retains ownership of initialization, reconciliation, queries, provider discovery,
terminal opening, and mutations until each settles or its adapter confirms cancellation and cleanup.
One eventual finalizer then attempts all runtime-resource and SQLite cleanup even when an earlier
independent cleanup fails. It releases the writer lease only after every admitted operation is
settled or cancelled, every registered resource is confirmed closed, and the repository closes. A
caller deadline may stop waiting but does not poison or revoke ownership. Concurrent and successful
closes share their result; failed or ambiguous members and phases retain the lease and remain
retryable by a later `close()`.

## Durable lifecycle and writer ownership

SQLite and tmux are coordinated by the persisted state machine in
[ADR 0005](decisions/0005-durable-local-runtime-lifecycle.md):

```text
creating ──▶ active ──▶ deleting ──▶ removed
legacy-unlinked ──────▶ deleting
```

Only `active` admits provider/session queries, attachment, or worker creation. Normal listing
returns active projects and removable legacy rows. Pending rows are reconciled before command
admission; a failed recovery keeps the row non-active and fails startup with an actionable
diagnostic.

A `creating` row persists an unpredictable nonce before tmux work. `new-session` associates that
nonce atomically with the exact captain and returns the created session ID/server generation in the
same command. Every configuration, respawn, compensation, history, kill, and attach action carries
that target through a tmux-side generation/ownership guard. For these new nonce-owned projects, both
captain policy and AgentLab's explicit worker command stamp the same nonce atomically on every
worker they create. In-process captain cleanup also requires `createdHere`. Creation recovery uses
one ownership-bearing tmux inventory snapshot for the exact captain and every parsed worker in the
conversation. It removes the reservation only when a second coherent snapshot confirms the entire
owned set absent, cleans only nonce-matching sessions, and retains `creating` on a missing,
mismatched, or ambiguous proof. Extra captain-shaped sessions are unowned: never shown, attached, or
automatically killed. Public deletion never admits `creating`. Deletion marks `deleting` before
stopping parsed workers and the exact persisted captain: nonce-bearing rows require a matching
nonce, while only migrated pre-nonce active or legacy-unlinked rows retain an explicit exact-name
compatibility cleanup path.

Ownership mode is persisted, not inferred: newly created rows are `nonce`; rows migrated from a
pre-nonce release are `legacy-name`, retain a null nonce through deletion, and are never upgraded in
place. A migrated active project and its already-running captain continue creating and cleaning
workers by exact managed identity. Recreating the project is the deliberate path to nonce ownership.
Inventories are capped at 128 managed sessions per conversation, and destructive cleanup runs at
most eight tmux processes concurrently. For nonce-owned projects, every session-consuming
operation—listing, attachment, explicit worker deletion, conversation deletion, and
recovery—requires exact managed identity plus the matching session nonce at the final boundary.
Missing/mismatched sessions are filtered or rejected and never stopped. Legacy-name projects retain
only their explicit exact-identity compatibility behavior.

Startup first verifies that the host has tmux 3.2 or newer, the oldest release supporting the atomic
`new-session -e` ownership stamp. One canonical database target then owns one sidecar SQLite writer
lease. It is acquired before main database migration or any session/PTY side effect and released
last. Relative and symlink aliases resolve to the same lease; ambiguous URI or hard-linked targets
are rejected. The dedicated lease transaction never touches or blocks the application database.

The repository accepts only nonce-owned `creating` reservations from product code and only the legal
`creating → active`, `active → deleting`, and `legacy-unlinked → deleting` compare-and-set edges.
SQLite uses `UPDATE … RETURNING` so a committed transition is its returned record rather than a
second fallible read. Migration remains the only source of legacy-name authority.

## Project creation

1. Startup lists saved projects but deliberately selects none; neither the current directory nor a
   CLI argument can become an implicit project.
2. The local command boundary validates the user-entered folder path, project name, provider, and
   nullable model/thinking selections.
3. The filesystem adapter expands `~/…`, resolves relative paths, requires an existing directory,
   and returns its canonical path. SQLite uniqueness allows only one project per canonical folder.
4. Provider capabilities are discovered in that exact folder and explicit selections are checked;
   null keeps the provider default.
5. A provider launcher builds an argument vector for an interactive captain. An initial task is not
   required.
6. SQLite reserves a `creating` row containing the exact captain identity and ownership nonce.
7. Tmux atomically creates the nonce-stamped session, configures it, then starts the real provider
   CLI.
8. SQLite compare-and-sets the row to `active`; only that record is returned to presentation.

If activation fails after launch, only the exact captain and parsed workers with the matching nonce
are removed, and the reservation disappears only after that entire set is confirmed absent. Any
incomplete or conflicting cleanup remains journaled for fail-closed startup recovery. If an active
captain exits quickly, `remain-on-exit` preserves its pane and output for inspection.

## Worker lifecycle

Explicit worker creation validates a friendly name, provider, and initial task. It generates a
strict identity owned by the conversation:

```text
agentlab__<conversation-uuid>__worker__<provider>__<slug>
```

For a `nonce` row, the application loads the active conversation's persisted ownership nonce and
stamps it in the same atomic `new-session` operation. Captain policy does the same through a fixed
quoted environment variable, so every new worker has identical deletion/recovery proof regardless of
creation path. A migrated `legacy-name` active row preserves exact-identity worker creation for both
paths because its already-running captain cannot safely receive a new environment or policy.

Deletion parses that identity, proves it is a worker in the selected conversation, confirms the
session still exists and, for a `nonce` row, carries the conversation nonce, and stops only that
exact tmux session. `legacy-name` rows use the explicit exact-identity compatibility rule in
ADR 0005. Captains are rejected at the application boundary and never offered as an independent
deletion target.

Whole-project deletion first persists `deleting`, confirms the captain stopped, cleans authorized
workers, and then re-enumerates the raw conversation worker set. The row is removed only after one
complete post-captain inventory is unambiguously empty; a late worker, ownership conflict, or
ambiguous result retains `deleting` for recovery.

Workers are temporary leases owned by their conversation's captain. Only the captain has enough
context to determine whether a quiet agent is finished, blocked, or awaiting a follow-up, so the
runtime does not infer completion from idle time or process activity.

## Provider capability discovery

Model metadata is obtained from each installed CLI without starting an agent turn:

- Codex uses app-server's machine-readable `model/list` protocol.
- Claude uses the official Agent SDK control channel's `supportedModels()` metadata with empty
  streaming input.
- OpenCode uses bounded parsing of `models --verbose`. Provider variants that cannot be selected by
  its persistent root TUI are deliberately not exposed.

Discovery runs in the selected project folder. Output size, JSON depth, record counts, and timeouts
are bounded. One total catalog deadline covers executable location, version probing, live model
discovery, and each adapter's bounded cleanup facade. Uncancellable filesystem discovery may outlive
the caller's bounded response, but the runtime continues owning that raw operation and shutdown
drains it before persistence closes. Spawned command trees and Codex app-servers have separate
immediate resource ownership. Claude injects the SDK's supported spawn hook and owns the actual CLI
process tree; SDK `return()` remains protocol cleanup rather than exit evidence. Cleanup failure or
a facade timeout therefore cannot release the writer lease and remains retryable. Cache entries are
isolated by provider, workspace, executable, and CLI version. Concurrent requests share a probe. A
failed refresh uses last-known-good metadata only for the exact key; without a catalog, an installed
provider remains available in provider-default-only mode.

Provider-default model and reasoning are represented by null and omit CLI flags. Launchers receive
only validated values. Every process is started with an argument array; only the tested tmux
command-string boundary applies POSIX quoting.

Captain policy uses each CLI's native high-priority instruction mechanism. OpenCode receives an
inline primary-agent configuration through its environment. Instruction text contains no raw
workspace or executable path: it references fixed, quoted variables such as `"$AGENTLAB_WORKSPACE"`,
whose values cross the tested tmux quoting boundary as single environment values. When an initial
objective is supplied, it remains a separate `--prompt` user message; user text is never
concatenated into the captain's system prompt. Prompt policy is not treated as a security sandbox.

## Persistence

SQLite stores app-owned project metadata: name, canonical folder, captain configuration, managed
session identity, lifecycle state, ownership mode, and creation ownership nonce. Provider
transcripts and credentials remain in provider-owned storage; tmux owns live output and terminal
state. The normal database is `$XDG_DATA_HOME/agentlab/agentlab.sqlite` (falling back to
`~/.local/share/agentlab/agentlab.sqlite`).

Explicit `AGENTLAB_DATABASE_PATH` wins and may reference an ordinary local-filesystem database.
Relative and symlink spellings are canonicalized; SQLite URI targets and existing hard-linked
targets are rejected before side effects.

## Performance model

- OpenTUI performs native framebuffer rendering and VT parsing.
- Bun provides the native PTY and compiles the distribution into one executable.
- The renderer targets 30 FPS, may render up to 60 FPS, and uses a render thread.
- OpenTUI and provider adapters load only for an interactive run; help/version stay lightweight.
- Only the selected agent produces live PTY traffic.
- Session polling waits for each request before scheduling the next, ignores superseded responses,
  avoids state updates when the snapshot did not change, and caches snapshots per conversation.
- The embedded terminal consumes the full center layout, deduplicates resize events, and recolors
  only OpenTUI's resolved black/white defaults to the shared workspace surface; colored ANSI cells
  remain native.
- A focused test feeds at least 5 MiB of ANSI output and enforces a conservative 2 MiB/s floor.
- Layouts below 90×18 show an explicit resize state instead of corrupting the three panes.

## Trust boundaries

- No network listener exists.
- Zod validates local command input and terminal dimensions; the filesystem boundary canonicalizes
  and verifies every selected project folder.
- Managed session names are generated or strictly parsed before tmux access.
- Persisted captain identities are revalidated against row conversation/provider ownership before
  any process action.
- Child processes use argument arrays; the one tmux shell boundary quotes every executable,
  argument, and environment value.
- Pre-listener PTY output and terminal scrollback have fixed bounds.
- Live terminal output cannot overtake retained history, and terminal input remains raw bytes until
  Bun writes it to the PTY.
- Shutdown rejects new application work and owns every admitted operation through settlement or
  confirmed cancellation before closing persistence.
- Provider authentication remains owned by installed CLIs.

## Compatibility and delivery invariants

Compatibility surfaces include the `@agentlab/runtime` export map, names, and signatures;
append-only SQLite migrations; managed-session grammar; persisted provider IDs; documented
`AGENTLAB_*` variables; launcher/native CLI behavior and exit semantics; and release-manifest/cache
formats. Shipped migrations are never edited. Historical rows and managed sessions remain readable
until an explicit migration/deprecation decision says otherwise.

Architecture work must preserve the aggregate CI check identity, release targets and asset names,
annotated-tag-on-main validation, checksums, SBOM/provenance attestations, immutable GitHub release,
OIDC trusted npm publication, byte-for-byte candidate comparison, and release recovery verification.
Release-control changes require separate review.

Interactive application smoke tests are an isolated release boundary. Before either the source TUI
or newly compiled application is executed, the harness creates one canonical owner-only disposable
root and pins its home, temporary, XDG data/config/state/cache/runtime, AgentLab database/cache, and
tmux socket paths below that root. The child receives only an allowlist of non-secret host
variables; provider credentials, provider executable overrides, ambient AgentLab overrides, and an
existing `TMUX` identity never cross the boundary. Every interactive-runtime smoke subprocess uses
that exact environment, and the root is removed after success or failure. See
[ADR 0008](decisions/0008-isolated-runtime-smokes.md).

## Architecture acceptance

The architecture is releasable only when automated tests prove:

- exhaustive workspace/manifest/tsconfig/source classification (including declarations), alias-free
  and symlink-free ownership, external-capability policy, public entries, exact public key presence,
  exact public parameter/return signatures, computed/destructured/reflective loader rejection, and
  real cycle diagnostics;
- exhaustive discovery of every repository-owned Bun test, including co-located workspace tests,
  with only explicit generated/vendor/fixture trees excluded;
- every supported historical schema migrates without data loss;
- the `new-session`/activation crash window is recovered only with exact matching ownership proof;
- unowned extra captains are neither presented nor destroyed;
- canonical/relative/symlink database aliases contend on one lease, process exit releases it, and
  ambiguous URI/hard-link targets fail before side effects;
- adversarial raw paths never appear in captain instruction text and remain one quoted environment
  value at the tmux boundary;
- a caller deadline cannot cancel or poison eventual all-operation drain and cleanup;
- failed or timed-out command, provider-query, and PTY cleanup stays owned, blocks lease release,
  and succeeds only after a confirmed retry; and
- interactive runtime smokes confine every writable path below a disposable private root and do not
  inherit operator credentials, database overrides, or tmux identity; and
- formatting, strict types, lint, unit/component tests, real tmux/Bun PTY integration, production
  build, packaging, dependency audit, and release metadata all pass.
