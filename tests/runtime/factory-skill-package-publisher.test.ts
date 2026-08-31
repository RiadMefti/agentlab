import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactFactorySkillSource } from "../../packages/runtime/src/application/artifact-factory-skill-source.js";
import { FactorySkillPackagePublisher } from "../../packages/runtime/src/application/factory-skill-package-publisher.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryIntakePolicyFixture } from "../helpers/factory-intake.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("FactorySkillPackagePublisher", () => {
  it("publishes and resolves every exact grant-pinned canonical package", async () => {
    const fixture = testFactoryIntakePolicyFixture();
    const documents = new NodeFactoryDocumentCodec();
    const artifacts = new FileFactoryArtifactStore(temporaryRoot());
    const publisher = new FactorySkillPackagePublisher(
      documents,
      artifacts,
      fixture.grant,
      fixture.packages
    );

    await publisher.publish();

    expect(publisher.inventory()).toHaveLength(fixture.grant.skills.length);
    const source = new ArtifactFactorySkillSource(artifacts, documents);
    for (const skill of fixture.grant.skills) {
      await expect(source.resolve(skill.manifest.packageDigest)).resolves.toMatchObject({
        manifest: skill.manifest
      });
    }
  });

  it("rejects missing, duplicate, altered, and unpinned package inventories", () => {
    const fixture = testFactoryIntakePolicyFixture();
    const documents = new NodeFactoryDocumentCodec();
    const artifacts = new FileFactoryArtifactStore(temporaryRoot());
    const construct = (packages: readonly unknown[]) =>
      new FactorySkillPackagePublisher(documents, artifacts, fixture.grant, packages);

    expect(() => construct(fixture.packages.slice(1))).toThrow(/exactly one package/u);
    expect(() => construct([...fixture.packages.slice(0, -1), fixture.packages[0]])).toThrow(
      /duplicate package/u
    );
    expect(() =>
      construct(
        fixture.packages.map((skillPackage, index) =>
          index === 0
            ? {
                ...skillPackage,
                files: {
                  ...skillPackage.files,
                  [skillPackage.manifest.instructionPath]: "Substituted instructions."
                }
              }
            : skillPackage
        )
      )
    ).toThrow(/not authorized/u);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-intake-skills-"));
  temporaryRoots.push(root);
  return root;
}
