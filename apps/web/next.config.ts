import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Next only reads .env files next to this config (apps/web). yomi's configuration lives in .env.local at the
// repo root, so load that too; variables already set are not overridden.
const rootEnv = path.join(import.meta.dirname, "..", "..", ".env.local");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  // NEXT_DIST_DIR lets several dev servers run side by side (e.g. one per DATABASE_URL).
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  transpilePackages: ["@yomi/api", "@yomi/contracts", "@yomi/core", "@yomi/db", "@yomi/importers"],
  // PGlite loads its WASM and data files from its own package directory, so it must not be bundled;
  // better-sqlite3 (a native addon) is only used by the v0.1 SQLite import.
  serverExternalPackages: ["@electric-sql/pglite", "pg", "better-sqlite3", "pdfjs-dist"],
};

export default nextConfig;
