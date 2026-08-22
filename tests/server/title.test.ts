import { describe, expect, it } from "vitest";

import { deriveTitle } from "../../apps/server/src/application/title.js";

describe("deriveTitle", () => {
  it("uses and normalizes the first line", () => {
    expect(deriveTitle("  Fix   the refresh race  \nExtra context")).toBe("Fix the refresh race");
  });

  it("truncates long prompts without splitting the visual contract", () => {
    const title = deriveTitle("a".repeat(100));
    expect(title).toHaveLength(56);
    expect(title.endsWith("…")).toBe(true);
  });

  it("has a stable fallback", () => {
    expect(deriveTitle(" \nignored")).toBe("New conversation");
  });
});
