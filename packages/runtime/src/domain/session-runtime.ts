import type { AgentSession } from "@agentlab/contracts";

import type { CommandSpec } from "./command.js";

export const sessionOwnershipEnvironmentVariable = "AGENTLAB_SESSION_OWNERSHIP";

export type SessionOwnership =
  { readonly mode: "nonce"; readonly nonce: string } | { readonly mode: "legacy-name" };

export type SessionOwnershipInspection =
  { readonly status: "absent" } | { readonly status: "present"; readonly nonce: string | null };

export type OwnedSessionKillResult = "absent" | "killed" | "ownership-mismatch";

export const maximumManagedSessionInventory = 128;

export interface SessionInventoryEntry {
  readonly session: AgentSession;
  readonly ownershipNonce: string | null;
}

export type SessionCreationCleanup = "confirmed-absent" | "unconfirmed";

/** Carries positive compensation evidence without turning ambiguous creation into absence. */
export class SessionCreationError extends Error {
  public constructor(
    primary: unknown,
    public readonly cleanup: SessionCreationCleanup,
    cause: unknown = primary
  ) {
    super(primary instanceof Error ? primary.message : "Managed session creation failed.", {
      cause
    });
    this.name = "SessionCreationError";
  }
}

/** Opaque, immutable adapter handle obtained only after current ownership proof. */
export interface SessionAttachmentTarget {
  readonly sessionName: string;
  readonly runtimeId: string;
  readonly serverPid: string;
  readonly serverStartedAt: string;
  readonly ownership: SessionOwnership;
}

export type OwnedSessionResolution =
  | { readonly status: "absent" | "ownership-mismatch" }
  | { readonly status: "owned"; readonly target: SessionAttachmentTarget };

export interface CreateCaptainSessionInput {
  readonly name: string;
  readonly cwd: string;
  readonly command: CommandSpec;
  readonly ownership: SessionOwnership;
}

export interface CreateWorkerSessionInput {
  readonly name: string;
  readonly cwd: string;
  readonly command: CommandSpec;
  readonly ownership: SessionOwnership;
}

/** Durable agent-session lifecycle independent of tmux or another adapter. */
export interface SessionRuntime {
  createCaptain(input: CreateCaptainSessionInput): Promise<void>;
  createWorker(input: CreateWorkerSessionInput): Promise<void>;
  inspectOwnership(name: string): Promise<SessionOwnershipInspection>;
  resolveOwnedTarget(name: string, ownership: SessionOwnership): Promise<OwnedSessionResolution>;
  killOwned(name: string, ownership: SessionOwnership): Promise<OwnedSessionKillResult>;
  exists(name: string): Promise<boolean>;
  listInventory(conversationId: string): Promise<readonly SessionInventoryEntry[]>;
  list(conversationId: string): Promise<readonly AgentSession[]>;
}
