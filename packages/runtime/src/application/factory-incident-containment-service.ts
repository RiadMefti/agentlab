import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  type FactoryIncidentContainment,
  type FactoryOperationsHealthReport,
  type Sha256Digest
} from "@agentlab/contracts";

import type { FactoryIncidentContainmentRepository } from "../domain/factory-incident-containment-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type { FactoryAuthorityState } from "../domain/factory-task-repository.js";
import type { FactoryOperationsHealthService } from "./factory-operations-health-service.js";

export interface FactoryIncidentContainmentResult {
  readonly schemaVersion: "agentlab.incident-containment-result.v1";
  readonly status: "healthy" | "degraded" | "contained" | "already-contained";
  readonly report: FactoryOperationsHealthReport;
  readonly reportDigest: Sha256Digest;
  readonly authorityBefore: FactoryAuthorityState;
  readonly authorityAfter: FactoryAuthorityState;
  readonly containment: FactoryIncidentContainment | null;
  readonly containmentDigest: Sha256Digest | null;
}

export interface FactoryIncidentContainmentServiceDependencies {
  readonly controllerId: string;
  readonly health: Pick<FactoryOperationsHealthService, "inspect">;
  readonly repository: Pick<
    FactoryIncidentContainmentRepository,
    "disableAtomically" | "findByHealthReportDigest"
  >;
  readonly documents: Pick<
    FactoryDocumentCodec,
    "controlEvent" | "incidentContainment" | "operationsHealthReport"
  >;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Recomputes health internally and can only remove scheduler and PR-broker authority. */
export class FactoryIncidentContainmentService {
  readonly #controllerId: string;

  public constructor(private readonly dependencies: FactoryIncidentContainmentServiceDependencies) {
    this.#controllerId = factoryIdentifierSchema.parse(dependencies.controllerId);
  }

  public async containIfCritical(): Promise<FactoryIncidentContainmentResult> {
    const report = await this.dependencies.health.inspect();
    const verifiedReport = this.dependencies.documents.operationsHealthReport(report.value);
    if (report.digest !== verifiedReport.digest || report.json !== verifiedReport.json) {
      throw new Error("Incident controller received a non-canonical health report.");
    }
    const authorityBefore = reportAuthority(report.value);
    if (report.value.status !== "critical") {
      return result(report, report.value.status, authorityBefore, authorityBefore, null);
    }
    const existing = await this.dependencies.repository.findByHealthReportDigest(report.digest);
    if (existing !== null) {
      return result(
        report,
        "already-contained",
        authorityBefore,
        { scheduler: false, prBroker: false },
        existing
      );
    }
    if (!authorityBefore.prBroker && !authorityBefore.scheduler) {
      return result(report, "already-contained", authorityBefore, authorityBefore, null);
    }

    const containedAt = factoryTimestampSchema.parse(this.dependencies.now());
    const actor = {
      kind: "control-plane" as const,
      role: "incident-commander" as const,
      id: this.#controllerId,
      sessionId: null
    };
    const reason = containmentReason(report);
    const brokerDisableEvent = authorityBefore.prBroker
      ? this.dependencies.documents.controlEvent({
          schemaVersion: "agentlab.control-event.v1",
          eventId: this.dependencies.createId(),
          control: "pr-broker",
          enabled: false,
          actor,
          occurredAt: containedAt,
          reason
        })
      : null;
    const schedulerDisableEvent = authorityBefore.scheduler
      ? this.dependencies.documents.controlEvent({
          schemaVersion: "agentlab.control-event.v1",
          eventId: this.dependencies.createId(),
          control: "scheduler",
          enabled: false,
          actor,
          occurredAt: containedAt,
          reason
        })
      : null;
    const containment = this.dependencies.documents.incidentContainment({
      schemaVersion: "agentlab.incident-containment.v1",
      containmentId: this.dependencies.createId(),
      healthReportDigest: report.digest,
      healthReport: report.value,
      authorityBefore: {
        schedulerEnabled: authorityBefore.scheduler,
        prBrokerEnabled: authorityBefore.prBroker
      },
      brokerDisableEventDigest: brokerDisableEvent?.digest ?? null,
      schedulerDisableEventDigest: schedulerDisableEvent?.digest ?? null,
      actor,
      containedAt
    });
    const stored = await this.dependencies.repository.disableAtomically({
      expectedAuthority: authorityBefore,
      brokerDisableEvent,
      schedulerDisableEvent,
      containment
    });
    if (stored === null) {
      throw new Error("Factory authority changed during critical incident containment.");
    }
    return result(
      report,
      "contained",
      authorityBefore,
      { scheduler: false, prBroker: false },
      stored
    );
  }
}

function reportAuthority(report: FactoryOperationsHealthReport): FactoryAuthorityState {
  if (
    report.authority.autonomousDraftsEnabled !==
    (report.authority.schedulerEnabled && report.authority.prBrokerEnabled)
  ) {
    throw new Error("Incident controller observed an inconsistent authority projection.");
  }
  return {
    scheduler: report.authority.schedulerEnabled,
    prBroker: report.authority.prBrokerEnabled
  };
}

function containmentReason(
  report: CanonicalFactoryDocument<FactoryOperationsHealthReport>
): string {
  return `Automatic containment for critical health report ${report.digest}: ${report.value.reasonCodes.join(",")}.`;
}

function result(
  report: CanonicalFactoryDocument<FactoryOperationsHealthReport>,
  status: FactoryIncidentContainmentResult["status"],
  authorityBefore: FactoryAuthorityState,
  authorityAfter: FactoryAuthorityState,
  containment: {
    readonly containment: FactoryIncidentContainment;
    readonly containmentDigest: Sha256Digest;
  } | null
): FactoryIncidentContainmentResult {
  return {
    schemaVersion: "agentlab.incident-containment-result.v1",
    status,
    report: report.value,
    reportDigest: report.digest,
    authorityBefore,
    authorityAfter,
    containment: containment?.containment ?? null,
    containmentDigest: containment?.containmentDigest ?? null
  };
}
