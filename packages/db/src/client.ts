import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { type SQL, sql } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import { backupDatabase, type BackupOptions, needsPreMigrateBackup, pgDumpHint } from "./backup";
import { acquireDirLock, releaseDirLock } from "./lock";
import { type DbTarget, defaultDatabaseUrl, defaultPgliteDir, migrationsFolder, redactUrl, resolveDbTarget } from "./paths";

/**
 * A database or a transaction handle. Both drivers (PGlite, node-postgres) are Drizzle PgDatabases, and a
 * transaction is one too, so functions taking `Db` accept either.
 */
export type Db = PgDatabase<PgQueryResultHKT, Record<string, never>>;

interface DbMeta {
  target: DbTarget;
  pglite: PGlite | null;
  pool: pg.Pool | null;
  lockFile: string | null;
  closed: boolean;
}

// Kept on the handle under a registry symbol rather than in a module-level map: Next.js can load this module
// more than once in one process (instrumentation, route handlers, pages), and each copy must still see the
// handle's target, PGlite instance and lock.
const META = Symbol.for("yomi.db.meta");

function setMeta(db: Db, m: DbMeta): void {
  Object.defineProperty(db, META, { value: m, enumerable: false });
}

function meta(db: Db): DbMeta {
  const m = (db as unknown as Record<symbol, DbMeta | undefined>)[META];
  if (!m) throw new Error("Not a root database handle from createDb (a transaction handle was passed?)");
  return m;
}

/** What `db` is connected to: a PGlite directory, in-memory PGlite, or a Postgres server. */
export function dbTarget(db: Db): DbTarget {
  return meta(db).target;
}

/** The PGlite instance behind `db`, or null on a Postgres server. */
export function pgliteOf(db: Db): PGlite | null {
  return meta(db).pglite;
}

/** Server pool size (DATABASE_POOL_MAX, default 10). */
function poolMax(): number {
  const n = Number(process.env.DATABASE_POOL_MAX);
  return Number.isInteger(n) && n > 0 ? n : 10;
}

/**
 * Opens the database named by `url` (default DATABASE_URL, else <repo>/data/pglite):
 * - a directory path: PGlite persisted there (created on first use). Takes `<dir>.lock`; throws
 *   DbLockedError when another live process holds it (a PGlite directory allows one process at a time).
 * - `memory://`: in-memory PGlite (tests).
 * - `postgres://` / `postgresql://`: a Postgres server through a node-postgres pool.
 * A path that is a file (a yomi v0.1 SQLite ledger) is refused, and so is creating the default data/pglite
 * next to an existing data/yomi.db, so an upgrade never starts an empty ledger by mistake (LegacyLedgerError;
 * `allowBesideLegacy` is for the import itself). Close with closeDb.
 */
