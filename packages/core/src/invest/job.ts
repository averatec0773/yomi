import { bankConnections, type Db, jobs } from "@yomi/db";
import { and, eq, lt, ne, or } from "@yomi/db/orm";
import { writeDailyBalanceSnapshots } from "../assets/balances";
import type { BankProvider } from "../sync/provider";
import type { CurrentUser } from "../user";
import { InvestError } from "./errors";
import { IBKR_MAX_DAYS, type IbkrSource } from "./ibkr";
import { clockNow } from "../time/clock";
import { latestSnapshotDate } from "./store";
import { investErrorOf, syncHoldings, type InvestSyncResult } from "./sync";
import { lastCompletedTradingDay, retryWindowClosed } from "./time";

export const HOLDINGS_SYNC_JOB = "holdings-sync";
const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
const STALE_RUNNING_MS = 30 * 60 * 1000;
/** A statement older than expected is asked for again at most this often. */
export const IBKR_RETRY_EVERY_MS = 2 * 60 * 60 * 1000;
/** Flex rate limit guard: the scheduler never pulls one token more often than this. */
export const IBKR_MIN_SPACING_MS = 10 * 60 * 1000;

/** jobs.cursor entry for IBKR. */
export interface IbkrJobState {
  /** Trading day whose statement the last scheduled pull expected. */
  expected: string;
  /** Statement date (Flex `toDate`) actually received; null when no pull has succeeded yet. */
  received: string | null;
  /** Pulls for `expected` that returned an older statement. */
  attempts: number;
  /** Last scheduled pull, successful or not (rate-limit spacing and retry cadence). */
  lastAttemptAt: string;
  /** Last successful pull. */
  at: string | null;
}

/** jobs.cursor of `holdings-sync`. Plaid records the trading day it was last pulled for. */
export interface HoldingsJobState {
  ibkr?: IbkrJobState;
  plaid?: { target: string; at: string };
}

export function parseHoldingsState(cursor: string | null): HoldingsJobState {
  if (!cursor) return {};
  try {
    const v = JSON.parse(cursor) as HoldingsJobState;
    if (!v || typeof v !== "object") return {};
    // Before 2026-09-30 the IBKR entry recorded the target day, not the day received: drop it so the
    // statement is asked for again.
    if (v.ibkr && typeof v.ibkr.expected !== "string") delete v.ibkr;
    return v;
  } catch {
    return {};
  }
}

const later = (a: string | null, b: string | null) => (a == null ? b : b == null ? a : a > b ? a : b);

/**
 * Whether IBKR is due at `now`. The expected day is the last weekday whose after-close (18:00 New
 * York) statement should exist. Nothing is due once a statement for it (or later) was received.
 * Otherwise the first pull for an expected day is due right away (also the catch-up after the app
 * was off); when that pull returned an older statement, it is repeated at most every 2 hours through
 * the night (IBKR usually publishes after midnight New York) until 06:00 the next morning. Still stale
 * then: the day is taken as a market holiday (or not published) and the normal daily cadence resumes
 * with the next expected day. Pulls are never closer than 10 minutes apart.
 */
export function ibkrDue(s: IbkrJobState | undefined, now: Date, latestSnapshot: string | null): boolean {
  const expected = lastCompletedTradingDay(now);
  const received = later(s?.received ?? null, latestSnapshot);
  if (received != null && received >= expected) return false;
  const sinceLast = s ? now.getTime() - Date.parse(s.lastAttemptAt) : Infinity;
  if (sinceLast < IBKR_MIN_SPACING_MS) return false;
  if (!s || s.expected !== expected || s.attempts === 0) return true;
  if (retryWindowClosed(expected, now)) return false;
  return sinceLast >= IBKR_RETRY_EVERY_MS;
}

/** Which providers are due at `now`. Plaid is due once per trading day (see `ibkrDue` for IBKR). */
export function holdingsDue(
  state: HoldingsJobState,
  now: Date,
  ctx: { ibkrConfigured: boolean; plaidConnections: boolean; latestIbkrSnapshot: string | null },
): ("ibkr" | "plaid")[] {
  const target = lastCompletedTradingDay(now);
  const due: ("ibkr" | "plaid")[] = [];
  if (ctx.ibkrConfigured && ibkrDue(state.ibkr, now, ctx.latestIbkrSnapshot)) due.push("ibkr");
  if (ctx.plaidConnections && state.plaid?.target !== target) due.push("plaid");
  return due;
}

