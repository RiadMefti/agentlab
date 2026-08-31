import { factoryCanaryRequestSchema, type FactoryCanaryRequest } from "@agentlab/contracts";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

/** Loads one owner-only human canary request; it contains no execution or remote credential. */
export async function loadLocalFactoryCanaryRequest(
  pathInput: string
): Promise<FactoryCanaryRequest> {
  const path = privateLocalFilePath(pathInput, "Local factory canary request");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory canary request",
    minimumBytes: 2,
    maximumBytes: 64 * 1_024
  });
  try {
    return factoryCanaryRequestSchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory canary request is not valid JSON.", { cause: error });
  }
}
