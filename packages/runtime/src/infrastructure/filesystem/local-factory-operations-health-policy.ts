import {
  factoryOperationsHealthPolicySchema,
  type FactoryOperationsHealthPolicy
} from "@agentlab/contracts";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

/** Loads the reviewed owner-only thresholds for the credentialless health observer. */
export async function loadLocalFactoryOperationsHealthPolicy(
  pathInput: string
): Promise<FactoryOperationsHealthPolicy> {
  const path = privateLocalFilePath(pathInput, "Local factory operations health policy");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory operations health policy",
    minimumBytes: 2,
    maximumBytes: 32 * 1_024
  });
  try {
    return factoryOperationsHealthPolicySchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory operations health policy is not valid JSON.", { cause: error });
  }
}
