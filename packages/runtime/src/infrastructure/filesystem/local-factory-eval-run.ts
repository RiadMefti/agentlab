import { factoryEvalRunSchema, type FactoryEvalRun } from "@agentlab/contracts";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

/** Loads one complete owner-only matched eval report without following ambiguous paths. */
export async function loadLocalFactoryEvalRun(pathInput: string): Promise<FactoryEvalRun> {
  const path = privateLocalFilePath(pathInput, "Local factory eval run");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory eval run",
    minimumBytes: 2,
    maximumBytes: 32 * 1_024 * 1_024
  });
  try {
    return factoryEvalRunSchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory eval run is not valid JSON.", { cause: error });
  }
}
