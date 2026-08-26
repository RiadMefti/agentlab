import type { BinarySbom } from "./generate-release-sbom.js";
import { discoverAnthropicSdkVersionInBinary } from "./binary-prebundle-scan.mjs";

export { discoverAnthropicSdkVersionInBinary } from "./binary-prebundle-scan.mjs";

/** Confirms that the compiled executable and its generated SBOM name the same opaque SDK. */
export async function assertBinarySbomCorrespondence(
  binaryPath: string,
  sbom: BinarySbom
): Promise<void> {
  const binaryVersion = await discoverAnthropicSdkVersionInBinary(binaryPath);
  const sdkComponents = sbom.components.filter(({ name }) => name === "@anthropic-ai/sdk");
  if (sdkComponents.length !== 1 || sdkComponents[0]?.version !== binaryVersion) {
    throw new Error(
      `Compiled Anthropic SDK ${binaryVersion} does not have one matching SBOM component.`
    );
  }
  const sdk = sdkComponents[0];
  const claude = sbom.components.find(({ name }) => name === "@anthropic-ai/claude-agent-sdk");
  const claudeDependency = sbom.dependencies.find(({ ref }) => ref === claude?.["bom-ref"]);
  if (claude === undefined || !claudeDependency?.dependsOn.includes(sdk["bom-ref"])) {
    throw new Error("The SBOM does not link Claude Agent SDK to its embedded Anthropic SDK.");
  }
  if (
    !hasProperty(sdk, "agentlab:component:distribution", "prebundled") ||
    !hasProperty(sdk, "agentlab:component:provenance", "anthropic-stainless-runtime-marker") ||
    !sdk.evidence?.occurrences.some(({ location }) =>
      location.endsWith("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs")
    )
  ) {
    throw new Error("The Anthropic SDK component has no verified source-bundle provenance.");
  }
}

function hasProperty(
  component: BinarySbom["components"][number],
  name: string,
  value: string
): boolean {
  return component.properties.some(
    (property) => property.name === name && property.value === value
  );
}
