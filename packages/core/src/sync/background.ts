import path from "node:path";
import { resolveDbTarget } from "@yomi/db";

export interface BackgroundSyncDecision {
  enabled: boolean;
  /** One line for the log when disabled. */
  reason?: string;
}

/**
 * Whether the bank and holdings schedulers (and their startup catch-up) may run in this process.
 * `YOMI_BACKGROUND_SYNC=0` always disables and `=1` always enables; otherwise they run only on the default
 * ledger (the PGlite directory `data/pglite`: no DATABASE_URL, or one that points at that directory), so a demo
 * copy, an e2e ledger, a scratch database or a Postgres server nobody opted in for never pulls real bank or
 * broker data. Manual "Sync now" is not affected.
 */
export function backgroundSyncDecision(env: Record<string, string | undefined>, defaultDataDir: string): BackgroundSyncDecision {
  const flag = env.YOMI_BACKGROUND_SYNC?.trim();
  if (flag === "0") return { enabled: false, reason: "YOMI_BACKGROUND_SYNC=0" };
  if (flag === "1") return { enabled: true };
  const url = env.DATABASE_URL?.trim();
  if (!url) return { enabled: true };
  const target = resolveDbTarget(url);
  if (target.kind === "pglite" && target.dataDir === path.resolve(defaultDataDir)) return { enabled: true };
  return { enabled: false, reason: "DATABASE_URL is not the default data/pglite (set YOMI_BACKGROUND_SYNC=1 to enable)" };
}
