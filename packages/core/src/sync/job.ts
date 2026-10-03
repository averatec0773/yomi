import type { Db } from "@yomi/db";
import { claimJob, finishJob, loadJob } from "../jobs";
import { secretsHealth } from "../secrets/tokens";
import type { CurrentUser } from "../user";
import type { BankProvider } from "./provider";
import { hasOpenLinkSessions, type LinkRecoveryResult, recoverLinkSessions } from "./link-sessions";
import { syncAll, type SyncAllResult, syncAwaitingFirstData } from "./sync";

export const BANK_SYNC_JOB = "bank-sync";
export const BANK_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type BankSyncJobOutcome = (
  | { ran: true; result: SyncAllResult }
  | { ran: false; reason: "not_due" | "running" }
  | { ran: false; reason: "secrets_unavailable"; message: string }
) & { recovery?: LinkRecoveryResult; awaiting?: SyncAllResult | null };

/**
 * One run of the `bank-sync` job, idempotent and guarded through the jobs row: it runs when due
 * (run_after passed or never set, which is the catch-up on startup) and when no other run holds the
 * row. On success run_after moves 6 hours ahead and cursor records the finish time; per-connection
 * cursors live in bank_connections. A thrown failure retries after 30 minutes.
 */
export async function runBankSyncJob(
  db: Db,
  user: CurrentUser,
  provider: BankProvider,
  opts: { now?: () => Date; force?: boolean; backup?: boolean } = {},
): Promise<BankSyncJobOutcome> {
  const now = opts.now ?? (() => new Date());
  // Stored tokens that cannot be decrypted (missing or wrong YOMI_SECRET_KEY) or a malformed key:
  // skip the whole run without touching the job row or any connection, so fixing the key and
  // restarting resumes exactly where it was.
  const health = await secretsHealth(db);
  if (health.error) return { ran: false, reason: "secrets_unavailable", message: health.error };
  // Before the due check, on every tick: a Link session left open (Link closed early, tab gone)
  // must be recovered while Plaid's public token (30 min) is still valid, not 6 hours later.
  let recovery: LinkRecoveryResult | undefined;
  try {
    if ((await hasOpenLinkSessions(db, user))) recovery = await recoverLinkSessions(db, user, provider, { now, backup: opts.backup });
  } catch {
    // per-session errors are stored on the session rows; never block the sync itself
  }
  const job = await loadJob(db, user, BANK_SYNC_JOB);
  const t0 = now();
  if (!opts.force && job.runAfter && job.runAfter > t0.toISOString()) {
    // Not due, but new connections whose first data was not ready yet are retried every tick.
    const awaiting = await syncAwaitingFirstData(db, user, provider, { now, backup: opts.backup }).catch(() => null);
    return { ran: false, reason: "not_due", recovery, awaiting };
  }
  if (!(await claimJob(db, job))) return { ran: false, reason: "running", recovery };

  try {
    const result = await syncAll(db, user, provider, { now, backup: opts.backup });
    const done = now();
    await finishJob(db, job, {
      failed: false,
      now: done,
      cursor: done.toISOString(),
      runAfter: new Date(done.getTime() + BANK_SYNC_INTERVAL_MS).toISOString(),
      lastError: result.errors.length ? result.errors.map((e) => `#${e.connectionId}: ${e.message}`).join("; ") : null,
    });
    return { ran: true, result, recovery };
  } catch (e) {
    await finishJob(db, job, { failed: true, now: now(), lastError: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

export interface BankSyncSchedulerDeps {
  getDb: () => Db | Promise<Db>;
  getUser: () => CurrentUser;
  /** Null while bank sync is not configured; the tick then does nothing. */
  getProvider: () => BankProvider | null | Promise<BankProvider | null>;
  /** How often to check whether the job is due. Default 10 minutes. */
  checkEveryMs?: number;
  log?: (message: string) => void;
}

const globalScheduler = globalThis as unknown as { yomiBankSyncStop?: () => void };

/**
 * In-process scheduler: checks right away (catch-up after the server was off) and then every
 * `checkEveryMs`; runBankSyncJob decides whether a run is due. One scheduler per process (a second
 * start replaces the first, which dev hot reload does), one run at a time.
 */
export function startBankSyncScheduler(deps: BankSyncSchedulerDeps): () => void {
  globalScheduler.yomiBankSyncStop?.();
  let busy = false;
  let skipLogged = false;
  const log = deps.log ?? ((m: string) => console.log(`[yomi] ${m}`));
  const tick = async () => {
    if (busy) return;
    // Taken before the first await, so a tick firing while the previous one still runs is skipped.
    busy = true;
    try {
      const provider = await deps.getProvider();
      if (!provider) return;
      const out = await runBankSyncJob(await deps.getDb(), deps.getUser(), provider);
      if (!out.ran && out.reason === "secrets_unavailable") {
        if (!skipLogged) log(`Bank sync skipped: ${out.message}`);
        skipLogged = true;
        return;
      }
      skipLogged = false;
      for (const r of out.recovery?.recovered ?? []) log(`Recovered an unfinished bank connection: ${r.institutionName ?? "bank"} (connection #${r.connectionId})`);
      const firstRows = out.awaiting?.results.reduce((n, r) => n + r.inserted, 0) ?? 0;
      if (firstRows) log(`First data for a new connection arrived: ${firstRows} new row(s)`);
      if (out.ran) {
        const inserted = out.result.results.reduce((s, r) => s + r.inserted, 0);
        log(`Bank sync done: ${inserted} new row(s)${out.result.errors.length ? `, ${out.result.errors.length} connection(s) failed` : ""}`);
      }
    } catch (e) {
      log(`Bank sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), deps.checkEveryMs ?? 10 * 60 * 1000);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    if (globalScheduler.yomiBankSyncStop === stop) globalScheduler.yomiBankSyncStop = undefined;
  };
  globalScheduler.yomiBankSyncStop = stop;
  return stop;
}
