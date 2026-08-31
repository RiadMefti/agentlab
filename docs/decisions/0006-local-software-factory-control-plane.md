# ADR 0006: add a local-first software-factory control plane

**Status:** Accepted; implementation is staged

**Date:** 2026-08-30

## Context

AgentLab already has a strong local runtime: one captain per conversation, zero or more workers,
durable tmux sessions, nonce-proved ownership, a single-writer SQLite lifecycle, strict process and
terminal cleanup, provider adapters, executable dependency rules, comprehensive verification, and a
release chain with pinned Actions, checksums, SBOMs, attestations, immutable releases, and OIDC npm
publishing.

Those controls were necessary but not sufficient for a software factory. At the time of this
decision, the captain prompt could ask workers to act, but prompts were not durable authority.
AgentLab had no immutable unit of work, skill provenance, isolated Git workspace per attempt,
append-only task ledger, deterministic risk policy, evidence bundle, independent-review proof,
repair loop, scheduler, PR broker, or bounded merge/release authority. Giving the captain a
long-lived GitHub token would turn a useful local orchestrator into an unauditable privileged actor.

The goal is a workflow in which a feature request, bug report, PR, or scheduled maintenance signal
is improved, specified, planned, implemented, verified, independently reviewed, proposed as a PR,
repaired when checks fail, merged under repository rules, released, and observed. The same design
must remain local-first, provider-neutral, auditable, interruptible, and safe under prompt
injection, provider failure, process failure, stale Git state, and compromised agent output.

## Industry evidence

The decision follows convergent primary-source guidance rather than one provider's orchestration
API:

