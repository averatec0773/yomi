import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupsDir, needsPreMigrateBackup } from "./backup";
import { closeDb, createDb, type Db, listTables, migrate } from "./client";
import { migrationsFolder } from "./paths";
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

/** A copy of the migrations folder with one more (trivial) migration appended to the journal. */
function migrationsWithExtra(): string {
  const folder = path.join(dir, "migrations-next");
  cpSync(migrationsFolder(), folder, { recursive: true });
  const journal = path.join(folder, "meta", "_journal.json");
  const j = JSON.parse(readFileSync(journal, "utf8")) as { entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[] };
  const last = j.entries.at(-1)!;
  j.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1000, tag: "9999_extra", breakpoints: true });
  writeFileSync(journal, JSON.stringify(j));
  writeFileSync(path.join(folder, "9999_extra.sql"), `CREATE TABLE "zz_extra" ("id" integer PRIMARY KEY);`);
  return folder;
}

function backups(): string[] {
  const d = path.join(dir, "backups");
  return existsSync(d) ? readdirSync(d).sort() : [];
}

// PGlite data directories on disk: initdb and file I/O take seconds when the whole suite runs in parallel.
describe("pre-migrate backup", { timeout: 30_000 }, () => {
  it("skips a fresh PGlite directory and an up-to-date one", async () => {
    const db = await openDb(path.join(dir, "pglite"));
    expect(await migrate(db)).toBeNull();
    await db.execute(sql`insert into participants (user_id, name, created_at) values (1, '室友', 'x')`);
    expect(await needsPreMigrateBackup(db, migrationsFolder())).toBe(false);
    expect(await migrate(db)).toBeNull();
    expect(backups()).toEqual([]);
  });

  it("skips in-memory databases", async () => {
    const db = await openDb("memory://");
    await migrate(db);
    await db.execute(sql`insert into participants (user_id, name, created_at) values (1, 'A', 'x')`);
    expect(await migrate(db, migrationsWithExtra())).toBeNull();
    expect(await listTables(db)).toContain("zz_extra");
  });

  it("writes a tarball of a PGlite directory with data before applying pending migrations, which restores", async () => {
    await migratedTestDir(path.join(dir, "pglite"));
    const db = await openDb(path.join(dir, "pglite"));
    expect(await migrate(db)).toBeNull();
    await db.execute(sql`insert into participants (user_id, name, created_at) values (1, '室友', 'x')`);

    const next = migrationsWithExtra();
    expect(await needsPreMigrateBackup(db, next)).toBe(true);
    const copy = await migrate(db, next);
    expect(copy).toMatch(/[/\\]backups[/\\]pglite-\d{8}-\d{6}-pre-migrate\.tar\.gz$/);
    expect(path.dirname(copy!)).toBe(backupsDir(db));
    expect(backups()).toHaveLength(1);
    expect(await listTables(db)).toContain("zz_extra");
    expect(await migrate(db, next)).toBeNull();
    expect(backups()).toHaveLength(1);

    // The tarball is the pre-migration database with the data in it.
    const restored = await PGlite.create({ loadDataDir: new Blob([new Uint8Array(readFileSync(copy!))]) });
    try {
      expect((await restored.query<{ name: string }>("select name from participants")).rows).toEqual([{ name: "室友" }]);
      const extra = await restored.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_name = 'zz_extra'");
      expect(extra.rows[0]!.n).toBe(0);
    } finally {
      await restored.close();
    }
  });
});
