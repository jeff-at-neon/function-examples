import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "blocks/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Block tests that need a real database are opt-in via NEON_BLOCKS_TEST_DATABASE_URL.
    // Everything else must be pure logic so `npm test` works offline.
    passWithNoTests: true,
  },
});
