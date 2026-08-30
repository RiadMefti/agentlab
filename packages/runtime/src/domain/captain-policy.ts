import type { ProviderId } from "@agentlab/contracts";

export interface CaptainPolicyInput {
  readonly conversationId: string;
  readonly workspace: string;
  readonly ownershipNonce: string;
  readonly providerExecutables: Readonly<Partial<Record<ProviderId, string>>>;
}

export interface RenderedCaptainPolicy {
  readonly instructions: string;
  readonly environment: Readonly<Record<string, string>>;
}

/** Renders tmux-facing captain policy without coupling application use cases to shell syntax. */
export interface CaptainPolicyRenderer {
  render(input: CaptainPolicyInput): RenderedCaptainPolicy;
}
