import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A PGlite data directory may be open in one process only (two embedded Postgres instances writing the
 * same files corrupt them). `<dataDir>.lock` (next to the directory, never inside it, so backups stay
 * clean) records the holder's pid; a lock whose process is gone is stale and taken over.
 */
export class DbLockedError extends Error {
  readonly code = "db_locked";
  constructor(
    readonly dataDir: string,
    readonly holderPid: number,
    readonly holder: string,
  ) {
    super(
      `The yomi database at ${dataDir} is in use by another process (pid ${holderPid}${holder ? `, ${holder}` : ""}). ` +
        "The embedded database allows one process at a time: if the yomi server is running, stop it or use the Import page " +
        "(Settings for syncs) instead of this command.",
    );
    this.name = "DbLockedError";
  }
}

interface LockInfo {
  pid: number;
  command: string;
  since: string;
}

// Process-wide (a registry symbol on globalThis), since this module may be loaded more than once in one process.
const registry = globalThis as unknown as Record<symbol, { held: Set<string>; exitHookInstalled: boolean } | undefined>;
const LOCKS = Symbol.for("yomi.db.locks");
const state = (registry[LOCKS] ??= { held: new Set<string>(), exitHookInstalled: false });
const held = state.held;

export function lockFileFor(dataDir: string): string {
  return `${dataDir.replace(/[\\/]+$/, "")}.lock`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(file: string): LockInfo | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<LockInfo>;
    return typeof v.pid === "number" ? { pid: v.pid, command: String(v.command ?? ""), since: String(v.since ?? "") } : null;
  } catch {
    return null;
  }
}

function command(): string {
  const args = process.argv.slice(1).map((a) => path.basename(a));
  return args.slice(0, 3).join(" ");
}

/** Takes the lock for `dataDir` or throws DbLockedError. Released by releaseDirLock or at process exit. */
export function acquireDirLock(dataDir: string): string {
  const file = lockFileFor(dataDir);
  if (held.has(file)) throw new DbLockedError(dataDir, process.pid, "this process already has it open");
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, command: command(), since: new Date().toISOString() } satisfies LockInfo), { flag: "wx" });
      held.add(file);
      if (!state.exitHookInstalled) {
        state.exitHookInstalled = true;
        process.on("exit", () => {
          for (const f of held) rmSync(f, { force: true });
        });
      }
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const info = readLock(file);
      if (info && info.pid === process.pid) throw new DbLockedError(dataDir, process.pid, "this process already has it open");
      if (info && alive(info.pid)) throw new DbLockedError(dataDir, info.pid, info.command);
      // Stale (holder gone, or unreadable): take it over.
      rmSync(file, { force: true });
    }
  }
  throw new DbLockedError(dataDir, -1, "could not take the lock");
}

export function releaseDirLock(file: string): void {
  if (!held.delete(file)) return;
  rmSync(file, { force: true });
}

/** The live process holding `dataDir`, or null when it is free (no lock, or a stale one). */
export function dirLockHolder(dataDir: string): LockInfo | null {
  const info = readLock(lockFileFor(dataDir));
  if (!info) return null;
  if (info.pid === process.pid) return held.has(lockFileFor(dataDir)) ? info : null;
  return alive(info.pid) ? info : null;
}
