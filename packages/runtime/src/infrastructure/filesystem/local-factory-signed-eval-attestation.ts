import {
  factorySignedEvalAttestationSchema,
  type FactorySignedEvalAttestation
} from "@agentlab/contracts";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

/** Loads one bounded, owner-only signed artifact before cryptographic verification. */
export async function loadLocalFactorySignedEvalAttestation(
  pathInput: string
): Promise<FactorySignedEvalAttestation> {
  const path = privateLocalFilePath(pathInput, "Local signed factory eval attestation");
  const content = await readPrivateLocalFile(path, {
    label: "Local signed factory eval attestation",
    minimumBytes: 2,
    maximumBytes: 512 * 1_024
  });
  try {
    return factorySignedEvalAttestationSchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local signed factory eval attestation is not valid JSON.", { cause: error });
  }
}
