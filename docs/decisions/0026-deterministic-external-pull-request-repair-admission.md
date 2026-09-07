# ADR 0026: Deterministic external pull-request repair admission

**Status:** Accepted; implemented but not provisioned or activated

## Context

ADR 0025 can publish independent review evidence, but a review decision is not execution authority.
Allowing a reviewer, feedback publisher, or worker to mint repair permission would combine duties
and let model-generated text control execution. External pull requests also lack AgentLab's internal
task contract, so the existing canary repair authorization cannot be reused without inventing
lineage.

## Decision

Add a separate `@agentlab/runtime/factory-external-pull-request-repair-admission` composition. It
has no provider, process runner, workspace, GitHub client, credential, branch mutation, merge,
deployment, or release path. It runs under a pinned non-root UID, uses the existing default-off
scheduler switch, and atomically consumes only a completed schema-v21 review bundle joined to its
completed schema-v22 feedback publication.

One canonical policy pins the repository, review and feedback policies, future repair-execution
policy, cost policy, role-identity policy, gate profile, reviewed skill-package digests, author/fork
rules, severity floor, changed-file/line and finding ceilings, evidence age, expiry, per-tick limit,
and an R1 ceiling. Every CLI tick repeats all downstream policy pins.

The deterministic decision requires unanimous `changes-requested` reviewer verdicts, complete
changed files, an admitted author/fork, fresh evidence, and at least one bounded finding at or above
the reviewed severity floor. The authorization contains only exact evidence digests, Git
coordinates, reviewer/finding IDs, downstream policy digests, and one repair attempt. It never
contains contributor or review prose. It hard-codes `replacement-draft`, `remoteWrite=false`,
`autoMerge=false`, and `release=false`.

SQLite schema 23 records denials and authorizations immutably with one decision per
bundle/admission-policy digest. Database triggers root every decision in the exact completed
feedback journal and bind each authorization to its authorized decision. A scheduler revocation
immediately before persistence prevents new authority.

## Consequences

AgentLab can make an auditable, idempotent decision about whether an externally reviewed PR may
enter a separate repair worker. This admission plane still cannot interpret feedback, create a
workspace, run a model, push a branch, open a draft, merge, deploy, or release. ADR 0027
subsequently adds the separate credentialless one-attempt execution plane; remote publication
remains a distinct future broker decision.
