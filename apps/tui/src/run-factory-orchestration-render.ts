import {
  loadLocalFactoryOrchestrationConfig,
  renderConfiguredLocalFactoryDailyCycle,
  type FactoryDailyCycleBundle,
  type LocalFactoryOrchestrationConfig
} from "@agentlab/runtime/factory-orchestration";

import { isNormalizedAbsolutePath } from "./factory-cli-input.js";

export interface FactoryOrchestrationRenderRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryOrchestrationConfig>;
  readonly render: (config: LocalFactoryOrchestrationConfig) => FactoryDailyCycleBundle;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryOrchestrationRenderRunnerDependencies = {
  loadConfig: loadLocalFactoryOrchestrationConfig,
  render: renderConfiguredLocalFactoryDailyCycle,
  write: (message) => process.stdout.write(message)
};

/** Emits a reviewable bundle to stdout; no file, service, authority, or ledger is changed. */
export async function runFactoryOrchestrationRender(
  configPath: string,
  dependencies: FactoryOrchestrationRenderRunnerDependencies = defaultDependencies
): Promise<number> {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory orchestration rendering requires a normalized absolute config path.");
  }
  const config = await dependencies.loadConfig(configPath);
  const bundle = dependencies.render(config);
  dependencies.write(`${JSON.stringify(bundle, null, 2)}\n`);
  return 0;
}
