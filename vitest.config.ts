import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", "**/.next-*/**", "e2e/**"],
    environment: "node",
    globalSetup: ["./vitest.global-setup.ts"],
    // Worker threads start faster than forked processes, which matters when each test file boots its own PGlite
    // (about half the suite's time with forks). CI uses forks: on GitHub's Linux runners Node 24 aborts while
    // tearing down PGlite's WebAssembly in worker threads (V8 "jit_page_->allocations_" check), after every test passed.
    pool: process.env.CI ? "forks" : "threads",
    passWithNoTests: true,
  },
});
