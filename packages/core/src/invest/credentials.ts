import { createFlexClient, type FlexClientOptions, FlexError, type FlexRange, type FlexRetry, type InvestStatement, mapFlexStatement } from "@yomi/importers";
import type { Db } from "@yomi/db";
import {
  auditSecretChange,
  type IdentifierFieldView,
  identifierView,
  readSecretSetting,
  removeSetting,
  resolveSecret,
  type ResolvedSecret,
  type SecretFieldView,
  SecretSettingError,
  secretView,
  writeSecretSetting,
} from "../settings/secrets";
import { deleteSetting, readSetting, writeSetting } from "../settings/store";
import { getTimeZone } from "../settings/time-zone";
import { dayDiff } from "../time/day";
import { clockNow, todayIn } from "../time/zone";
import type { CurrentUser } from "../user";
import { InvestError } from "./errors";
import { IBKR_QUERY_ENV, IBKR_TOKEN_ENV, type IbkrConfig, type IbkrSource, toInvestError } from "./ibkr";
import { type FlexPullLog, formatFlexPullLog, type IbkrPullKind } from "./pull-log";
import { type IbkrSectionItem, ibkrQueryKey, nextSectionsRecord, recordIbkrSections } from "./sections";
import { lastCompletedTradingDay, previousWeekday } from "./time";

/** user_settings keys (per user). Token and query id are sealed (`enc:v1:`); the expiry date is plain. */
export const IBKR_TOKEN_SETTING = "ibkr_flex_token";
export const IBKR_QUERY_SETTING = "ibkr_flex_query_id";
export const IBKR_EXPIRES_SETTING = "ibkr_flex_token_expires_on";

/** Days before the expiry date from which the row warns. */
export const IBKR_EXPIRY_WARN_DAYS = 14;

export interface IbkrCredentials {
  token: ResolvedSecret;
  queryId: ResolvedSecret;
}

/** Token and query id for `user`: IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID from env first, then Settings, per field. */
export async function resolveIbkrCredentials(q: Db, user: CurrentUser, env: NodeJS.ProcessEnv = process.env): Promise<IbkrCredentials> {
  return {
    token: resolveSecret(env[IBKR_TOKEN_ENV], await readSecretSetting(q, user, IBKR_TOKEN_SETTING, env)),
    queryId: resolveSecret(env[IBKR_QUERY_ENV], await readSecretSetting(q, user, IBKR_QUERY_SETTING, env)),
  };
}

/** configured + the names of what is missing (env variable names, which also name the Settings fields). */
export async function resolveIbkrConfig(q: Db, user: CurrentUser, env: NodeJS.ProcessEnv = process.env): Promise<IbkrConfig> {
  return ibkrConfigOf(await resolveIbkrCredentials(q, user, env));
}

export function ibkrConfigOf(c: IbkrCredentials): IbkrConfig {
  const missing = [c.token.value ? null : IBKR_TOKEN_ENV, c.queryId.value ? null : IBKR_QUERY_ENV].filter((x): x is string => x != null);
  return { configured: missing.length === 0, missing };
}

export type FlexOptions = Pick<FlexClientOptions, "fetch" | "sleep" | "maxWaitMs" | "initialDelayMs" | "maxDelayMs" | "timeoutMs"> & {
  /** Where the one line per pull goes (`formatFlexPullLog`); default console.log. */
  log?: (line: string) => void;
};

/**
 * Flex answers after which a `from`/`to` pull is asked once more with `to` one weekday earlier: 1003 "Statement
 * is not available" and 1020 "Invalid request or unable to validate request". IBKR's docs do not say what
 * SendRequest answers when `td` is a day whose statement is not published yet; these are the plausible codes,
 * and the earlier `to` gives the same result the "Last Business Day" period did (the job sees a stale statement
 * and retries overnight).
 */
export const FLEX_UNPUBLISHED_CODES = new Set(["1003", "1020"]);

/**
 * A Flex source for one token and query id (SendRequest, then GetStatement with the client's retry behavior).
 * Each pull writes one log line (`formatFlexPullLog`): kind, window, retry codes and waits, fallback, statement
 * date, sections, duration.
 */
