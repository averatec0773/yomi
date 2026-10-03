import { bankConnections, type Db } from "@yomi/db";
import { CodedError, type MessageParams } from "@yomi/importers";
import { and, asc, eq } from "@yomi/db/orm";
import { openSecret } from "../secrets/crypto";
import { assertSecretsUsable } from "../secrets/tokens";
import type { BankProvider } from "../sync/provider";
import type { CurrentUser } from "../user";
import { InvestError } from "./errors";
import { ibkrWindow, type IbkrSource } from "./ibkr";
import type { IbkrPullKind } from "./pull-log";
import { recordIbkrSections } from "./sections";
import { latestSnapshotDate, writeStatement, type WriteStatementResult } from "./store";
import { clockNow } from "../time/clock";
import { addDays, lastCompletedTradingDay, marketClock } from "./time";

export type InvestProviderChoice = "ibkr" | "plaid" | "all";

export interface InvestSyncDeps {
  /** Null when IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID are not set. */
  ibkr?: IbkrSource | null;
  /** The Plaid provider (bank sync), null when Plaid is not configured. */
  plaid?: BankProvider | null;
  now?: () => Date;
}

export interface InvestSyncItem extends WriteStatementResult {
  provider: "ibkr" | "plaid";
  /** Plaid brokerage connection the pull came from. */
  connectionId: number | null;
  /** IBKR: the trading day whose statement should exist by now (null for Plaid). */
  expectedAsOf: string | null;
  /** IBKR returned a statement older than `expectedAsOf` (not published yet, or a market holiday). */
  stale: boolean;
  /** IBKR: the activity window asked for (`fd`/`td`, both inclusive); null for Plaid. */
  range: { from: string; to: string } | null;
}

export interface InvestSyncError {
  provider: "ibkr" | "plaid";
  connectionId: number | null;
  code: string;
  params: MessageParams;
  message: string;
}

export interface InvestSyncResult {
  results: InvestSyncItem[];
  errors: InvestSyncError[];
  /** Providers asked for (via "all") that are not configured. */
  skipped: ("ibkr" | "plaid")[];
}

/** First pull of a Plaid brokerage login asks for 24 months of investment transactions (Plaid's maximum). */
const PLAID_HISTORY_DAYS = 730;
/** Later pulls re-read this many days before the last pull, so late-posting activity is caught (upserts). */
const PLAID_OVERLAP_DAYS = 30;

/** Stable code + params of a failed pull (bank_provider_* for Plaid provider errors, as on /api/bank). */
export function investErrorOf(e: unknown, provider: "ibkr" | "plaid"): { code: string; params: MessageParams; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof CodedError) return { code: e.code, params: e.params, message };
  return { code: provider === "ibkr" ? "invest_ibkr_error" : "invest_plaid_error", params: { detail: message }, message };
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Pulls holdings (and investment transactions) and stores one snapshot per account per `as_of` day;
 * re-running on the same day overwrites that day. IBKR: the configured Activity Flex Query for the window
 * of `ibkrWindow` (365 days on the first pull, from shortly before the last stored statement afterwards,
 * `ibkrHistoryDays` when the user asks for history), always ending on the expected trading day, dated by
 * its statement `toDate`, recording which Flex sections the statement had (`recordIbkrSections`). Plaid: every
 * active brokerage connection, dated by today's New York date, with a per-connection cursor (last pull's end
 * date) that bounds the transactions window.
 * A single named provider that is not configured throws InvestError; "all" skips it. Failures of
 * individual pulls are collected, never partially written.
 */
export async function syncHoldings(
  db: Db,
  user: CurrentUser,
  opts: { provider: InvestProviderChoice; ibkrHistoryDays?: number; ibkrPull?: IbkrPullKind },
  deps: InvestSyncDeps,
): Promise<InvestSyncResult> {
  const out: InvestSyncResult = { results: [], errors: [], skipped: [] };
  const now = deps.now ?? (() => clockNow());
  const want = (p: "ibkr" | "plaid") => opts.provider === "all" || opts.provider === p;

  if (want("ibkr")) {
    if (!deps.ibkr) {
      if (opts.provider === "ibkr") {
        throw new InvestError("invest_ibkr_not_configured", "IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID must be set", { missing: "IBKR_FLEX_TOKEN, IBKR_FLEX_QUERY_ID" });
      }
      out.skipped.push("ibkr");
    } else {
      try {
        const expectedAsOf = lastCompletedTradingDay(now());
        const range = ibkrWindow(expectedAsOf, await latestSnapshotDate(db, user, "ibkr"), opts.ibkrHistoryDays);
        const st = await deps.ibkr.fetchStatement(range, opts.ibkrPull ?? (opts.ibkrHistoryDays != null ? "history" : "sync"));
        const written = await writeStatement(db, user, st);
        if (st.sections) await recordIbkrSections(db, user, { at: new Date().toISOString(), ...range, present: st.sections, query: deps.ibkr.queryKey ?? null });
        out.results.push({ provider: "ibkr", connectionId: null, expectedAsOf, stale: st.asOf < expectedAsOf, range, ...written });
      } catch (e) {
        if (opts.provider === "ibkr") throw e;
        out.errors.push({ provider: "ibkr", connectionId: null, ...investErrorOf(e, "ibkr") });
      }
    }
  }

  if (want("plaid")) {
    const provider = deps.plaid;
    if (!provider?.fetchInvestments) {
      if (opts.provider === "plaid") throw new InvestError("invest_plaid_not_configured", "Plaid is not configured");
      out.skipped.push("plaid");
    } else {
      await syncPlaidBrokerages(db, user, provider, now, out);
    }
  }
  return out;
}

async function syncPlaidBrokerages(db: Db, user: CurrentUser, provider: BankProvider, now: () => Date, out: InvestSyncResult): Promise<void> {
  const conns = (await db
    .select()
    .from(bankConnections)
    .where(and(eq(bankConnections.userId, user.id), eq(bankConnections.provider, provider.id), eq(bankConnections.kind, "brokerage")))
    .orderBy(asc(bankConnections.id))
    )
    .filter((c) => c.status !== "disconnected" && c.status !== "paused");
  if (conns.length === 0) return;
  // Tokens that cannot be decrypted: stop before any call or write.
  await assertSecretsUsable(db);
  const asOf = marketClock(now()).date;
  for (const c of conns) {
    const accessToken = openSecret(c.accessToken);
    const env = provider.tokenEnvironment(accessToken);
    if (env && !provider.environments.includes(env)) continue;
    const startDate = c.cursor && /^\d{4}-\d{2}-\d{2}$/.test(c.cursor) ? addDays(c.cursor, -PLAID_OVERLAP_DAYS) : addDays(asOf, -PLAID_HISTORY_DAYS);
    try {
      const st = await provider.fetchInvestments!({ accessToken, enrollmentId: c.enrollmentId, institutionName: c.institutionName }, { asOf, startDate, endDate: asOf });
      const r = await writeStatement(db, user, st, { bankConnectionId: c.id });
      await db.update(bankConnections)
        .set({ cursor: asOf, lastSyncedAt: now().toISOString(), status: "active", lastError: null })
        .where(eq(bankConnections.id, c.id));
      out.results.push({ provider: "plaid", connectionId: c.id, expectedAsOf: null, stale: false, range: null, ...r });
    } catch (e) {
      await db.update(bankConnections).set({ status: "error", lastError: text(e) }).where(eq(bankConnections.id, c.id));
      out.errors.push({ provider: "plaid", connectionId: c.id, ...investErrorOf(e, "plaid") });
    }
  }
}
