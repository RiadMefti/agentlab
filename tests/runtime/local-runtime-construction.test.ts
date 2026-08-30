import { describe, expect, it, vi } from "vitest";

import { cleanupFailedRuntimeConstruction } from "../../packages/runtime/src/application/local-runtime-construction.js";

describe("failed local runtime construction", () => {
  it("retains the writer lease when repository closure is not confirmed", () => {
    const repositoryFailure = new Error("repository close ambiguous");
    const writerLease = { databasePath: "/work/agentlab.sqlite", close: vi.fn() };

    const failures = cleanupFailedRuntimeConstruction(
      {
        close() {
          throw repositoryFailure;
        }
      },
      writerLease
    );

    expect(failures).toEqual([repositoryFailure]);
    expect(writerLease.close).not.toHaveBeenCalled();
  });

  it("releases the writer lease only after the repository is confirmed closed", () => {
    const repository = { close: vi.fn() };
    const writerLease = { databasePath: "/work/agentlab.sqlite", close: vi.fn() };

    expect(cleanupFailedRuntimeConstruction(repository, writerLease)).toEqual([]);
    expect(repository.close).toHaveBeenCalledOnce();
    expect(writerLease.close).toHaveBeenCalledOnce();
  });

  it("retains the writer lease when repository construction never confirmed database closure", () => {
    const writerLease = { databasePath: "/work/agentlab.sqlite", close: vi.fn() };

    expect(cleanupFailedRuntimeConstruction(null, writerLease, false)).toEqual([]);
    expect(writerLease.close).not.toHaveBeenCalled();
  });
});
