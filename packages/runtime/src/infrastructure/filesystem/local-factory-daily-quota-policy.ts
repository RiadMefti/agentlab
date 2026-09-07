import { factoryDailyQuotaPolicySchema, type FactoryDailyQuotaPolicy } from "@agentlab/contracts";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

/** Loads the reviewed owner-only repository and organization UTC-day ceilings. */
export async function loadLocalFactoryDailyQuotaPolicy(
  pathInput: string
): Promise<FactoryDailyQuotaPolicy> {
  const path = privateLocalFilePath(pathInput, "Local factory daily quota policy");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory daily quota policy",
    minimumBytes: 2,
    maximumBytes: 256 * 1_024
  });
  try {
    return factoryDailyQuotaPolicySchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory daily quota policy is not valid JSON.", { cause: error });
  }
}
