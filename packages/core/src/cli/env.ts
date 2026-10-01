import { existsSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "@yomi/db";
import { configureKeyFile, defaultKeyFilePath } from "../secrets/keyfile";

/**
 * Loads <repo>/.env.local like next.config.ts does for the web server (variables already set win), then the
 * secret key file, so CLIs read credentials like the server does: env first, then Settings.
 */
export function loadRootEnv(): void {
  const file = path.join(findRepoRoot(), ".env.local");
  if (existsSync(file)) process.loadEnvFile(file);
  configureKeyFile(defaultKeyFilePath());
}