/** The IBKR cursor after one pull for `expected` at `at` (`received` null when the pull failed). */
export function nextIbkrState(prev: IbkrJobState | undefined, expected: string, received: string | null, at: string): IbkrJobState {
  const same = prev?.expected === expected;
  const attempts = (same ? prev.attempts : 0) + (received != null && received < expected ? 1 : 0);
  return {
    expected,
    received: later(received, prev?.received ?? null),
    attempts: received != null && received >= expected ? 0 : attempts,
    lastAttemptAt: at,
    at: received != null ? at : (prev?.at ?? null),
  };
}

export type HoldingsJobOutcome =
  | {
      ran: true;
      /** The trading day whose statement was expected. */
      expected: string;
      providers: ("ibkr" | "plaid")[];
      result: InvestSyncResult;
    }
  | { ran: false; reason: "not_due" | "running" | "backoff" };

async function hasBrokerageConnections(db: Db, user: CurrentUser): Promise<boolean> {
  return (
    (await db
      .select({ id: bankConnections.id })
      .from(bankConnections)
      .where(and(eq(bankConnections.userId, user.id), eq(bankConnections.kind, "brokerage"), eq(bankConnections.status, "active")))
      .limit(1))[0] != null
  );
}

/**
 * One run of the `holdings-sync` job, idempotent and guarded through its jobs row (same claim rule
 * as bank-sync). Due providers are pulled. IBKR records the statement date it actually received and
 * the attempts for the expected day; Plaid records its target only when its pull succeeded. A
 * failure moves run_after 30 minutes ahead.
 */
export async function runHoldingsSyncJob(
  db: Db,
  user: CurrentUser,
  deps: { ibkr: IbkrSource | null; plaid: BankProvider | null; now?: () => Date; force?: boolean },
): Promise<HoldingsJobOutcome> {
  const now = deps.now ?? (() => new Date());
  await db.insert(jobs).values({ userId: user.id, name: HOLDINGS_SYNC_JOB, status: "idle" }).onConflictDoNothing();
  const job = (await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.userId, user.id), eq(jobs.name, HOLDINGS_SYNC_JOB)))
    .limit(1))[0]!;
  const t0 = now();
  if (!deps.force && job.runAfter && job.runAfter > t0.toISOString()) return { ran: false, reason: "backoff" };
  const state = parseHoldingsState(job.cursor);
  const expected = lastCompletedTradingDay(t0);
  const due = deps.force
    ? ([deps.ibkr ? "ibkr" : null, deps.plaid ? "plaid" : null].filter(Boolean) as ("ibkr" | "plaid")[])
    : holdingsDue(state, t0, {
        ibkrConfigured: deps.ibkr != null,
        plaidConnections: deps.plaid != null && await hasBrokerageConnections(db, user),
        latestIbkrSnapshot: await latestSnapshotDate(db, user, "ibkr"),
      });
  if (due.length === 0) return { ran: false, reason: "not_due" };

  const staleBefore = new Date(t0.getTime() - STALE_RUNNING_MS).toISOString();
  const claimed = await db
    .update(jobs)
    .set({ status: "running" })
    .where(and(eq(jobs.id, job.id), or(ne(jobs.status, "running"), lt(jobs.updatedAt, staleBefore))))
    .returning({ id: jobs.id });
  if (claimed.length === 0) return { ran: false, reason: "running" };

  const result: InvestSyncResult = { results: [], errors: [], skipped: [] };
  const next: HoldingsJobState = { ...state };
  for (const p of due) {
    let ok = false;
    try {
      const r = await syncHoldings(db, user, { provider: p, ibkrPull: "scheduled" }, { ibkr: deps.ibkr, plaid: deps.plaid, now });
      result.results.push(...r.results);
      result.errors.push(...r.errors);
      ok = r.errors.length === 0;
    } catch (e) {
      result.errors.push({ provider: p, connectionId: null, ...investErrorOf(e, p) });
    }
    if (p === "ibkr") {
      const received = ok ? (result.results.find((x) => x.provider === "ibkr")?.asOf ?? null) : null;
      next.ibkr = nextIbkrState(state.ibkr, expected, received, t0.toISOString());
    } else if (ok) {
      next.plaid = { target: expected, at: now().toISOString() };
    }
  }
  const failed = result.errors.length > 0;
  await db.update(jobs)
    .set({
      status: failed ? "failed" : "idle",
      cursor: JSON.stringify(next),
      attempts: failed ? job.attempts + 1 : 0,
      lastError: failed ? result.errors.map((e) => `${e.provider}${e.connectionId != null ? ` #${e.connectionId}` : ""}: ${e.code}`).join("; ") : null,
      runAfter: failed ? new Date(now().getTime() + RETRY_AFTER_FAILURE_MS).toISOString() : null,
    })
    .where(eq(jobs.id, job.id));
  return { ran: true, expected, providers: due, result };
}

