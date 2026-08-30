import { createHash } from "node:crypto";

import {
  evidenceBundleSchema,
  factoryAgentRunRecordSchema,
  factoryControlEventSchema,
  factoryGateObservationSchema,
  factoryPatchProposalSchema,
  factoryPolicyDecisionSchema,
  factoryPolicyEvaluationRecordSchema,
  factoryPullRequestProposalSchema,
  factoryPullRequestRecordSchema,
  factoryReviewResultSchema,
  factoryResourceIsolationRecordSchema,
  factorySkillPackageSchema,
  factoryTaskUsageRecordSchema,
  immutableTaskContractSchema,
  taskEventSchema
} from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";

export class NodeFactoryDocumentCodec implements FactoryDocumentCodec {
  public taskContract(input: unknown) {
    return encodeCanonicalDocument(immutableTaskContractSchema.parse(input));
  }

  public taskEvent(input: unknown) {
    return encodeCanonicalDocument(taskEventSchema.parse(input));
  }

  public evidenceBundle(input: unknown) {
    return encodeCanonicalDocument(evidenceBundleSchema.parse(input));
  }

  public controlEvent(input: unknown) {
    return encodeCanonicalDocument(factoryControlEventSchema.parse(input));
  }

  public policyDecision(input: unknown) {
    return encodeCanonicalDocument(factoryPolicyDecisionSchema.parse(input));
  }

  public policyEvaluation(input: unknown) {
    return encodeCanonicalDocument(factoryPolicyEvaluationRecordSchema.parse(input));
  }

  public skillPackage(input: unknown) {
    return encodeCanonicalDocument(factorySkillPackageSchema.parse(input));
  }

  public agentRun(input: unknown) {
    return encodeCanonicalDocument(factoryAgentRunRecordSchema.parse(input));
  }

  public gateObservation(input: unknown) {
    return encodeCanonicalDocument(factoryGateObservationSchema.parse(input));
  }

  public resourceIsolation(input: unknown) {
    return encodeCanonicalDocument(factoryResourceIsolationRecordSchema.parse(input));
  }

  public patchProposal(input: unknown) {
    return encodeCanonicalDocument(factoryPatchProposalSchema.parse(input));
  }

  public reviewResult(input: unknown) {
    return encodeCanonicalDocument(factoryReviewResultSchema.parse(input));
  }

  public pullRequestProposal(input: unknown) {
    return encodeCanonicalDocument(factoryPullRequestProposalSchema.parse(input));
  }

  public pullRequestRecord(input: unknown) {
    return encodeCanonicalDocument(factoryPullRequestRecordSchema.parse(input));
  }

  public taskUsage(input: unknown) {
    return encodeCanonicalDocument(factoryTaskUsageRecordSchema.parse(input));
  }
}

export function encodeCanonicalDocument<Value>(value: Value): CanonicalFactoryDocument<Value> {
  const json = canonicalJson(value);
  return {
    value,
    json,
    digest: `sha256:${createHash("sha256").update(json, "utf8").digest("hex")}`
  };
}

/** RFC 8785-compatible canonical JSON for the bounded JSON values admitted by factory schemas. */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set<object>());
}

function serializeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers.");
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON rejects ${typeof value} values.`);
  }
  if (ancestors.has(value)) throw new TypeError("Canonical JSON rejects cyclic values.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serializeCanonical(item, ancestors)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const properties = Object.keys(record)
      .sort()
      .map((key) => {
        assertUnicodeScalarString(key);
        return `${JSON.stringify(key)}:${serializeCanonical(record[key], ancestors)}`;
      });
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) {
        throw new TypeError("Canonical JSON rejects unpaired UTF-16 surrogates.");
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("Canonical JSON rejects unpaired UTF-16 surrogates.");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("Canonical JSON rejects unpaired UTF-16 surrogates.");
    }
  }
}
