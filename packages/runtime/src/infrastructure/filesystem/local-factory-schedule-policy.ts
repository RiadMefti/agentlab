import { factorySchedulePolicySchema, type FactorySchedulePolicy } from "@agentlab/contracts";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

/** Loads the separately reviewed owner-only daily schedule and quota policy. */
export async function loadLocalFactorySchedulePolicy(
  pathInput: string
): Promise<FactorySchedulePolicy> {
  const path = privateLocalFilePath(pathInput, "Local factory schedule policy");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory schedule policy",
    minimumBytes: 2,
    maximumBytes: 64 * 1_024
  });
  try {
    return factorySchedulePolicySchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory schedule policy is not valid JSON.", { cause: error });
  }
}
