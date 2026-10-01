import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { closeDb, createDb, type Db, listTables, migrate, openDumpInMemory } from "./client";

// Test support: one migrated in-memory PGlite per test file (module), emptied between tests. Starting PGlite
// with initdb and migrating costs about half a second per database; the root vitest global setup
// (vitest.global-setup.ts) migrates one database per run and hands its data directory to every test file
// (YOMI_TEST_PGLITE_TEMPLATE), which loads in about a tenth of that. TRUNCATE ... RESTART IDENTITY then costs a
// few milliseconds and restarts every id at 1 like a fresh database.

export const TEMPLATE_ENV = "YOMI_TEST_PGLITE_TEMPLATE";

let shared: Promise<Db> | undefined;

/** A migrated in-memory database: a copy of the run's template when there is one, else created and migrated. */
async function newMigratedDb(): Promise<Db> {
  const template = process.env[TEMPLATE_ENV];
  if (template && existsSync(template)) return await openDumpInMemory(new Blob([new Uint8Array(readFileSync(template))]));
  const db = await createDb("memory://");
  await migrate(db);
  return db;
}

/** Empties every ledger table and restarts identity sequences; the schema and migration log stay. */
export async function resetDb(db: Db): Promise<void> {
  const tables = await listTables(db);
  if (tables.length) await db.execute(sql.raw(`truncate table ${tables.map((t) => `"${t}"`).join(", ")} restart identity cascade`));
}

/**
 * The file's shared migrated in-memory database, emptied. Calling it again empties it again, so a test that
 * needs two independent databases at once uses isolatedTestDb for the second.
 */
export async function testDb(): Promise<Db> {
  shared ??= newMigratedDb();
  const db = await shared;
  await resetDb(db);
  return db;
}

/**
 * A migrated PGlite data directory at `dataDir` (closed, ready for createDb), made from the run's template:
 * loading it takes a fraction of a fresh initdb, which dominates tests of on-disk ledgers.
 */
export async function migratedTestDir(dataDir: string): Promise<void> {
  const template = process.env[TEMPLATE_ENV];
  mkdirSync(path.dirname(dataDir), { recursive: true });
  if (template && existsSync(template)) {
    const pg = await PGlite.create(dataDir, { loadDataDir: new Blob([new Uint8Array(readFileSync(template))]) });
    await pg.close();
    return;
  }
  const db = await createDb(dataDir);
  await migrate(db);
  await closeDb(db);
}

/** A separate migrated in-memory database; the caller closes it with closeDb. */
export async function isolatedTestDb(): Promise<Db> {
  return await newMigratedDb();
}

export { closeDb };
