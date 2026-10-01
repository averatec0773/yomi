import { createDb, type Db, DbLockedError, LegacyLedgerError, migrate } from "@yomi/db";
import { upgradeSecretsOnOpen } from "../secrets/tokens";
import { seed } from "../seed";

/**
 * Opens the ledger for a CLI (DATABASE_URL, default the PGlite directory data/pglite): migrates (backing up
 * first when needed), seeds and upgrades stored secrets, like the web server does. A PGlite directory is open
 * in one process at a time; while the yomi server (or another command) has it, this prints why and exits 1
 * without touching it.
 */
export async function openLedgerForCli(): Promise<Db> {
  let db: Db;
  try {
    db = await createDb();
  } catch (e) {
    if (e instanceof DbLockedError || e instanceof LegacyLedgerError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const backup = await migrate(db);
  if (backup) console.log(`Backed up before migrating: ${backup}`);
  await seed(db);
  await upgradeSecretsOnOpen(db);
  return db;
}
