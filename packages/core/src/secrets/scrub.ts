import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  BACKUP_EXTENSION,
  closeDb,
  compactTables,
  type Db,
  findRepoRoot,
  listTables,
  openBackupFile,
  resolveDbTarget,
  rewriteBackupFile,
} from "@yomi/db";
import { isEncrypted } from "./crypto";
import { encryptTokensInTransaction, readStoredTokens, TOKEN_TABLES } from "./tokens";

export interface ScrubFileResult {
  file: string;
  /** Plaintext tokens found (before --apply). */
  plaintext: number;
  encrypted: number;
  /** Tokens encrypted by this run (0 in a dry run). */
  rewritten: number;
  error: string | null;
}

/** data/backups next to the ledger directory (DATABASE_URL, default data/pglite); <repo>/data/backups otherwise. */
export function defaultBackupsDir(): string {
  const t = resolveDbTarget();
  return t.kind === "pglite" ? path.join(path.dirname(t.dataDir), "backups") : path.join(findRepoRoot(), "data", "backups");
}

/** PGlite backup tarballs (*.tar.gz) in the given files/directories (directories are not recursed), sorted. */
export function backupFiles(targets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of targets) {
    if (!existsSync(t)) continue;
    if (statSync(t).isDirectory()) {
      for (const f of readdirSync(t)) if (f.endsWith(BACKUP_EXTENSION)) out.add(path.resolve(t, f));
    } else out.add(path.resolve(t));
  }
  return [...out].sort();
}

/**
 * Counts plaintext Plaid tokens in one backup; with `key` (apply) encrypts them in one verified transaction and
 * replaces the file: the PGlite tarball is loaded into memory, compacted (so the plaintext row versions are gone)
 * and written back. Never deletes a backup.
 */
export async function scrubBackupFile(file: string, opts: { key?: Buffer | null } = {}): Promise<ScrubFileResult> {
  const key = opts.key ?? null;
  const res: ScrubFileResult = { file, plaintext: 0, encrypted: 0, rewritten: 0, error: null };
  let db: Db;
  try {
    db = await openBackupFile(file);
  } catch (e) {
    res.error = `cannot open: ${e instanceof Error ? e.message : String(e)}`;
    return res;
  }
  try {
    const present = new Set(await listTables(db));
    const tables = TOKEN_TABLES.filter((t) => present.has(t));
    const tokens = await readStoredTokens(db, tables);
    res.plaintext = tokens.filter((t) => !isEncrypted(t.value)).length;
    res.encrypted = tokens.length - res.plaintext;
    if (key && res.plaintext > 0) {
      res.rewritten = await encryptTokensInTransaction(db, tokens, key);
      await compactTables(db, tables);
      await rewriteBackupFile(db, file);
    }
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
  } finally {
    await closeDb(db);
  }
  return res;
}
