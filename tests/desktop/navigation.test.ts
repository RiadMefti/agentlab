import { describe, expect, it } from "vitest";

import { isTrustedAppUrl } from "../../apps/desktop/src/navigation.js";

describe("desktop navigation policy", () => {
  const appUrl = "http://127.0.0.1:49152";

  it("accepts only the embedded server origin", () => {
    expect(isTrustedAppUrl(`${appUrl}/api/health`, appUrl)).toBe(true);
    expect(isTrustedAppUrl("http://127.0.0.1:4321", appUrl)).toBe(false);
    expect(isTrustedAppUrl("https://example.com", appUrl)).toBe(false);
    expect(isTrustedAppUrl("not a URL", appUrl)).toBe(false);
  });
});
