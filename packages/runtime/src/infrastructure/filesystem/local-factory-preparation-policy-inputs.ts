import {
  factoryPreparationAuthorityGrantSchema,
  factorySkillPackageSchema,
  type FactoryPreparationAuthorityGrant,
  type FactorySkillPackage
} from "@agentlab/contracts";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

export async function loadFactoryPreparationGrant(
  pathInput: string
): Promise<FactoryPreparationAuthorityGrant> {
  const path = privateLocalFilePath(pathInput, "Factory preparation authority grant");
  const content = await readPrivateLocalFile(path, {
    label: "Factory preparation authority grant",
    minimumBytes: 2,
    maximumBytes: 2 * 1_024 * 1_024
  });
  try {
    return factoryPreparationAuthorityGrantSchema.parse(
      parseJson(content.toString("utf8"), "preparation authority grant")
    );
  } finally {
    content.fill(0);
  }
}

export async function loadFactorySkillPackage(pathInput: string): Promise<FactorySkillPackage> {
  const path = privateLocalFilePath(pathInput, "Factory skill package");
  const content = await readPrivateLocalFile(path, {
    label: "Factory skill package",
    minimumBytes: 2,
    maximumBytes: 8 * 1_024 * 1_024
  });
  try {
    return factorySkillPackageSchema.parse(parseJson(content.toString("utf8"), "skill package"));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Local factory ${label} is not valid JSON.`, { cause: error });
  }
}
