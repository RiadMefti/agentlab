import type { FactoryAutonomousMergePolicy } from "@agentlab/contracts";

import {
  type CanonicalFactoryDocument,
  type FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "../persistence/canonical-factory-documents.js";
import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

/** Loads a strict owner-only autonomous merge policy without loading any remote credential. */
export async function loadLocalFactoryAutonomousMergePolicy(
  pathInput: string,
  documents: Pick<FactoryDocumentCodec, "autonomousMergePolicy"> = new NodeFactoryDocumentCodec()
): Promise<CanonicalFactoryDocument<FactoryAutonomousMergePolicy>> {
  const path = privateLocalFilePath(pathInput, "Local factory autonomous merge policy");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory autonomous merge policy",
    minimumBytes: 2,
    maximumBytes: 256 * 1_024
  });
  try {
    return documents.autonomousMergePolicy(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local autonomous merge policy is not valid JSON.", { cause: error });
  }
}