export async function createDb(url: string = defaultDatabaseUrl(), opts: { allowBesideLegacy?: boolean } = {}): Promise<Db> {
  const target = resolveDbTarget(url);
  if (target.kind === "pglite") assertNotLegacy(target.dataDir, opts.allowBesideLegacy ?? false);
  if (target.kind === "server") {
    const pool = new pg.Pool({ connectionString: target.url, max: poolMax() });
    try {
      await pool.query("select 1");
    } catch (e) {
      await pool.end().catch(() => {});
      throw new Error(`Cannot connect to ${redactUrl(target.url)}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    const db = drizzleNodePg({ client: pool }) as unknown as Db;
    setMeta(db, { target, pglite: null, pool, lockFile: null, closed: false });
    return db;
  }
  let lockFile: string | null = null;
  let client: PGlite;
  if (target.kind === "pglite") {
    mkdirSync(path.dirname(target.dataDir), { recursive: true });
    lockFile = acquireDirLock(target.dataDir);
    try {
      client = await PGlite.create(target.dataDir);
    } catch (e) {
      releaseDirLock(lockFile);
      throw e;
    }
  } else {
    client = await PGlite.create();
  }
  const db = drizzlePglite({ client }) as unknown as Db;
  setMeta(db, { target, pglite: client, pool: null, lockFile, closed: false });
  return db;
}

/**
 * An in-memory PGlite loaded from a data directory tarball (a backup written by backupDatabase). Changes stay in
 * memory until saved with backupDatabase-style dumping (see rewriteBackup). Close with closeDb.
 */
export async function openDumpInMemory(tarball: Blob): Promise<Db> {
  const client = await PGlite.create({ loadDataDir: tarball });
  const db = drizzlePglite({ client }) as unknown as Db;
  setMeta(db, { target: { kind: "memory" }, pglite: client, pool: null, lockFile: null, closed: false });
  return db;
}

const IMPORT_HINT = "pnpm db:import-sqlite data/yomi.db";

/** Opening a v0.1 SQLite ledger as a PGlite directory, or starting a new default ledger beside one. */
export class LegacyLedgerError extends Error {
  readonly code = "db_legacy_sqlite";
  constructor(message: string) {
    super(message);
    this.name = "LegacyLedgerError";
  }
}

function assertNotLegacy(dataDir: string, allowBesideLegacy: boolean): void {
  if (existsSync(dataDir) && !statSync(dataDir).isDirectory()) {
    throw new LegacyLedgerError(
      `DATABASE_URL points at the file ${dataDir}, probably a yomi v0.1 SQLite ledger. yomi now keeps the ledger in a ` +
        `PGlite directory: copy it with \`pnpm db:import-sqlite ${dataDir}\`, then unset DATABASE_URL (or point it at a directory).`,
    );
  }
  if (allowBesideLegacy || dataDir !== defaultPgliteDir()) return;
  const fresh = !existsSync(dataDir) || readdirSync(dataDir).length === 0;
  const legacy = path.join(path.dirname(dataDir), "yomi.db");
  if (fresh && existsSync(legacy)) {
    throw new LegacyLedgerError(
      `Found a yomi v0.1 SQLite ledger at ${legacy} but no ledger at ${dataDir}. Copy it first with \`${IMPORT_HINT}\` ` +
        "(stop the yomi server while it runs); yomi does not start an empty ledger beside it.",
    );
  }
}

/** Closes the PGlite instance (flushing it to disk) or the server pool, and releases the directory lock. */
export async function closeDb(db: Db): Promise<void> {
  const m = meta(db);
  if (m.closed) return;
  m.closed = true;
  try {
    if (m.pglite) await m.pglite.close();
    if (m.pool) await m.pool.end();
  } finally {
    if (m.lockFile) releaseDirLock(m.lockFile);
  }
}

/** Runs a raw statement and returns its rows (both drivers return `{ rows }`). For packages/db, scripts and tests. */
export async function queryRows<T>(db: Db, query: SQL): Promise<T[]> {
  const r = (await db.execute(query)) as unknown as { rows: T[] };
  return r.rows;
}

/** Names of the ledger tables (schema public), sorted. */
export async function listTables(db: Db): Promise<string[]> {
  const rows = await queryRows<{ name: string }>(
    db,
    sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
  );
  return rows.map((t) => t.name);
}

/**
 * After secrets were rewritten in place: VACUUM FULL rewrites the given tables into new files (the old files,
 * which still hold the replaced plaintext row versions, are dropped). On PGlite the write-ahead log still has
 * those row versions too, so it then switches to a new WAL segment with recycling off and checkpoints, which
 * deletes the old segments instead of keeping them for reuse. The plaintext then lingers neither in the data
 * directory nor in its next backup. Best effort on a server (VACUUM FULL needs table ownership; failures are
 * ignored, and the server's WAL and archives are the operator's). Must run outside a transaction.
 */
export async function compactTables(db: Db, tables: readonly string[]): Promise<void> {
  for (const t of tables) {
    try {
      await db.execute(sql.raw(`vacuum full "${t.replace(/"/g, '""')}"`));
    } catch {
      // not the owner (server) or table missing: nothing more we can do here
    }
  }
  if (!meta(db).pglite) return;
  await db.execute(sql`set wal_recycle = off`);
  try {
    await db.execute(sql`select pg_switch_wal()`);
    await db.execute(sql`checkpoint`);
  } finally {
    await db.execute(sql`reset wal_recycle`);
  }
}

/**
 * Applies pending migrations (in one transaction). A PGlite directory that already holds data gets a
 * `pre-migrate` backup tarball first (see backupDatabase); in-memory and fresh databases do not. On a server,
 * yomi cannot copy the database, so it prints how to take one with pg_dump before migrating. Returns the backup
 * path, if one was written.
 */
export async function migrate(db: Db, folder: string = migrationsFolder(), backup: BackupOptions = {}): Promise<string | null> {
  const m = meta(db);
  let copy: string | null = null;
  if (m.target.kind !== "memory" && (await needsPreMigrateBackup(db, folder))) {
    if (m.target.kind === "pglite") copy = await backupDatabase(db, "pre-migrate", backup);
    else console.log(`[yomi] Applying database migrations. yomi does not back up a Postgres server itself; to keep a copy first: ${pgDumpHint()}`);
  }
  if (m.pool) await migrateNodePg(db as never, { migrationsFolder: folder });
  else await migratePglite(db as never, { migrationsFolder: folder });
  return copy;
}
