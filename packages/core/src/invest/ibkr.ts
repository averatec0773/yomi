import { FLEX_MAX_RANGE_DAYS, FlexError, type FlexRange, type InvestStatement } from "@yomi/importers";
import { InvestError, type InvestErrorCode } from "./errors";
import type { IbkrPullKind } from "./pull-log";
import { addDays } from "./time";

export const IBKR_TOKEN_ENV = "IBKR_FLEX_TOKEN";
export const IBKR_QUERY_ENV = "IBKR_FLEX_QUERY_ID";

/** What the UI may know about the IBKR setup: never the token or the query id. */
export interface IbkrConfig {
  configured: boolean;
  /** Names of what is missing (the env variable names, also used for the Settings fields). */
  missing: string[];
}

/** From env only. Everything that runs uses resolveIbkrConfig (env, then Settings) from ./credentials. */
export function ibkrConfig(env: NodeJS.ProcessEnv = process.env): IbkrConfig {
  const missing = [IBKR_TOKEN_ENV, IBKR_QUERY_ENV].filter((k) => !env[k]?.trim());
  return { configured: missing.length === 0, missing };
}

/** Pulls the configured Activity Flex Query and maps it. Injected in tests. */
export interface IbkrSource {
  /** `range` overrides the period saved in the query (SendRequest `p`, or `fd`/`td`); `kind` names the pull in its log line. */
  fetchStatement(range?: FlexRange, kind?: IbkrPullKind): Promise<InvestStatement>;
  /** `ibkrQueryKey` of the query, so the sections each pull had are recorded for it (absent on injected sources). */
  queryKey?: string;
}

/** The longest window yomi asks for: IBKR's limit for a SendRequest override. */
export const IBKR_MAX_DAYS = FLEX_MAX_RANGE_DAYS;
/** Later pulls start this many calendar days before the last stored statement, so late-posting activity is re-read (upserts). */
export const IBKR_OVERLAP_DAYS = 7;

/**
 * The `fd`/`td` window of an IBKR pull, both days inclusive; `to` is always `target` (the trading day whose
 * close the holdings should show). `historyDays` (1 to 365, the user's history pull): that many days ending
 * on `target`. No statement stored yet: the last 365 days (backfill). Otherwise from `IBKR_OVERLAP_DAYS`
 * before the latest stored statement, so a yomi that was off catches up, capped at 365 days.
 */
export function ibkrWindow(target: string, latestStored: string | null, historyDays?: number): { from: string; to: string } {
  const earliest = addDays(target, -(IBKR_MAX_DAYS - 1));
  if (historyDays != null) {
    const days = Math.min(Math.max(Math.trunc(historyDays), 1), IBKR_MAX_DAYS);
    return { from: addDays(target, -(days - 1)), to: target };
  }
  if (latestStored == null) return { from: earliest, to: target };
  let from = addDays(latestStored, -IBKR_OVERLAP_DAYS);
  if (from < earliest) from = earliest;
  if (from > target) from = addDays(target, -IBKR_OVERLAP_DAYS);
  return { from, to: target };
}

/** FlexError → InvestError (same code and params); any other failure while reading the statement → invest_ibkr_statement_invalid. */
export function toInvestError(e: unknown): InvestError {
  if (e instanceof InvestError) return e;
  if (e instanceof FlexError) return new InvestError(e.code as InvestErrorCode, e.message, e.params);
  const detail = e instanceof Error ? e.message : String(e);
  return new InvestError("invest_ibkr_statement_invalid", `The Flex statement could not be read: ${detail}`, { detail });
}
