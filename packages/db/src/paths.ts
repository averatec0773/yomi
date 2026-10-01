import { existsSync } from "node:fs";
import path from "node:path";

/** Walks up from `start` to the directory holding pnpm-workspace.yaml. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`yomi repo root not found above ${start}`);
    dir = parent;
  }
}

export function migrationsFolder(): string {
  return path.join(findRepoRoot(), "packages", "db", "migrations");
}

/** The default ledger: an embedded Postgres (PGlite) data directory at <repo>/data/pglite. */
export function defaultPgliteDir(): string {
  return path.join(findRepoRoot(), "data", "pglite");
}

/** DATABASE_URL (a PGlite directory, `memory://`, or a postgres:// URL), else <repo>/data/pglite. */
export function defaultDatabaseUrl(): string {
  const env = process.env.DATABASE_URL?.trim();
  if (env) return env;
  return defaultPgliteDir();
}

export type DbTarget =
  /** Embedded Postgres persisted to a directory (absolute path). One process at a time. */
  | { kind: "pglite"; dataDir: string }
  /** Embedded Postgres in memory (tests). */
  | { kind: "memory" }
  /** A Postgres server (Neon, a VPS, a local postgres), reached through a connection pool. */
  | { kind: "server"; url: string };

/**
 * Reads a DATABASE_URL: `postgres://` / `postgresql://` is a server, `memory://` an in-memory PGlite,
 * anything else a PGlite data directory (a path, optionally `file:`-prefixed; relative paths resolve
 * from the repo root).
 */
export function resolveDbTarget(url: string = defaultDatabaseUrl()): DbTarget {
  const u = url.trim();
  if (/^postgres(ql)?:\/\//i.test(u)) return { kind: "server", url: u };
  if (u === "memory://" || u === ":memory:") return { kind: "memory" };
  const p = u.startsWith("file:") ? u.slice("file:".length) : u;
  return { kind: "pglite", dataDir: path.isAbsolute(p) ? path.resolve(p) : path.resolve(findRepoRoot(), p) };
}

/** A server URL with the password masked, for log lines. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "postgres://…";
  }
}
