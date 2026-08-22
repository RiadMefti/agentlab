import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@orchestrator/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    clearMocks: true,
    include: ["tests/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    testTimeout: 10_000
  }
});