export function ibkrSourceFor(token: string, queryId: string, opts: FlexOptions = {}): IbkrSource {
  const { log = (l: string) => console.log(l), ...clientOpts } = opts;
  const client = createFlexClient({ ...clientOpts, token: token.trim(), queryId: queryId.trim() });
  return {
    queryKey: ibkrQueryKey(queryId),
    async fetchStatement(range?: FlexRange, kind: IbkrPullKind = "sync") {
      const t0 = performance.now();
      const retries: FlexRetry[] = [];
      const hooks = { onRetry: (r: FlexRetry) => void retries.push(r) };
      let fallback: FlexPullLog["fallback"] = null;
      const entry = (rest: Pick<FlexPullLog, "statementDate" | "sections" | "error">): FlexPullLog => ({
        kind,
        range: range && "to" in range ? { from: range.from, to: range.to } : null,
        retries,
        fallback,
        ms: performance.now() - t0,
        ...rest,
      });
      try {
        let st: InvestStatement;
        try {
          st = mapFlexStatement(await client.fetchStatement(range, hooks));
        } catch (e) {
          if (!range || !("to" in range) || !(e instanceof FlexError) || !e.flexCode || !FLEX_UNPUBLISHED_CODES.has(e.flexCode)) throw e;
          const to = previousWeekday(range.to);
          fallback = { to, code: e.flexCode };
          st = mapFlexStatement(await client.fetchStatement({ from: range.from < to ? range.from : to, to }, hooks));
        }
        log(formatFlexPullLog(entry({ statementDate: st.asOf, sections: st.sections ?? null, error: null })));
        return st;
      } catch (e) {
        const err = toInvestError(e);
        const flexCode = typeof err.params.flexCode === "string" ? err.params.flexCode : null;
        log(formatFlexPullLog(entry({ statementDate: null, sections: null, error: { code: err.code, flexCode } })));
        throw err;
      }
    },
  };
}

/**
 * The IBKR source resolved at use time (per request, per scheduler tick), so a token saved in Settings takes
 * effect without a restart. Null when the token or the query id is missing.
 */
export async function resolveIbkrSource(q: Db, user: CurrentUser, env: NodeJS.ProcessEnv = process.env, opts: FlexOptions = {}): Promise<IbkrSource | null> {
  const c = await resolveIbkrCredentials(q, user, env);
  if (!c.token.value || !c.queryId.value) return null;
  return ibkrSourceFor(c.token.value, c.queryId.value, opts);
}

export interface IbkrTestResult {
  /** Statement date (Flex toDate). */
  statementDate: string;
  /** Positions (not cash) in the statement. */
  positions: number;
  accounts: number;
  /**
   * The query sections yomi reads, in a fixed order: present, missing, or unknown (Trades and Cash Transactions
   * absent on this one-day window, which proves nothing). With `record`, earlier pulls of the same query count too.
   */
  sections: IbkrSectionItem[];
}

/** Longest total wait of a Test connection for IBKR to prepare the statement. */
export const IBKR_TEST_MAX_WAIT_MS = 60_000;

/**
 * The day Test connection asks for: the weekday before `lastCompletedTradingDay`, a statement IBKR has certainly
 * published. After 18:00 New York the last completed trading day is today, which IBKR usually publishes only after
 * midnight, so asking for it keeps the test polling for minutes.
 */
export function ibkrTestDay(now: Date): string {
  return previousWeekday(lastCompletedTradingDay(now));
}

/**
 * "Test connection": pulls the query once through the real flow (one day, `ibkrTestDay`) and reports the statement
 * date, positions and which of the sections yomi reads the query has. Waits about a minute at most, then throws
 * `invest_ibkr_test_timeout`. Stores nothing but, with `record` (the test ran on the saved query), the sections this
 * pull had. Throws InvestError (token expired, invalid, query invalid, rate limited, …).
 */
export async function testIbkrCredentials(
  token: string,
  queryId: string,
  opts: FlexOptions = {},
  now: Date = clockNow(),
  record?: { q: Db; user: CurrentUser },
): Promise<IbkrTestResult> {
  // One day is enough to check the token and the query, whatever period the query has saved.
  const day = ibkrTestDay(now);
  let s: InvestStatement;
  try {
    s = await ibkrSourceFor(token, queryId, { maxWaitMs: IBKR_TEST_MAX_WAIT_MS, ...opts }).fetchStatement({ from: day, to: day }, "test");
  } catch (e) {
    if (!(e instanceof InvestError) || e.code !== "invest_flex_in_progress_timeout") throw e;
    throw new InvestError("invest_ibkr_test_timeout", "IBKR was still preparing the statement after about a minute; try again in a few minutes", e.params);
  }
  const pull = { at: new Date().toISOString(), from: day, to: day, present: s.sections ?? [], query: ibkrQueryKey(queryId) };
  const sections = (record ? await recordIbkrSections(record.q, record.user, pull) : nextSectionsRecord(null, pull)).sections;
  return {
    statementDate: s.asOf,
    positions: s.holdings.filter((h) => h.securityExternalId != null).length,
    accounts: s.accounts.length,
    sections,
  };
}

