import { factoryIntakeSubmissionSchema, type FactoryIntakeSubmission } from "@agentlab/contracts";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

/** Reads one bounded owner-only feature or bug report at the local process boundary. */
export async function loadLocalFactoryIntakeSubmission(
  pathInput: string
): Promise<FactoryIntakeSubmission> {
  const path = privateLocalFilePath(pathInput, "Local factory intake submission");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory intake submission",
    minimumBytes: 2,
    maximumBytes: 128 * 1_024
  });
  try {
    return factoryIntakeSubmissionSchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory intake submission is not valid JSON.", { cause: error });
  }
}
