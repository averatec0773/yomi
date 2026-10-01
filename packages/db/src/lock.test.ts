import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, createDb, LegacyLedgerError } from "./client";
import { acquireDirLock, DbLockedError, dirLockHolder, lockFileFor, releaseDirLock } from "./lock";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "yomi-lock-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The pid of a process that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid!;
}

function writeLock(dataDir: string, pid: number): void {
  writeFileSync(lockFileFor(dataDir), JSON.stringify({ pid, command: "yomi test", since: "2026-09-30T00:00:00.000Z" }));
}

// PGlite data directories on disk: initdb and file I/O take seconds when the whole suite runs in parallel.
describe("directory lock", { timeout: 30_000 }, () => {
  it("sits next to the directory and refuses a second acquire in the same process", () => {
    const data = path.join(dir, "pglite");
    expect(lockFileFor(`${data}/`)).toBe(`${data}.lock`);
    expect(dirLockHolder(data)).toBeNull();
    const file = acquireDirLock(data);
    try {
      expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
      expect(dirLockHolder(data)?.pid).toBe(process.pid);
      expect(() => acquireDirLock(data)).toThrow(DbLockedError);
    } finally {
      releaseDirLock(file);
    }
    expect(existsSync(file)).toBe(false);
    expect(dirLockHolder(data)).toBeNull();
  });

  it("takes over a stale lock left by a dead process", () => {
    const data = path.join(dir, "pglite");
    writeLock(data, deadPid());
    expect(dirLockHolder(data)).toBeNull();
    const file = acquireDirLock(data);
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
    releaseDirLock(file);
  });

  it("reports and respects a live holder in another process", async () => {
    const data = path.join(dir, "pglite");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      writeLock(data, child.pid!);
      expect(dirLockHolder(data)).toEqual({ pid: child.pid, command: "yomi test", since: "2026-09-30T00:00:00.000Z" });
      let err: unknown;
      try {
        acquireDirLock(data);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DbLockedError);
      expect((err as DbLockedError).holderPid).toBe(child.pid);
      expect((err as DbLockedError).code).toBe("db_locked");
      expect((err as Error).message).toContain(data);
    } finally {
      child.kill();
      await new Promise((r) => child.once("exit", r));
    }
    expect(dirLockHolder(data)).toBeNull();
  });

  it("createDb on a directory another handle has open throws DbLockedError until that handle closes", async () => {
    const data = path.join(dir, "pglite");
    const first = await createDb(data);
    try {
      await expect(createDb(data)).rejects.toThrow(DbLockedError);
      expect(dirLockHolder(data)?.pid).toBe(process.pid);
    } finally {
      await closeDb(first);
    }
    expect(existsSync(lockFileFor(data))).toBe(false);
    const second = await createDb(data);
    await closeDb(second);
    await closeDb(second);
  });

  it("refuses to open a file (a v0.1 SQLite ledger) as a PGlite directory, without locking or changing it", async () => {
    const file = path.join(dir, "yomi.db");
    writeFileSync(file, "SQLite format 3\u0000");
    await expect(createDb(file)).rejects.toThrow(LegacyLedgerError);
    expect(readFileSync(file, "utf8")).toBe("SQLite format 3\u0000");
    expect(existsSync(lockFileFor(file))).toBe(false);
  });
});
