import { describe, expect, it } from "vitest";

import { CanonicalFactoryIntakeDeduplicator } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-intake-deduplicator.js";

describe("CanonicalFactoryIntakeDeduplicator", () => {
  it("keys stable report identity and changes across repository, kind, or source", () => {
    const deduplicator = new CanonicalFactoryIntakeDeduplicator();
    const input = {
      repositoryId: "riadmefti/agentlab",
      requestKind: "feature" as const,
      sourceRef: "local/42"
    };

    expect(deduplicator.key(input)).toBe(deduplicator.key({ ...input }));
    expect(deduplicator.key(input)).not.toBe(deduplicator.key({ ...input, requestKind: "bug" }));
    expect(deduplicator.key(input)).not.toBe(deduplicator.key({ ...input, sourceRef: "local/43" }));
    expect(deduplicator.key(input)).not.toBe(
      deduplicator.key({ ...input, repositoryId: "riadmefti/another" })
    );
  });
});
