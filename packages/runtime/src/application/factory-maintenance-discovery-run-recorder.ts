import type {
  FactoryArtifactReference,
  FactoryMaintenanceDiscoveryOutput,
  FactoryMaintenanceDiscoveryPolicy,
  FactoryMaintenanceDiscoveryRunRecord,
  FactoryMaintenanceDiscoveryRunRequest
} from "@agentlab/contracts";

import type { FactoryAgentExecutionOutput } from "../domain/factory-agent-executor.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import { factoryUsageFits } from "../domain/factory-authority-limits.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";

const maximumOutputBytes = 2 * 1_024 * 1_024;

export interface CapturedMaintenanceDiscoveryRun {
  readonly record: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRunRecord>;
  readonly recordArtifact: FactoryArtifactReference;
  readonly output: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryOutput> | null;
}

/** Captures provider output before any proposed finding can enter trusted intake. */
export class FactoryMaintenanceDiscoveryRunRecorder {
  public constructor(
    private readonly artifacts: FactoryArtifactStore,
    private readonly documents: Pick<
      FactoryDocumentCodec,
      "maintenanceDiscoveryOutput" | "maintenanceDiscoveryRunRecord"
    >
  ) {}

  public async capture(input: {
    readonly request: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRunRequest>;
    readonly policy: FactoryMaintenanceDiscoveryPolicy;
    readonly output: FactoryAgentExecutionOutput;
  }): Promise<CapturedMaintenanceDiscoveryRun> {
    const { request, policy, output } = input;
    if (output.isolation.isolationId !== request.value.executionId) {
      throw new Error("Maintenance discovery isolation identity changed during execution.");
    }
    const stdoutArtifact = await this.#putText(output.stdout, "text/plain; charset=utf-8");
    const stderrArtifact = await this.#putText(output.stderr, "text/plain; charset=utf-8");
    const finalOutputArtifact =
      output.finalOutput === null
        ? null
        : await this.#putText(output.finalOutput, "application/json; charset=utf-8");

    let errorCode =
      output.status === "succeeded" ? null : (output.errorCode ?? "discovery-run-failed");
    if (!output.usageComplete) errorCode = "usage-incomplete";
    if (!factoryUsageFits(output.usage, request.value.budget))
      errorCode = "discovery-budget-exceeded";
    if (output.status === "succeeded" && output.providerSessionId === null) {
      errorCode = "provider-session-missing";
    }

    let discoveryOutput: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryOutput> | null = null;
    if (errorCode === null && output.finalOutput !== null) {
      try {
        if (new TextEncoder().encode(output.finalOutput).byteLength > maximumOutputBytes) {
          throw new Error("Discovery output exceeds its hard byte limit.");
        }
        discoveryOutput = this.documents.maintenanceDiscoveryOutput(JSON.parse(output.finalOutput));
        if (discoveryOutput.value.findings.length > policy.maximumFindingsPerTick) {
          throw new Error("Discovery output exceeds its policy finding ceiling.");
        }
      } catch {
        discoveryOutput = null;
        errorCode = "provider-output-invalid";
      }
    } else {
      errorCode ??= "provider-output-missing";
    }
    const outputDocumentArtifact =
      discoveryOutput === null
        ? null
        : await this.#putCanonical(
            discoveryOutput.json,
            discoveryOutput.digest,
            "application/vnd.agentlab.maintenance-discovery-output+json;version=1"
          );
    const succeeded =
      errorCode === null && discoveryOutput !== null && outputDocumentArtifact !== null;
    const record = this.documents.maintenanceDiscoveryRunRecord({
      schemaVersion: "agentlab.maintenance-discovery-run-record.v1",
      executionId: request.value.executionId,
      runId: request.value.runId,
      runDigest: request.value.runDigest,
      provider: request.value.provider,
      providerVersion: output.providerVersion,
      harnessVersion: output.harnessVersion,
      model: request.value.model,
      reasoning: request.value.reasoning,
      providerSessionId: output.providerSessionId,
      status: succeeded ? "succeeded" : output.status === "timed-out" ? "timed-out" : "failed",
      startedAt: output.startedAt,
      finishedAt: output.finishedAt,
      exitCode: succeeded ? 0 : output.exitCode,
      stdoutArtifact,
      stderrArtifact,
      finalOutputArtifact,
      outputDocumentArtifact,
      usage: output.usage,
      usageComplete: output.usageComplete,
      errorCode: succeeded ? null : (errorCode ?? "discovery-run-failed"),
      isolation: output.isolation
    });
    const recordArtifact = await this.#putCanonical(
      record.json,
      record.digest,
      "application/vnd.agentlab.maintenance-discovery-run-record+json;version=1"
    );
    return { record, recordArtifact, output: discoveryOutput };
  }

  async #putText(content: string, mediaType: string): Promise<FactoryArtifactReference> {
    const stored = await this.artifacts.putText(content);
    return { digest: stored.digest, mediaType, sizeBytes: stored.sizeBytes };
  }

  async #putCanonical(
    json: string,
    expectedDigest: string,
    mediaType: string
  ): Promise<FactoryArtifactReference> {
    const artifact = await this.#putText(json, mediaType);
    if (artifact.digest !== expectedDigest) {
      throw new Error("Canonical discovery artifact digest changed during publication.");
    }
    return artifact;
  }
}
