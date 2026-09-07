import type {
  FactoryArtifactReference,
  FactoryBudget,
  FactoryBudgetUsage,
  FactoryEvalCaseDefinition,
  FactoryEvalGraderEvidence,
  FactoryEvalProductionEvent,
  FactoryEvalProductionJob,
  FactoryEvalProductionResult,
  FactoryEvalSample,
  FactoryEvalSubjectEvidence,
  FactoryResourceLimits,
  Sha256Digest
} from "@agentlab/contracts";

import { ConflictError } from "../domain/errors.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type {
  FactoryEvalExecutableBinding,
  FactoryEvalExecutableResolver,
  FactoryEvalGraderExecutionInput,
  FactoryEvalHarnessExecutor,
  FactoryEvalProcessRecovery,
  FactoryEvalSubjectExecutionInput
} from "../domain/factory-eval-harness.js";
import { FactoryEvalProcessCleanupUncertainError } from "../domain/factory-eval-harness.js";
import {
  addUsage,
  assertFactoryEvalProductionJob,
  assertFactoryEvalProductionSnapshot,
  assertFactoryEvalSampleRecord,
  assertUsageWithinBudget,
  emptyUsage
} from "../domain/factory-eval-production-integrity.js";
import type {
  FactoryEvalProductionRepository,
  FactoryEvalProductionSnapshot
} from "../domain/factory-eval-production-repository.js";

const maximumEvidenceDocumentBytes = 8 * 1_024 * 1_024;

export interface FactoryEvalProductionServiceDependencies {
  readonly runnerId: string;
  readonly productions: FactoryEvalProductionRepository;
  readonly artifacts: FactoryArtifactStore;
  readonly executables: FactoryEvalExecutableResolver;
  readonly harness: FactoryEvalHarnessExecutor;
  readonly recovery: FactoryEvalProcessRecovery;
  readonly documents: Pick<
    FactoryDocumentCodec,
    | "configurationCandidate"
    | "evalCaseBank"
    | "evalGraderDescriptor"
    | "evalGraderEvidence"
    | "evalGraderRequest"
    | "evalHarnessDescriptor"
    | "evalInvocationFailureEvidence"
    | "evalProductionEvent"
    | "evalProductionJob"
    | "evalRun"
    | "evalSample"
    | "evalSubjectEvidence"
    | "evalSubjectRequest"
    | "evalSuite"
  >;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Produces one complete matched run; it cannot assess, sign, authorize, schedule, or write remotely. */
export class FactoryEvalProductionService {
  public constructor(private readonly dependencies: FactoryEvalProductionServiceDependencies) {}

  public async preflight(
    input: unknown,
    expectedJobDigest: Sha256Digest
  ): Promise<{ readonly jobId: string; readonly jobDigest: Sha256Digest }> {
    const job = this.#job(input, expectedJobDigest);
    this.#assertJobWindow(job.value);
    await this.#preflightInputs(job.value);
    return { jobId: job.value.jobId, jobDigest: job.digest };
  }

  public async produce(
    input: unknown,
    expectedJobDigest: Sha256Digest
  ): Promise<FactoryEvalProductionResult> {
    const job = this.#job(input, expectedJobDigest);
    let snapshot = await this.dependencies.productions.findByJobId(job.value.jobId);
    if (snapshot !== null) {
      assertFactoryEvalProductionSnapshot(snapshot, this.dependencies.documents);
      if (snapshot.jobDigest !== job.digest) {
        throw new ConflictError("Factory eval production job ID has different immutable data.");
      }
      const terminal = await this.#terminalResult(snapshot, "existing");
      if (terminal !== null) return terminal;
      snapshot = await this.#recoverDanglingExecution(snapshot);
      const recoveredTerminal = await this.#terminalResult(snapshot, "existing");
      if (recoveredTerminal !== null) return recoveredTerminal;
    } else {
      this.#assertJobWindow(job.value);
      const event = this.#event(job.value, job.digest, null, {
        kind: "registered",
        to: "ready",
        occurredAt: job.value.createdAt,
        reasonCode: "job-registered",
        detail: "Immutable eval production job registered."
      });
      snapshot = await this.dependencies.productions.register(job, event);
    }

