import {
  factoryPreparationAuthorityGrantSchema,
  factorySkillPackageSchema,
  skillManifestSchema,
  type FactoryPreparationAuthorityGrant,
  type FactorySkillPackage,
  type Sha256Digest
} from "@agentlab/contracts";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";

const utf8Encoder = new TextEncoder();

export interface FactorySkillPackageInventoryEntry {
  readonly id: string;
  readonly packageDigest: Sha256Digest;
}

/** Validates and immutably publishes the exact skill packages pinned by an authority grant. */
export class FactorySkillPackagePublisher {
  readonly #packages: readonly CanonicalFactoryDocument<FactorySkillPackage>[];
  readonly #inventory: readonly FactorySkillPackageInventoryEntry[];

  public constructor(
    documents: Pick<FactoryDocumentCodec, "skillPackage">,
    private readonly artifacts: Pick<FactoryArtifactStore, "putText">,
    grantInput: unknown,
    packageInputs: readonly unknown[]
  ) {
    const grant = factoryPreparationAuthorityGrantSchema.parse(grantInput);
    this.#packages = packageInputs.map((input) =>
      documents.skillPackage(factorySkillPackageSchema.parse(input))
    );
    this.#inventory = validateInventory(grant, this.#packages);
  }

  public inventory(): readonly FactorySkillPackageInventoryEntry[] {
    return this.#inventory.map((entry) => ({ ...entry }));
  }

  public async publish(): Promise<void> {
    await Promise.all(
      this.#packages.map(async (document) => {
        const stored = await this.artifacts.putText(document.json);
        if (
          stored.digest !== document.digest ||
          stored.sizeBytes !== utf8Encoder.encode(document.json).byteLength
        ) {
          throw new Error("Published factory skill package does not match its canonical document.");
        }
      })
    );
  }
}

function validateInventory(
  grant: FactoryPreparationAuthorityGrant,
  packages: readonly CanonicalFactoryDocument<FactorySkillPackage>[]
): readonly FactorySkillPackageInventoryEntry[] {
  if (packages.length !== grant.skills.length) {
    throw new Error("Factory intake requires exactly one package for every authorized skill.");
  }
  const authorizedByDigest = new Map(
    grant.skills.map((skill) => [skill.manifest.packageDigest, skill] as const)
  );
  if (authorizedByDigest.size !== grant.skills.length) {
    throw new Error("Factory authority grant contains duplicate skill package digests.");
  }
  const seen = new Set<Sha256Digest>();
  const inventory: FactorySkillPackageInventoryEntry[] = [];
  for (const document of packages) {
    if (seen.has(document.digest)) {
      throw new Error("Factory intake skill package list contains a duplicate package.");
    }
    seen.add(document.digest);
    const authorized = authorizedByDigest.get(document.digest);
    if (authorized === undefined) {
      throw new Error(`Factory skill package ${document.digest} is not authorized by the grant.`);
    }
    const actualManifest = skillManifestSchema.parse({
      ...document.value.manifest,
      packageDigest: document.digest
    });
    if (JSON.stringify(actualManifest) !== JSON.stringify(authorized.manifest)) {
      throw new Error(`Factory skill package ${document.digest} manifest differs from its grant.`);
    }
    inventory.push({ id: actualManifest.id, packageDigest: document.digest });
  }
  if (seen.size !== authorizedByDigest.size) {
    throw new Error("Factory intake is missing an authorized skill package.");
  }
  return inventory.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
