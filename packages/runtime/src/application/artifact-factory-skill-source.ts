import { skillManifestSchema, type Sha256Digest } from "@agentlab/contracts";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type { FactorySkillSource, ResolvedFactorySkill } from "../domain/factory-skill.js";

const maximumSkillPackageBytes = 8 * 1_024 * 1_024;

/** Resolves only canonical, content-addressed skill packages from local immutable storage. */
export class ArtifactFactorySkillSource implements FactorySkillSource {
  public constructor(
    private readonly artifacts: FactoryArtifactStore,
    private readonly documents: Pick<FactoryDocumentCodec, "skillPackage">
  ) {}

  public async resolve(packageDigest: Sha256Digest): Promise<ResolvedFactorySkill> {
    const json = await this.artifacts.readText(packageDigest, maximumSkillPackageBytes);
    const document = this.documents.skillPackage(parseJson(json));
    if (document.digest !== packageDigest || document.json !== json) {
      throw new Error("Factory skill package is not its pinned canonical artifact.");
    }
    const manifest = skillManifestSchema.parse({
      ...document.value.manifest,
      packageDigest
    });
    const instructions = document.value.files[manifest.instructionPath];
    if (instructions === undefined || instructions.trim().length === 0) {
      throw new Error(`Skill ${manifest.id} has no usable instruction file.`);
    }
    return {
      packageDigest,
      package: document.value,
      manifest,
      instructions
    };
  }
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error("Factory skill package is not valid JSON.", { cause: error });
  }
}
