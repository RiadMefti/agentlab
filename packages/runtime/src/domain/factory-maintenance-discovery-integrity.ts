import type {
  FactoryMaintenanceDiscoveryEvent,
  FactoryMaintenanceDiscoveryRun
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";

type DiscoveryRunDocument = CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRun>;
type DiscoveryEventDocument = CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent>;

export function assertFactoryMaintenanceDiscoveryRun(
  run: DiscoveryRunDocument,
  documents: Pick<FactoryDocumentCodec, "maintenanceDiscoveryPolicy" | "schedulePolicy">
): void {
  if (
    documents.maintenanceDiscoveryPolicy(run.value.discoveryPolicy).digest !==
      run.value.discoveryPolicyDigest ||
    documents.schedulePolicy(run.value.schedulePolicy).digest !== run.value.schedulePolicyDigest
  ) {
    throw new Error("Maintenance discovery run contains a non-canonical policy pin.");
  }
  if (
    run.value.discoveryPolicy.maximumFindingsPerTick >
      run.value.schedulePolicy.maximumCandidatesPerTick ||
    run.value.discoveryPolicy.maximumAdmissionsPerTick >
      run.value.schedulePolicy.maximumTasksPerTick
  ) {
    throw new Error("Maintenance discovery policy exceeds its daily schedule ceilings.");
  }
}

export function assertFactoryMaintenanceDiscoveryRegistration(
  run: DiscoveryRunDocument,
  event: DiscoveryEventDocument
): void {
  if (
    event.value.kind !== "registered" ||
    event.value.runId !== run.value.runId ||
    event.value.runDigest !== run.digest ||
    event.value.correlationId !== run.value.correlationId ||
    event.value.occurredAt !== run.value.createdAt
  ) {
    throw new Error("Maintenance discovery registration does not match its immutable run.");
  }
}

export function assertFactoryMaintenanceDiscoveryEvent(
  run: DiscoveryRunDocument,
  event: DiscoveryEventDocument,
  history: readonly DiscoveryEventDocument[]
): void {
  const previous = history.at(-1);
  if (previous === undefined) {
    throw new Error("Maintenance discovery event history has no registration root.");
  }
  if (
    event.value.runId !== run.value.runId ||
    event.value.runDigest !== run.digest ||
    event.value.correlationId !== run.value.correlationId ||
    event.value.sequence !== previous.value.sequence + 1 ||
    event.value.previousEventDigest !== previous.digest ||
    event.value.from !== previous.value.to ||
    event.value.occurredAt < previous.value.occurredAt ||
    event.value.occurredAt < run.value.createdAt
  ) {
    throw new Error("Maintenance discovery event chain failed immutable lineage validation.");
  }
  const started = [...history]
    .reverse()
    .find(
      (
        candidate
      ): candidate is CanonicalFactoryDocument<
        Extract<FactoryMaintenanceDiscoveryEvent, { readonly kind: "agent-started" }>
      > => candidate.value.kind === "agent-started"
    );
  if (
    (event.value.kind === "agent-finished" || event.value.kind === "agent-failed") &&
    event.value.executionId !== started?.value.executionId
  ) {
    throw new Error("Maintenance discovery completion does not match its agent execution.");
  }
  if (event.value.kind === "finding-admitted" || event.value.kind === "finding-skipped") {
    const findingKey = event.value.findingKey;
    if (
      history.some(
        ({ value }) =>
          (value.kind === "finding-admitted" || value.kind === "finding-skipped") &&
          value.findingKey === findingKey
      )
    ) {
      throw new Error(`Maintenance finding ${findingKey} already has a disposition.`);
    }
  }
  if (event.value.kind === "completed") {
    const agentFinished = history.find(({ value }) => value.kind === "agent-finished")?.value;
    const admitted = history.filter(({ value }) => value.kind === "finding-admitted").length;
    const skipped = history.filter(({ value }) => value.kind === "finding-skipped").length;
    if (
      agentFinished?.kind !== "agent-finished" ||
      event.value.findings !== agentFinished.findings ||
      event.value.admitted !== admitted ||
      event.value.skipped !== skipped ||
      admitted + skipped !== agentFinished.findings ||
      JSON.stringify(event.value.usage) !== JSON.stringify(agentFinished.usage)
    ) {
      throw new Error("Maintenance discovery completion summary disagrees with its event history.");
    }
  }
}
