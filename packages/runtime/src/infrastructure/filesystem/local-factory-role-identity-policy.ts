import {
  factoryRoleIdentityPolicySchema,
  type FactoryRoleIdentityPolicy
} from "@agentlab/contracts";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

/** Loads one owner-only copy of the shared signer/worker identity policy. */
export async function loadLocalFactoryRoleIdentityPolicy(
  pathInput: string
): Promise<FactoryRoleIdentityPolicy> {
  const path = privateLocalFilePath(pathInput, "Local factory role identity policy");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory role identity policy",
    minimumBytes: 2,
    maximumBytes: 16 * 1_024
  });
  try {
    return factoryRoleIdentityPolicySchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory role identity policy is not valid JSON.", { cause: error });
  }
}
