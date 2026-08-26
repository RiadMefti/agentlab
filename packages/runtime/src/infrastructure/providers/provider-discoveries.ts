import type { ProviderCapabilityDiscovery } from "../../domain/provider-capability-discovery.js";
import type { CommandRunner } from "../process/command-runner.js";
import { ClaudeCapabilityDiscovery } from "./claude-capability-discovery.js";
import { CodexCapabilityDiscovery } from "./codex-capability-discovery.js";
import { OpenCodeCapabilityDiscovery } from "./opencode-capability-discovery.js";

/** Composes every provider discovery behind the shared domain port. */
export function createProviderDiscoveries(
  runner: CommandRunner
): readonly ProviderCapabilityDiscovery[] {
  return [
    new CodexCapabilityDiscovery(),
    new ClaudeCapabilityDiscovery(),
    new OpenCodeCapabilityDiscovery(runner)
  ];
}
