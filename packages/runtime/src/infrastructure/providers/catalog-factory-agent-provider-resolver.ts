import type { ProviderId } from "@agentlab/contracts";

import type { ProviderCatalogFactory } from "../../domain/agent-launcher.js";
import type {
  FactoryAgentProviderResolver,
  ResolvedFactoryAgentProvider
} from "../../domain/factory-agent-executor.js";

/** Reuses the live local provider catalog while exposing no interactive launcher to the factory. */
export class CatalogFactoryAgentProviderResolver implements FactoryAgentProviderResolver {
  public constructor(private readonly catalogs: ProviderCatalogFactory) {}

  public async resolve(
    provider: ProviderId,
    workspace: string
  ): Promise<ResolvedFactoryAgentProvider | null> {
    const resolved = await this.catalogs.forWorkspace(workspace).resolve(provider);
    if (resolved === null) return null;
    return { executable: resolved.executable, version: resolved.version };
  }
}
