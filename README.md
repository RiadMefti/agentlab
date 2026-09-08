# AgentLab

[![CI](https://github.com/RiadMefti/agentlab/actions/workflows/ci.yml/badge.svg)](https://github.com/RiadMefti/agentlab/actions/workflows/ci.yml)
[![Release](https://github.com/RiadMefti/agentlab/actions/workflows/release.yml/badge.svg)](https://github.com/RiadMefti/agentlab/actions/workflows/release.yml)

**One captain per project folder, with all your coding agents in one fast local terminal.**

AgentLab runs Codex, Claude Code, and OpenCode as their real CLIs. They keep their existing
authentication, configuration, tools, and context. Each saved project is a named local folder with
exactly one captain. The captain may coordinate any number of workers, and every live session
remains directly accessible.

```text
┌─ PROJECTS ───────┬─ SELECTED AGENT TERMINAL ───────────────┬─ AGENTS ─────────┐
│ named folders    │ full ANSI/PTY interaction               │ CAPTAIN (pinned) │
│                  │                                         │ WORKERS           │
└──────────────────┴─────────────────────────────────────────┴───────────────────┘
```

There is no web server, browser UI, Electron shell, or remote mode. The application is a
single-process terminal compositor that calls the local application layer directly. tmux owns the
durable sessions; the UI attaches exactly one PTY to the selected agent.

## Install

Install the single public package, then start the app from anywhere:

```bash
npm install --global agentlab
agentlab
```

The npm package downloads the matching AgentLab executable from GitHub on first use, shows live
download progress, and caches it by version. Later launches use the cached executable and make no
update request. Updates are always explicit:

```bash
agentlab update --check
agentlab update
```

You can alternatively download an executable from the
[latest GitHub release](https://github.com/RiadMefti/agentlab/releases/latest):

- `agentlab-vVERSION-linux-x64`
- `agentlab-vVERSION-mac-arm64`

Then make it executable and place it on your `PATH`:

```bash
chmod +x agentlab-vVERSION-PLATFORM
mv agentlab-vVERSION-PLATFORM ~/.local/bin/agentlab
agentlab
```

The macOS executable is not notarized. If Gatekeeper blocks a direct download, clear the download
quarantine with `xattr -d com.apple.quarantine agentlab-vVERSION-mac-arm64`.

## Requirements

- Linux x64 with glibc, or macOS on Apple silicon
- Node.js 20 or newer when installing through npm; direct executables do not need Node.js or Bun
- `tmux` 3.2 or newer
- at least one installed and authenticated provider CLI: `codex`, `claude`, or `opencode`
- a terminal at least 90 columns by 18 rows

Install tmux with `brew install tmux` on macOS or your distribution's package manager on Linux.

## Use

1. Run `agentlab`. Startup never infers a project from the current directory and nothing is selected
   until you choose it.
2. Press `Alt+N`, paste any existing folder path, name the project, and choose its captain
   provider/model/thinking level. Absolute paths, relative paths, spaces, and `~/…` are supported.
3. Select projects on the left. Each project keeps exactly one captain pinned above its workers.
4. The captain can create real worker sessions, or press `Alt+W` to start one explicitly. Press
   `Enter` to focus and interact with the selected exact agent CLI.
5. Removing a project stops its managed sessions and forgets it in AgentLab. It never deletes or
   modifies the project folder.

### Keys

| Key                       | Action                                        |
| ------------------------- | --------------------------------------------- |
| `Alt+1`, `Alt+2`, `Alt+3` | Focus projects, terminal, or agents           |
| `Up`, `Down`, `Enter`     | Navigate a focused sidebar and enter terminal |
| `Alt+N`                   | Add a project folder                          |
| `Alt+W`                   | New worker in the selected project            |
| `Delete`                  | Remove the selected project or worker         |
| `Alt+C`                   | Copy the terminal selection through OSC 52    |
| `Alt+Q`                   | Quit the UI                                   |

Control-key input, including `Ctrl+C`, goes to the selected agent when the terminal is focused. The
Alt shortcuts are reserved for application controls.

## Run from source

Source development requires Node.js 24+, Bun 1.4+, and tmux 3.2+.

```bash
npm ci
npm run dev
```

Build and smoke-test the standalone executable for the current platform:

```bash
npm run package
./release/agentlab-vVERSION-linux-x64 --help
```

Packaging smoke-runs the new binary inside a disposable private home/data/state/cache/tmux sandbox;
it never opens the database or provider credentials from your normal AgentLab environment.

## Configuration

| Variable                 | Default                                   | Purpose                         |
| ------------------------ | ----------------------------------------- | ------------------------------- |
| `AGENTLAB_CACHE_PATH`    | `$XDG_CACHE_HOME/agentlab`                | npm launcher binary cache       |
| `AGENTLAB_DATABASE_PATH` | `$XDG_DATA_HOME/agentlab/agentlab.sqlite` | Local project metadata database |
| `AGENTLAB_CODEX_BIN`     | discovered                                | Codex executable override       |
| `AGENTLAB_CLAUDE_BIN`    | discovered                                | Claude Code executable override |
| `AGENTLAB_OPENCODE_BIN`  | discovered                                | OpenCode executable override    |

Project folders are chosen only inside the application. `AGENTLAB_DATABASE_PATH` always takes
precedence. Provider credentials remain in each CLI's own local authentication store.

## Architecture

- `apps/tui` owns the OpenTUI/React terminal layout and the one selected terminal attachment.
- `packages/runtime/src/application` owns validated use cases independent of UI and infrastructure.
- `packages/runtime/src/domain` owns conversation, session, command, and terminal ports.
- `packages/runtime/src/infrastructure` implements SQLite, provider discovery/launching, tmux, and
  Bun's native PTY.
- `packages/runtime/src/local-runtime.ts` composes the interactive runtime;
  `local-factory-broker.ts` is a separate broker-only composition exported only through
  `@agentlab/runtime/factory-broker`; and `local-factory-worker.ts` is a credentialless execution
  composition exported only through `@agentlab/runtime/factory-worker`. `local-factory-authority.ts`
  is a human-only local control composition exported only through
  `@agentlab/runtime/factory-authority`; it can compare-and-set scheduler and broker switches but
  has no scheduler execution, provider, process, or GitHub port. The separate
  `@agentlab/runtime/factory-intake` composition can register only owner-confirmed local feature or
  bug reports under repository-owned policy; it has no model or remote authority. The credentialless
  `@agentlab/runtime/factory-eval-producer` runs only digest-pinned administrator-installed subject
  and grader executables through an offline bubblewrap/systemd boundary, journals every invocation,
  stores raw content-addressed evidence, and emits a complete matched run. It cannot assess or sign
  that run, issue authority, join the daily chain, or reach a provider, GitHub, merge, or release.
  The credentialless `@agentlab/runtime/factory-evaluator` records complete matched eval reports,
  deterministic assessments, and public-key-verified attestation records. The isolated
  `@agentlab/runtime/factory-eval-attestor` can only sign a fresh exact run and cannot reach SQLite.
  The separate human-only `@agentlab/runtime/factory-canary-authority` re-verifies one exact signed
  eval record and can issue only an expiring R0/R1 cohort with `autoMerge:false` and
  `release:false`. The credentialless `@agentlab/runtime/factory-maintenance-discovery` runs only a
  policy-pinned read-only scout and registers deterministic scheduled intake; it cannot reserve or
  execute that work. The separate `@agentlab/runtime/factory-external-pull-request-discovery`
  composition uses a dedicated read-only GitHub App identity to inventory a bounded page of open
  pull requests and changed paths into an immutable daily journal. It treats titles, bodies, and
  paths as untrusted evidence and can only classify work for later agent or human review; it cannot
  invoke a model, check out code, comment, approve, repair, merge, or release. The separate
  `@agentlab/runtime/factory-external-pull-request-review` composition can invoke pinned models
  under resource ceilings against exact locally present objects, but has no GitHub credential or
  remote port. The separate `@agentlab/runtime/factory-external-pull-request-feedback` composition
  consumes only completed review bundles and can publish one deterministic advisory `COMMENT` review
  through a dedicated PR-only GitHub App; it cannot approve, repair, push, merge, deploy, or
  release. The separate `@agentlab/runtime/factory-external-pull-request-repair-execution`
  composition can run one credentialless repairer against exact local objects and emit a local patch
  bundle, but has no GitHub or remote-write port. The separate
  `@agentlab/runtime/factory-external-pull-request-repair-qualification` composition reconstructs
  that exact patch, runs the ordered seven-gate quality floor, and obtains a distinct read-only
  review quorum without any GitHub or remote-write port. The separate
  `@agentlab/runtime/factory-external-pull-request-replacement-draft` composition consumes only
  completed qualified bundles under a distinct broker UID and GitHub App, creates a deterministic
  new base-repository branch and draft PR, and verifies exact original/replacement, commit,
  proposal, qualification, broker, and publisher lineage. It cannot touch contributor branches,
  force-push, approve, merge, deploy, release, or invoke a model. Evaluator and authority
  compositions cannot execute a model, contact GitHub, merge, or release.
- `agentlab factory external-pr-review-preflight --config ...` validates the separate non-root
  worker identity, exact review/discovery/cost policy pins, reviewed skill inventory, pinned
  provider executables, and read-only capabilities without running a model.
  `external-pr-review-tick` consumes only immutable admitted discovery candidates, requires exact
  base/head objects already present in local Git, reconstructs and authenticates a bounded patch in
  a detached worktree, and records an ordered independent-review quorum in SQLite v21. Reviewers
  have no network, secrets, commands, workspace write, remote repository, or GitHub credential;
  disagreement routes to a human and no result can comment, approve, repair, push, merge, deploy, or
  release.
- `agentlab factory external-pr-feedback-preflight --config ...` verifies the distinct process/App
  identities, exact policy pins, repository, and broker kill switch without writing.
  `external-pr-feedback-tick` consumes only completed immutable review bundles, rechecks the exact
  open base/head, sanitizes a digest-marked advisory body, and submits only a GitHub `COMMENT`
  review. SQLite v22 journals intent before POST and reconciles uncertain outcomes by exact marker
  and App user ID without blind duplicate writes. It has no provider, branch write, approval,
  repair, merge, deployment, or release capability.
- `agentlab factory external-pr-repair-admission-preflight --config ...` verifies the separate
  non-root deterministic authority plane, all transitive policy pins, and the scheduler switch.
  `external-pr-repair-admission-tick` consumes only a completed review joined to its completed
  feedback publication and records one immutable schema-v23 authorization or denial. The capability
  selects findings by identity without copying untrusted prose, permits one future credentialless
  repair, requires replacement-draft publication, and grants no remote write, merge, deployment, or
  release authority.
- `agentlab factory external-pr-repair-execution-preflight --config ...` verifies the separate
  credentialless worker identity, exact execution/admission/cost/role/gate pins, ordered repair
  skills, provider executable, local paths, and scheduler without running a model.
  `external-pr-repair-execution-tick` consumes one unexpired schema-v23 authorization, authenticates
  already-local base/head objects and the original patch without fetching, resolves only selected
  finding IDs from exact review evidence, and permits one isolated workspace-writing repairer.
  SQLite v24 journals intent before the agent starts and records an immutable patch bundle only
  after the workspace closes. Pre-agent workspace setup may recover within policy; a post-start
  uncertain outcome is quarantined and never retried under the same authorization. The command has
  no GitHub credential or remote-write port and cannot push, publish, merge, deploy, or release.
- `agentlab factory external-pr-repair-qualification-preflight --config ...` verifies the separate
  worker identity, exact qualification/execution/cost/role/gate pins, content-addressed review
  skills, provider executables, and all seven gate executable digests without executing work.
  `external-pr-repair-qualification-tick` consumes only completed schema-v24 bundles, reconstructs
  the exact repaired patch, and runs format, architecture, typecheck, lint, test, build, and secret
  scan gates before a reviewer distinct from the repairer. SQLite v25 journals intent before each
  process, enforces immutable evidence lineage, quarantines uncertain post-start outcomes without
  rerun, and records `qualified`, `rejected`, or `human-review-required` only after the worktree is
  unchanged and closed. It cannot publish, push, approve on GitHub, merge, deploy, or release.
- `agentlab factory external-pr-replacement-draft-preflight --config ...` verifies the distinct
  broker UID/App publisher identity, exact publication/qualification/role pins, repository, trusted
  checks, and both kill switches without writing. `external-pr-replacement-draft-tick` consumes only
  completed qualified schema-v25 bundles, rechecks exact original base/head and governance before
  each mutation, records schema-v26 intent before a normal push and draft-PR POST, reconciles only
  exact App-authored remote state, and quarantines conflicts. It never writes contributor branches,
  force-pushes, approves, merges, deploys, or releases.
- `agentlab factory external-pr-discovery-preflight --config ...` validates the owner-only reader
  configuration, exact policy pins, read-only installation token, and remote repository identity.
  `external-pr-discovery-tick` uses exact `checks:read`, `contents:read`, and `pull_requests:read`
  installation permissions, re-reads each pull request around its bounded changed-file query, and
  records a content-addressed snapshot plus deterministic dispositions. An `agent-review-candidate`
  disposition is inventory, not review or execution authority.
- `agentlab factory eval-producer-preflight --config ... --job ... --job-digest ...` revalidates one
  immutable suite/case-bank/candidate/harness/grader matrix, complete budget reservation, fixtures,
  executable digests, runner, and deadline without launching a process. `eval-produce` executes its
  fixed offline protocols under per-invocation and aggregate bounds; SQLite v20 and immutable
  artifacts make exact retries and crash recovery fail closed.
- `agentlab factory eval-assess --config ... --run ... --confirm-assess` validates canonical
  candidate/suite identities and the complete matched trial matrix, derives confidence, safety,
  regression, flake, cost, and latency metrics from raw samples, and atomically records one
  pass/deny assessment. `eval-inspect` emits the compact immutable result without samples or traces.
- `agentlab factory eval-sign --config ... --run ... --confirm-sign` emits one Ed25519 DSSE in-toto
  artifact from a signer composition with no database or remote capability. `eval-attest` verifies
  it against a pinned public key, exact run/assessment lineage, and independent timing bounds before
  one immutable schema-13 append.
- `agentlab factory canary-authorize --config ... --attestation ... --request ... --confirm-authorize-canary`
  requires a currently valid verified attestation and separate owner-only human request, then
  records one attestation- and role-policy-bound non-executing cohort.
- `agentlab factory canary-reserve --config ... --task ...` re-verifies one exact v2 cohort and its
  signed evaluation, then atomically reserves the scheduled task's complete ceiling against cohort
  task and budget limits. The credentialless command executes no model, opens no PR, and grants no
  merge or release authority.
- `agentlab factory maintenance-discovery-tick --config ... --discovery-policy ... --schedule-policy ... --policy ... --preparation-grant ... --role-policy ...`
  runs one durable daily read-only scout at an exact Git base. Findings must be R1, evidenced by
  tracked files, inside reviewed scope/confidence/count ceilings, and outside protected paths before
  trusted code derives identity and registers scheduled intake. SQLite v18 makes the run and every
  disposition immutable. It has no GitHub, reservation, execution, merge, or release authority.
- `agentlab factory canary-admission-tick --config ... --cohort ... --candidate ... --schedule-policy ... --role-policy ... --policy ...`
  reserves a bounded page only inside an already attested and human-issued cohort. It obeys the
  scheduler switch and schedule ceilings, reuses the full signature/freshness/risk/aggregate-budget
  checks, and cannot issue authority or run work.
- `agentlab factory scheduler-tick --config ... --schedule-policy ... --daily-quota ... --policy ...`
  runs or reconciles one exact daily UTC slot from an owner-only worker v4 or v5 config. Before
  model work, SQLite schema 31 preserves schema-27 quota enforcement and adds append-only atomic
  incident containment; quota admission reserves the task's full ceiling and one possible draft
  against exact repository/day and organization/day limits. Schedule-run/event v3 bind that
  immutable reservation, the canary authority, policy digests, and the durable correlation reused
  after interruption. The worker independently rechecks the chain before each resumable phase. It
  cannot open a PR, mutate authority, merge, or release.
- `agentlab factory broker-open-canary-draft --config ... --task ... --reservation ... --schedule-policy ... --role-policy ... --policy ...`
  accepts only a completed scheduled R1 proposal with an exact current `brokered-draft-pr`
  reservation. Broker config v4 loads the same schedule, daily-quota, and role policies; SQLite v17
  stores their coordinates in a v2 dispatch before remote mutation, and the broker independently
  rechecks the authority before every resumable phase. It does not discover work, enable the broker,
  merge, or release.
- `agentlab factory broker-canary-tick --config ... --schedule-policy ... --role-policy ... --policy ...`
  discovers one bounded page of exact completed scheduler handoffs and reconciles them through the
  same durable dispatch service. It prioritizes current authority, then incomplete dispatch recovery
  within that class; obeys the schedule policy's candidate and task ceilings; and reports expiry or
  denial for operator attention. It installs no timer, changes no authority, and has no merge or
  release path.
- `agentlab factory broker-pr-maintenance-tick --config ... --schedule-policy ... --role-policy ... --policy ...`
  reconciles one bounded page of exact open scheduled-canary PR heads. Once per daily slot it
  records authenticated CI/review facts and, only for a deterministic actionable disposition,
  creates the existing immutable repair authorization. Exact retries resume from observation
  evidence without another remote read. It cannot execute a repair, update a branch, merge, or
  release.
- `agentlab factory merge-admission-tick --config ... --merge-policy ... --policy ... --schedule-policy ... --daily-quota ... --role-policy ...`
  credentiallessly derives one bounded page of short-lived exact-head authorizations from scheduled
  R1 contracts, live canary reservations, complete patch/usage evidence, broker-authenticated clear
  observations, pinned successful checks, independent reviews, and all three authority switches.
- `agentlab factory merger-tick --config ... --merge-policy ... --policy ... --schedule-policy ... --daily-quota ... --role-policy ...`
  runs under a distinct UID and GitHub App, records intent before each mutation, marks the exact
  draft ready, and enqueues the authorized head with `expectedHeadOid`. It reconciles the merge
  queue and records exact completion evidence; direct merge, release, and provider execution are
  unreachable.
- `agentlab factory worker-run --config ... --task ... --policy ... --confirm-run` resumes one
  registered task through preparation, immutable contract materialization, isolated implementation,
  strict gates, independent review, and bounded repair. It stops at `pr-proposed`; opening the draft
  remains a separate broker command and authority boundary.
- `agentlab factory broker-observe-pr --config ... --task ... --policy ... --confirm-observe` reads
  only the exact durable PR record, trusted checks, formal reviews, inline review comments, and PR
  conversation comments. It stores bounded feedback as explicitly untrusted content-addressed
  evidence, prints only counts and a deterministic disposition, and has no repair, merge, or release
  path.
- `agentlab factory broker-authorize-repair --config ... --task ... --observation ... --policy ... --confirm-repair`
  reserves one remaining contract repair attempt from the exact latest actionable observation. Its
  immutable authorization selects formal exact-head change requests from trusted human repository
  associations, linked inline comments, and failed checks from pinned producers by ID; it never
  copies feedback text, invokes a model, changes task state, or writes GitHub.
- `agentlab factory worker-repair-pr --config ... --task ... --authorization ... --policy ... --confirm-repair`
  consumes exactly that authorization in a fresh exact-base worktree, reapplies the prior patch,
  presents the selected feedback as untrusted data, and permits one credentialless repair attempt.
  Every strict gate and a distinct read-only review run again. Its append-only journal makes
  interruption recoverable, cumulative task budgets remain authoritative, and it stops at a new
  local `pr-proposed` checkpoint; branch update remains a separate broker responsibility.
- `agentlab factory worker-pr-repair-tick --config ... --schedule-policy ... --role-policy ... --policy ...`
  recovers interrupted repair journals first, even under normal-work blockers, then consumes a
  bounded page of exact maintenance-issued canary repair authorizations. Fresh work rechecks worker
  readiness and current reservation authority, reserves its full contract ceiling against the tick
  budget, runs in the credentialless worker, and stops at a gated, independently reviewed local
  proposal.
- `agentlab factory broker-pr-update-tick --config ... --schedule-policy ... --role-policy ... --policy ...`
  recovers interrupted broker update journals first, then publishes a bounded page of exact
  completed canary repairs. Fresh work must retain its maintenance observation, authorization,
  current PR head, reservation, scheduler handoff, policy pins, repository governance, and enabled
  broker authority. It uses the existing non-force crash-durable update service, returns each task
  to `pr-open` for exact-head re-observation, and cannot run a model, merge, or release.
- `agentlab factory broker-update-draft --config ... --task ... --authorization ... --policy ... --confirm-update`
  consumes the completed repair only in the credential-bearing broker composition. It revalidates
  the exact repair journal, patch, cumulative usage, policy, prior PR authority record, repository
  governance, and kill switch. The broker creates a deterministic commit whose sole parent is the
  recorded remote head and performs a normal non-force fast-forward. Its five-checkpoint SQLite
  journal reconciles an exact already-applied update after interruption, records authenticated
  evidence, returns the task to `pr-open`, and makes re-observation bind the new head.
- `packages/contracts` owns provider, conversation, session, and software-factory schemas shared
  across local layers.

Cross-package imports use public entry points, inner runtime layers never depend outward, and the
product source graph must remain acyclic. `npm run architecture:check` enforces those rules. The
embedded terminal uses native VT parsing, true color, selection, resize, paste, cursor state, and a
16 MiB scrollback byte budget. Tmux separately retains up to 20,000 history lines; the number of
lines held by the embedded terminal varies with encoded content. Focused tests enforce
multi-megabyte ANSI throughput and the one-attachment invariant. See
[Architecture](docs/architecture.md) for the complete boundaries.

The repository also contains a tested, staged software-factory safety kernel, governed local intake,
credentialless local worker and evaluator compositions, separated human-only authority compositions,
bounded daily scheduler, and draft-PR broker. None is connected to the interactive runtime. No live
schedule/eval policy, timer, worker, evaluator, broker, or authority configuration is provisioned or
enabled. Intake accepts a strict owner-only `feature` or `bug` submission, derives task identity and
the current Git base itself, verifies every pinned skill package and exact-model cost rule, and
registers an immutable preparation journal only after literal confirmation and an operator-pinned
policy digest. A distinct `--confirm-register-scheduled` confirmation marks requests eligible for
scheduler selection. The worker has a bounded serialized command port and read-only host preflight
covering its pinned toolchain, schedule-policy digest, and owner-only storage roots, but no GitHub
or authority-control capability. Its manual task runner, daily scheduler, and authorization-bound PR
repair runner are crash-resumable and stop before remote writes. Separate CLI commands inspect local
authority and compare-and-set the scheduler, PR-broker, and merge-broker switches independently;
that human-only process cannot run agents or contact GitHub. Manual initial-draft and
repaired-branch writes require an exact task UUID, operator-pinned policy digest, and literal
confirmation. Evaluated scheduled initial-draft and repaired-branch paths instead require exact
reservation, schedule, role, and factory-policy lineage through their bounded consumers. All invoke
only the broker after a clean preflight, and their inner services recheck policy, evidence, base
revision, governance, and the broker kill switch. All three switches remain default-off. The eval
slice produces a strict owner-only matched report from digest-pinned offline harnesses, signs and
verifies its exact bytes through disjoint local compositions, and can issue a structurally
non-merge/non-release cohort after human sample review and fresh attestation re-verification. The
producer and reservation consumer exist but neither is provisioned or activated. Scheduled config v5
and eval signing now pin one canonical role policy: distinct non-root worker/signer UIDs plus the
exact signer key and runner, with the policy digest carried in every signed eval predicate. No
accounts are provisioned or activated. Provider-neutral per-run, per-tick, and host-local
repository/organization daily reservation accounting are policy-pinned and fail-closed, and the
shipped live rate card is intentionally empty. Owner-only worker and broker config can load the same
separate strict cost-policy file without sharing broker credentials; broker config v5 also pins the
schedule, daily quota, role, merge, and compiled factory policies needed for reservation-bound
dispatch and exact policy continuity. The dormant daily-cycle v5 orders independent health and
disable-only containment → discovery → canary admission → quota-bound scheduler → brokered
draft/repair → final exact-head observation → credentialless merge admission → isolated GitHub
merge-queue broker while keeping separate fixed-UID configs; legacy manifests remain readable but
cannot render an executable cycle. The current repository also exposes a separate policy-pinned,
query-only operations-health command that revalidates canonical ledger documents, reports
schedule/task/quota health, and returns monitor-friendly healthy/degraded/critical exit codes
without any worker, broker, provider, GitHub, or authority-mutation port. A distinct credentialless
incident command recomputes that health and can only atomically disable merge broker, PR broker, and
scheduler authority while journaling the exact evidence; it has no enable path. Automatic merge is
restricted to scheduled R1 tasks whose immutable contracts opt in, fresh exact-head evidence with
the pinned successful check set, a live canary reservation, a short-lived single-use authorization,
and GitHub's merge queue. The merger adapter has no direct-merge or release operation and records
intent before remote mutation. Repository governance blocks live write commands. No unit is
installed or activated, and no live factory task or PR has been created or merged through these
factory commands. The separated-UID daily chain is currently **not deployable**: its stages require
one shared ledger and artifact store, but the storage adapters enforce owner-only access and
ownership-only permission changes. A live two-UID proof reproduces the failed handoff; unit-file
verification and same-user integration tests do not prove this deployment works. See
[the single-owner ledger decision](docs/decisions/0034-single-owner-factory-ledger-boundary.md) for
evidence and the accepted correction. Its authenticated read boundary now passes a positive
cross-UID test; write operations, artifact transfers, and role migration remain unfinished. Do not
weaken permissions or collapse role identities to activate the current chain. See
[ADR 0006](docs/decisions/0006-local-software-factory-control-plane.md) for implemented controls,
activation blockers, and later phases, and
[ADR 0007](docs/decisions/0007-deterministic-evaluation-and-canary-authority.md) for promotion
separation; [ADR 0009](docs/decisions/0009-isolated-eval-attestation.md) for the signing boundary;
[ADR 0011](docs/decisions/0011-enforced-signer-worker-identities.md) for enforced OS identities;
[ADR 0012](docs/decisions/0012-attested-canary-authority.md) for attestation-gated cohorts;
[ADR 0014](docs/decisions/0014-canary-bound-scheduled-execution.md) for scheduled execution;
[ADR 0015](docs/decisions/0015-canary-bound-draft-pr-dispatch.md) for scheduled draft authority;
[ADR 0016](docs/decisions/0016-bounded-canary-broker-reconciliation.md) for bounded broker
reconciliation; [ADR 0017](docs/decisions/0017-slot-bound-canary-pr-maintenance.md) for bounded
CI/review observation and repair admission; and
[ADR 0018](docs/decisions/0018-recovery-first-canary-pr-repair-consumer.md) for recovery-first
credentialless repair consumption; and
[ADR 0019](docs/decisions/0019-recovery-first-canary-pr-update-consumer.md) for recovery-first
brokered repair publication; and
[ADR 0021](docs/decisions/0021-durable-maintenance-discovery-and-canary-consumption.md) for daily
maintenance intake and bounded cohort consumption; and
[ADR 0022](docs/decisions/0022-sandboxed-eval-evidence-production.md) for offline eval production;
and [ADR 0023](docs/decisions/0023-read-only-external-pull-request-discovery.md) for bounded
external pull-request inventory; and
[ADR 0024](docs/decisions/0024-credentialless-external-pull-request-review-evidence.md) for isolated
local external-review evidence; and
[ADR 0025](docs/decisions/0025-feedback-only-external-pull-request-review-publication.md) for the
separate advisory publication boundary; and
[ADR 0026](docs/decisions/0026-deterministic-external-pull-request-repair-admission.md) for the
selectors-only external repair authority boundary; and
[ADR 0027](docs/decisions/0027-credentialless-external-pull-request-repair-execution.md) for the
one-attempt isolated repair and patch-bundle boundary; and
[ADR 0028](docs/decisions/0028-credentialless-external-pull-request-repair-qualification.md) for the
strict post-repair gate and independent-review boundary; and
[ADR 0029](docs/decisions/0029-brokered-external-pull-request-replacement-drafts.md) for the
contributor-safe publication boundary; and
[ADR 0030](docs/decisions/0030-durable-daily-aggregate-quotas.md) for host-local repository and
organization daily ceilings; [ADR 0031](docs/decisions/0031-query-only-operations-health.md) for the
credentialless ledger health projection; and
[ADR 0032](docs/decisions/0032-durable-disable-only-incident-containment.md) for atomic disable-only
containment; and [ADR 0033](docs/decisions/0033-policy-bound-autonomous-r1-merge-queue.md) for
exact-head, queue-backed autonomous R1 merge. The dormant procedures are in
[Local factory scheduler operations](docs/factory-operations.md) and
[Local factory evaluation operations](docs/factory-evaluation-operations.md).

## Development

```bash
npm run verify
npm audit --omit=dev
```

`verify` checks formatting, architecture boundaries and cycles, strict TypeScript, linting,
unit/component tests, real tmux and PTY integration, the production build, and the standalone
executable. See [Contributing](CONTRIBUTING.md) for the engineering contract.

## Security

AgentLab opens no network listener. The npm launcher connects to GitHub only when its exact binary
is missing and to npm when you explicitly request an update. The separate factory broker preflight
connects to GitHub only when explicitly invoked with an owner-only local config; it performs no
remote write. Managed session identities and all local command input are validated before process
boundaries; child processes receive argument arrays, and the one tmux shell-command boundary uses
tested POSIX quoting. Published executables are immutable. See [Security](SECURITY.md) for reporting
guidance.