export type ExpiryState = "none" | "ok" | "soon" | "expired";

/** `soon` from 14 days before the expiry date (days 0 = expires today), `expired` after it. */
export function tokenExpiry(expiresOn: string | null, today: string): { state: ExpiryState; days: number | null } {
  if (!expiresOn) return { state: "none", days: null };
  const days = dayDiff(today, expiresOn);
  return { state: days < 0 ? "expired" : days <= IBKR_EXPIRY_WARN_DAYS ? "soon" : "ok", days };
}

export interface IbkrSecretsView {
  token: SecretFieldView;
  queryId: IdentifierFieldView;
  /** Expiry date the user entered when creating the token (YYYY-MM-DD), or null. */
  expiresOn: string | null;
  expiry: { state: ExpiryState; days: number | null };
}

export async function ibkrSecretsView(db: Db, user: CurrentUser, env: NodeJS.ProcessEnv = process.env, now: Date = clockNow()): Promise<IbkrSecretsView> {
  const c = await resolveIbkrCredentials(db, user, env);
  const expiresOn = await readSetting(db, user, IBKR_EXPIRES_SETTING);
  return {
    token: secretView(c.token),
    queryId: identifierView(c.queryId),
    expiresOn,
    expiry: tokenExpiry(expiresOn, todayIn(await getTimeZone(db, user), now)),
  };
}

export interface IbkrSaveInput {
  token?: string;
  queryId?: string;
  /** YYYY-MM-DD, or null to clear; omitted keeps it. */
  expiresOn?: string | null;
}

/**
 * Saves the fields sent (encrypted; the key file is created on first need). A field set by env cannot be saved
 * (`secret_set_by_env`). One audit line per changed setting, never the value.
 */
export async function saveIbkrCredentials(db: Db, user: CurrentUser, input: IbkrSaveInput, env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (l) => console.log(l)): Promise<void> {
  const fields: [string | undefined, string, string][] = [
    [input.token, IBKR_TOKEN_ENV, IBKR_TOKEN_SETTING],
    [input.queryId, IBKR_QUERY_ENV, IBKR_QUERY_SETTING],
  ];
  for (const [value, envName] of fields) {
    if (value !== undefined && env[envName]?.trim()) throw new SecretSettingError("secret_set_by_env", `${envName} is set in the environment, which wins over Settings`, { name: envName });
  }
  await db.transaction(async (tx) => {
    for (const [value, , setting] of fields) {
      if (value === undefined) continue;
      await writeSecretSetting(tx, user, setting, value.trim(), env, log);
    }
    if (input.expiresOn !== undefined) {
      if (input.expiresOn) await writeSetting(tx, user, IBKR_EXPIRES_SETTING, input.expiresOn);
      else await deleteSetting(tx, user, IBKR_EXPIRES_SETTING);
    }
  });
  for (const [value, , setting] of fields) if (value !== undefined) auditSecretChange(log, user, setting, "set");
  if (input.expiresOn !== undefined) auditSecretChange(log, user, IBKR_EXPIRES_SETTING, input.expiresOn ? "set" : "removed");
}

/** Removes the token, query id and expiry saved in Settings (env values are untouched). */
export async function removeIbkrCredentials(db: Db, user: CurrentUser, log: (line: string) => void = (l) => console.log(l)): Promise<void> {
  const present: string[] = [];
  for (const k of [IBKR_TOKEN_SETTING, IBKR_QUERY_SETTING, IBKR_EXPIRES_SETTING]) if ((await readSetting(db, user, k)) != null) present.push(k);
  await db.transaction(async (tx) => {
    for (const k of present) await removeSetting(tx, user, k);
  });
  for (const k of present) auditSecretChange(log, user, k, "removed");
}
