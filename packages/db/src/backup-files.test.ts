// backupDatabase, rotation and backup files; split from backup.test.ts (pre-migrate) so both run in parallel.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDatabase, backupsDir, openBackupFile, rewriteBackupFile, rotateBackups } from "./backup";
import { closeDb, createDb, type Db, queryRows } from "./client";
import { migratedTestDir } from "./testing";

let dir: string;
const open: Db[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yomi-backup-"));
});
afterEach(async () => {
  for (const db of open.splice(0)) await closeDb(db);
  rmSync(dir, { recursive: true, force: true });
});

async function openDb(url: string): Promise<Db> {
  const db = await createDb(url);
  open.push(db);
  return db;
}

function backups(): string[] {
  const d = path.join(dir, "backups");
  return existsSync(d) ? readdirSync(d).sort() : [];
}

// PGlite data directories on disk: initdb and file I/O take seconds when the whole suite runs in parallel.
describe("backupDatabase", { timeout: 30_000 }, () => {
  it("names by data directory and reason, disambiguates same-second copies, keeps the newest N per reason", async () => {
    await migratedTestDir(path.join(dir, "ledger"));
    const db = await openDb(path.join(dir, "ledger"));
    const t0 = new Date(2026, 8, 29, 10, 0, 0);
    for (let i = 0; i < 4; i++) await backupDatabase(db, "pre-import", { now: new Date(t0.getTime() + i * 1000), keep: 3 });
    const same = await backupDatabase(db, "pre-import", { now: new Date(t0.getTime() + 3 * 1000), keep: 3 });
    await backupDatabase(db, "manual", { now: t0, keep: 3 });

    expect(same).toMatch(/ledger-20260929-100003-pre-import-2\.tar\.gz$/);
    const files = backups();
    const imports = files.filter((f) => f.includes("pre-import"));
    expect(imports).toEqual(["ledger-20260929-100002-pre-import.tar.gz", "ledger-20260929-100003-pre-import-2.tar.gz", "ledger-20260929-100003-pre-import.tar.gz"]);
    expect(files.filter((f) => f.includes("manual"))).toEqual(["ledger-20260929-100000-manual.tar.gz"]);
    expect(files.some((f) => f.endsWith(".partial"))).toBe(false);
  });

  it("rotation ignores other data directory names and reasons", () => {
    const d = path.join(dir, "b");
    mkdirSync(d);
    for (const f of [
      "demo-20260101-000000-manual.tar.gz",
      "pglite-20260101-000000-manual.tar.gz",
      "pglite-20260102-000000-manual.tar.gz",
      "pglite-20260101-000000-pre-import.tar.gz",
      "notes.txt",
    ]) {
      writeFileSync(path.join(d, f), "");
    }
    expect(rotateBackups(d, "pglite", "manual", 1)).toEqual(["pglite-20260101-000000-manual.tar.gz"]);
    expect(readdirSync(d).sort()).toEqual(["demo-20260101-000000-manual.tar.gz", "notes.txt", "pglite-20260101-000000-pre-import.tar.gz", "pglite-20260102-000000-manual.tar.gz"]);
  });

  it("returns null for in-memory databases and rejects odd reasons", async () => {
    const db = await openDb("memory://");
    expect(backupsDir(db)).toBeNull();
    expect(await backupDatabase(db, "manual")).toBeNull();
    await expect(backupDatabase(db, "../x")).rejects.toThrow(/invalid backup reason/);
  });

  it("a backup opens in memory with its rows, and rewriteBackupFile replaces it in place", async () => {
    await migratedTestDir(path.join(dir, "pglite"));
    const db = await openDb(path.join(dir, "pglite"));
    await db.execute(sql`insert into user_settings (user_id, key, value, updated_at) values (0, 'k', 'enc:v1:abc', 'x')`);
    const file = (await backupDatabase(db, "manual"))!;

    const copy = await openBackupFile(file);
    open.push(copy);
    expect(await queryRows(copy, sql`select user_id, key, value from user_settings`)).toEqual([{ user_id: 0, key: "k", value: "enc:v1:abc" }]);
    await copy.execute(sql`update user_settings set value = 'enc:v2:def'`);
    await rewriteBackupFile(copy, file);
    expect(existsSync(`${file}.partial`)).toBe(false);

    const again = await openBackupFile(file);
    open.push(again);
    expect(await queryRows(again, sql`select value from user_settings`)).toEqual([{ value: "enc:v2:def" }]);
    // The live directory is untouched.
    expect(await queryRows(db, sql`select value from user_settings`)).toEqual([{ value: "enc:v1:abc" }]);
  });
});
