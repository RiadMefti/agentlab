import type {
  FactoryBudget,
  FactoryBudgetUsage,
  FactoryEvalProductionJob,
  FactoryEvalSample
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";
import type { FactoryEvalProductionSnapshot } from "./factory-eval-production-repository.js";

type EvalProductionDocuments = Pick<
  FactoryDocumentCodec,
  | "configurationCandidate"
  | "evalCaseBank"
  | "evalGraderDescriptor"
  | "evalHarnessDescriptor"
  | "evalProductionEvent"
  | "evalProductionJob"
  | "evalSample"
  | "evalSuite"
>;

/** Recomputes every content coordinate and the complete reserved budget before any process starts. */
export function assertFactoryEvalProductionJob(
  job: CanonicalFactoryDocument<FactoryEvalProductionJob>,
  documents: EvalProductionDocuments
): void {
  const suite = documents.evalSuite(job.value.suite);
  const bank = documents.evalCaseBank(job.value.caseBank);
  const baseline = documents.configurationCandidate(job.value.baselineCandidate);
  const challenger = documents.configurationCandidate(job.value.challengerCandidate);
  const baselineHarness = documents.evalHarnessDescriptor(job.value.baselineHarness);
  const challengerHarness = documents.evalHarnessDescriptor(job.value.challengerHarness);
  const grader = documents.evalGraderDescriptor(job.value.grader);
  if (
    suite.digest !== job.value.suiteDigest ||
    bank.digest !== job.value.caseBankDigest ||
    bank.digest !== suite.value.caseBankDigest ||
    baseline.digest !== job.value.baselineCandidateDigest ||
    challenger.digest !== job.value.challengerCandidateDigest ||
    baselineHarness.digest !== job.value.baselineHarnessDigest ||
    challengerHarness.digest !== job.value.challengerHarnessDigest ||
    grader.digest !== job.value.graderDigest ||
    baseline.value.harnessDigest !== baselineHarness.digest ||
    challenger.value.harnessDigest !== challengerHarness.digest
  ) {
    throw new Error("Factory eval production job changed a canonical input digest.");
  }
  if (
    baseline.value.repositoryId !== challenger.value.repositoryId ||
    baseline.value.baseRevision !== challenger.value.baseRevision ||
    baseline.value.createdAt > job.value.createdAt ||
    challenger.value.createdAt > job.value.createdAt
  ) {
    throw new Error(
      "Factory eval production candidates are not matched on repository, base, and time."
    );
  }
  if (
    !sameValues(
      bank.value.cases.map(({ caseId }) => caseId),
      suite.value.caseIds
    ) ||
    bank.value.cases.some(({ seedDigests }) => seedDigests.length !== suite.value.trialsPerCase)
  ) {
    throw new Error("Factory eval case bank does not match the suite's exact ordered matrix.");
  }
  const reserved = emptyUsage();
  for (const definition of bank.value.cases) {
    addBudget(reserved, definition.subjectBudgetCeiling);
    addBudget(reserved, definition.subjectBudgetCeiling);
    addBudget(reserved, definition.graderBudgetCeiling);
  }
  multiplyUsage(reserved, suite.value.trialsPerCase);
  assertUsageWithinBudget(reserved, job.value.aggregateBudget, "reserved eval production");
}

/** Revalidates the immutable journal chain on every read. */
export function assertFactoryEvalProductionSnapshot(
  snapshot: FactoryEvalProductionSnapshot,
  documents: EvalProductionDocuments
): void {
  const job = documents.evalProductionJob(snapshot.job);
  assertFactoryEvalProductionJob(job, documents);
  if (job.digest !== snapshot.jobDigest || snapshot.events.length === 0) {
    throw new Error("Stored factory eval production job failed canonical integrity validation.");
  }
  let previousDigest: string | null = null;
  let state: string | null = null;
  for (const [index, item] of snapshot.events.entries()) {
    const event = documents.evalProductionEvent(item.event);
    if (
      event.digest !== item.eventDigest ||
      event.value.jobId !== job.value.jobId ||
      event.value.jobDigest !== job.digest ||
      event.value.sequence !== index + 1 ||
      event.value.previousEventDigest !== previousDigest ||
      event.value.from !== state ||
      event.value.correlationId !== job.value.correlationId
    ) {
      throw new Error("Factory eval production event chain failed canonical integrity validation.");
    }
    previousDigest = event.digest;
    state = event.value.to;
  }
}

export function assertFactoryEvalSampleRecord(
  sample: CanonicalFactoryDocument<FactoryEvalSample>,
  expected: {
    readonly caseId: string;
    readonly trial: number;
    readonly seedDigest: string;
    readonly fixtureDigest: string;
    readonly graderEvidenceDigest: string;
  }
): void {
  if (
    sample.value.caseId !== expected.caseId ||
    sample.value.trial !== expected.trial ||
    sample.value.seedDigest !== expected.seedDigest ||
    sample.value.fixtureDigest !== expected.fixtureDigest ||
    sample.value.graderEvidenceDigest !== expected.graderEvidenceDigest
  ) {
    throw new Error("Factory eval sample changed its matched production coordinate.");
  }
}

export function addUsage(target: FactoryBudgetUsage, usage: FactoryBudgetUsage): void {
  for (const key of usageKeys) {
    const value = target[key] + usage[key];
    if (!Number.isSafeInteger(value)) throw new Error("Factory eval usage counter overflowed.");
    (target as Record<typeof key, number>)[key] = value;
  }
  target.workers = Math.max(target.workers, usage.workers);
}

export function assertUsageWithinBudget(
  usage: FactoryBudgetUsage,
  budget: FactoryBudget,
  label: string
): void {
  const mappings = [
    ["wallClockSeconds", "wallClockSeconds"],
    ["agentTurns", "maxAgentTurns"],
    ["toolCalls", "maxToolCalls"],
    ["inputTokens", "maxInputTokens"],
    ["outputTokens", "maxOutputTokens"],
    ["costMicrousd", "maxCostMicrousd"],
    ["processes", "maxProcesses"],
    ["outputBytes", "maxOutputBytes"],
    ["workers", "maxWorkers"],
    ["repairAttempts", "maxRepairAttempts"],
    ["changedFiles", "maxChangedFiles"],
    ["changedLines", "maxChangedLines"]
  ] as const;
  if (mappings.some(([usageKey, budgetKey]) => usage[usageKey] > budget[budgetKey])) {
    throw new Error(`${label} exceeds its immutable budget ceiling.`);
  }
}

export function emptyUsage(): FactoryBudgetUsage {
  return {
    wallClockSeconds: 0,
    agentTurns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicrousd: 0,
    processes: 0,
    outputBytes: 0,
    workers: 1,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0
  };
}

const usageKeys = [
  "wallClockSeconds",
  "agentTurns",
  "toolCalls",
  "inputTokens",
  "outputTokens",
  "costMicrousd",
  "processes",
  "outputBytes",
  "repairAttempts",
  "changedFiles",
  "changedLines"
] as const;

function addBudget(target: FactoryBudgetUsage, budget: FactoryBudget): void {
  addUsage(target, {
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
  });
}

function multiplyUsage(usage: FactoryBudgetUsage, multiplier: number): void {
  for (const key of usageKeys) {
    const value = usage[key] * multiplier;
    if (!Number.isSafeInteger(value)) throw new Error("Factory eval reserved budget overflowed.");
    (usage as Record<typeof key, number>)[key] = value;
  }
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
