import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

const httpsRequest = vi.hoisted(() => vi.fn());

vi.mock("node:https", () => ({ request: httpsRequest }));

import { GitHubRestClient } from "../../packages/runtime/src/infrastructure/github/github-rest-client.js";

describe("GitHubRestClient boundary validation", () => {
  it("rejects invalid repository identity and HTTP header configuration", () => {
    const tokenSource = { token: () => Promise.resolve("token") };
    expect(() => new GitHubRestClient({ repositoryId: "Not/Lowercase", tokenSource })).toThrow(
      /lowercase owner\/name/u
    );
    expect(
      () =>
        new GitHubRestClient({
          repositoryId: "example/agentlab",
          tokenSource,
          userAgent: "bad user agent\r\n"
        })
    ).toThrow(/HTTP token/u);
  });

  it("rejects paths and bodies before acquiring a credential or opening a connection", async () => {
    let tokenRequests = 0;
    const client = new GitHubRestClient({
      repositoryId: "example/agentlab",
      tokenSource: {
        token: () => {
          tokenRequests += 1;
          return Promise.resolve("token");
        }
      },
      maximumRequestBytes: 8
    });

    await expect(client.request("GET", "/repos/other/repository")).rejects.toThrow(
      /outside the configured repository/u
    );
    await expect(
      client.request("GET", "/repos/example/agentlab/issues", { unexpected: true })
    ).rejects.toThrow(/cannot carry a body/u);
    await expect(
      client.request("POST", "/repos/example/agentlab/pulls", { body: "too large" })
    ).rejects.toThrow(/request exceeded its size limit/u);
    expect(tokenRequests).toBe(0);
  });

  it("invalidates only the credential rejected by GitHub", async () => {
    respondOnce(401, '{"message":"Bad credentials"}');
    const invalidations: { readonly repositoryId: string; readonly token: string }[] = [];
    const client = new GitHubRestClient({
      repositoryId: "example/agentlab",
      tokenSource: {
        token: () => Promise.resolve("rejected-token"),
        invalidate: (repositoryId, token) => invalidations.push({ repositoryId, token })
      }
    });

    await expect(
      client.request("GET", "/repos/example/agentlab/pulls?state=open")
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(invalidations).toEqual([{ repositoryId: "example/agentlab", token: "rejected-token" }]);
  });
});

afterEach(() => {
  httpsRequest.mockReset();
});

function respondOnce(statusCode: number, body: string): void {
  httpsRequest.mockImplementationOnce(
    (
      _options: import("node:https").RequestOptions,
      callback: (response: IncomingMessage) => void
    ): ClientRequest => {
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