/** `holdings-sync` last_error without its IBKR part ("plaid #3: …"), or null when nothing else failed. */
function withoutIbkr(lastError: string | null): string | null {
  const rest = (lastError ?? "").split(";").map((x) => x.trim()).filter((x) => x && !/^ibkr:/.test(x));
  return rest.length ? rest.join("; ") : null;
}

const minutesUntil = (at: number, now: Date) => Math.max(1, Math.ceil((at - now.getTime()) / 60_000));

/**
 * "Pull history": one IBKR pull of the last `days` days (1 to 365, IBKR's limit) ending on the expected trading
 * day, through the `holdings-sync` job row so it never runs beside a scheduled pull. Refused, before anything
 * is sent to IBKR, while a pull runs (`invest_ibkr_pull_running`), within 10 minutes of the last IBKR pull
 * (`invest_ibkr_pull_too_soon`, Flex rate limit) and within 30 minutes of a failed IBKR pull
 * (`invest_ibkr_pull_backoff`); both carry `minutes` until it is allowed. The pull is recorded like a scheduled
 * one (IBKR cursor, failure and its 30-minute retry); a failure of another provider stays as it was. Throws the
 * pull's InvestError when it fails.
 */
export async function pullIbkrHistory(
  db: Db,
  user: CurrentUser,
  opts: { days: number },
  deps: { ibkr: IbkrSource | null; now?: () => Date },
): Promise<InvestSyncResult> {
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > IBKR_MAX_DAYS) {
    throw new InvestError("invest_ibkr_history_days_invalid", `History must be 1 to ${IBKR_MAX_DAYS} days`, { min: 1, max: IBKR_MAX_DAYS });
  }
  if (!deps.ibkr) {
    throw new InvestError("invest_ibkr_not_configured", "IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID must be set", { missing: "IBKR_FLEX_TOKEN, IBKR_FLEX_QUERY_ID" });
  }
  const now = deps.now ?? (() => clockNow());
  await db.insert(jobs).values({ userId: user.id, name: HOLDINGS_SYNC_JOB, status: "idle" }).onConflictDoNothing();
  const job = (await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.userId, user.id), eq(jobs.name, HOLDINGS_SYNC_JOB)))
    .limit(1))[0]!;
  const t0 = now();
  const state = parseHoldingsState(job.cursor);
  const ibkrFailed = job.status === "failed" && /(^|;)\s*ibkr:/.test(job.lastError ?? "");
  if (ibkrFailed && job.runAfter && job.runAfter > t0.toISOString()) {
    throw new InvestError("invest_ibkr_pull_backoff", "The last IBKR pull failed; try again later", { minutes: minutesUntil(Date.parse(job.runAfter), t0) });
  }
  const last = state.ibkr ? Date.parse(state.ibkr.lastAttemptAt) : Number.NaN;
  if (Number.isFinite(last) && t0.getTime() - last < IBKR_MIN_SPACING_MS) {
    throw new InvestError("invest_ibkr_pull_too_soon", "IBKR was pulled less than 10 minutes ago", { minutes: minutesUntil(last + IBKR_MIN_SPACING_MS, t0) });
  }
  const staleBefore = new Date(t0.getTime() - STALE_RUNNING_MS).toISOString();
  const claimed = await db
    .update(jobs)
    .set({ status: "running" })
    .where(and(eq(jobs.id, job.id), or(ne(jobs.status, "running"), lt(jobs.updatedAt, staleBefore))))
    .returning({ id: jobs.id });
  if (claimed.length === 0) throw new InvestError("invest_ibkr_pull_running", "A holdings pull is running");

  const expected = lastCompletedTradingDay(t0);
  const others = withoutIbkr(job.lastError);
  try {
    const r = await syncHoldings(db, user, { provider: "ibkr", ibkrHistoryDays: opts.days, ibkrPull: "history" }, { ibkr: deps.ibkr, now });
    const received = r.results.find((x) => x.provider === "ibkr")?.asOf ?? null;
    await db.update(jobs)
      .set({
        status: others ? "failed" : "idle",
        cursor: JSON.stringify({ ...state, ibkr: nextIbkrState(state.ibkr, expected, received, t0.toISOString()) } satisfies HoldingsJobState),
        attempts: others ? job.attempts : 0,
        lastError: others,
        runAfter: others ? job.runAfter : null,
      })
      .where(eq(jobs.id, job.id));
    return r;
  } catch (e) {
    const code = investErrorOf(e, "ibkr").code;
    await db.update(jobs)
      .set({
        status: "failed",
        cursor: JSON.stringify({ ...state, ibkr: nextIbkrState(state.ibkr, expected, null, t0.toISOString()) } satisfies HoldingsJobState),
        attempts: job.attempts + 1,
        lastError: [others, `ibkr: ${code}`].filter(Boolean).join("; "),
        runAfter: new Date(now().getTime() + RETRY_AFTER_FAILURE_MS).toISOString(),
      })
      .where(eq(jobs.id, job.id));
    throw e;
  }
}