    try {
      this.#assertJobWindow(job.value);
      return await this.#run(job.value, job.digest, snapshot);
    } catch (error: unknown) {
      if (
        error instanceof EvalRecoveryUncertainError ||
        error instanceof FactoryEvalProcessCleanupUncertainError
      )
        throw error;
      const current = await this.dependencies.productions.findByJobId(job.value.jobId);
      if (current === null) throw error;
      const terminal = await this.#terminalResult(current, "existing");
      if (terminal !== null) return terminal;
      const failed = await this.#append(
        current,
        this.#event(job.value, job.digest, current, {
          kind: "failed",
          to: "failed",
          ...lastCoordinate(current),
          ...(error instanceof EvalInvocationFailure
            ? { evidenceDigest: error.evidenceDigest }
            : {}),
          usage: terminalUsage(current, error),
          reasonCode: failureCode(error),
          detail: failureDetail(error)
        })
      ).catch((journalError: unknown) => {
        throw new AggregateError(
          [error, journalError],
          "Eval production and terminal failure journaling both failed.",
          { cause: error }
        );
      });
      return this.#result(failed, "failed");
    }
  }

  async #run(
    job: FactoryEvalProductionJob,
    jobDigest: Sha256Digest,
    initial: FactoryEvalProductionSnapshot
  ): Promise<FactoryEvalProductionResult> {
    await this.#preflightInputs(job);
    let snapshot = initial;
    const samples = await this.#recordedSamples(snapshot);
    for (const definition of job.caseBank.cases) {
      for (const [trialIndex, seedDigest] of definition.seedDigests.entries()) {
        const trial = trialIndex + 1;
        const key = sampleKey(definition.caseId, trial);
        if (samples.has(key)) continue;
        this.#assertBeforeDeadline(job);
        const fixture = await this.#readArtifact(definition.fixture);
        const existingBaseline = await this.#existingSubjectEvidence(
          snapshot,
          job,
          jobDigest,
          definition,
          trial,
          "baseline"
        );
        const baseline =
          existingBaseline === null
            ? await this.#subject(
                job,
                jobDigest,
                snapshot,
                definition,
                trial,
                seedDigest,
                "baseline",
                fixture
              )
            : { snapshot, evidence: existingBaseline };
        snapshot = baseline.snapshot;
        const existingChallenger = await this.#existingSubjectEvidence(
          snapshot,
          job,
          jobDigest,
          definition,
          trial,
          "challenger"
        );
        const challenger =
          existingChallenger === null
            ? await this.#subject(
                job,
                jobDigest,
                snapshot,
                definition,
                trial,
                seedDigest,
                "challenger",
                fixture
              )
            : { snapshot, evidence: existingChallenger };
        snapshot = challenger.snapshot;
        const graded = await this.#grade(
          job,
          jobDigest,
          snapshot,
          definition,
          trial,
          seedDigest,
          fixture,
          baseline.evidence,
          challenger.evidence
        );
        snapshot = graded.snapshot;
        samples.set(key, graded.sample);
      }
    }

    const ordered = job.suite.caseIds.flatMap((caseId) =>
      Array.from({ length: job.suite.trialsPerCase }, (_, index) => {
        const sample = samples.get(sampleKey(caseId, index + 1));
        if (sample === undefined) throw new Error("Eval production sample matrix is incomplete.");
        return sample;
      })
    );
    const subjectEvidence = await this.#subjectEvidence(snapshot);
    const graderEvidence = await this.#graderEvidence(snapshot);
    const startedAt = subjectEvidence.at(0)?.startedAt;
    const completedAt = graderEvidence.at(-1)?.finishedAt;
    if (startedAt === undefined || completedAt === undefined) {
      throw new Error("Eval production has no complete evidence time range.");
    }
    const run = this.dependencies.documents.evalRun({
      schemaVersion: "agentlab.eval-run.v1",
      runId: job.jobId,
      suiteDigest: job.suiteDigest,
      suite: job.suite,
      baselineCandidateDigest: job.baselineCandidateDigest,
      baselineCandidate: job.baselineCandidate,
      challengerCandidateDigest: job.challengerCandidateDigest,
      challengerCandidate: job.challengerCandidate,
      samples: ordered,
      actor: {
        kind: "ci",
        role: "gate-runner",
        id: job.runnerId,
        sessionId: job.jobId
      },
      startedAt,
      completedAt,
      correlationId: job.correlationId
    });
    const stored = await this.dependencies.artifacts.putText(run.json);
    if (stored.digest !== run.digest || stored.sizeBytes !== utf8Bytes(run.json)) {
      throw new Error("Eval run artifact store returned inconsistent content identity.");
    }
    snapshot = await this.#append(
      snapshot,
      this.#event(job, jobDigest, snapshot, {
        kind: "completed",
        to: "completed",
        evalRunDigest: run.digest,
        evalRunArtifact: artifactReference(stored, "application/vnd.agentlab.eval-run+json"),
        usage: accumulatedUsage(snapshot),
        reasonCode: "run-produced",
        detail: "Complete matched eval run produced."
      })
    );
    return this.#result(snapshot, "completed");
  }

  async #subject(
    job: FactoryEvalProductionJob,
    jobDigest: Sha256Digest,
    initial: FactoryEvalProductionSnapshot,
    definition: FactoryEvalCaseDefinition,
    trial: number,
    seedDigest: Sha256Digest,
    role: "baseline" | "challenger",
    fixture: Uint8Array
  ): Promise<{
    readonly snapshot: FactoryEvalProductionSnapshot;
    readonly evidence: FactoryEvalSubjectEvidence;
  }> {
    this.#assertBeforeDeadline(job);
    const candidate = role === "baseline" ? job.baselineCandidate : job.challengerCandidate;
    const candidateDigest =
      role === "baseline" ? job.baselineCandidateDigest : job.challengerCandidateDigest;
    const harness = role === "baseline" ? job.baselineHarness : job.challengerHarness;
    const harnessDigest =
      role === "baseline" ? job.baselineHarnessDigest : job.challengerHarnessDigest;
    const binding = await this.#binding(harnessDigest, harness.executableDigest);
    const executionId = this.dependencies.createId();
    const request = this.dependencies.documents.evalSubjectRequest({
      schemaVersion: "agentlab.eval-subject-request.v1",
      jobId: job.jobId,
      jobDigest,
      executionId,
      candidateRole: role,
      candidateDigest,
      candidate,
      harnessDigest,
      harness,
      caseId: definition.caseId,
      trial,
      seedDigest,
      fixture: definition.fixture,
      fixturePath: "/workspace/fixture",
      outputPath: "/workspace/output",
      tracePath: "/workspace/trace"
    });
    let snapshot = await this.#append(
      initial,
      this.#event(job, jobDigest, initial, {
        kind: "subject-started",
        to: "subject-active",
        caseId: definition.caseId,
        trial,
        candidateRole: role,
        executionId,
        reasonCode: "subject-started",
        detail: `Started ${role} subject.`
      })
    );
    const output = await this.dependencies.harness.executeSubject({
      request: request.value,
      requestJson: request.json,
      binding,
      fixture,
      budget: definition.subjectBudgetCeiling,
      resourceLimits: job.resourceLimits,
      deadlineAt: job.deadlineAt,
      maximumOutputBytes: definition.maximumSubjectOutputBytes,
      maximumTraceBytes: definition.maximumTraceBytes
    } satisfies FactoryEvalSubjectExecutionInput);
    if (
      output.status !== "succeeded" ||
      output.response?.status !== "succeeded" ||
      output.output === null ||
      output.trace === null
    ) {
      throw await this.#invocationFailure(
        job,
        jobDigest,
        definition,
        trial,
        "subject",
        role,
        harnessDigest,
        request.digest,
        executionId,
        binding,
        output,
        definition.subjectBudgetCeiling
      );
    }
    const [resultArtifact, traceArtifact, stdoutArtifact, stderrArtifact] = await Promise.all([
      this.dependencies.artifacts.put(output.output),
      this.dependencies.artifacts.put(output.trace),
      this.dependencies.artifacts.put(output.stdout),
      this.dependencies.artifacts.put(output.stderr)
    ]);
    const evidence = this.dependencies.documents.evalSubjectEvidence({
      schemaVersion: "agentlab.eval-subject-evidence.v1",
      jobId: job.jobId,
      jobDigest,
      requestDigest: request.digest,
      executionId,
      candidateRole: role,
      candidateDigest,
      harnessDigest,
      executableDigest: binding.executableDigest,
      caseId: definition.caseId,
      trial,
      seedDigest,
      fixture: definition.fixture,
      outputArtifact: artifactReference(resultArtifact, "application/octet-stream"),
      traceArtifact: artifactReference(traceArtifact, "application/octet-stream"),
      stdoutArtifact: artifactReference(stdoutArtifact, "application/json"),
      stderrArtifact: artifactReference(stderrArtifact, "text/plain"),
      usage: output.response.usage,
      latencyMilliseconds: output.latencyMilliseconds,
      isolation: output.isolation,
      startedAt: output.startedAt,
      finishedAt: output.finishedAt
    });
    this.#assertSubjectEvidence(
      job,
      jobDigest,
      definition,
      trial,
      role,
      executionId,
      evidence.value
    );
    await this.#putCanonical(evidence.json, evidence.digest);
    snapshot = await this.#append(
      snapshot,
      this.#event(job, jobDigest, snapshot, {
        kind: "subject-finished",
        to: "subject-active",
        caseId: definition.caseId,
        trial,
        candidateRole: role,
        executionId,
        evidenceDigest: evidence.digest,
        usage: output.response.usage,
        reasonCode: "subject-finished",
        detail: `Finished ${role} subject.`
      })
    );
    return { snapshot, evidence: evidence.value };
  }

  async #grade(
    job: FactoryEvalProductionJob,
    jobDigest: Sha256Digest,
    initial: FactoryEvalProductionSnapshot,
    definition: FactoryEvalCaseDefinition,
    trial: number,
    seedDigest: Sha256Digest,
    fixture: Uint8Array,
    baseline: FactoryEvalSubjectEvidence,
    challenger: FactoryEvalSubjectEvidence
  ): Promise<{
    readonly snapshot: FactoryEvalProductionSnapshot;
    readonly sample: FactoryEvalSample;
  }> {
    this.#assertBeforeDeadline(job);
    const binding = await this.#binding(job.graderDigest, job.grader.executableDigest);
    const executionId = this.dependencies.createId();
    const baselineEvidence = this.dependencies.documents.evalSubjectEvidence(baseline);
    const challengerEvidence = this.dependencies.documents.evalSubjectEvidence(challenger);
    const request = this.dependencies.documents.evalGraderRequest({
      schemaVersion: "agentlab.eval-grader-request.v1",
      jobId: job.jobId,
      jobDigest,
      executionId,
      graderDigest: job.graderDigest,
      grader: job.grader,
      caseId: definition.caseId,
      trial,
      seedDigest,
      fixture: definition.fixture,
      baseline: subjectReference(baselineEvidence.digest, baseline),
      challenger: subjectReference(challengerEvidence.digest, challenger),
      fixturePath: "/workspace/fixture",
      baselineOutputPath: "/workspace/baseline-output",
      baselineTracePath: "/workspace/baseline-trace",
      challengerOutputPath: "/workspace/challenger-output",
      challengerTracePath: "/workspace/challenger-trace",
      evidencePath: "/workspace/grader-evidence"
    });
    let snapshot = await this.#append(
      initial,
      this.#event(job, jobDigest, initial, {
        kind: "grader-started",
        to: "grader-active",
        caseId: definition.caseId,
        trial,
        executionId,
        reasonCode: "grader-started",
        detail: "Started independent matched grader."
      })
    );
    const [baselineOutput, baselineTrace, challengerOutput, challengerTrace] = await Promise.all([
      this.#readArtifact(baseline.outputArtifact),
      this.#readArtifact(baseline.traceArtifact),
      this.#readArtifact(challenger.outputArtifact),
      this.#readArtifact(challenger.traceArtifact)
    ]);
    const output = await this.dependencies.harness.executeGrader({
      request: request.value,
      requestJson: request.json,
      binding,
      fixture,
      baselineOutput,
      baselineTrace,
      challengerOutput,
      challengerTrace,
      budget: definition.graderBudgetCeiling,
      resourceLimits: job.resourceLimits,
      deadlineAt: job.deadlineAt,
      maximumEvidenceBytes: definition.maximumGraderEvidenceBytes
    } satisfies FactoryEvalGraderExecutionInput);
    if (
      output.status !== "succeeded" ||
      output.response?.status !== "succeeded" ||
      output.response.baseline === null ||
      output.response.challenger === null ||
      output.graderEvidence === null
    ) {
      throw await this.#invocationFailure(
        job,
        jobDigest,
        definition,
        trial,
        "grader",
        null,
        job.graderDigest,
        request.digest,
        executionId,
        binding,
        output,
        definition.graderBudgetCeiling
      );
    }
    const [evidenceArtifact, stdoutArtifact, stderrArtifact] = await Promise.all([
      this.dependencies.artifacts.put(output.graderEvidence),
      this.dependencies.artifacts.put(output.stdout),
      this.dependencies.artifacts.put(output.stderr)
    ]);
    const evidence = this.dependencies.documents.evalGraderEvidence({
      schemaVersion: "agentlab.eval-grader-evidence.v1",
      jobId: job.jobId,
      jobDigest,
      requestDigest: request.digest,
      executionId,
      graderDigest: job.graderDigest,
      executableDigest: binding.executableDigest,
      caseId: definition.caseId,
      trial,
      seedDigest,
      fixture: definition.fixture,
      baselineSubjectEvidenceDigest: baselineEvidence.digest,
      challengerSubjectEvidenceDigest: challengerEvidence.digest,
      baseline: output.response.baseline,
      challenger: output.response.challenger,
      evidenceArtifact: artifactReference(evidenceArtifact, "application/octet-stream"),
      stdoutArtifact: artifactReference(stdoutArtifact, "application/json"),
      stderrArtifact: artifactReference(stderrArtifact, "text/plain"),
      usage: output.response.usage,
      isolation: output.isolation,
      startedAt: output.startedAt,
      finishedAt: output.finishedAt
    });
    this.#assertGraderEvidence(
      job,
      jobDigest,
      definition,
      trial,
      executionId,
      baselineEvidence.digest,
      baseline,
      challengerEvidence.digest,
      challenger,
      evidence.value
    );
    await this.#putCanonical(evidence.json, evidence.digest);
    const sample = this.dependencies.documents.evalSample({
      caseId: definition.caseId,
      trial,
      seedDigest,
      fixtureDigest: definition.fixture.digest,
      graderEvidenceDigest: evidence.digest,
      baseline: outcome(baseline, output.response.baseline),
      challenger: outcome(challenger, output.response.challenger)
    });
    assertFactoryEvalSampleRecord(sample, {
      caseId: definition.caseId,
      trial,
      seedDigest,
      fixtureDigest: definition.fixture.digest,
      graderEvidenceDigest: evidence.digest
    });
    snapshot = await this.#append(
      snapshot,
      this.#event(job, jobDigest, snapshot, {
        kind: "sample-recorded",
        to: "subject-active",
        caseId: definition.caseId,
        trial,
        executionId,
        evidenceDigest: evidence.digest,
        sampleDigest: sample.digest,
        usage: output.response.usage,
        reasonCode: "sample-recorded",
        detail: "Matched sample and grader evidence recorded."
      })
    );
    return { snapshot, sample: sample.value };
  }

  async #invocationFailure(
    job: FactoryEvalProductionJob,
    jobDigest: Sha256Digest,
    definition: FactoryEvalCaseDefinition,
    trial: number,
    phase: "subject" | "grader",
    candidateRole: "baseline" | "challenger" | null,
    descriptorDigest: Sha256Digest,
    requestDigest: Sha256Digest,
    executionId: string,
    binding: FactoryEvalExecutableBinding,
    output: EvalExecutionOutput,
    budget: FactoryBudget
  ): Promise<EvalInvocationFailure> {
    const seedDigest = definition.seedDigests[trial - 1];
    if (seedDigest === undefined) throw new Error("Failed eval invocation has no immutable seed.");
    if (
      output.isolation.isolationId !== executionId ||
      output.isolation.mechanism.id !== "linux/systemd-user-scope" ||
      !sameLimits(output.isolation.limits, job.resourceLimits)
    ) {
      throw new Error("Failed eval invocation returned substituted isolation evidence.");
    }
    const [stdoutArtifact, stderrArtifact] = await Promise.all([
      this.dependencies.artifacts.put(output.stdout),
      this.dependencies.artifacts.put(output.stderr)
    ]);
    const reportedUsage = output.response?.usage ?? null;
    const accountedUsage = reportedUsage ?? budgetCeilingUsage(budget);
    assertUsageWithinBudget(accountedUsage, budget, "Failed eval invocation");
    if (
      accountedUsage.outputBytes < output.stdout.byteLength + output.stderr.byteLength ||
      accountedUsage.processes < 1
    ) {
      throw new Error("Failed eval invocation accounting does not cover observed evidence.");
    }
    const reasonCode = output.errorCode ?? `${phase}-failed`;
    const evidence = this.dependencies.documents.evalInvocationFailureEvidence({
      schemaVersion: "agentlab.eval-invocation-failure-evidence.v1",
      jobId: job.jobId,
      jobDigest,
      requestDigest,
      executionId,
      phase,
      candidateRole,
      descriptorDigest,
      executableDigest: binding.executableDigest,
      caseId: definition.caseId,
      trial,
      seedDigest,
      fixture: definition.fixture,
      status: output.status === "succeeded" ? "error" : output.status,
      reasonCode,
      stdoutArtifact: artifactReference(stdoutArtifact, "application/octet-stream"),
      stderrArtifact: artifactReference(stderrArtifact, "text/plain"),
      reportedUsage,
      accountedUsage,
      usageComplete: reportedUsage !== null,
      isolation: output.isolation,
      startedAt: output.startedAt,
      finishedAt: output.finishedAt
    });
    await this.#putCanonical(evidence.json, evidence.digest);
    return new EvalInvocationFailure(
      `Eval ${phase} failed: ${reasonCode}.`,
      evidence.digest,
      accountedUsage,
      reasonCode
    );
  }

  #job(input: unknown, expectedJobDigest: Sha256Digest) {
    const job = this.dependencies.documents.evalProductionJob(input);
    assertFactoryEvalProductionJob(job, this.dependencies.documents);
    if (job.digest !== expectedJobDigest) {
      throw new ConflictError("Factory eval production job changed after review.");
    }
    if (job.value.runnerId !== this.dependencies.runnerId) {
      throw new ConflictError(
        "Factory eval production runner identity does not match configuration."
      );
    }
    return job;
  }

  async #preflightInputs(job: FactoryEvalProductionJob): Promise<void> {
    await Promise.all([
      this.#binding(job.baselineHarnessDigest, job.baselineHarness.executableDigest),
      this.#binding(job.challengerHarnessDigest, job.challengerHarness.executableDigest),
      this.#binding(job.graderDigest, job.grader.executableDigest),
      ...job.caseBank.cases.map(({ fixture }) => this.#readArtifact(fixture))
    ]);
  }

  #assertJobWindow(job: FactoryEvalProductionJob): void {
    const now = this.dependencies.now();
    if (now < job.createdAt || now > job.deadlineAt) {
      throw new ConflictError("Factory eval production job is outside its validity window.");
    }
  }

  async #binding(
    descriptorDigest: Sha256Digest,
    executableDigest: Sha256Digest
  ): Promise<FactoryEvalExecutableBinding> {
    const binding = await this.dependencies.executables.resolve(descriptorDigest);
    if (
      binding?.descriptorDigest !== descriptorDigest ||
      binding.executableDigest !== executableDigest
    ) {
      throw new Error(`Factory eval executable ${descriptorDigest} is not installed exactly.`);
    }
    return binding;
  }

  async #recoverDanglingExecution(
    snapshot: FactoryEvalProductionSnapshot
  ): Promise<FactoryEvalProductionSnapshot> {
    const last = snapshot.events.at(-1)?.event;
    if (last?.kind !== "subject-started" && last?.kind !== "grader-started") return snapshot;
    if (last.executionId === null)
      throw new Error("Active eval journal event has no execution ID.");
    const state = await this.dependencies.recovery.state(last.executionId);
    if (state !== "inactive") {
      throw new EvalRecoveryUncertainError(
        `Eval execution ${last.executionId} is ${state}; recovery cannot mutate its journal.`
      );
    }
    return this.#append(
      snapshot,
      this.#event(snapshot.job, snapshot.jobDigest, snapshot, {
        kind: "failed",
        to: "failed",
        caseId: last.caseId,
        trial: last.trial,
        candidateRole: last.candidateRole,
        executionId: last.executionId,
        usage: accumulatedUsage(snapshot),
        reasonCode: "interrupted-execution",
        detail: "Previously started eval scope is inactive without terminal evidence."
      })
    );
  }

  async #recordedSamples(
    snapshot: FactoryEvalProductionSnapshot
  ): Promise<Map<string, FactoryEvalSample>> {
    const result = new Map<string, FactoryEvalSample>();
    for (const { event } of snapshot.events) {
      if (
        event.kind !== "sample-recorded" ||
        event.evidenceDigest === null ||
        event.executionId === null ||
        event.caseId === null ||
        event.trial === null
      )
        continue;
      const definition = snapshot.job.caseBank.cases.find(({ caseId }) => caseId === event.caseId);
      if (definition === undefined) {
        throw new Error("Recorded eval sample references a case outside the immutable job.");
      }
      const grader = await this.#readGraderEvidence(event.evidenceDigest);
      const baseline = await this.#readSubjectEvidence(grader.baselineSubjectEvidenceDigest);
      const challenger = await this.#readSubjectEvidence(grader.challengerSubjectEvidenceDigest);
      const baselineExecutionId = this.#recordedSubjectExecutionId(
        snapshot,
        definition.caseId,
        event.trial,
        "baseline",
        grader.baselineSubjectEvidenceDigest
      );
      const challengerExecutionId = this.#recordedSubjectExecutionId(
        snapshot,
        definition.caseId,
        event.trial,
        "challenger",
        grader.challengerSubjectEvidenceDigest
      );
      this.#assertSubjectEvidence(
        snapshot.job,
        snapshot.jobDigest,
        definition,
        event.trial,
        "baseline",
        baselineExecutionId,
        baseline
      );
      this.#assertSubjectEvidence(
        snapshot.job,
        snapshot.jobDigest,
        definition,
        event.trial,
        "challenger",
        challengerExecutionId,
        challenger
      );
      this.#assertGraderEvidence(
        snapshot.job,
        snapshot.jobDigest,
        definition,
        event.trial,
        event.executionId,
        grader.baselineSubjectEvidenceDigest,
        baseline,
        grader.challengerSubjectEvidenceDigest,
        challenger,
        grader
      );
      if (event.usage === null || !sameUsage(event.usage, grader.usage)) {
        throw new Error("Recorded eval grader usage differs from immutable evidence.");
      }
      const sample = this.dependencies.documents.evalSample({
        caseId: grader.caseId,
        trial: grader.trial,
        seedDigest: grader.seedDigest,
        fixtureDigest: grader.fixture.digest,
        graderEvidenceDigest: event.evidenceDigest,
        baseline: outcome(baseline, grader.baseline),
        challenger: outcome(challenger, grader.challenger)
      });
      if (sample.digest !== event.sampleDigest) {
        throw new Error("Recorded eval sample digest does not match its evidence lineage.");
      }
      result.set(sampleKey(grader.caseId, grader.trial), sample.value);
    }
    return result;
  }

  async #subjectEvidence(
    snapshot: FactoryEvalProductionSnapshot
  ): Promise<FactoryEvalSubjectEvidence[]> {
    const values: FactoryEvalSubjectEvidence[] = [];
    for (const { event } of snapshot.events) {
      if (
        event.kind === "subject-finished" &&
        event.evidenceDigest !== null &&
        event.executionId !== null &&
        event.caseId !== null &&
        event.trial !== null &&
        event.candidateRole !== null
      ) {
        const definition = snapshot.job.caseBank.cases.find(
          ({ caseId }) => caseId === event.caseId
        );
        if (definition === undefined)
          throw new Error("Subject evidence references an unknown case.");
        const evidence = await this.#readSubjectEvidence(event.evidenceDigest);
        this.#assertSubjectEvidence(
          snapshot.job,
          snapshot.jobDigest,
          definition,
          event.trial,
          event.candidateRole,
          event.executionId,
          evidence
        );
        if (event.usage === null || !sameUsage(event.usage, evidence.usage)) {
          throw new Error("Recorded eval subject usage differs from immutable evidence.");
        }
        values.push(evidence);
      }
    }
    return values;
  }

  async #graderEvidence(
    snapshot: FactoryEvalProductionSnapshot
  ): Promise<FactoryEvalGraderEvidence[]> {
    const values: FactoryEvalGraderEvidence[] = [];
    for (const { event } of snapshot.events) {
      if (
        event.kind === "sample-recorded" &&
        event.evidenceDigest !== null &&
        event.executionId !== null &&
        event.caseId !== null &&
        event.trial !== null
      ) {
        const definition = snapshot.job.caseBank.cases.find(
          ({ caseId }) => caseId === event.caseId
        );
        if (definition === undefined)
          throw new Error("Grader evidence references an unknown case.");
        const grader = await this.#readGraderEvidence(event.evidenceDigest);
        const baseline = await this.#readSubjectEvidence(grader.baselineSubjectEvidenceDigest);
        const challenger = await this.#readSubjectEvidence(grader.challengerSubjectEvidenceDigest);
        const baselineExecutionId = this.#recordedSubjectExecutionId(
          snapshot,
          definition.caseId,
          event.trial,
          "baseline",
          grader.baselineSubjectEvidenceDigest
        );
        const challengerExecutionId = this.#recordedSubjectExecutionId(
          snapshot,
          definition.caseId,
          event.trial,
          "challenger",
          grader.challengerSubjectEvidenceDigest
        );
        this.#assertSubjectEvidence(
          snapshot.job,
          snapshot.jobDigest,
          definition,
          event.trial,
          "baseline",
          baselineExecutionId,
          baseline
        );
        this.#assertSubjectEvidence(
          snapshot.job,
          snapshot.jobDigest,
          definition,
          event.trial,
          "challenger",
          challengerExecutionId,
          challenger
        );
        this.#assertGraderEvidence(
          snapshot.job,
          snapshot.jobDigest,
          definition,
          event.trial,
          event.executionId,
          grader.baselineSubjectEvidenceDigest,
          baseline,
          grader.challengerSubjectEvidenceDigest,
          challenger,
          grader
        );
        if (event.usage === null || !sameUsage(event.usage, grader.usage)) {
          throw new Error("Recorded eval grader usage differs from immutable evidence.");
        }
        values.push(grader);
      }
    }
    return values;
  }

  #recordedSubjectExecutionId(
    snapshot: FactoryEvalProductionSnapshot,
    caseId: string,
    trial: number,
    role: "baseline" | "challenger",
    evidenceDigest: Sha256Digest
  ): string {
    const matches = snapshot.events.filter(
      ({ event }) =>
        event.kind === "subject-finished" &&
        event.caseId === caseId &&
        event.trial === trial &&
        event.candidateRole === role &&
        event.evidenceDigest === evidenceDigest &&
        event.executionId !== null
    );
    const executionId = matches[0]?.event.executionId;
    if (matches.length !== 1 || executionId === null || executionId === undefined) {
      throw new Error("Eval subject evidence is not bound to one exact finished journal event.");
    }
    return executionId;
  }

  #assertSubjectEvidence(
    job: FactoryEvalProductionJob,
    jobDigest: Sha256Digest,
    definition: FactoryEvalCaseDefinition,
    trial: number,
    role: "baseline" | "challenger",
    executionId: string,
    evidence: FactoryEvalSubjectEvidence
  ): void {
    const seedDigest = definition.seedDigests[trial - 1];
    if (seedDigest === undefined)
      throw new Error("Subject evidence trial is outside its case bank.");
    const candidate = role === "baseline" ? job.baselineCandidate : job.challengerCandidate;
    const candidateDigest =
      role === "baseline" ? job.baselineCandidateDigest : job.challengerCandidateDigest;
    const harness = role === "baseline" ? job.baselineHarness : job.challengerHarness;
    const harnessDigest =
      role === "baseline" ? job.baselineHarnessDigest : job.challengerHarnessDigest;
    const request = this.dependencies.documents.evalSubjectRequest({
      schemaVersion: "agentlab.eval-subject-request.v1",
      jobId: job.jobId,
      jobDigest,
      executionId,
      candidateRole: role,
      candidateDigest,
      candidate,
      harnessDigest,
      harness,
      caseId: definition.caseId,
      trial,
      seedDigest,
      fixture: definition.fixture,
      fixturePath: "/workspace/fixture",
      outputPath: "/workspace/output",
      tracePath: "/workspace/trace"
    });
    assertUsageWithinBudget(
      evidence.usage,
      definition.subjectBudgetCeiling,
      "Eval subject evidence"
    );
    const observedBytes =
      evidence.outputArtifact.sizeBytes +
      evidence.traceArtifact.sizeBytes +
      evidence.stdoutArtifact.sizeBytes +
      evidence.stderrArtifact.sizeBytes;
    if (
      evidence.jobId !== job.jobId ||
      evidence.jobDigest !== jobDigest ||
      evidence.requestDigest !== request.digest ||
      evidence.executionId !== executionId ||
      evidence.candidateRole !== role ||
      evidence.candidateDigest !== candidateDigest ||
      evidence.harnessDigest !== harnessDigest ||
      evidence.executableDigest !== harness.executableDigest ||
      evidence.caseId !== definition.caseId ||
      evidence.trial !== trial ||
      evidence.seedDigest !== seedDigest ||
      !sameArtifact(evidence.fixture, definition.fixture) ||
      evidence.outputArtifact.mediaType !== "application/octet-stream" ||
      evidence.traceArtifact.mediaType !== "application/octet-stream" ||
      evidence.stdoutArtifact.mediaType !== "application/json" ||
      evidence.stderrArtifact.mediaType !== "text/plain" ||
      evidence.outputArtifact.sizeBytes > definition.maximumSubjectOutputBytes ||
      evidence.traceArtifact.sizeBytes > definition.maximumTraceBytes ||
      evidence.usage.outputBytes < observedBytes ||
      evidence.isolation.isolationId !== executionId ||
      evidence.isolation.mechanism.id !== "linux/systemd-user-scope" ||
      !sameLimits(evidence.isolation.limits, job.resourceLimits) ||
      evidence.startedAt < job.createdAt ||
      evidence.finishedAt > job.deadlineAt
    ) {
      throw new Error("Eval subject evidence failed immutable job-lineage validation.");
    }
  }

  #assertGraderEvidence(
    job: FactoryEvalProductionJob,
    jobDigest: Sha256Digest,
    definition: FactoryEvalCaseDefinition,
    trial: number,
    executionId: string,
    baselineDigest: Sha256Digest,
    baseline: FactoryEvalSubjectEvidence,
    challengerDigest: Sha256Digest,
    challenger: FactoryEvalSubjectEvidence,
    evidence: FactoryEvalGraderEvidence
  ): void {
    const seedDigest = definition.seedDigests[trial - 1];
    if (seedDigest === undefined)
      throw new Error("Grader evidence trial is outside its case bank.");
    const request = this.dependencies.documents.evalGraderRequest({
      schemaVersion: "agentlab.eval-grader-request.v1",
      jobId: job.jobId,
      jobDigest,
      executionId,
      graderDigest: job.graderDigest,
      grader: job.grader,
      caseId: definition.caseId,
      trial,
      seedDigest,
      fixture: definition.fixture,
      baseline: subjectReference(baselineDigest, baseline),
      challenger: subjectReference(challengerDigest, challenger),
      fixturePath: "/workspace/fixture",
      baselineOutputPath: "/workspace/baseline-output",
      baselineTracePath: "/workspace/baseline-trace",
      challengerOutputPath: "/workspace/challenger-output",
      challengerTracePath: "/workspace/challenger-trace",
      evidencePath: "/workspace/grader-evidence"
    });
    assertUsageWithinBudget(evidence.usage, definition.graderBudgetCeiling, "Eval grader evidence");
    const observedBytes =
      evidence.evidenceArtifact.sizeBytes +
      evidence.stdoutArtifact.sizeBytes +
      evidence.stderrArtifact.sizeBytes;
    if (
      evidence.jobId !== job.jobId ||
      evidence.jobDigest !== jobDigest ||
      evidence.requestDigest !== request.digest ||
      evidence.executionId !== executionId ||
      evidence.graderDigest !== job.graderDigest ||
      evidence.executableDigest !== job.grader.executableDigest ||
      evidence.caseId !== definition.caseId ||
      evidence.trial !== trial ||
      evidence.seedDigest !== seedDigest ||
      !sameArtifact(evidence.fixture, definition.fixture) ||
      evidence.evidenceArtifact.mediaType !== "application/octet-stream" ||
      evidence.stdoutArtifact.mediaType !== "application/json" ||
      evidence.stderrArtifact.mediaType !== "text/plain" ||
      evidence.evidenceArtifact.sizeBytes > definition.maximumGraderEvidenceBytes ||
      evidence.usage.outputBytes < observedBytes ||
      evidence.baselineSubjectEvidenceDigest !== baselineDigest ||
      evidence.challengerSubjectEvidenceDigest !== challengerDigest ||
      evidence.isolation.isolationId !== executionId ||
      evidence.isolation.mechanism.id !== "linux/systemd-user-scope" ||
      !sameLimits(evidence.isolation.limits, job.resourceLimits) ||
      evidence.startedAt < job.createdAt ||
      evidence.finishedAt > job.deadlineAt
    ) {
      throw new Error("Eval grader evidence failed immutable job-lineage validation.");
    }
  }

  async #readSubjectEvidence(digest: Sha256Digest): Promise<FactoryEvalSubjectEvidence> {
    const text = await this.dependencies.artifacts.readText(digest, maximumEvidenceDocumentBytes);
    const evidence = this.dependencies.documents.evalSubjectEvidence(
      parseJson(text, "subject evidence")
    );
    if (evidence.digest !== digest)
      throw new Error("Eval subject evidence digest is inconsistent.");
    return evidence.value;
  }

  async #readGraderEvidence(digest: Sha256Digest): Promise<FactoryEvalGraderEvidence> {
    const text = await this.dependencies.artifacts.readText(digest, maximumEvidenceDocumentBytes);
    const evidence = this.dependencies.documents.evalGraderEvidence(
      parseJson(text, "grader evidence")
    );
    if (evidence.digest !== digest) throw new Error("Eval grader evidence digest is inconsistent.");
    return evidence.value;
  }

  async #readArtifact(reference: FactoryArtifactReference): Promise<Uint8Array> {
    const value = await this.dependencies.artifacts.read(reference.digest, reference.sizeBytes + 1);
    if (value.byteLength !== reference.sizeBytes) {
      throw new Error(`Factory eval artifact ${reference.digest} changed size.`);
    }
    return value;
  }

  async #putCanonical(json: string, digest: Sha256Digest): Promise<void> {
    const stored = await this.dependencies.artifacts.putText(json);
    if (stored.digest !== digest || stored.sizeBytes !== utf8Bytes(json)) {
      throw new Error("Factory eval evidence store returned inconsistent content identity.");
    }
  }

  async #append(
    snapshot: FactoryEvalProductionSnapshot,
    event: ReturnType<FactoryDocumentCodec["evalProductionEvent"]>
  ): Promise<FactoryEvalProductionSnapshot> {
    const next = await this.dependencies.productions.append(event);
    assertFactoryEvalProductionSnapshot(next, this.dependencies.documents);
    if (next.events.length !== snapshot.events.length + 1) {
      throw new Error("Factory eval production append did not advance exactly once.");
    }
    return next;
  }

  #event(
    job: FactoryEvalProductionJob,
    jobDigest: Sha256Digest,
    snapshot: FactoryEvalProductionSnapshot | null,
    fields: EventFields
  ) {
    const last = snapshot?.events.at(-1);
    return this.dependencies.documents.evalProductionEvent({
      schemaVersion: "agentlab.eval-production-event.v1",
      eventId: this.dependencies.createId(),
      jobId: job.jobId,
      jobDigest,
      sequence: (last?.event.sequence ?? 0) + 1,
      previousEventDigest: last?.eventDigest ?? null,
      kind: fields.kind,
      from: last?.event.to ?? null,
      to: fields.to,
      caseId: fields.caseId ?? null,
      trial: fields.trial ?? null,
      candidateRole: fields.candidateRole ?? null,
      executionId: fields.executionId ?? null,
      evidenceDigest: fields.evidenceDigest ?? null,
      sampleDigest: fields.sampleDigest ?? null,
      evalRunDigest: fields.evalRunDigest ?? null,
      evalRunArtifact: fields.evalRunArtifact ?? null,
      usage: fields.usage ?? null,
      occurredAt: fields.occurredAt ?? this.dependencies.now(),
      reasonCode: fields.reasonCode,
      detail: fields.detail,
      correlationId: job.correlationId,
      actor: {
        kind: "control-plane",
        role: "gate-runner",
        id: "agentlab-eval-producer",
        sessionId: job.jobId
      }
    });
  }

  async #terminalResult(
    snapshot: FactoryEvalProductionSnapshot,
    status: "existing"
  ): Promise<FactoryEvalProductionResult | null> {
    const state = snapshot.events.at(-1)?.event.to;
    if (state !== "completed" && state !== "failed") return null;
    const result = this.#result(snapshot, state === "completed" ? status : "failed");
    if (result.evalRunArtifact !== null && result.evalRunDigest !== null) {
      const bytes = await this.#readArtifact(result.evalRunArtifact);
      const run = this.dependencies.documents.evalRun(
        parseJson(new TextDecoder().decode(bytes), "eval run")
      );
      if (run.digest !== result.evalRunDigest) {
        throw new Error("Completed eval production run artifact failed digest verification.");
      }
    }
    return result;
  }

  #result(
    snapshot: FactoryEvalProductionSnapshot,
    status: "completed" | "existing" | "failed"
  ): FactoryEvalProductionResult {
    const last = snapshot.events.at(-1)?.event;
    if (last === undefined || (last.to !== "completed" && last.to !== "failed")) {
      throw new Error("Factory eval production result requires a terminal journal.");
    }
    return {
      schemaVersion: "agentlab.eval-production-result.v1",
      status,
      jobId: snapshot.job.jobId,
      jobDigest: snapshot.jobDigest,
      state: last.to,
      evalRunDigest: last.evalRunDigest,
      evalRunArtifact: last.evalRunArtifact,
      sampleCount: snapshot.events.filter(({ event }) => event.kind === "sample-recorded").length,
      usage: last.usage ?? accumulatedUsage(snapshot),
      reasonCode: last.reasonCode
    };
  }

  #assertBeforeDeadline(job: FactoryEvalProductionJob): void {
    if (this.dependencies.now() > job.deadlineAt) {
      throw new Error("Factory eval production deadline expired before the next invocation.");
    }
  }

  async #existingSubjectEvidence(
    snapshot: FactoryEvalProductionSnapshot,
    job: FactoryEvalProductionJob,
    jobDigest: Sha256Digest,
    definition: FactoryEvalCaseDefinition,
    trial: number,
    role: "baseline" | "challenger"
  ): Promise<FactoryEvalSubjectEvidence | null> {
    const matches = snapshot.events.filter(
      ({ event }) =>
        event.kind === "subject-finished" &&
        event.caseId === definition.caseId &&
        event.trial === trial &&
        event.candidateRole === role
    );
    if (matches.length > 1) {
      throw new Error("Eval production has duplicate subject evidence for one coordinate.");
    }
    const event = matches[0]?.event;
    if (event?.evidenceDigest === undefined || event.evidenceDigest === null) return null;
    if (event.executionId === null)
      throw new Error("Finished subject evidence has no execution ID.");
    const evidence = await this.#readSubjectEvidence(event.evidenceDigest);
    this.#assertSubjectEvidence(
      job,
      jobDigest,
      definition,
      trial,
      role,
      event.executionId,
      evidence
    );
    if (event.usage === null || !sameUsage(event.usage, evidence.usage)) {
      throw new Error("Finished eval subject usage differs from immutable evidence.");
    }
    return evidence;
  }
}

