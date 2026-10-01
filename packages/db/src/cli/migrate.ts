// `pnpm db:migrate`: applies pending migrations to DATABASE_URL (default: the PGlite directory data/pglite).
import { closeDb, createDb, migrate } from "../client";
import { DbLockedError } from "../lock";
import { defaultDatabaseUrl, redactUrl, resolveDbTarget } from "../paths";

const url = defaultDatabaseUrl();
const target = resolveDbTarget(url);
try {
  const db = await createDb(url);
  const backup = await migrate(db);
  if (backup) console.log(`backed up to ${backup}`);
  await closeDb(db);
  console.log(`migrated ${target.kind === "server" ? redactUrl(target.url) : target.kind === "pglite" ? target.dataDir : "memory://"}`);
} catch (e) {
  console.error(e instanceof DbLockedError ? e.message : `migration failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
