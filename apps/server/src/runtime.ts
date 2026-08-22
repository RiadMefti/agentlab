import type { FastifyInstance } from "fastify";

import { ConversationService } from "./application/conversation-service.js";
import { buildApp } from "./app.js";
import { NodeCommandRunner } from "./infrastructure/process/command-runner.js";
import { SqliteConversationRepository } from "./infrastructure/persistence/sqlite-conversation-repository.js";
import { BinaryLocator } from "./infrastructure/providers/binary-locator.js";
import { captainLaunchers } from "./infrastructure/providers/captain-launchers.js";
import { LocalProviderCatalog } from "./infrastructure/providers/local-provider-catalog.js";
import { createProviderDiscoveries } from "./infrastructure/providers/provider-discoveries.js";
import { TerminalGateway } from "./infrastructure/terminal/terminal-gateway.js";
import { TmuxSessionRuntime } from "./infrastructure/tmux/tmux-session-runtime.js";

export { loadConfig, type AppConfig } from "./config.js";

export interface OrchestratorServerOptions {
  readonly databasePath: string;
  readonly workspace: string;
  readonly logger?: boolean;
  readonly webRoot?: string | null;
}

export async function createOrchestratorServer(
  options: OrchestratorServerOptions
): Promise<FastifyInstance> {
  const runner = new NodeCommandRunner();
  const repository = new SqliteConversationRepository(options.databasePath);

  try {
    const sessions = new TmuxSessionRuntime(runner);
    const providers = new LocalProviderCatalog(
      captainLaunchers,
      createProviderDiscoveries(runner),
      new BinaryLocator(runner),
      runner,
      { workspace: options.workspace }
    );
    const conversations = new ConversationService({
      repository,
      providers,
      sessions,
      workspace: options.workspace
    });
    const app = await buildApp({
      conversations,
      terminal: new TerminalGateway(),
      workspace: options.workspace,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot })
    });

    app.addHook("onClose", () => {
      repository.close();
    });
    return app;
  } catch (error: unknown) {
    repository.close();
    throw error;
  }
}