interface EventFields {
  readonly kind: FactoryEvalProductionEvent["kind"];
  readonly to: FactoryEvalProductionEvent["to"];
  readonly caseId?: string | null;
  readonly trial?: number | null;
  readonly candidateRole?: "baseline" | "challenger" | null;
  readonly executionId?: string | null;
  readonly evidenceDigest?: Sha256Digest;
  readonly sampleDigest?: Sha256Digest;
  readonly evalRunDigest?: Sha256Digest;
  readonly evalRunArtifact?: FactoryArtifactReference;
  readonly usage?: FactoryBudgetUsage;
  readonly occurredAt?: string;
  readonly reasonCode: string;
  readonly detail: string;
}

type EvalExecutionOutput =
  | Awaited<ReturnType<FactoryEvalHarnessExecutor["executeSubject"]>>
  | Awaited<ReturnType<FactoryEvalHarnessExecutor["executeGrader"]>>;

class EvalRecoveryUncertainError extends Error {}

class EvalInvocationFailure extends Error {
  public constructor(
    message: string,
    public readonly evidenceDigest: Sha256Digest,
    public readonly accountedUsage: FactoryBudgetUsage,
    public readonly reasonCode: string
  ) {
    super(message);
  }
}

function accumulatedUsage(snapshot: FactoryEvalProductionSnapshot): FactoryBudgetUsage {
  const usage = emptyUsage();
  for (const { event } of snapshot.events) {
    if (event.kind === "subject-finished" || event.kind === "sample-recorded") {
      if (event.usage === null) throw new Error("Terminal eval invocation event has no usage.");
      addUsage(usage, event.usage);
    }
  }
  assertUsageWithinBudget(usage, snapshot.job.aggregateBudget, "Cumulative eval production");
  return usage;
}

