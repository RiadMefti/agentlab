import type { AgentSession } from "@orchestrator/contracts";

import type { CommandSpec } from "./command.js";

export interface CreateCaptainSessionInput {
  readonly name: string;
  readonly cwd: string;
  readonly command: CommandSpec;
}

export interface SessionRuntime {
  createCaptain(input: CreateCaptainSessionInput): Promise<void>;
  kill(name: string): Promise<void>;
  exists(name: string): Promise<boolean>;
  list(conversationId: string): Promise<readonly AgentSession[]>;
}
