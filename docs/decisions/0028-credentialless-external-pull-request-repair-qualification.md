# ADR 0028: Credentialless external pull-request repair qualification

**Status:** Accepted; implemented but not provisioned or activated

## Context

ADR 0027 deliberately ends at a closed-workspace patch bundle. Publishing that model-authored patch
without a deterministic quality floor and a reviewer independent from the repairer would turn one
agent result directly into remote repository authority. Running qualification inside the future
GitHub publisher would instead place untrusted repository content, provider execution, and a remote
credential in one process. Retrying an interrupted gate or reviewer after its process may have
started would also make the evidence ambiguous.

## Decision

Add a separate `@agentlab/runtime/factory-external-pull-request-repair-qualification` composition.
It may read completed repair evidence, reconstruct one exact local patch, execute reviewed gates in
an offline bubblewrap/systemd boundary, and invoke pinned providers as read-only reviewers. It has
no GitHub client, App credential, remote-repository port, broker, merge, deployment, release, tmux,
terminal, or interactive path. Architecture checks enforce that closed allowlist.

The canonical qualification policy embeds and hashes the exact ordered R1 gate floor: format,
architecture, typecheck, lint, test, build, and secret scan. Each gate fixes its executable path and
SHA-256, arguments, timeout, output ceiling, and evidence kind. The owner-only configuration loader
hashes canonical executable files through no-follow descriptors before runtime construction. It also
mutually verifies the qualification, execution, cost, role, gate, reviewer-skill, repository, and
provider coordinates. The execution policy pins the future qualification-policy digest, while
qualification is rooted through the completed execution run and bundle, avoiding a policy hash
cycle.

Reviewer profiles are filesystem/Git read-only, network-off, secretless, command-allowlist-free, and
have no remote authority. Process mode is provider-enforceable: Codex uses its read-only
sandboxed-process adapter and Claude uses no process capability. Reviewer IDs, execution IDs, and
provider session IDs must differ from the repairer; reviewer sessions must differ from each other.
The policy reserves every mandatory gate and selected reviewer within the aggregate budget and
deadline. R1, replacement-draft publication, and false remote-write, auto-merge, and release flags
are structural constants.

One completed schema-v24 repair bundle creates one schema-v25 qualification run. The worker verifies
the canonical repairer record, exact local head, repaired patch digest, and change set before work.
It records durable intent before every gate and reviewer process. Gate failure records rejection and
skips review. Passing gates require the complete independent-review quorum; unanimity qualifies or
rejects, while split verdicts require a human. The final bundle includes the exact repaired patch,
gate observations and isolation records, reviewer requests/records/results, aggregate usage, policy
lineage, and confirmation that the unchanged workspace closed.

Stable pre-process states may recover by rebuilding the same exact worktree within the configured
limit. An interrupted `gate-active` or `reviewer-active` process is reconciled and quarantined,
never blindly rerun. SQLite makes runs, event chains, and bundles immutable and revalidates
canonical/transitive evidence at every repository boundary.

## Consequences

AgentLab can now produce auditable local evidence that one repaired external patch passed the
mandatory quality floor and an independent review. That bundle is not publication authority and the
composition cannot write GitHub. Contributor/fork-safe replacement-draft creation, exact-head
re-observation, merge, deployment, release, canary telemetry, and rollback remain separate future
authority planes.