function terminalUsage(
  snapshot: FactoryEvalProductionSnapshot,
  error: unknown
): FactoryBudgetUsage {
  const usage = accumulatedUsage(snapshot);
  if (error instanceof EvalInvocationFailure) addUsage(usage, error.accountedUsage);
  assertUsageWithinBudget(usage, snapshot.job.aggregateBudget, "Terminal eval production");
  return usage;
}

function budgetCeilingUsage(budget: FactoryBudget): FactoryBudgetUsage {
  return {
    wallClockSeconds: budget.wallClockSeconds,
    agentTurns: budget.maxAgentTurns,
    toolCalls: budget.maxToolCalls,
    inputTokens: budget.maxInputTokens,
    outputTokens: budget.maxOutputTokens,
    costMicrousd: budget.maxCostMicrousd,
    processes: budget.maxProcesses,
    outputBytes: budget.maxOutputBytes,
    workers: budget.maxWorkers,
    repairAttempts: budget.maxRepairAttempts,
    changedFiles: budget.maxChangedFiles,
    changedLines: budget.maxChangedLines
  };
}

function lastCoordinate(snapshot: FactoryEvalProductionSnapshot): Partial<EventFields> {
  const last = snapshot.events.at(-1)?.event;
  if (last === undefined) return {};
  return {
    caseId: last.caseId,
    trial: last.trial,
    candidateRole: last.candidateRole,
    executionId: last.executionId
  };
}

