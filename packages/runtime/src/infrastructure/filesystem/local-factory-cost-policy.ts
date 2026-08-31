import { factoryCostPolicySchema, type FactoryCostPolicy } from "@agentlab/contracts";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

/** Loads one canonical owner-only rate card; no mutable provider pricing is consulted at runtime. */
export async function loadLocalFactoryCostPolicy(pathInput: string): Promise<FactoryCostPolicy> {
  const path = privateLocalFilePath(pathInput, "Local factory cost policy");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory cost policy",
    minimumBytes: 2,
    maximumBytes: 256 * 1_024
  });
  try {
    return factoryCostPolicySchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory cost policy is not valid JSON.", { cause: error });
  }
}
