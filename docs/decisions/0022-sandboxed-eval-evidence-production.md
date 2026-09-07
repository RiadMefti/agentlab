# ADR 0022: produce eval evidence in a separate offline sandbox boundary

**Status:** Accepted; implemented but not provisioned or activated

**Date:** 2026-09-01

## Context

The promotion chain already validates matched samples, computes deterministic policy, signs exact
run bytes, verifies the signature, and requires separate human canary authority. It previously
trusted an externally supplied `agentlab.eval-run.v1`, so the repository could not itself prove
which reviewed harness, fixture, seed, executable, budget, isolation scope, or raw artifact produced
each sample.

This boundary follows the versioned-data, repeated-trial, explicit-grader approach in
[OpenAI's eval guidance](https://developers.openai.com/api/docs/guides/evals), the independent
task/transcript/outcome and human-calibration guidance in
[Anthropic's agent-eval guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
and the authenticated-statement separation in the
[in-toto Attestation Framework](https://github.com/in-toto/attestation/blob/main/spec/v1/README.md).
It does not claim SLSA provenance and does not make an untrusted harness truthful.

## Decision

Add a fourth exact promotion composition: `@agentlab/runtime/factory-eval-producer`. It is an
offline, credentialless gate runner that can produce one complete matched run but cannot assess,
sign, authorize, schedule, contact GitHub, merge, release, or mutate product source.

The owner supplies one canonical `agentlab.eval-production-job.v1` and its expected SHA-256 digest.
The job embeds and pins the suite, case bank, baseline and challenger candidates, separate subject
harness descriptors, deterministic grader descriptor, fixture references, unique per-trial seeds,
per-invocation budgets, aggregate budget, process limits, runner identity, creation time, deadline,
and correlation ID. Candidates must share repository and base revision. The suite and bank must
describe the exact same ordered Cartesian matrix. The aggregate ceiling must reserve the sum of all
baseline, challenger, and grader invocation ceilings before the first process starts.

Each harness/grader descriptor fixes protocol `agentlab.eval-harness-protocol.v1`, `network:"off"`,
`secrets:false`, semantic version, and exact executable digest. A separate owner-only local config
maps descriptor digests to administrator-installed absolute executables and their reviewed content
digests. The resolver re-hashes the executable before every invocation; the executor re-hashes it
again after execution. The operating-system image, bubblewrap, systemd, mounted runtime libraries,
kernel, and local administrator remain the trusted computing base and require normal host
provisioning and change control.

Every invocation receives canonical JSON over stdin and a fixed `subject` or `grade` argument. It
runs in a transient systemd user scope with job process/memory/CPU ceilings, inside bubblewrap with
all namespaces unshared, no inherited environment or secrets, an empty home, no host root mount, and
one ephemeral writable `/workspace`. `/usr` and explicitly configured runtime roots are read-only.
The command has a hard wall-clock timeout and bounded control input/output. Fixtures and prior
outputs enter through exact private files; successful outputs must be non-symlink, single-link,
owner-only regular files inside the workspace and within individual byte ceilings.

Subject and grader responses are strict and must report complete usage covering observed elapsed
time and output bytes. The trusted producer stores raw output, trace, stdout, stderr, and grader
evidence in the content-addressed artifact store. Canonical evidence records bind request,
job/candidate/harness/executable, case/trial/seed/fixture, isolation, usage, timing, and artifact
digests. Only after every matched coordinate exists does it emit the existing strict
`agentlab.eval-run.v1`; downstream evaluation, signing, verification, and human review remain
unchanged and separate.

## Durability and recovery

SQLite schema 19 stores the immutable production job and append-only event chain:

```text
registered/ready
  → subject-started → subject-finished
  → subject-started → subject-finished
  → grader-started → sample-recorded
  → ... exact remaining matrix ...
  → completed
```

Any error instead appends `failed` with accumulated completed usage. A launched invocation also
stores canonical failure evidence plus bounded stdout/stderr; complete harness-reported usage is
charged when available, otherwise the full reserved invocation ceiling is charged conservatively.
Database triggers bind indexed identity, canonical JSON, job/correlation lineage, sequence, previous
digest, state transition, and monotonic time; update and delete are rejected. Exact retries return
the existing terminal result. Finished canonical subject evidence is reused after a normal restart.

A `subject-started` or `grader-started` event is the durable pre-execution checkpoint. On recovery,
the producer asks systemd for the exact UUID-derived scope. Active or uncertain state blocks without
journal mutation. Confirmed inactive state without terminal evidence becomes a terminal
`interrupted-execution` failure and is never rerun, because re-execution could duplicate cost or
produce unmatched stochastic evidence. The deadline is rechecked before every process launch.
Workspace cleanup must be exact and confirmed; unknown process-tree cleanup preserves the workspace
and active checkpoint for the same systemd recovery decision instead of recording false completion.

## Authority and activation

The producer is deliberately absent from the daily maintenance chain. Candidate evaluation is a
separate promotion ceremony, not ordinary task execution, and an unreviewed candidate cannot
schedule its own qualification. Operators may run only:

```text
agentlab factory eval-producer-preflight --config /absolute/producer.json --job /absolute/job.json --job-digest sha256:...
agentlab factory eval-produce --config /absolute/producer.json --job /absolute/job.json --job-digest sha256:...
```

The output run still grants no authority. It must pass the credentialless evaluator, isolated
attestor, independent verifier, human sample review, and human canary-authority steps. No config,
executable, timer, account, candidate, fixture, or job is shipped or activated.

## Deliberate exclusions

This decision does not provide hosted-provider credentials to eval harnesses, a secretless model
gateway, hardware-backed keys, transparency logging, automated case-bank curation, grader truth or
calibration, fleet quotas, telemetry canaries, merge, release, rollback, revocation, paging, or
incident automation. Provider-backed evals require a later narrowly scoped broker that preserves
secretlessness and records complete provider usage; the current producer supports only installed
offline harnesses.

## Fitness functions

Required checks cover strict contracts and digest substitution, complete budget reservation,
deadline edges, exact retry and crash recovery, append-only SQLite identity/transition triggers,
owner-only config/job input, executable re-hashing, sandbox mounts/environment, private bounded
outputs, complete usage, cleanup, fixed CLI coordinates, exact public exports, and a transitive
architecture allowlist that excludes providers, credentials, evaluator, signer, authority,
scheduler, broker, GitHub, merge, release, terminal, tmux, and the interactive runtime.