- OpenAI documents OS-enforced sandboxing, network-off defaults, and separate sandbox and approval
  controls. Its CI guidance gives the model-bearing job read-only repository authority, emits a
  patch artifact, and lets a separate job with no model credential apply the patch and open the PR.
  `/review` is read-only. See
  [agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security),
  [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), and
  [code review](https://learn.chatgpt.com/docs/code-review).
- OpenAI's reported internal harness uses isolated worktrees, repo-local legibility, self-review,
  separate targeted reviews, repair loops, and recurring small maintenance changes. See
  [Harness engineering](https://openai.com/index/harness-engineering/).
- OpenAI's current model guidance says to define autonomy and approval boundaries, expose only
  relevant tools, specify output/evidence plus concurrency, retry, and stopping limits, and compare
  representative evals on task success, completeness, evidence, tokens, latency, and cost. See
  [Model guidance](https://developers.openai.com/api/docs/guides/latest-model).
- Anthropic separates an agent's replaceable “brain” from stable “hands,” persists an append-only
  session log, and treats sandboxing as a capability boundary. Its long-running-agent guidance uses
  explicit progress artifacts across context windows; its eval guidance combines deterministic,
  model, and human graders over tasks, trials, and traces. See
  [Building a C compiler with parallel Claudes](https://www.anthropic.com/engineering/managed-agents),
  [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents),
  [Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing), and
  [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
- GitHub Agentic Workflows compiles human-readable workflow definitions into hardened Actions, keeps
  agents read-only by default, and converts requested writes into bounded safe outputs handled by
  separate permission-bearing jobs. Its PR broker protects policy, workflow, dependency, and
  instruction files by default. See the
  [overview](https://github.github.io/gh-aw/introduction/overview/),
  [safe outputs](https://github.github.io/gh-aw/reference/safe-outputs/), and
  [safe-output pull requests](https://github.github.io/gh-aw/reference/safe-outputs-pull-requests/).
- GitHub repository rules can require PRs, code-owner and last-push approval, status checks, signed
  commits, code scanning, deployments, and merge queues. Artifact attestations bind artifacts to
  workflow identity through Sigstore. See
  [ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
  [secure use of GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions),
  and
  [artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations).
- GitHub's REST API exposes exact branch-reference and pull-request readback but no create-PR
  idempotency key, so crash recovery must reconcile the deterministic branch/head/PR tuple. GitHub
  App installation tokens can be restricted to selected repositories and permissions and expire
  after one hour. App authentication uses a bounded RS256 JWT, and the installation-token request
  can pin both `repository_ids` and the requested permission map. See
  [generating a JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
  [Git references](https://docs.github.com/en/rest/git/refs),
  [pull requests](https://docs.github.com/en/rest/pulls/pulls), and
  [installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
- SLSA requires provenance verification against expected builder, source, build type, and
  parameters; its higher source level requires two-party review and its higher build level requires
  isolation. See [source requirements](https://slsa.dev/spec/v1.2/source-requirements),
  [build track](https://slsa.dev/spec/v1.2/build-track-basics), and
  [verifying artifacts](https://slsa.dev/spec/v1.2/verifying-artifacts).
- Kubernetes documents that scheduled jobs may be missed or duplicated and therefore must be
  idempotent; its starting deadline and concurrency policy are explicit admission controls. See
  [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/).
- Google SRE recommends reproducible automated small releases, peer review, canary evaluation
  against service objectives, and automated rollback. See
  [Canarying releases](https://sre.google/workbook/canarying-releases/).
- NIST's AI RMF makes governance, role accountability, inventory, continuous measurement,
  third-party monitoring, incident response, and recovery ongoing functions. The
  [NIST AI RMF Playbook](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/) and the
  [OWASP Agentic Top 10](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
  cover the governance and threat categories this control plane must expose.

Real repositories used as interoperability references include
[github/gh-aw](https://github.com/github/gh-aw),
[anthropics/claude-code-action](https://github.com/anthropics/claude-code-action),
[anthropics/cwc-long-running-agents](https://github.com/anthropics/cwc-long-running-agents), and
[openai/codex](https://github.com/openai/codex). AgentLab adopts their durable control patterns, not
their provider-specific task formats.

## Decision

Add the software factory as an additive bounded context. Do not replace or loosen the existing
conversation/session runtime. A factory task belongs to one conversation; that conversation still
has exactly one captain, and every agent execution is a worker attempt owned by that captain. The
deterministic control plane—not captain prose—owns task state, authority, budgets, gates, and
evidence.

The design has three planes:

```text
request / issue / PR / schedule
              │
              ▼
control plane: contract → ledger → policy → orchestration → evidence
              │                                  │
              ▼                                  ▼
execution plane: isolated implementer, verifier, reviewer, repair workers
              │
              ▼ untrusted patch + structured proposal
authority plane: PR broker → GitHub rules/CI → human or merge queue → release controller
```

The control plane is local and durable. The execution plane is disposable and least-privileged. The
authority plane is deterministic and independently credentialed. Agent output is always untrusted
proposed content; it is never proof that policy passed and never authority to update a remote
repository, merge, publish, deploy, or access a secret.

Provider adapters implement stable execution ports. Contracts record the selected provider, model,
harness, and tool versions in evidence, but domain transitions and policy contain no Codex, Claude,
OpenCode, tmux, GitHub, Fastify, or React conditionals.

## Durable contracts

All external and persisted factory data is strict, versioned, bounded, and validated at its process
or future HTTP boundary. Canonical JSON is hashed with SHA-256. Mutating a task means issuing a new
contract that references the previous contract digest; it never means editing a signed contract in
place.

### Governed preparation chain

The raw request is not an execution contract, and agent-authored preparation is never an authority
source. Six canonical documents form the pre-contract boundary:

- intake binds a task/conversation, exact repository/base, source references, trigger, requester,
  deduplication key, title, body, and creation time;
- qualification links the intake digest and records `ready`, `needs-human`, or `rejected`, plus the
  clarified objective, assumptions, questions, or rejection reason;
- specification links the exact qualification and records the unchanged qualified objective,
  acceptance criteria, non-goals, and requested path scope;
- plan links the exact specification and proposes risk, authorized skill/profile IDs, capabilities,
  budget, and extra evidence—never gates, approvals, credentials, or policy;
- preparation authority is issued by trusted policy for that exact task/request/base and pins the
  predecessor contract, active policy digest, exact skill manifests/DAG, read-only preparation
  profiles, execution worker profiles, exact include-path allowlist, protected paths,
  risk/capability/budget ceilings, retry count, evidence floor, approval roles, and
  validity/lifetime limits;
- the preparation bundle links every artifact/authority digest and one session-bound agent run for
  each `qualify`, `specify`, and `plan` phase, including exact skill package and output digests.

The deterministic compiler receives authority only through its trusted construction boundary; the
agent-facing compilation input cannot supply or replace it. It recanonicalizes all six documents and
rejects unknown fields, invalid dispositions, digest substitution/replay, objective drift, stale or
mismatched authority, causal time violations, unpinned skills/workers, missing dependency closure or
execution phases, provider incompatibility, and any scope/capability/budget/risk widening. It unions
trusted protected paths and evidence floors, calculates prospective risk with the same policy used
at execution, and derives the gate profile, independent-review count, and every stage approval from
pinned policy. The result is the existing `agentlab.task-contract.v1`; there is no second
execution-authority format.

The schemas, trusted authority issuer, compiler, provider-neutral preparation execution, and
append-only SQLite preparation journal now exist with adversarial tests. Each run is pinned to an
exact read-only/offline/no-secret worker profile, skill package, provider/model/reasoning setting,
capability grant, budget, attempt, request/authority digest, predecessor artifacts, and OS resource
profile. The journal records `phase-started` before side effects and captures canonical run
requests, run records, outputs, usage, isolation, and terminal decisions. Recovery can abandon an
in-flight run only after the local reconciler positively confirms it inactive. The durable execution
ID binds the journal run, transient systemd scope, and disposable Git worktree. Recovery validates
the canonical source repository, exact base commit, and factory root; checks the exact scope before
cleanup, immediately before cleanup, and after cleanup; and requires non-blocking acquisition of the
canonical task-directory `flock` held by every worktree Git command. The lock also remains held by
an orphaned command after a control-plane crash. Recovery removes only the derived worktree or its
exact partial directory, rejects symlink/path ambiguity, and verifies both Git registration and
filesystem absence. Unknown or changing systemd state, a held or unobservable worktree lock,
repository mismatch, and unconfirmed cleanup preserve the running journal state. Workspace
acquisition failure and a process runner that cannot confirm tree cleanup also remain in-flight
rather than manufacturing completion.

Execution after contract materialization has a separate, deliberately small durable journal rather
than overloading task state. `agentlab.execution-run.v1` immutably binds one run to the exact task,
contract digest, repository/base commit, correlation ID, and `maxRepairAttempts + 1` workspace
ceiling. `agentlab.execution-event.v1` is append-only and hash chained:

```text
ready → workspace-active → operation-active → workspace-active → ready → completed
  │             │                 │                 │
  └─────────────┴─────────────────┴─────────────────┴────────────→ abandoned
```

The control plane appends `attempt-started` with a caller-generated workspace UUID before worktree
creation. It appends `operation-started` with the exact agent execution UUID or gate isolation UUID
before the process adapter is invoked. Agent requests are canonical, content-addressed documents.
The gate executor must use the caller's UUID and throws when process-tree cleanup is unconfirmed;
the execution service rejects any returned isolation identity that differs from the journal. Only
after confirmed process cleanup and canonical evidence publication may `operation-finished` be
appended. Only after confirmed worktree removal may `attempt-closed` be appended. SQLite version 7
materializes and independently constrains identities, event sequence, digest links, legal state
edges, resource-coordinate fields, operation descriptors, and the contract-derived attempt limit;
triggers forbid update or deletion.

Recovery reuses one provider-neutral workspace-recovery port and the same local Linux adapter as
preparation. A `ready` run has no live resource. For `workspace-active`, recovery owns the exact
workspace UUID; for `operation-active`, it additionally owns the exact process UUID. The reconciler
must prove every supplied systemd scope inactive, acquire the task worktree lock non-blockingly,
re-prove source repository and base commit identity, remove only the derived worktree, and prove
final process/Git/filesystem absence. It then appends `execution-abandoned` and moves an active task
to `failed` or `needs-attention` as its task-state edge permits. Any uncertainty leaves both task
and journal recoverable and nonterminal. A repeated recovery is idempotent after abandonment.

Materialization replays all referenced artifacts and rejects missing, changed, substituted,
over-budget, or identity-mismatched data. One SQLite transaction then inserts the immutable
contract, the complete `intake → qualified → specified → planned` task-event chain, initial evidence
(including trusted `contract-validation`, `scope-validation`, and `policy-validation` claims bound
to the compiled contract and pinned policy), and the preparation `prepared` marker. Those
deterministic gate claims are emitted only by the materializer, not by a worker. A forced late
insert failure is tested to leave neither a partial task ledger nor a false prepared marker. These
paths are reachable only through the separate credentialless worker composition. The Linux recovery
adapter is exercised in the supported target-host CI lane. A separate explicit, policy-pinned worker
command or its bounded scheduler may now invoke one already registered request; the normal TUI and
authority issuer still cannot invoke execution.

Execution admission is deterministic and separate from execution. Its command accepts only a task
UUID. The service reloads the planned task and active conversation, obtains the current commit from
a hardened Git adapter that verifies the canonical repository top level, and supplies that observed
revision to policy with an empty change set and zero complete usage. It transitions only an allowed
R1 task to `queued`; a denial or human requirement remains recorded without a state transition, and
an already queued task is idempotent. The admission surface exposes neither control switches nor
preparation-authority issuance.

The worker configuration is an owner-only, strict `agentlab.local-factory-worker.v1` document with
no remote-repository credentials or authority controls. It pins storage/worktree roots, Git and
Linux isolation executables, the systemd version identity, non-root Bubblewrap runtime mounts, the
exact seven external R1 gates and their evidence kinds, and supported provider executables by
canonical path, SHA-256 digest, and exact version output. Its cost policy remains a separate
owner-only document. Provider resolution revalidates the executable and runs `--version` with a
fixed credentialless environment; unconfigured providers resolve to no capability. This boundary
does not discover models dynamically or inherit GitHub/package/cloud secrets.

```text
registered → qualifying → qualified → specifying → specified → planning → planned → prepared
                 ↘ retry                 ↘ retry               ↘ retry
registered/qualified/specified ← phase-failed or confirmed-abandoned
qualifying → needs-human | rejected
active preparation → failed | cancelled | expired
```

`prepared` is not appendable through the ordinary journal repository; only the atomic
task-materialization port may create it.

### Skill manifest

A reusable skill manifest contains:

- schema version, stable ID, semantic version, package digest, instruction path, and description;
- allowed roles and triggers;
- input/output schema digests;
- requested filesystem, Git, remote-read, process, network, command, and secret capabilities;
- maximum risk tier, allowed source/destination task states, and supported providers;
- wall-clock, token, tool, process, output, worker, repair, and diff ceilings;
- required evidence kinds and content-addressed dependency digests.

The manifest describes a request. Installation policy resolves it to a signed or locally trusted
package digest and may only reduce its capabilities. A skill cannot declare GitHub write, PR, merge,
or release authority. Instruction files and dependency digests are pinned before execution; workers
cannot change the skill or policy that governs their own attempt.

### Immutable task contract

A task contract contains:

- schema version, task/conversation IDs, creation/expiry times, predecessor and deduplication
  digests;
- repository identity and exact base commit, plus issue/PR/local source references;
- objective, testable acceptance criteria, non-goals, included, excluded, and protected paths;
- risk tier and an acyclic, digest-pinned skill plan;
- allowed providers and minimum independent-review requirements;
- granted capabilities and all resource/diff/repair budgets;
- a versioned policy/gate-profile digest, required evidence, and stage-specific approval rules.

The contract deliberately contains no mutable task state and no remote credential. A stale base SHA,
expired contract, changed policy bundle, scope expansion, budget increase, or different skill digest
requires a new contract and approval calculation.

### Task state and ledger

The authoritative record is an append-only sequence of strictly increasing task events. Each event
binds the task, contract digest, previous and next state, actor role/session, timestamp, reason
code, correlation ID, and optional evidence-bundle digest. Derived snapshots and dashboards can
always be rebuilt from this ledger.

```text
intake → qualified → specified → planned
      → [awaiting-execution-approval] → queued → executing → verifying → reviewing
      ↘                                 repair ← failures/findings ←──────────────┘
                                            └→ verifying
reviewing → pr-proposed → pr-open → merge-ready
         → [awaiting-merge-approval] → merge-queued → merged
         → [canary] → [released] → observing → completed
```

Every active state also has only explicitly enumerated failure edges. `needs-attention`, `rejected`,
`cancelled`, `expired`, `failed`, `quarantined`, and `rolled-back` are terminal. Resuming one
creates a superseding contract/task, preserving the original history instead of rewriting it. No
stage can jump over verification, independent review, policy evaluation, or the broker.

## Risk-tier gate profiles

Classification is deterministic and fail-closed. The highest matching rule wins. A protected path
sets a tier floor even when the requested change sounds harmless.

| Tier | Typical scope                                                                                               | Agent authority                                                            | Required gates and human control                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| R0   | triage, explanation, inventory, review                                                                      | read-only; no PR                                                           | contract/policy/evidence validation; output is advisory                                                      |
| R1   | docs, tests, narrowly scoped non-behavioral refactor outside protected paths                                | isolated worktree; broker may open a draft PR                              | existing verify suite, secret/scope scan, one distinct reviewer; human merge in the initial program          |
| R2   | product behavior, dependencies, public APIs                                                                 | isolated execution; broker may open a draft PR                             | full CI, dependency/security gates, independent reviews, owner approval, human merge, canary when deployable |
| R3   | auth, process/shell boundaries, data/migrations, architecture, workflow, policy, supply chain, release code | write execution requires prior human approval; no autonomous merge/release | protected owners, two-person review, staging/canary, signed evidence, human release                          |
| R4   | secrets, destructive production action, cross-repository authority, emergency operations                    | agents are read-only advisers                                              | humans execute under change/incident procedure with multi-party approval                                     |

The initial protected set includes `.github/**`, `AGENTS.md`, `SECURITY.md`, `docs/architecture.md`,
`docs/decisions/**`, dependency manifests and lockfiles, migrations, release scripts, authorization,
secret handling, and process/shell boundaries. Ordinary production source has an R2 floor; factory
control, provider, broker, and policy source has an R3 floor. Policy can add repository paths but a
task cannot remove them.

No tier permits an agent to merge or release in the minimal rollout. Later R1 auto-merge is a
separate opt-in policy change, only after the eval/canary exit criteria are met. R3 and R4 never
inherit that exception.

## Policy-as-code and separation of duties

The policy engine is ordinary deterministic code. Given a canonical contract, exact repository
facts, diff facts, evidence references, actor history, and a pinned policy bundle, it returns
`allow`, `deny`, or `needs-human` with stable reason codes. Unknown fields, missing evidence,
unavailable policy, stale Git heads, unavailable identity, or unverifiable attestations deny. Model
classifiers may add findings but cannot grant capability or override a denial.

Role bindings are recorded for requester, qualifier, specifier, planner, implementer, repairer,
reviewer, gate runner, policy engine, PR broker, merger, release controller, and incident commander.
One actor may perform adjacent low-risk preparation roles, but these separations are invariant:

- an implementer or repairer cannot satisfy independent review for its own patch;
- self-review never counts as the required independent review;
- an agent and its model-bearing process cannot invoke the PR broker, merge, or release credential;
- the broker cannot manufacture missing test, review, or policy evidence;
- the merger cannot be the last actor to push the reviewed commit; higher tiers require distinct
  owners and approval identities;
- the release controller accepts only the exact merged and attested commit/artifacts.

## Evidence and attestation bundle

Evidence is append-only and content-addressed. Each bundle links its predecessor and records the
task/contract/policy digests. Items record subject and artifact digests, media type and size,
result, producer kind/role/session, time, and bounded claims. The complete bundle eventually
includes:

- normalized intake, contract, skill packages, base/head/patch hashes, and changed-path/diff facts;
- provider/model/harness/tool/sandbox identities and resource usage;
- command vectors, exit codes, bounded logs, format/type/lint/test/build/security results;
- reviewer findings, reviewer independence, repairs, policy inputs/decisions, and approvals;
- PR/check/merge identities and exact Git commits;
- SBOM, provenance, release artifact, canary, rollback, and incident references.

Agent-produced artifacts are marked by producer identity and remain untrusted. Only the control
plane, isolated CI, policy engine, broker, and release system can attest facts they directly
observed. Secrets are redacted before storage, but redaction never changes the original artifact's
hash claim; a separately hashed redacted representation is retained. Trusted attestations bind the
subject digest, workflow identity, issuer, and transparency-log reference where available.

Internal evidence append uses registered object capabilities, not caller-supplied trust. Bootstrap
binds separate capabilities to the control plane, execution observer, gate observer, and one exact
broker identity. Each channel has a closed producer/kind matrix. The ingress verifies artifact
existence, size, content digest, task/contract/policy identity, and—for resource evidence—the exact
canonical isolation record and claims. An unknown capability or attempted producer impersonation
fails before the append-only ledger changes. Any future process or HTTP boundary must authenticate
to one of these narrow channels; it may not expose the raw evidence repository.

## Execution, PR, merge, and release controls

Each attempt starts from the contract's exact base commit in a dedicated Git worktree and OS-level
sandbox. The default is no network, no secrets, repository read, and only an explicit command set.
An implementer receives workspace write only inside that worktree. Limits apply to the whole process
tree, output, time, tokens, tools, cost, changed files/lines, concurrency, and repair count.

Baseline gate profiles 1.3 conservatively intersect every allowed write-scope glob with the
protected-path rules before execution and bind request/qualification/specification/plan evidence to
the compiled contract digest. Exclusions cannot lower this ceiling: a broad or ambiguous scope
receives the highest tier it could reach, while the exact changed paths are classified again after
execution. This prevents an under-classified worker from touching an R3/R4 path before the post-run
diff exists. The policy also pins instantaneous resource profiles by risk tier. The narrower
task/skill process count wins. On supported Linux hosts, every provider and gate command must first
be wrapped in a unique transient systemd user scope with cgroup `TasksMax`, `MemoryMax`, zero swap,
and `CPUQuota`; there is no no-op fallback. Deterministic repository commands then run inside
Bubblewrap within that scope, and the wrapper removes its user-manager environment before the target
starts. Each successful execution and gate emits a canonical resource-isolation record, and policy
denies a PR when any successful worker or sandboxed gate lacks matching provenance.

Policy bundle 1.4 uses `agentlab.factory-policy.v2` to pin a strict `agentlab.cost-policy.v1`. Every
rule names one exact provider/model coordinate and selects either integer token-rate accounting or
provider-reported cost; wildcard/default pricing is forbidden. Both preparation and execution
preflight the pinned policy digest and exact model before a durable run-start or provider process.
The executor repeats that check, then replaces adapter cost with the policy-accounted micro-USD
value. Token rates use overflow-checked integer arithmetic and round up. Provider-reported cost is
accepted only with complete structural usage; Claude totals aggregate all per-model direct and
cached tokens and reject an explicitly unknown pricing basis. The unchanged v1 run artifacts remain
replayable because their existing contract/authority digest already pins this policy. Evidence adds
the policy digest, completeness bit, and final cost. The repository default contains no live rate
rules, so autonomous runs remain fail-closed until reviewed rates are provisioned.

`npm run test:factory-sandbox` is the adversarial host test: it reads the live process cgroup to
verify exact CPU/memory/process ceilings, confirms an over-memory workload is killed, and exercises
Bubblewrap with a distinct network namespace, writable workspace, hidden source repository, and
read-only dependencies. It also exercises both single-process preparation recovery and
multi-operation execution-workspace recovery against the live systemd user manager. The distinct
`factory-sandbox` Ubuntu CI job provisions those host dependencies and runs the same command; a
unit-only pass is not a substitute for that job. Its credentialless ephemeral runner explicitly
permits unprivileged user namespaces before invoking Bubblewrap; production hosts must satisfy the
same preflight through their own narrowly governed host policy.

The model-bearing job never receives remote write authority. It emits a content-addressed patch and
structured proposal. A separate broker process/job, with no provider key and a short-lived
repository-scoped token, independently verifies contract/policy digests, base SHA, scope and
protected paths, patch size, required successful evidence, reviewer independence, expiry, and
budget. It may then open or update only a draft PR. Broker limits bound title/body size, file count,
labels, reviewers, and one PR per deduplication key.

The concrete GitHub App credential adapter is bound at construction to one lowercase repository, its
numeric repository ID, one installation, and one App client ID. For each mint it loads the RSA
private key only at the signer boundary, issues GitHub's bounded JWT, erases both mutable key
buffers after signing, and calls only the fixed installation-token endpoint with the exact
repository ID and `checks:read`, `contents:write`, plus `pull_requests:write`. It accepts the result
only when GitHub reports that exact selected repository, no broader permissions, and a safe short
lifetime. Concurrent requests coalesce; the token is refreshed five minutes before expiry and
invalidated after an HTTP 401 or failed Git push. The variable-length token is never placed in a
URL, argv, artifact, or error.

The remote authority plane has its own exact package entry, `@agentlab/runtime/factory-broker`, and
is absent from the interactive runtime entry. Its strict `agentlab.local-factory-broker.v1`
configuration binds the database, artifact and temporary roots, lowercase repository name and
numeric ID, broker ID, absolute Git executable, App client and installation IDs, private-key path,
and exact trusted GitHub App ID for each required `verify` and `factory-sandbox` status context. A
same-named check from another App is treated as missing. The config and key must be canonical
owner-only regular files with one link; reads are bounded and reject metadata changes. A retryable
owner drains admitted work, clears cached credentials, closes all three SQLite repositories in
reverse order, and releases the writer lease only after repository closure is confirmed.

The v1 broker config remains supported and deliberately cost-blocked. The additive
`agentlab.local-factory-broker.v2` form requires a canonical absolute `costPolicyPath`. Before any
runtime object is built, the same owner-only stable-file reader loads and strictly validates that
separate `agentlab.cost-policy.v1` document. This gives future isolated worker and broker processes
one shared rate-card artifact without giving a model-bearing process broker credentials. A changed
file produces a changed enclosing policy digest; tasks pinned to another digest fail closed. No live
rates are committed in this repository.

The CLI has non-authorizing broker and worker preflight commands. They report deterministic
non-secret JSON and close their runtimes before output. Normal SQLite initialization may still apply
local schema migrations. A blocked result exits 2; an inspection or cleanup failure exits 1 without
emitting a misleading readiness record. The separate `broker-open-draft` command is the only initial
remote-write entry: exact argument order binds an owner-only config, task UUID, expected policy
digest, and literal `--confirm-draft`. It does not call the write port unless broker preflight is
clean and the policy pin matches; the inner service independently rechecks task state, exact
evidence and complete usage, base revision, governance, authority, and policy around durable
idempotent dispatch. The authority switch still defaults off, and no broker or worker command can
change it. The separate `@agentlab/runtime/factory-authority` entry is the local human
administration boundary. Its owner-only v1 config pins only the durable ledger and operator ID; its
port can inspect controls and atomically compare-and-set `scheduler` or `pr-broker` through distinct
commands while appending one canonical human event. Exact expected state, opposite desired state,
bounded reason, and the matching control-specific literal confirmation are mandatory. It has no
scheduler execution, worker, provider, process, GitHub, broker, tmux, terminal, or interactive
capability, and architecture fitness tests enforce that closure. OS account/file ownership
authorizes the local operation; operator ID is audit metadata rather than cryptographic personhood.
Live key/config provisioning plus successful preflights are activation work, not assumptions. An
empty rate card both adds `cost-policy-unconfigured` to preflight and denies draft mutation itself.

The separate `broker-update-draft` command is the only repaired-branch write entry. Exact arguments
bind the same owner-only config to a task UUID, repair-authorization digest, policy digest, and
literal `--confirm-update`. Its service admits only the exact completed repair journal and evidence,
complete cumulative usage, allowing policy, authenticated prior PR record, unchanged base and
governance, and enabled broker switch. It cannot start a model, reserve another repair, merge, or
release.

The separate `broker-observe-pr` command is a credentialed read-and-local-evidence operation, not a
remote-write entry. Exact argument order binds the owner-only broker config, task UUID, expected
policy digest, and literal `--confirm-observe`. After clean preflight it resolves only a completed
durable dispatch, rechecks task/contract/proposal/record/broker identity, and reads the exact PR.
Formal reviews, inline review comments, PR conversation comments, and check runs are bounded below
one full 100-item page so pagination can never be silently discarded. Required checks match both
configured context and App ID on the observed head; a same-named run from another producer has no
authority. Canonical `agentlab.pull-request-observation.v1` stores raw feedback in fields named
`untrustedBody`, while the CLI reports no feedback body. A deterministic facts-only assessment can
report drift, trusted-check failure, formal changes requested, pending checks, or feedback awaiting
classification, but cannot interpret text, widen scope, update a branch, start repair, or change
task state.

The separate `worker-run` command requires an exact task UUID, expected policy digest, and literal
`--confirm-run`. It ignores only `scheduler-disabled` and `schedule-policy-unconfigured` during
manual readiness; cost, host, toolchain, storage, provider, gate, and policy drift remain blocking.
A generated correlation UUID binds the complete attempt. The resumable runner first reconciles any
in-flight preparation or execution journal, then sequences only the existing preparation,
materialization, admission, and bounded execution services under the worker coordinator's one-writer
queue. It rejects mismatched preparation/task/execution identities, stops on human, policy, or
terminal outcomes, and ends at `pr-proposed`. Its composition and CLI closure remain mechanically
unable to reach GitHub, broker credentials, authority mutation, merge, or release code.

Bounded scheduler admission is now implemented as a one-shot command inside that same credentialless
worker closure. Strict `agentlab.schedule-policy.v1` fixes one daily UTC time, a start deadline,
candidate/task limits, and an aggregate tick budget. Owner-only worker config v2 loads the policy
from a separate canonical file; v1 remains valid for manual work and cannot smuggle in a schedule.
The command requires both the exact schedule-policy digest and factory-policy digest. It admits only
immutably `scheduled` intake, requires clean host/cost readiness plus the human scheduler switch,
and reserves each task's complete authority budget ceiling before model work. SQLite v11 stores one
immutable run per stable schedule ID/slot and the append-only sequence
`registered → task-claimed → task-finished`, with bounded `task-skipped` events before one
`completed` event. A claim containing the request/authority digests and task correlation is durable
before the existing task runner starts. An ambiguous crash therefore retries the exact correlation
and its existing journals; a duplicate tick for a completed slot is side-effect free. A new run
after its start deadline is refused, while an existing active run remains recoverable. The scheduler
cannot mutate controls, reach broker credentials, open or update a PR, merge, release, or install
its own timer. No live policy, timer, or scheduler authority is provisioned.

Remote dispatch is itself durable and replayable. `agentlab.pull-request-dispatch.v1` binds one task
to the exact canonical proposal, proposal digest, broker identity, creation time, and correlation ID
before the first remote side effect. Its five-event SQLite v8 journal is immutable and append-only:

```text
ready → dispatch-active → remote-open → evidence-recorded → completed
```

The Git commit generated from a replayed proposal is deterministic because the base, patch, title,
and timestamp are pinned. The broker reuses an existing branch only when its head is exact; it
reuses an existing PR only when its repository, branch, base, head, draft state, title, and body are
exact. A crash after branch push resumes PR creation without another push. A lost successful API
response is recovered by bounded branch-filtered PR readback. The application separately persists
the validated remote record, authenticated evidence bundle digest, and exact `pr-open` task-event
digest. Injected failures after each checkpoint prove that a retry creates neither a second commit
nor a second PR. A checkpoint that observes revocation performs no new write. If revocation races an
already in-flight call, the exact remote result is journaled but cannot authorize the task
transition; the dispatch remains recoverable for operator action.

PR CI observation now binds the actual head SHA, exact check context and App ID, bounded formal
reviews, inline comments, conversation comments, the durable PR record digest, and one authenticated
evidence bundle. A separate confirmed admission command now creates an immutable
`agentlab.pull-request-repair-authorization.v1` only for the exact latest actionable observation. It
selects formal exact-head changes-requested reviews from trusted human repository associations,
their linked inline comments, and failed checks from pinned producers by IDs, never by interpreting
or copying raw feedback. Complete initial usage determines the next remaining contract repair slot;
an outstanding authorization prevents a second reservation. Admission is idempotent and performs no
model execution, task transition, or remote write.

The separate `worker-repair-pr` command now consumes that exact authorization. Its immutable
`agentlab.pull-request-repair-run.v1` header and SQLite v9 append-only journal are durable before
the model starts and bind the task/contract/policy, authorization, observation, prior patch, exact
base, cumulative repair slot, and correlation ID. The credentialless worker creates a fresh
exact-base worktree, reapplies the prior patch, resolves only the selected feedback IDs from
authenticated local observation evidence, labels all bodies untrusted, and permits one repairer
attempt. It then repeats the complete gate profile and requires a distinct identified read-only
reviewer. Cumulative time/token/tool/process/output/cost usage is carried forward from initial
execution; exhaustion or incomplete accounting becomes `needs-attention`. A crash is reconciled
through exact journal-owned process/worktree coordinates and cannot reuse the consumed
authorization. Success returns to a new local `pr-proposed` checkpoint. The worker still has no
remote credential or write port. A separate broker operation now consumes that completed repair. Its
immutable `agentlab.pull-request-update-proposal.v1` and SQLite v10 five-checkpoint journal bind the
exact prior PR authority record/head, repair authorization and run, repaired patch, policy,
repository, broker, and repair slot before a remote side effect. The Git adapter rebuilds the full
repaired tree from the contract base, makes the prior remote head the new commit's sole parent, and
uses a normal non-force push. Retry accepts only the exact deterministic already-applied head. The
broker verifies the draft, records authenticated update evidence, returns the task to `pr-open`, and
promotes the completed update record as the sole input to re-observation and the next repair cycle.

Repository rules remain the merge authority: required status checks, conversation resolution,
stale-review dismissal, last-push approval, CODEOWNERS for protected paths, linear history, and a
merge queue where enabled. The current repository already requires the strict `verify` check and the
distinct live `factory-sandbox` check, dismisses stale reviews, applies protection to
administrators, forbids branch deletion and force-push, and protects linear history. Its required
approval count is zero, latest-push approval is off, and no CODEOWNERS policy or required code-owner
review exists. All are explicit preflight blockers for agent-originated PRs.

The existing release workflow, asset names, checksums, SBOMs, build and SBOM attestations, immutable
release, registry comparison, and OIDC publishing remain unchanged. Release automation accepts only
an annotated tag on the reviewed main commit. Before agent-originated releases, the release
environment must require non-bypassable reviewers, and production canary/rollback evidence must be
part of the task.

## Budgets, circuit breakers, and scheduling

Budgets exist at skill, attempt, task, repository/day, and organization/day levels. The narrower
ceiling wins. Initial R1 brokered-PR defaults are one active task per repository, one implementer,
one distinct reviewer, 45 minutes, two repair attempts, 500 tool calls per worker, 20 changed files,
500 changed lines, no network, no agent secrets, at most three draft PRs and a configured cost
ceiling per day. R2 increases require an explicit repository profile; R3 write work is
human-approved; R4 never writes.

Per-run accounting and one scheduler tick's conservative reservation are implemented. Before a task
claim, the scheduler adds the task authority's complete budget ceiling—not an optimistic estimate—to
the slot's recorded reserved usage and skips candidates that would exceed any tick dimension.
Repository/day and organization/day ledgers are not implemented, and neither task nor tick policy is
a provider-side hard spending guarantee.

Any secret access/exfiltration signal, remote-write attempt from an execution worker, protected-path
bypass, attestation mismatch, policy tampering, or critical sandbox failure immediately quarantines
the task and pauses its repository lane. Initial operational circuit breakers also pause new work
after two rollbacks in a rolling ten-task window or a gate-failure rate above 30% in that window.
Thresholds are policy versions, not prompt text. A human may resume only by recording a new decision
and contract.

Current scheduling uses deduplicated owner-confirmed intake, one exact daily UTC slot, a bounded
candidate list, task count, start deadline, per-tick reservation ceiling, SQLite single-writer
lease, prior-day open-run reconciliation, and a separate human kill switch. Multiple open runs or
policy drift on an open run fail closed before a new slot. It does not yet implement blackout
windows, repository/day or organization/day quotas, global concurrency/cost coordination, or
autonomous maintenance discovery. The scheduler runs only already-authorized R1 requests and stops
at a local proposal; it does not invent R2-R4 scope. Future maintenance discovery must start in
read-only inventory/shadow mode and advance only through the eval and canary policy.

## Evaluation, canary, rollback, and incidents

Every provider/model/harness/skill/policy change is itself a versioned factory release. A golden
task bank covers request qualification, scope classification, implementation, regression repair,
prompt-injection resistance, secret handling, stale-base behavior, reviewer independence, and broker
denial. Multiple matched trials measure variance. Deterministic code/test/security graders are
primary; read-only model graders add semantic coverage; humans periodically calibrate both. Trace
and outcome data are kept with evidence, subject to retention and redaction policy.

Rollout stages are: offline fixtures, read-only shadow runs, local patch generation with no broker,
brokered draft PRs on selected R1 repositories, and limited R1 auto-open. Human merge remains the
default. A challenger advances only when it has no critical safety regression, meets task-success
and false-positive thresholds with confidence bounds, stays within cost/latency budgets, and passes
a human sample. Infrastructure, time, and concurrency are matched so small score changes are not
mistaken for model improvement.

The kill switch stops scheduling, revokes broker/release credentials, and preserves running
evidence. Rollback pins the last-known-good policy, skills, provider/harness configuration, and
release artifact. A production regression creates a highest-priority rollback task, but rollback
authority still belongs to the release system/human policy. Incidents quarantine affected tasks,
preserve logs and hashes, rotate possibly exposed credentials, identify all derived PRs/releases,
notify owners, restore service, and produce a post-incident policy/eval update before autonomy
resumes.

## Executive measures

The executive scorecard emphasizes accepted outcomes and risk, never raw agent activity:

- accepted and merged PR rate by risk tier, change class, provider, and repository;
- request-to-PR, PR-to-merge, and merge-to-release lead time; queue age and stuck-task rate;
- first-pass gate rate, repair-loop distribution, review findings, escaped defects, change-failure
  and rollback rates, and canary/SLO impact;
- independent-review and evidence completeness, policy denials/overrides, protected-path or secret
  violations, quarantines, and mean time to detect/recover;
- cost, tokens, compute, and human minutes per accepted/merged PR, plus abandoned-work cost;
- eval success and safety rates with confidence intervals, drift, flake rate, and production-vs-eval
  correlation.

Lines changed, commits, agent turns, and PR count are diagnostic capacity measures, not success
metrics.

## Phased implementation

Implementation status on 2026-08-31: phases 1–3 and the draft-only mechanics of phase 4 exist behind
ports with focused fail-closed tests. The governed request-to-contract path now also has trusted
authority issuance, provider-neutral read-only workers, a crash-durable preparation journal,
canonical run capture/replay, bounded retries and terminal states, and atomic task/evidence
materialization. Authenticated channel-bound evidence ingress and mandatory systemd/cgroup resource
isolation are implemented. The target-host CI lane now exercises both cgroup enforcement and the
Bubblewrap filesystem/network boundary. Post-contract execution now has an immutable run header,
append-only resource journal, caller-owned worktree/agent/gate identities, canonical agent requests,
and deterministic restart recovery through the shared reconciler. The live sandbox, preparation
recovery, and multi-operation execution recovery preflights pass on the current Linux development
host. Draft-PR dispatch now also has an immutable exact-proposal run, SQLite v8 checkpoint journal,
deterministic branch/PR reconciliation, injected recovery tests spanning remote creation, evidence
append, and task-ledger transition, and an exact-repository GitHub App installation-token source. An
exact broker-only package entry, owner-only config/key loader, retryable resource owner, and
non-authorizing CLI preflight now compose that authority plane without importing provider adapters.
The separate owner-only human authority composition now supplies status plus distinct atomic
compare-and-set enable/disable commands for the scheduler and draft-PR switches. It records
canonical append-only events under a pinned operator ID and is mechanically isolated from the
broker, GitHub, providers, execution, and scheduler execution. The broker and worker cannot
self-enable, and the authority process cannot run work or perform a remote write. The
provider-neutral, policy-pinned per-run cost accountant and pre-spawn admission checks also exist
behind the separate worker port. Owner-only config v2 provisions the broker's canonical copy of the
rate card, and the worker composition loads the same separate owner-only document without receiving
broker credentials. The worker has a read-only fixed-argv host preflight that also proves canonical
owner-only artifact and worktree roots, an exact provider/gate inventory, a globally serialized
32-command queue, recovery access under normal-work blockers, and retryable process/repository/lease
shutdown. Its public closure is mechanically barred from GitHub, broker, tmux, terminal, interactive
discovery, and every provider module except the explicit factory adapter allowlist. The default
bundle remains empty. The normal TUI has no enable or PR action; explicit non-interactive human
commands can change only one named local switch at a time, while the explicit draft command remains
blocked by current governance and provisioning controls. The explicit worker task command now
supplies the local request-to-proposal driver, and the authorization-bound repair command has its
own immutable SQLite v9 journal, fresh isolation, cumulative budgets, repeated gates, distinct
review, and deterministic crash recovery. A one-shot daily scheduler now adds a strict owner-only
policy, exact dual-digest pins, full-ceiling tick reservations, scheduled-only selection, a distinct
human switch, and an immutable SQLite v11 claim/recovery journal. Duplicate and interrupted ticks
are tested, but AgentLab installs no timer. No live configuration has been provisioned or invoked.
No live authority change, agent task, PR, deployment, or publication has been performed through this
code.

The pre-contract intake is now a fifth mechanically separate runtime entry,
`@agentlab/runtime/factory-intake`. It loads an owner-only configuration plus separately protected
cost policy, repository authority grant, and exact canonical skill packages. A strict owner-authored
feature/bug submission cannot assert task, actor, base revision, timestamps, policy, digest, or
authority. Preflight observes the active conversation and Git commit and proves an R1-only,
worker-supported, fully cost-accounted grant. Registration requires the reviewed policy digest and a
trigger-specific literal confirmation, publishes all pinned packages, then atomically appends the
immutable request, authority, and initial event. Repository/kind/source deduplication makes exact
retries safe while changed content or authority fails closed. This composition has no provider,
execution, control switch, GitHub, broker, or release path. No live intake configuration or task has
been created.

Branch protection now requires both exact GitHub Actions checks, `verify` and `factory-sandbox`,
dismisses stale reviews, applies rules to administrators, and forbids force-push/deletion. Phase 4
activation remains blocked by zero required approvals, missing latest-push approval, missing
CODEOWNERS and required code-owner review, unprovisioned live broker config/key, and incomplete live
cost-policy provisioning. A dedicated owner-only live authority config is also not provisioned. An
incomplete usage record already denies PR creation. The non-authorizing preflight reports these
governance, empty-cost-policy, and default-off-authority blockers rather than weakening them.

1. **Safety kernel:** versioned intake/qualification/specification/plan/authority/skill/task/event/
   evidence schemas, digest-linked preparation compiler, explicit state machine, this ADR, and
   architecture fitness tests. No agent or remote write authority.
2. **Local control plane:** canonical hashing, append-only SQLite task ledger, content-addressed
   evidence store, deterministic risk classifier/gate policy, actor/session separation, budgets,
   audit queries, and kill switch.
3. **Isolated execution:** worktree and sandbox lifecycle, provider-neutral non-interactive runner,
   digest-pinned skill resolver, implement/verify/review/repair attempts, authenticated evidence
   channels, cgroup CPU/memory/process enforcement, bounded logs, durable resource coordinates, and
   deterministic crash recovery. A separate credentialless worker composition now owns these ports,
   serializes work, retains its writer lease until cleanup is conclusive, and exposes one explicit
   policy-pinned resumable task command that stops before remote writes.
4. **Minimal brokered-PR loop:** the internal preparation, exact-base worktree, one implementer,
   deterministic `verify`, one distinct read-only reviewer, hashed patch/evidence, concrete local
   crash reconciler, and separate draft-only broker mechanics exist. The target-host
   recovery/sandbox CI, credentialless worker composition, isolated exact-repository credential
   adapter, broker-only composition, owner-only key provisioning boundary, operator preflights, and
   fail-closed explicit draft command now exist. A separate governed intake composition now creates
   the immutable preparation root from an owner-confirmed feature or bug report, and a separate
   human-only authority composition owns atomic switch enable/disable without broker or scheduler
   execution capability. The explicit worker task command now connects intake to the local
   broker-ready proposal checkpoint without joining worker and broker authority. A separate bounded
   read command records exact-head trusted checks and untrusted review feedback. A separate
   admission command selects actionable facts, and the credentialless repair command consumes one
   immutable authorization in a fresh worktree, repeats all gates and independent review, and stops
   before a remote branch update. A separate confirmed broker command now advances only that exact
   repaired draft through a deterministic non-force child commit, crash-durable journal,
   authenticated evidence, and re-observable head lineage. Activation still requires the missing
   review protections, provisioned live key/config and exact cost rules, passing live preflights,
   separate human execution of the authority ceremony, and human merge. No scheduler, auto-merge,
   release, or protected-path write is live; the local scheduler code stops before the broker.
5. **CI repair and operations:** credential rotation/monitoring, CODEOWNERS/last-push/approval
   rules, dashboards, alerts, quotas, and incident tooling. Deterministic feedback qualification,
   bounded fresh repair execution, brokered repaired-branch update, and exact-head re-observation
   now exist. One policy-pinned daily scheduler tick, durable claim recovery, and tick reservation
   ceiling now exist; cross-repository/day quotas, timer provisioning, alerting, and incident
   automation do not.
6. **Eval and canary program:** golden suites, repeated trials, shadow cohorts, production sampling,
   provider/model/skill promotion, daily R0 then selected R1 scheduling, and rollback drills.
7. **Controlled shipping:** merge queue and release/canary integration. Any R1 auto-merge is a new
   explicit ADR/policy approval; higher-risk human controls remain.

The minimal loop is safe enough to enable brokered draft-PR creation only when phases 1–4, the
repository-governance blocker, isolated broker identity, and complete usage accounting are all
complete, with exact live cost rules provisioned. Activation also requires authenticated
evidence-ingestion paths and OS-enforced process/CPU/memory ceilings for untrusted agent and
repository code. Those mechanisms and the required target-host CI lane now exist; the configured
broker preflight must still report ready under independently reviewed repository policy, including a
reviewed non-empty rate card, before activation. Until then, authority remains default-off and
preflight prevents the explicit CLI command from reaching the remote-write port.

## Consequences and fitness functions

This design adds durable machinery and operational cost, but it keeps probabilistic work behind a
small deterministic authority surface. Provider or harness replacement does not rewrite task
history, policy, or evidence. Local operation remains useful without GitHub; the broker is an
optional outer adapter.

Each implementation slice must add focused happy-path, malformed-input, stale-state, timeout,
crash-recovery, replay, privilege, prompt-injection, and fail-closed tests. Architecture checks must
classify any new bounded-context source roots and keep the graph acyclic. Full type checking, lint,
tests, integration tests, build, package verification, and the existing release controls remain
mandatory.

This ADR does not authorize an HTTP server, browser renderer, remote agent control plane, dynamic
provider plugins, unattended merge, release, production access, or a long-lived repository token.
Each is outside the current implementation and requires its own explicit compatibility and security
decision.
