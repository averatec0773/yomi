import { type Db, holdingSnapshots, investmentAccounts, jobs } from "@yomi/db";
import { and, eq, isNotNull, max } from "@yomi/db/orm";
import type { CurrentUser } from "../user";
import { ibkrConfigOf, resolveIbkrCredentials } from "./credentials";
import { HOLDINGS_SYNC_JOB, parseHoldingsState } from "./job";
import { type IbkrSectionItem, ibkrQueryKey, ibkrSectionsRecord } from "./sections";
import { latestSnapshotDate } from "./store";
import { clockNow } from "../time/clock";
import { lastCompletedTradingDay } from "./time";

/**
 * What Settings > Connections shows for IBKR. `not_configured`: token or query id missing;
 * `never`: set up, nothing stored yet; `waiting`: the latest statement is older than the trading day
 * that should be out by now; `error`: the last scheduled pull failed and nothing was stored since.
 */
export type IbkrState = "not_configured" | "never" | "active" | "waiting" | "error";

export interface IbkrStatus {
  configured: boolean;
  /** Names of what is missing (env variable names), never values. */
  missing: string[];
  state: IbkrState;
  /** Date of the latest stored IBKR statement, or null. */
  lastStatementDate: string | null;
  /** When that statement was stored (ISO time), or null. */
  syncedAt: string | null;
  /** Positions (not cash) in the latest statement. */
  positions: number;
  /** The trading day whose statement should exist by now. */
  expectedAsOf: string;
  /** Stable code of the failed pull when `state` is `error`. */
  errorCode: string | null;
  /** Which Flex sections the pulls of the current query had (latest pull and its window), or null before the first. */
  sectionCheck: { at: string; from: string; to: string; sections: IbkrSectionItem[] } | null;
}

/** Code of the IBKR part of a `holdings-sync` last_error ("ibkr: invest_ibkr_token_expired; plaid #3: …"). */
export function ibkrErrorCode(lastError: string | null): string | null {
  if (!lastError) return null;
  for (const part of lastError.split(";")) {
    const m = /^\s*ibkr:\s*(\S+)\s*$/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

/** Read-only IBKR status from env or Settings (names only), stored snapshots and the holdings-sync job row. */
export async function ibkrStatus(db: Db, user: CurrentUser, env: NodeJS.ProcessEnv = process.env, now: Date = clockNow()): Promise<IbkrStatus> {
  const creds = await resolveIbkrCredentials(db, user, env);
  const cfg = ibkrConfigOf(creds);
  const lastStatementDate = await latestSnapshotDate(db, user, "ibkr");
  const expectedAsOf = lastCompletedTradingDay(now);
  let syncedAt: string | null = null;
  let positions = 0;
  if (lastStatementDate) {
    const at = and(eq(holdingSnapshots.userId, user.id), eq(investmentAccounts.provider, "ibkr"), eq(holdingSnapshots.asOf, lastStatementDate));
    syncedAt =
      (await db
        .select({ at: max(holdingSnapshots.createdAt) })
        .from(holdingSnapshots)
        .innerJoin(investmentAccounts, eq(investmentAccounts.id, holdingSnapshots.investmentAccountId))
        .where(at)
        .limit(1))[0]?.at ?? null;
    positions = (await db
      .select({ id: holdingSnapshots.id })
      .from(holdingSnapshots)
      .innerJoin(investmentAccounts, eq(investmentAccounts.id, holdingSnapshots.investmentAccountId))
      .where(and(at, isNotNull(holdingSnapshots.securityId)))
      ).length;
  }

  let errorCode: string | null = null;
  const job = (await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.userId, user.id), eq(jobs.name, HOLDINGS_SYNC_JOB)))
    .limit(1))[0];
  if (job?.status === "failed") {
    const code = ibkrErrorCode(job.lastError);
    const attemptAt = parseHoldingsState(job.cursor).ibkr?.lastAttemptAt ?? null;
    // A manual Sync now that stored a statement after the failed pull clears it.
    if (code && (syncedAt == null || attemptAt == null || attemptAt > syncedAt)) errorCode = code;
  }

  const state: IbkrState = !cfg.configured
    ? "not_configured"
    : errorCode
      ? "error"
      : lastStatementDate == null
        ? "never"
        : lastStatementDate < expectedAsOf
          ? "waiting"
          : "active";
  const record = cfg.configured ? await ibkrSectionsRecord(db, user, ibkrQueryKey(creds.queryId.value!)) : null;
  const sectionCheck = record && { at: record.at, from: record.from, to: record.to, sections: record.sections };
  return { configured: cfg.configured, missing: cfg.missing, state, lastStatementDate, syncedAt, positions, expectedAsOf, errorCode, sectionCheck };
}
