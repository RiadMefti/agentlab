import { factoryEvalProductionJobSchema, type FactoryEvalProductionJob } from "@agentlab/contracts";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

/** Loads one owner-only immutable eval-production request. */
export async function loadLocalFactoryEvalProductionJob(
  pathInput: string
): Promise<FactoryEvalProductionJob> {
  const path = privateLocalFilePath(pathInput, "Local factory eval production job");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory eval production job",
    minimumBytes: 2,
    maximumBytes: 16 * 1_024 * 1_024
  });
  try {
    return factoryEvalProductionJobSchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory eval production job is not valid JSON.", { cause: error });
  }
}
