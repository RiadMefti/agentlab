# ADR 0006: add a local-first software-factory control plane

**Status:** Accepted; implementation is staged

**Date:** 2026-08-30

## Context

AgentLab already has a strong local runtime: one captain per conversation, zero or more workers,
durable tmux sessions, nonce-proved ownership, a single-writer SQLite lifecycle, strict process and
terminal cleanup, provider adapters, executable dependency rules, comprehensive verification, and a
release chain with pinned Actions, checksums, SBOMs, attestations, immutable releases, and OIDC npm
publishing.

Those controls are necessary but not sufficient for a software factory. The current captain prompt
can ask workers to act, but prompts are not durable authority. AgentLab has no immutable unit of
work, skill provenance, isolated Git workspace per attempt, append-only task ledger, deterministic
risk policy, evidence bundle, independent-review proof, repair loop, scheduler, PR broker, or
bounded merge/release authority. Giving the current captain a long-lived GitHub token would turn a
useful local orchestrator into an unauditable privileged actor.

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
contract, the complete `intake → qualified → specified → planned` task-event chain, initial
evidence, and the preparation `prepared` marker. A forced late insert failure is tested to leave
neither a partial task ledger nor a false prepared marker. These paths remain internal: the Linux
recovery adapter is not composed or exercised in the supported target-host CI lane, and a
composition root, operator command/TUI, and activation controls are still required before a live
request can invoke them.

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

Baseline policy 1.3 conservatively intersects every allowed write-scope glob with the protected-path
rules before execution and binds request/qualification/specification/plan evidence to the compiled
contract digest. Exclusions cannot lower this ceiling: a broad or ambiguous scope receives the
highest tier it could reach, while the exact changed paths are classified again after execution.
This prevents an under-classified worker from touching an R3/R4 path before the post-run diff
exists. The policy also pins instantaneous resource profiles by risk tier. The narrower task/skill
process count wins. On supported Linux hosts, every provider and gate command must first be wrapped
in a unique transient systemd user scope with cgroup `TasksMax`, `MemoryMax`, zero swap, and
`CPUQuota`; there is no no-op fallback. Deterministic repository commands then run inside Bubblewrap
within that scope, and the wrapper removes its user-manager environment before the target starts.
Each successful execution and gate emits a canonical resource-isolation record, and policy denies a
PR when any successful worker or sandboxed gate lacks matching provenance.
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
private key only at the signer boundary, issues GitHub's bounded JWT, and calls only the fixed
installation-token endpoint with the exact repository ID and `contents:write` plus
`pull_requests:write`. It accepts the result only when GitHub reports that exact selected
repository, no broader permissions, and a safe short lifetime. Concurrent requests coalesce; the
token is refreshed five minutes before expiry and invalidated after an HTTP 401 or failed Git push.
The variable-length token is never placed in a URL, argv, artifact, or error. This adapter is still
internal: an operator-facing secret/key source and composition switch must exist before activation.

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

PR CI checks the actual head SHA. A failure appends evidence and may create a bounded repair attempt
in a fresh isolated worker; it cannot silently widen scope. The repaired patch repeats all gates and
independent review. Exhausted budget becomes `needs-attention`.

Repository rules remain the merge authority: required status checks, conversation resolution,
stale-review dismissal, last-push approval, CODEOWNERS for protected paths, linear history, and a
merge queue where enabled. The current repository already requires the strict `verify` check and
protects history, but its required approval count is zero; that is a blocker for agent-originated
PRs until at least one approval and protected-path ownership are configured.

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

Any secret access/exfiltration signal, remote-write attempt from an execution worker, protected-path
bypass, attestation mismatch, policy tampering, or critical sandbox failure immediately quarantines
the task and pauses its repository lane. Initial operational circuit breakers also pause new work
after two rollbacks in a rolling ten-task window or a gate-failure rate above 30% in that window.
Thresholds are policy versions, not prompt text. A human may resume only by recording a new decision
and contract.

Scheduling uses a bounded per-repository queue, deduplication keys, minimum intervals, blackout
windows, global concurrency/cost limits, and a kill switch. Daily maintenance starts in read-only
inventory mode. It may propose small R1 tasks only after the repository's eval and canary policy
permits that class; it does not invent R2-R4 scope.

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

