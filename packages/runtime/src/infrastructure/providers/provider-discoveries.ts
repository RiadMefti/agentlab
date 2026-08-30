import type { ProviderCapabilityDiscovery } from "../../domain/provider-capability-discovery.js";
import type { ManagedRuntimeResourceOwner } from "../../domain/runtime-resource.js";
import type { CommandRunner } from "../process/command-runner.js";
import {
  ClaudeAgentSdkCatalogClient,
  ClaudeCapabilityDiscovery
} from "./claude-capability-discovery.js";
import {
  CodexAppServerCatalogClient,
  CodexCapabilityDiscovery
} from "./codex-capability-discovery.js";
import { OpenCodeCapabilityDiscovery } from "./opencode-capability-discovery.js";

/** Composes every provider discovery behind the shared domain port. */
export function createProviderDiscoveries(
  runner: CommandRunner,
  resourceOwner?: ManagedRuntimeResourceOwner
): readonly ProviderCapabilityDiscovery[] {
  return [
    new CodexCapabilityDiscovery(
      new CodexAppServerCatalogClient(undefined, undefined, undefined, resourceOwner)
    ),
    new ClaudeCapabilityDiscovery(new ClaudeAgentSdkCatalogClient(undefined, resourceOwner)),
    new OpenCodeCapabilityDiscovery(runner)
  ];
}
