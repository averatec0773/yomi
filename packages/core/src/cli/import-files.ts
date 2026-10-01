// Terminal import: `pnpm import:files <file>...` (DATABASE_URL picks the ledger, default the PGlite directory data/pglite).
// Stop the yomi server first (or use the Import page): a PGlite directory is open in one process at a time.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { closeDb } from "@yomi/db";
import { detectAndParse } from "@yomi/importers";
import { commitImport } from "../import";
import { ensureOccurredOn } from "../settings/time-zone";
import { getCurrentUser } from "../user";
import { loadRootEnv } from "./env";
import { openLedgerForCli } from "./open";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const force = process.argv.includes("--force");
if (files.length === 0) {
  console.error("usage: pnpm import:files [--force] <file>...");
  process.exit(1);
}

loadRootEnv();
const db = await openLedgerForCli();
const user = getCurrentUser();
await ensureOccurredOn(db, user);

for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  try {
    const r = await commitImport(db, user, detectAndParse, bytes, basename(file), { force });
    const rec = r.reconciliation.ok ? "reconciled" : "does NOT reconcile";
    console.log(`${r.source} batch #${r.batchId}: ${r.rowsTotal} rows, ${r.inserted} new, ${r.skippedDup} duplicate, ${r.linked} linked, ${rec}`);
    for (const w of r.warnings) console.log(`  note: ${w.message}`);
  } catch (e) {
    console.error(`${basename(file)}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
await closeDb(db);
