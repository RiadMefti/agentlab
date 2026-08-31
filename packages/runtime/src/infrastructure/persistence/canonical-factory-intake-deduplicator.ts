import { factoryIdentifierSchema, factoryIntakeSubmissionSchema } from "@agentlab/contracts";

import type {
  FactoryIntakeDeduplicationInput,
  FactoryIntakeDeduplicator
} from "../../domain/factory-intake-deduplicator.js";
import { encodeCanonicalDocument } from "./canonical-factory-documents.js";

/** Hashes only stable source identity, never mutable report text or caller-provided task data. */
export class CanonicalFactoryIntakeDeduplicator implements FactoryIntakeDeduplicator {
  public key(input: FactoryIntakeDeduplicationInput) {
    const repositoryId = factoryIdentifierSchema.parse(input.repositoryId);
    const submission = factoryIntakeSubmissionSchema
      .pick({
        kind: true,
        sourceRef: true
      })
      .parse({ kind: input.requestKind, sourceRef: input.sourceRef });
    return encodeCanonicalDocument({
      schemaVersion: "agentlab.intake-deduplication.v1" as const,
      repositoryId,
      requestKind: submission.kind,
      sourceRef: submission.sourceRef
    }).digest;
  }
}
