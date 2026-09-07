import {
  factorySkillPackageSchema,
  skillManifestSchema,
  type FactorySkillPackage,
  type Sha256Digest
} from "@agentlab/contracts";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type { FactorySkillSource, ResolvedFactorySkill } from "../domain/factory-skill.js";

/** Publishes and resolves a strict administrator-supplied immutable skill inventory. */
export class ConfiguredFactorySkillSource implements FactorySkillSource {
  readonly #skills: ReadonlyMap<
    Sha256Digest,
    { readonly documentJson: string; readonly resolved: ResolvedFactorySkill }
  >;

  public constructor(
    packages: readonly FactorySkillPackage[],
    private readonly artifacts: Pick<FactoryArtifactStore, "putText">,
    documents: Pick<FactoryDocumentCodec, "skillPackage">
  ) {
    const entries = packages.map((input) => {
      const document = documents.skillPackage(factorySkillPackageSchema.parse(input));
      const manifest = skillManifestSchema.parse({
        ...document.value.manifest,
        packageDigest: document.digest
      });
      const instructions = document.value.files[manifest.instructionPath];
      if (instructions === undefined || instructions.trim().length === 0) {
        throw new Error(`Configured skill ${manifest.id} has no usable instruction file.`);
      }
      return [
        document.digest,
        {
          documentJson: document.json,
          resolved: {
            packageDigest: document.digest,
            package: document.value,
            manifest,
            instructions
          } satisfies ResolvedFactorySkill
        }
      ] as const;
    });
    if (new Map(entries).size !== entries.length) {
      throw new Error("Configured factory skill inventory contains duplicate packages.");
    }
    this.#skills = new Map(entries);
  }

  public async resolve(packageDigest: Sha256Digest): Promise<ResolvedFactorySkill> {
    const configured = this.#skills.get(packageDigest);
    if (configured === undefined) {
      throw new Error(`Configured factory skill ${packageDigest} is absent.`);
    }
    const stored = await this.artifacts.putText(configured.documentJson);
    if (stored.digest !== configured.resolved.packageDigest) {
      throw new Error("Configured factory skill changed during immutable publication.");
    }
    return configured.resolved;
  }
}