Implementation status on 2026-08-30: phases 1–3 and the internal, draft-only mechanics of phase 4
exist behind ports with focused fail-closed tests. The governed request-to-contract path now also
has trusted authority issuance, provider-neutral read-only workers, a crash-durable preparation
journal, canonical run capture/replay, bounded retries and terminal states, and atomic task/evidence
materialization. Authenticated channel-bound evidence ingress and mandatory systemd/cgroup resource
isolation are implemented. The target-host CI lane now exercises both cgroup enforcement and the
Bubblewrap filesystem/network boundary. Post-contract execution now has an immutable run header,
append-only resource journal, caller-owned worktree/agent/gate identities, canonical agent requests,
and deterministic restart recovery through the shared reconciler. The live sandbox, preparation
recovery, and multi-operation execution recovery preflights pass on the current Linux development
host. Draft-PR dispatch now also has an immutable exact-proposal run, SQLite v8 checkpoint journal,
deterministic branch/PR reconciliation, injected recovery tests spanning remote creation, evidence
append, and task-ledger transition, and an exact-repository GitHub App installation-token source.
These paths are intentionally not wired into the public runtime or TUI. No live agent task or PR has
been created by this code. Phase 4 activation remains blocked until repository governance requires
at least one approval, dismisses stale reviews, requires approval of the latest push, applies rules
to administrators, forbids force-push/deletion, and requires the exact `verify` check. Complete
provider cost accounting must also be configured; an incomplete usage record denies PR creation. The
activation change must make the passing `factory-sandbox` job required, configure protected-path
ownership, compose the broker behind an operator boundary, and supply the App key from a separate
broker-only secret source.

1. **Safety kernel:** versioned intake/qualification/specification/plan/authority/skill/task/event/
   evidence schemas, digest-linked preparation compiler, explicit state machine, this ADR, and
   architecture fitness tests. No agent or remote write authority.
2. **Local control plane:** canonical hashing, append-only SQLite task ledger, content-addressed
   evidence store, deterministic risk classifier/gate policy, actor/session separation, budgets,
   audit queries, and kill switch.
3. **Isolated execution:** worktree and sandbox lifecycle, provider-neutral non-interactive runner,
   digest-pinned skill resolver, implement/verify/review/repair attempts, authenticated evidence
   channels, cgroup CPU/memory/process enforcement, bounded logs, durable resource coordinates, and
   deterministic crash recovery.
4. **Minimal brokered-PR loop:** the internal preparation, exact-base worktree, one implementer,
   deterministic `verify`, one distinct read-only reviewer, hashed patch/evidence, concrete local
   crash reconciler, and separate draft-only broker mechanics exist. The target-host
   recovery/sandbox CI and isolated exact-repository credential adapter now exist. Activation still
   requires the public composition/operator boundary, current branch protection including the
   sandbox check, broker-only key provisioning, complete accounting, and human merge. No scheduler,
   auto-merge, release, or protected-path write.
5. **CI repair and operations:** PR-head reconciliation, bounded fresh repair attempts, GitHub App
   identity, CODEOWNERS/last-push/approval rules, dashboards, alerts, quotas, and incident tooling.
6. **Eval and canary program:** golden suites, repeated trials, shadow cohorts, production sampling,
   provider/model/skill promotion, daily R0 then selected R1 scheduling, and rollback drills.
7. **Controlled shipping:** merge queue and release/canary integration. Any R1 auto-merge is a new
   explicit ADR/policy approval; higher-risk human controls remain.

The minimal loop is safe enough to enable brokered draft-PR creation only when phases 1–4, the
repository-governance blocker, isolated broker identity, and complete usage accounting are all
complete. Activation also requires authenticated evidence-ingestion paths and OS-enforced
process/CPU/memory ceilings for untrusted agent and repository code. Those mechanisms now exist; the
target-host CI lane and operator preflight must execute the live adversarial test before activation.
Until then, its authority switches default off and no public composition can invoke it.

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
