import "server-only";
import { configureKeyFile, defaultKeyFilePath, ensureOccurredOn, getCurrentUser, seed, upgradeSecretsOnOpen } from "@yomi/core";
import { createDb, type Db, migrate } from "@yomi/db";

// One handle per process, kept on globalThis so dev hot reload reuses it: a PGlite directory can be open in
// one process only, and a second PGlite instance in this process would be refused by its lock.
const globalForDb = globalThis as unknown as { yomiDb?: Promise<Db> };

async function open(): Promise<Db> {
  const db = await createDb();
  const backup = await migrate(db);
  if (backup) console.log(`[yomi] Backed up the database before migrating: ${backup}`);
  await seed(db);
  configureKeyFile(defaultKeyFilePath());
  await upgradeSecretsOnOpen(db);
  const regrouped = await ensureOccurredOn(db, getCurrentUser());
  if (regrouped) console.log(`[yomi] Regrouped ${regrouped} transactions by day in your time zone`);
  return db;
}

/**
 * Process-wide DB handle. The first call opens DATABASE_URL (default: the PGlite directory data/pglite),
 * migrates (backing up first when migrations are pending on a ledger with data), seeds, loads the secret key
 * file (used when YOMI_SECRET_KEY is unset; created on the first secret saved in Settings), and with a key
 * encrypts any plaintext bank tokens in place (backing up first). Recomputes transaction days when they are
 * not in the user's time zone yet. Concurrent first calls share one opening; a failed opening is retried by
 * the next call.
 */
export function getDb(): Promise<Db> {
  if (!globalForDb.yomiDb) {
    globalForDb.yomiDb = open().catch((e: unknown) => {
      globalForDb.yomiDb = undefined;
      throw e;
    });
  }
  return globalForDb.yomiDb;
}