export interface HoldingsSchedulerDeps {
  getDb: () => Db | Promise<Db>;
  getUser: () => CurrentUser;
  getIbkr: () => IbkrSource | null | Promise<IbkrSource | null>;
  getPlaid: () => BankProvider | null | Promise<BankProvider | null>;
  /** Default 10 minutes. */
  checkEveryMs?: number;
  log?: (message: string) => void;
}

const globalScheduler = globalThis as unknown as { yomiHoldingsSyncStop?: () => void };

/**
 * In-process scheduler for `holdings-sync`: checks right away (catch-up on start) and then every
 * `checkEveryMs`. Each tick first writes the day's account balance snapshots (once per day). Logs only
 * counts, never positions or balances.
 */
export function startHoldingsSyncScheduler(deps: HoldingsSchedulerDeps): () => void {
  globalScheduler.yomiHoldingsSyncStop?.();
  let busy = false;
  const log = deps.log ?? ((m: string) => console.log(`[yomi] ${m}`));
  const tick = async () => {
    if (busy) return;
    // Taken before the first await, so a tick firing while the previous one still runs is skipped.
    busy = true;
    try {
      // Daily account balance snapshots (Assets history); once per day, catches up on start.
      try {
        const written = await writeDailyBalanceSnapshots(await deps.getDb(), deps.getUser());
        if (written) log(`balance snapshots for today: ${written} account balance(s)`);
      } catch (e) {
        log(`balance snapshots failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const ibkr = await deps.getIbkr();
      const plaid = await deps.getPlaid();
      if (!ibkr && !plaid) return;
      const out = await runHoldingsSyncJob(await deps.getDb(), deps.getUser(), { ibkr, plaid });
      if (out.ran) {
        const positions = out.result.results.reduce((n, r) => n + r.positions, 0);
        const errs = out.result.errors.map((e) => `${e.provider}: ${e.code}`).join(", ");
        const stale = out.result.results.find((r) => r.stale);
        const late = stale ? `, IBKR statement still ${stale.asOf}` : "";
        log(`holdings sync for ${out.expected}: ${out.result.results.length} pulls, ${positions} positions${late}${errs ? `, errors: ${errs}` : ""}`);
      }
    } catch (e) {
      log(`holdings sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), deps.checkEveryMs ?? 10 * 60 * 1000);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    if (globalScheduler.yomiHoldingsSyncStop === stop) globalScheduler.yomiHoldingsSyncStop = undefined;
  };
  globalScheduler.yomiHoldingsSyncStop = stop;
  return stop;
}