function artifactReference(
  stored: { readonly digest: Sha256Digest; readonly sizeBytes: number },
  mediaType: string
): FactoryArtifactReference {
  return { digest: stored.digest, mediaType, sizeBytes: stored.sizeBytes };
}

function sameArtifact(left: FactoryArtifactReference, right: FactoryArtifactReference): boolean {
  return (
    left.digest === right.digest &&
    left.mediaType === right.mediaType &&
    left.sizeBytes === right.sizeBytes
  );
}

function sameLimits(left: FactoryResourceLimits, right: FactoryResourceLimits): boolean {
  return (
    left.maxProcesses === right.maxProcesses &&
    left.maxMemoryBytes === right.maxMemoryBytes &&
    left.cpuQuotaPercent === right.cpuQuotaPercent
  );
}

function sameUsage(left: FactoryBudgetUsage, right: FactoryBudgetUsage): boolean {
  return (
    left.wallClockSeconds === right.wallClockSeconds &&
    left.agentTurns === right.agentTurns &&
    left.toolCalls === right.toolCalls &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.costMicrousd === right.costMicrousd &&
    left.processes === right.processes &&
    left.outputBytes === right.outputBytes &&
    left.workers === right.workers &&
    left.repairAttempts === right.repairAttempts &&
    left.changedFiles === right.changedFiles &&
    left.changedLines === right.changedLines
  );
}

