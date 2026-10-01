// Daily FX rates from Frankfurter (free, no key). Rates are decimal strings; conversions use BigInt
// with a single rounding step. See packages/importers/src/ibkr/README.md for the verified API facts.
import { type Db, jobs } from "@yomi/db";
import { divRound, formatDec, numberToDecimal, parseDec } from "@yomi/importers";
import { and, eq } from "@yomi/db/orm";
import { minorDigits } from "../money";
import type { CurrentUser } from "../user";
import { InvestError } from "./errors";
import { clockNow } from "../time/clock";
import { marketClock } from "./time";

/** v2 endpoint (v1 /latest answers with a Deprecation header naming /v2/rates as successor). */
export const FRANKFURTER_URL = "https://api.frankfurter.dev/v2/rates";
export const FX_BASE = "USD";
export const FX_JOB = "fx-rates";

/** Units of each currency per 1 USD, as published for `date`. */
export interface FxTable {
  base: typeof FX_BASE;
  /** Publication date of the rates (the provider's, not the fetch day). */
  date: string;
  rates: Record<string, string>;
  source: "frankfurter";
}

interface FxCache extends FxTable {
  /** New York calendar day the rates were fetched on. */
  fetchedOn: string;
}

/** GET /v2/rates?base=USD&quotes=CNY,HKD → [{ date, base, quote, rate }]. */
export async function fetchFrankfurter(quotes: string[], opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<FxTable> {
  const url = new URL(FRANKFURTER_URL);
  url.searchParams.set("base", FX_BASE);
  url.searchParams.set("quotes", quotes.join(","));
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url.toString(), { signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new InvestError("invest_fx_unavailable", `Frankfurter request failed: ${detail}`, { detail });
  }
  if (!res.ok) throw new InvestError("invest_fx_unavailable", `Frankfurter HTTP ${res.status}`, { detail: `HTTP ${res.status}` });
  const body = (await res.json()) as unknown;
  if (!Array.isArray(body)) throw new InvestError("invest_fx_unavailable", "Frankfurter answer is not a list", { detail: "not a list" });
  const rates: Record<string, string> = {};
  let date = "";
  for (const r of body as { date?: string; base?: string; quote?: string; rate?: number }[]) {
    if (r.base !== FX_BASE || typeof r.quote !== "string" || typeof r.rate !== "number" || !(r.rate > 0)) continue;
    rates[r.quote.toUpperCase()] = numberToDecimal(r.rate);
    if (r.date && r.date > date) date = r.date;
  }
  return { base: FX_BASE, date, rates, source: "frankfurter" };
}

async function readCache(db: Db, user: CurrentUser): Promise<FxCache | null> {
  const row = (await db
    .select({ cursor: jobs.cursor })
    .from(jobs)
    .where(and(eq(jobs.userId, user.id), eq(jobs.name, FX_JOB)))
    .limit(1))[0];
  if (!row?.cursor) return null;
  try {
    const c = JSON.parse(row.cursor) as FxCache;
    return c && c.base === FX_BASE && typeof c.rates === "object" ? c : null;
  } catch {
    return null;
  }
}

async function writeCache(db: Db, user: CurrentUser, c: FxCache): Promise<void> {
  await db.insert(jobs)
    .values({ userId: user.id, name: FX_JOB, status: "idle", cursor: JSON.stringify(c) })
    .onConflictDoUpdate({ target: [jobs.userId, jobs.name], set: { cursor: JSON.stringify(c), status: "idle", lastError: null } });
}

const covers = (t: FxTable, currencies: string[]) => currencies.every((c) => c === FX_BASE || t.rates[c]);

/**
 * Rates for `currencies` (any case), fetched at most once per New York day and cached in the
 * `fx-rates` jobs row. If the fetch fails, yesterday's cached table is used when it covers the
 * currencies; otherwise InvestError invest_fx_unavailable.
 */
export async function getFxRates(
  db: Db,
  user: CurrentUser,
  currencies: string[],
  opts: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<FxTable> {
  const wanted = [...new Set(currencies.map((c) => c.toUpperCase()))].filter((c) => c !== FX_BASE).sort();
  const today = marketClock((opts.now ?? (() => clockNow()))()).date;
  const cached = await readCache(db, user);
  if (cached && cached.fetchedOn === today && covers(cached, wanted)) return strip(cached);
  if (wanted.length === 0) return { base: FX_BASE, date: cached?.date ?? today, rates: {}, source: "frankfurter" };
  const quotes = [...new Set([...wanted, ...Object.keys(cached?.rates ?? {})])].sort();
  try {
    const fresh = await fetchFrankfurter(quotes, { fetch: opts.fetch });
    const missing = wanted.filter((c) => !fresh.rates[c]);
    if (missing.length) throw new InvestError("invest_fx_currency_unsupported", `Frankfurter has no rate for ${missing.join(", ")}`, { currencies: missing.join(", ") });
    await writeCache(db, user, { ...fresh, fetchedOn: today });
    return fresh;
  } catch (e) {
    if (cached && covers(cached, wanted)) return strip(cached);
    throw e;
  }
}

function strip(c: FxCache): FxTable {
  return { base: c.base, date: c.date, rates: c.rates, source: c.source };
}

function rateOf(t: FxTable, currency: string) {
  const c = currency.toUpperCase();
  if (c === t.base) return parseDec("1");
  const r = t.rates[c];
  if (!r) throw new InvestError("invest_fx_currency_unsupported", `No FX rate for ${c}`, { currencies: c });
  return parseDec(r);
}

/**
 * amountMinor in `from` → minor units of `to`: amount × rate(to) / rate(from), both rates per 1 USD,
 * minor-unit exponents applied, one half-away-from-zero rounding at the end.
 */
export function convertMinor(amountMinor: number, from: string, to: string, t: FxTable): number {
  if (from.toUpperCase() === to.toUpperCase()) return amountMinor;
  const rf = rateOf(t, from);
  const rt = rateOf(t, to);
  const df = minorDigits(from);
  const dt = minorDigits(to);
  // amount_to_minor = amount_from_minor × 10^(dt − df) × (rt.units / 10^rt.scale) / (rf.units / 10^rf.scale)
  let num = BigInt(amountMinor) * rt.units;
  let den = rf.units;
  const exp = dt - df + rf.scale - rt.scale;
  if (exp >= 0) num *= 10n ** BigInt(exp);
  else den *= 10n ** BigInt(-exp);
  const v = divRound(num, den);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`converted amount out of range: ${v}`);
  return n === 0 ? 0 : n;
}

/** Units of `to` per 1 `from`, as a decimal string with `places` decimals (display only). */
export function crossRate(from: string, to: string, t: FxTable, places = 6): string {
  const rf = rateOf(t, from);
  const rt = rateOf(t, to);
  // rt / rf scaled to `places` decimals
  let num = rt.units * 10n ** BigInt(places);
  let den = rf.units;
  const exp = rf.scale - rt.scale;
  if (exp >= 0) num *= 10n ** BigInt(exp);
  else den *= 10n ** BigInt(-exp);
  return formatDec({ units: divRound(num, den), scale: places });
}
