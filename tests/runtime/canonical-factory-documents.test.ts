import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryContract } from "../helpers/factory.js";

describe("canonical factory documents", () => {
  it("orders object keys recursively and normalizes equivalent values", () => {
    expect(canonicalJson({ z: 1, a: { y: true, b: null }, list: [3, "two"] })).toBe(
      '{"a":{"b":null,"y":true},"list":[3,"two"],"z":1}'
    );
    expect(encodeCanonicalDocument({ b: 2, a: 1 }).digest).toBe(
      encodeCanonicalDocument({ a: 1, b: 2 }).digest
    );
  });

  it("validates before hashing a typed factory document", () => {
    const codec = new NodeFactoryDocumentCodec();
    const contract = testFactoryContract();
    const encoded = codec.taskContract(contract);

    expect(encoded.json).toContain('"schemaVersion":"agentlab.task-contract.v1"');
    expect(encoded.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(() => codec.taskContract({ ...contract, unknown: true })).toThrow();
  });

  it("rejects cycles, unsupported values, and unpaired surrogates", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/u);
    expect(() => canonicalJson(undefined)).toThrow(/undefined/u);
    expect(() => canonicalJson("\ud800")).toThrow(/surrogates/u);
  });
});
