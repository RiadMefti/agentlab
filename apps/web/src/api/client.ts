import {
  apiErrorSchema,
  conversationSchema,
  conversationsResponseSchema,
  providersResponseSchema,
  sessionsResponseSchema,
  workerCreatedResponseSchema,
  type Conversation,
  type ConversationsResponse,
  type CreateConversationInput,
  type CreateWorkerInput,
  type ProvidersResponse,
  type SessionsResponse,
  type WorkerCreatedResponse
} from "@orchestrator/contracts";
import { z, type ZodType } from "zod";

export class ApiClientError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function getProviders(): Promise<ProvidersResponse> {
  return request("/api/providers", undefined, providersResponseSchema);
}

export async function getConversations(): Promise<ConversationsResponse> {
  return request("/api/conversations", undefined, conversationsResponseSchema);
}

export async function createConversation(input: CreateConversationInput): Promise<Conversation> {
  return request(
    "/api/conversations",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    },
    conversationSchema
  );
}

export async function getSessions(conversationId: string): Promise<SessionsResponse> {
  return request(
    `/api/conversations/${encodeURIComponent(conversationId)}/sessions`,
    undefined,
    sessionsResponseSchema
  );
}

export async function createWorker(
  conversationId: string,
  input: CreateWorkerInput
): Promise<WorkerCreatedResponse> {
  return request(
    `/api/conversations/${encodeURIComponent(conversationId)}/sessions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    },
    workerCreatedResponseSchema
  );
}

export async function deleteWorker(conversationId: string, sessionName: string): Promise<void> {
  await request(
    `/api/conversations/${encodeURIComponent(conversationId)}/sessions/${encodeURIComponent(sessionName)}`,
    { method: "DELETE" },
    z.null()
  );
}

async function request<T>(
  path: string,
  init: RequestInit | undefined,
  schema: ZodType<T>
): Promise<T> {
  const response = await fetch(path, init);
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(data);
    throw new ApiClientError(
      parsed.success ? parsed.data.error.message : "The local server returned an error.",
      parsed.success ? parsed.data.error.code : "UNKNOWN_ERROR",
      response.status
    );
  }
  return schema.parse(data);
}
