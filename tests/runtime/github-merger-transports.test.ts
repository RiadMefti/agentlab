import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";

import { afterEach, describe, expect, it, vi } from "vitest";

const httpsRequest = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ request: httpsRequest }));

import { GitHubGraphqlClient } from "../../packages/runtime/src/infrastructure/github/github-graphql-client.js";
import { GitHubMergerInstallationRestClient } from "../../packages/runtime/src/infrastructure/github/github-merger-installation-client.js";

afterEach(() => httpsRequest.mockReset());

describe.each([
  {
    name: "GraphQL",
    status: 200,
    invoke: () =>
      new GitHubGraphqlClient({
        repositoryId: "example/agentlab",
        tokenSource: { token: () => Promise.resolve("test-token") }
      }).request("query AgentLab { viewer { login } }", {})
  },
  {
    name: "merger installation token",
    status: 201,
    invoke: () =>
      new GitHubMergerInstallationRestClient().createToken({
        installationId: 1,
        repositoryNumericId: 2,
        jwt: "test.test.test"
      })
  }
])("$name response settlement", ({ status, invoke }) => {
  it("rejects malformed JSON instead of leaving the operation pending", async () => {
    respondOnce(status, "{malformed");
    await expect(invoke()).rejects.toThrow(/invalid JSON/u);
  }, 1_000);

  it("resolves a complete valid JSON response", async () => {
    respondOnce(status, '{"ok":true}');
    await expect(invoke()).resolves.toEqual({ ok: true });
  });
});

function respondOnce(statusCode: number, body: string): void {
  httpsRequest.mockImplementationOnce(
    (_options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
      const response = Object.assign(new EventEmitter(), {
        statusCode,
        destroy: () => response
      }) as unknown as IncomingMessage;
      const request = Object.assign(new EventEmitter(), {
        setTimeout: () => request,
        destroy: () => request,
        end: () => {
          queueMicrotask(() => {
            callback(response);
            response.emit("data", Buffer.from(body, "utf8"));
            response.emit("end");
          });
          return request;
        }
      }) as unknown as ClientRequest;
      return request;
    }
  );
}
