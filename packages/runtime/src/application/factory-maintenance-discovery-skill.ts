import {
  factoryMaintenanceDiscoveryPolicySchema,
  factorySkillPackageSchema,
  skillManifestSchema,
  type FactoryMaintenanceDiscoveryPolicy,
  type FactorySkillPackage
} from "@agentlab/contracts";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type { ResolvedFactorySkill } from "../domain/factory-skill.js";

const utf8Encoder = new TextEncoder();

/** Verifies and publishes the one scout skill pinned by the discovery policy. */
export class FactoryMaintenanceDiscoverySkill {
  readonly #policy: FactoryMaintenanceDiscoveryPolicy;
  readonly #package: CanonicalFactoryDocument<FactorySkillPackage>;
  readonly #resolved: ResolvedFactorySkill;

  public constructor(
    documents: Pick<FactoryDocumentCodec, "skillPackage">,
    private readonly artifacts: Pick<FactoryArtifactStore, "putText">,
    policyInput: unknown,
    packageInput: unknown
  ) {
    this.#policy = factoryMaintenanceDiscoveryPolicySchema.parse(policyInput);
    this.#package = documents.skillPackage(factorySkillPackageSchema.parse(packageInput));
    const manifest = skillManifestSchema.parse({
      ...this.#package.value.manifest,
      packageDigest: this.#package.digest
    });
    if (
      this.#package.digest !== this.#policy.skill.packageDigest ||
      JSON.stringify(manifest) !== JSON.stringify(this.#policy.skill)
    ) {
      throw new Error("Maintenance discovery skill package differs from its reviewed policy.");
    }
    const instructions = this.#package.value.files[manifest.instructionPath];
    if (instructions === undefined || instructions.trim().length === 0) {
      throw new Error("Maintenance discovery skill has no usable instruction file.");
    }
    this.#resolved = {
      packageDigest: this.#package.digest,
      package: this.#package.value,
      manifest,
      instructions
    };
  }

  public inventory() {
    return {
      id: this.#resolved.manifest.id,
      version: this.#resolved.manifest.version,
      packageDigest: this.#resolved.packageDigest
    };
  }

  public async publish(): Promise<ResolvedFactorySkill> {
    const stored = await this.artifacts.putText(this.#package.json);
    if (
      stored.digest !== this.#package.digest ||
      stored.sizeBytes !== utf8Encoder.encode(this.#package.json).byteLength
    ) {
      throw new Error("Published discovery skill package is not its canonical document.");
    }
    return this.#resolved;
  }
}
