import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/.next-*/**", "e2e/**"],
    environment: "node",
    globalSetup: ["./vitest.global-setup.ts"],
    // Worker threads start faster than forked processes, which matters when each test file boots its own PGlite
    // (about half the suite's time with forks).
    pool: "threads",
    passWithNoTests: true,
  },
});
