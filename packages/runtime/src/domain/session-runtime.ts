import type { AgentSession } from "@agentlab/contracts";

import type { CommandSpec } from "./command.js";

export interface CreateCaptainSessionInput {
  readonly name: string;
  readonly cwd: string;
  readonly command: CommandSpec;
}

export interface CreateWorkerSessionInput {
  readonly name: string;
  readonly cwd: string;
  readonly command: CommandSpec;
}

/** Durable agent-session lifecycle independent of tmux or another adapter. */
export interface SessionRuntime {
  createCaptain(input: CreateCaptainSessionInput): Promise<void>;
  createWorker(input: CreateWorkerSessionInput): Promise<void>;
  kill(name: string): Promise<void>;
  exists(name: string): Promise<boolean>;
  list(conversationId: string): Promise<readonly AgentSession[]>;
}
