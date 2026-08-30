import { describe, expect, it } from "vitest";

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
});