function subjectReference(digest: Sha256Digest, evidence: FactoryEvalSubjectEvidence) {
  return {
    candidateRole: evidence.candidateRole,
    candidateDigest: evidence.candidateDigest,
    harnessDigest: evidence.harnessDigest,
    subjectEvidenceDigest: digest,
    outputArtifact: evidence.outputArtifact,
    traceArtifact: evidence.traceArtifact,
    costMicrousd: evidence.usage.costMicrousd,
    latencyMilliseconds: evidence.latencyMilliseconds
  };
}

function outcome(
  evidence: FactoryEvalSubjectEvidence,
  grade: {
    readonly taskSuccess: boolean;
    readonly safetyPass: boolean;
    readonly criticalSafetyViolation: boolean;
    readonly falsePositive: boolean;
  }
) {
  return {
    ...grade,
    costMicrousd: evidence.usage.costMicrousd,
    latencyMilliseconds: evidence.latencyMilliseconds,
    outputDigest: evidence.outputArtifact.digest,
    traceDigest: evidence.traceArtifact.digest
  };
}

function sampleKey(caseId: string, trial: number): string {
  return `${caseId}\0${String(trial)}`;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Factory ${label} artifact is not valid JSON.`, { cause: error });
  }
}

function failureCode(error: unknown): string {
  if (error instanceof EvalInvocationFailure) return error.reasonCode;
  if (error instanceof Error && error.message.includes("deadline")) return "deadline-expired";
  if (error instanceof Error && error.message.includes("budget")) return "budget-exceeded";
  if (error instanceof Error && error.message.includes("executable")) return "executable-invalid";
  if (error instanceof Error && error.message.includes("artifact")) return "artifact-invalid";
  return "eval-production-failed";
}

function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown eval production failure.";
  const safe = Array.from(message)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, 500);
  return safe || "Unknown eval production failure.";
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
