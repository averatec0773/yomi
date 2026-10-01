import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { type Db, dbTarget, listTables, openDumpInMemory, pgliteOf, queryRows } from "./client";

export const BACKUPS_KEEP = 10;
export const BACKUP_EXTENSION = ".tar.gz";

export interface BackupOptions {
  /** Defaults to `<parent of the data directory>/backups` (data/backups for data/pglite). */
  dir?: string;
  /** Backups kept per data directory and reason. */
  keep?: number;
  now?: Date;
}

/** Where backups of `db` go: data/backups next to a PGlite directory; null in memory or on a server. */
export function backupsDir(db: Db): string | null {
  const t = dbTarget(db);
  return t.kind === "pglite" ? path.join(path.dirname(t.dataDir), "backups") : null;
}

/** The pg_dump command (run from the repo root) that copies a server database into data/backups; yomi never runs it itself. */
export function pgDumpHint(now: Date = new Date()): string {
  return `pg_dump --format=custom --file=data/backups/yomi-${stamp(now)}.dump "$DATABASE_URL"`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local time as YYYYMMDD-HHmmss. */
function stamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Writes a consistent gzip tarball of a PGlite data directory (PGlite dumpDataDir, taken between queries) to
 * `<dir>/<data dir name>-<YYYYMMDD-HHmmss>-<reason>.tar.gz` and keeps the newest `keep` copies for that name +
 * reason. Returns the new file's path; null in memory or on a Postgres server (see pgDumpHint). Restore: stop
 * yomi, move the data directory aside, `mkdir data/pglite && tar -xzf <backup> -C data/pglite`.
 * Must not be called inside a transaction.
 */
export async function backupDatabase(db: Db, reason: string, opts: BackupOptions = {}): Promise<string | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reason)) throw new Error(`invalid backup reason: ${reason}`);
  const t = dbTarget(db);
  const client = pgliteOf(db);
  if (t.kind !== "pglite" || !client) return null;
  const dir = opts.dir ?? path.join(path.dirname(t.dataDir), "backups");
  mkdirSync(dir, { recursive: true });

  const base = path.basename(t.dataDir);
  const prefix = `${base}-${stamp(opts.now ?? new Date())}-${reason}`;
  const existing = new Set(readdirSync(dir));
  let name = `${prefix}${BACKUP_EXTENSION}`;
  for (let n = 2; existing.has(name); n++) name = `${prefix}-${n}${BACKUP_EXTENSION}`;
  const target = path.join(dir, name);
  const dump = await client.dumpDataDir("gzip");
  const tmp = `${target}.partial`;
  writeFileSync(tmp, new Uint8Array(await dump.arrayBuffer()));
  renameSync(tmp, target);

  rotateBackups(dir, base, reason, opts.keep ?? BACKUPS_KEEP);
  return target;
}

/** Deletes all but the newest `keep` backups of `base` + `reason` in `dir`. */
export function rotateBackups(dir: string, base: string, reason: string, keep: number): string[] {
  const re = new RegExp(`^${escapeRe(base)}-(\\d{8}-\\d{6})-${escapeRe(reason)}(?:-(\\d+))?${escapeRe(BACKUP_EXTENSION)}$`);
  const files = readdirSync(dir)
    .map((f) => ({ f, m: re.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .map(({ f, m }) => ({ f, key: m[1]!, n: Number(m[2] ?? 1) }))
    .sort((a, b) => (a.key === b.key ? a.n - b.n : a.key < b.key ? -1 : 1));
  const removed = files.slice(0, Math.max(files.length - keep, 0)).map((x) => x.f);
  for (const f of removed) rmSync(path.join(dir, f), { force: true });
  return removed;
}

/** True when the database already holds ledger tables and at least one migration in `folder` has not run. */
export async function needsPreMigrateBackup(db: Db, folder: string): Promise<boolean> {
  if ((await listTables(db)).length === 0) return false;
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const hasLog = await queryRows<{ n: number }>(
    db,
    sql`select count(*)::int as n from information_schema.tables where table_schema = 'drizzle' and table_name = '__drizzle_migrations'`,
  );
  if (!hasLog[0]?.n) return migrations.length > 0;
  const last = await queryRows<{ created_at: number | string | null }>(db, sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`);
  return migrations.some((m) => !last[0] || Number(last[0].created_at) < m.folderMillis);
}

/** Opens a backup tarball as an in-memory database (the file is not changed). Close with closeDb. */
export async function openBackupFile(file: string): Promise<Db> {
  return await openDumpInMemory(new Blob([new Uint8Array(readFileSync(file))]));
}

/** Replaces a backup tarball with the current contents of `db` (opened by openBackupFile): written aside, then renamed over it. */
export async function rewriteBackupFile(db: Db, file: string): Promise<void> {
  const client = pgliteOf(db);
  if (!client) throw new Error("rewriteBackupFile needs a PGlite database");
  const dump = await client.dumpDataDir("gzip");
  const tmp = `${file}.partial`;
  writeFileSync(tmp, new Uint8Array(await dump.arrayBuffer()));
  renameSync(tmp, file);
}
