import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DbLockedError, dirLockHolder } from "@yomi/db";

/**
 * Resolves a demo ledger directory and deletes the earlier one. Exits when the name lacks "demo", another
 * process (a dev server) has it open, or it is not a PGlite data directory (or empty).
 */
export function prepareDemoDir(arg: string | undefined, fallback: string): string {
  const target = path.resolve(arg ?? fallback);
  if (!/demo/i.test(path.basename(target))) {
    console.error(`refusing to overwrite ${target}: the directory name must contain "demo"`);
    process.exit(1);
  }
  if (existsSync(target)) {
    const holder = dirLockHolder(target);
    if (holder) {
      console.error(new DbLockedError(target, holder.pid, holder.command).message);
      process.exit(1);
    }
    // Only ever delete an earlier demo ledger: a PGlite data directory (PG_VERSION) or an empty directory.
    if (!statSync(target).isDirectory() || (readdirSync(target).length > 0 && !existsSync(path.join(target, "PG_VERSION")))) {
      console.error(`refusing to overwrite ${target}: it is not a PGlite data directory (an old demo .db file? delete it yourself)`);
      process.exit(1);
    }
    rmSync(target, { recursive: true, force: true });
  }
  return target;
}
