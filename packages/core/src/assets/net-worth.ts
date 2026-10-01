// Net worth at a point in time and its daily history: cash (bank accounts, wallets), cards (owed,
// negative) and holdings market value, per currency; one converted total only with a stated FX rate.
import { accountBalanceSnapshots, accounts, type BalanceSource, type Db, holdingSnapshots } from "@yomi/db";
import { and, asc, eq, lte, min } from "@yomi/db/orm";
import { convertMinor, crossRate, type FxTable, getFxRates } from "../invest/fx";
import { InvestError } from "../invest/errors";
import { getTimeZone } from "../settings/time-zone";
import { addDays } from "../stats/period";
import { clockNow, todayIn } from "../time/zone";
import type { CurrentUser } from "../user";
import { type BalanceClass, balanceTimeline } from "./balances";

export const NET_WORTH_RANGES = ["1m", "3m", "1y", "all"] as const;
export type NetWorthRange = (typeof NET_WORTH_RANGES)[number];
const RANGE_DAYS: Record<Exclude<NetWorthRange, "all">, number> = { "1m": 30, "3m": 90, "1y": 365 };
/** The change shown next to the net worth compares with this many days before. */
export const CHANGE_DAYS = 30;

export interface NetWorthParts {
  /** Bank accounts, wallets and cash. */
  cashMinor: number;
  /** Credit cards: what is owed, negative. */
  cardsMinor: number;
  /** Market value of holdings, brokerage cash included. */
  holdingsMinor: number;
  /** Unrealized P/L of positions with a known cost. */
  pnlMinor: number;
  totalMinor: number;
}

export interface CurrencyNetWorth extends NetWorthParts {
  currency: string;
  /** Total now minus the total 30 days before; null when nothing was known then. */
  changeMinor: number | null;
}

export interface NetWorthPoint {
  date: string;
  byCurrency: Record<string, NetWorthParts>;
  /** The same day in the converted currency (today's rate for every day); null without FX. */
  converted: NetWorthParts | null;
}

export interface AccountBalanceView {
  id: number;
  name: string;
  kind: string;
  institution: string | null;
  last4: string | null;
  currency: string;
  class: BalanceClass;
  plaidLinked: boolean;
  startingBalance: { amountMinor: number; on: string } | null;
  balances: {
    currency: string;
    balanceMinor: number;
    /** Change over the last 30 days; null when the balance 30 days ago is unknown. */
    changeMinor: number | null;
    source: BalanceSource | null;
    /** Day the balance is from (a statement's date, the starting balance day for derived balances). */
    sourceAsOf: string | null;
  }[];
}

export interface ConvertedNetWorth extends NetWorthParts {
  currency: string;
  changeMinor: number | null;
  /** rate: units of the target per 1 `from`; inverse: units of `from` per 1 target (4 decimals, display). */
  fx: { source: FxTable["source"]; date: string; rates: { from: string; rate: string; inverse: string }[] };
}

export interface NetWorth {
  asOf: string;
  range: NetWorthRange;
  /** First day of the history series. */
  from: string;
  /** Earliest day anything is known (snapshot, starting balance, holdings); null when nothing is. */
  firstDate: string | null;
  currencies: CurrencyNetWorth[];
  converted: ConvertedNetWorth | null;
  fxError: { code: string; params: Record<string, string | number>; message: string } | null;
  series: NetWorthPoint[];
  /** Every ledger account; those with nothing known have no balances. */
  accounts: AccountBalanceView[];
  /** Any account balance snapshot or starting balance exists (holdings alone do not count). */
  hasBalances: boolean;
}

const zero = (): NetWorthParts => ({ cashMinor: 0, cardsMinor: 0, holdingsMinor: 0, pnlMinor: 0, totalMinor: 0 });

async function earliestDate(db: Db, user: CurrentUser): Promise<string | null> {
  const a = (await db.select({ d: min(accountBalanceSnapshots.asOf) }).from(accountBalanceSnapshots).where(eq(accountBalanceSnapshots.userId, user.id)).limit(1))[0]?.d ?? null;
  const b = (await db.select({ d: min(accounts.startingBalanceOn) }).from(accounts).where(eq(accounts.userId, user.id)).limit(1))[0]?.d ?? null;
  const c = (await db.select({ d: min(holdingSnapshots.asOf) }).from(holdingSnapshots).where(eq(holdingSnapshots.userId, user.id)).limit(1))[0]?.d ?? null;
  return [a, b, c].filter((d): d is string => d != null).sort()[0] ?? null;
}

/** Market value and P/L per currency per day: each investment account's latest snapshot on or before the day. */
async function holdingsTimeline(db: Db, user: CurrentUser, days: string[]): Promise<Map<string, { mv: number[]; pnl: number[] }>> {
  const out = new Map<string, { mv: number[]; pnl: number[] }>();
  if (days.length === 0) return out;
  const rows = await db
    .select({
      accountId: holdingSnapshots.investmentAccountId,
      asOf: holdingSnapshots.asOf,
      currency: holdingSnapshots.currency,
      mv: holdingSnapshots.marketValueMinor,
      cost: holdingSnapshots.costBasisMinor,
    })
    .from(holdingSnapshots)
    .where(and(eq(holdingSnapshots.userId, user.id), lte(holdingSnapshots.asOf, days[days.length - 1]!)))
    .orderBy(asc(holdingSnapshots.asOf));
  // account → ordered dates → currency → totals
  const byAccount = new Map<number, Map<string, Map<string, { mv: number; pnl: number }>>>();
  for (const r of rows) {
    const dates = byAccount.get(r.accountId) ?? new Map<string, Map<string, { mv: number; pnl: number }>>();
    byAccount.set(r.accountId, dates);
    const cur = dates.get(r.asOf) ?? new Map<string, { mv: number; pnl: number }>();
    dates.set(r.asOf, cur);
    const t = cur.get(r.currency) ?? { mv: 0, pnl: 0 };
    t.mv += r.mv;
    if (r.cost != null) t.pnl += r.mv - r.cost;
    cur.set(r.currency, t);
  }
  for (const dates of byAccount.values()) {
    const list = [...dates.entries()];
    let k = 0;
    let cur: Map<string, { mv: number; pnl: number }> | null = null;
    days.forEach((day, i) => {
      while (k < list.length && list[k]![0] <= day) cur = list[k++]![1];
      if (!cur) return;
      for (const [c, t] of cur) {
        let s = out.get(c);
        if (!s) out.set(c, (s = { mv: days.map(() => 0), pnl: days.map(() => 0) }));
        s.mv[i]! += t.mv;
        s.pnl[i]! += t.pnl;
      }
    });
  }
  return out;
}

export interface NetWorthOptions {
  /** Default: today in the user's time zone. */
  asOf?: string;
  range?: NetWorthRange;
  /** Also total everything in this currency (Frankfurter rate, stated with its date). */
  currency?: string;
}

/**
 * Net worth per currency on `asOf` (cash, cards, holdings), the change over 30 days, the daily history
 * for the range (gaps carried forward) and every account's balance. Pure reads, no FX.
 */
export async function netWorthData(db: Db, user: CurrentUser, opts: { asOf: string; range: NetWorthRange; from?: string }): Promise<Omit<NetWorth, "converted" | "fxError">> {
  const { asOf, range } = opts;
  const firstDate = await earliestDate(db, user);
  const from =
    opts.from && opts.from <= asOf ? opts.from
    : range === "all" ? (firstDate && firstDate < asOf ? firstDate : addDays(asOf, -RANGE_DAYS["1m"])) : addDays(asOf, -RANGE_DAYS[range]);
  const changeFrom = addDays(asOf, -CHANGE_DAYS);
  const start = from < changeFrom ? from : changeFrom;
  const timeline = await balanceTimeline(db, user, { from: start, to: asOf });
  const days = timeline.days;
  const holdings = await holdingsTimeline(db, user, days);

  // Per day, per currency parts.
  const perDay: Map<string, NetWorthParts>[] = days.map(() => new Map());
  const partsAt = (i: number, c: string) => {
    const m = perDay[i]!;
    let p = m.get(c);
    if (!p) m.set(c, (p = zero()));
    return p;
  };
  const known: Set<string>[] = days.map(() => new Set());
  for (const a of timeline.accounts) {
    for (const [c, s] of a.daily) {
      s.forEach((v, i) => {
        if (v == null) return;
        const p = partsAt(i, c);
        if (a.class === "card") p.cardsMinor += v;
        else p.cashMinor += v;
        p.totalMinor += v;
        known[i]!.add(c);
      });
    }
  }
  for (const [c, s] of holdings) {
    s.mv.forEach((v, i) => {
      if (v === 0 && s.pnl[i] === 0) return;
      const p = partsAt(i, c);
      p.holdingsMinor += v;
      p.pnlMinor += s.pnl[i]!;
      p.totalMinor += v;
      known[i]!.add(c);
    });
  }

  const last = days.length - 1;
  const changeIdx = days.indexOf(changeFrom);
  const currencies: CurrencyNetWorth[] = [...(perDay[last]?.entries() ?? [])]
    .map(([currency, p]) => ({
      currency,
      ...p,
      changeMinor: changeIdx >= 0 && known[changeIdx]!.has(currency) ? p.totalMinor - (perDay[changeIdx]!.get(currency)?.totalMinor ?? 0) : null,
    }))
    .sort((x, y) => x.currency.localeCompare(y.currency));

  const fromIdx = days.indexOf(from);
  const series: NetWorthPoint[] = days.slice(fromIdx).map((date, j) => ({ date, byCurrency: Object.fromEntries(perDay[fromIdx + j]!), converted: null }));

  const accountViews: AccountBalanceView[] = timeline.accounts.map((a) => ({
    id: a.account.id,
    name: a.account.name,
    kind: a.account.kind,
    institution: a.account.institution,
    last4: a.account.last4,
    currency: a.account.currency,
    class: a.class,
    plaidLinked: a.plaidLinked,
    startingBalance:
      a.account.startingBalanceMinor != null && a.account.startingBalanceOn ? { amountMinor: a.account.startingBalanceMinor, on: a.account.startingBalanceOn } : null,
    balances: [...a.daily.entries()]
      .filter(([, s]) => s[last] != null)
      .map(([currency, s]) => {
        const then = changeIdx >= 0 ? s[changeIdx] : null;
        const info = a.sourceAt.get(currency);
        return { currency, balanceMinor: s[last]!, changeMinor: then == null ? null : s[last]! - then, source: info?.source ?? null, sourceAsOf: info?.asOf ?? null };
      })
      .sort((x, y) => (x.currency === a.account.currency ? -1 : y.currency === a.account.currency ? 1 : x.currency.localeCompare(y.currency))),
  }));
  const hasBalances =
    (await db.select({ id: accountBalanceSnapshots.id }).from(accountBalanceSnapshots).where(eq(accountBalanceSnapshots.userId, user.id)).limit(1))[0] != null ||
    timeline.accounts.some((a) => a.account.startingBalanceOn != null);

  return { asOf, range, from, firstDate, currencies, series, accounts: accountViews, hasBalances };
}

function convertParts(p: NetWorthParts, from: string, to: string, fx: FxTable): NetWorthParts {
  return {
    cashMinor: convertMinor(p.cashMinor, from, to, fx),
    cardsMinor: convertMinor(p.cardsMinor, from, to, fx),
    holdingsMinor: convertMinor(p.holdingsMinor, from, to, fx),
    pnlMinor: convertMinor(p.pnlMinor, from, to, fx),
    totalMinor: convertMinor(p.totalMinor, from, to, fx),
  };
}

function addParts(a: NetWorthParts, b: NetWorthParts): NetWorthParts {
  return {
    cashMinor: a.cashMinor + b.cashMinor,
    cardsMinor: a.cardsMinor + b.cardsMinor,
    holdingsMinor: a.holdingsMinor + b.holdingsMinor,
    pnlMinor: a.pnlMinor + b.pnlMinor,
    totalMinor: a.totalMinor + b.totalMinor,
  };
}

/**
 * Adds the converted total, change and series in `currency` with one FX table (its rates and date are
 * stated). Each currency's parts are converted once, then added.
 */
export function convertNetWorth(data: Omit<NetWorth, "converted" | "fxError">, currency: string, fx: FxTable): Pick<NetWorth, "converted" | "series"> {
  const to = currency.toUpperCase();
  const convertAll = (byCurrency: Record<string, NetWorthParts>) =>
    Object.entries(byCurrency).reduce((acc, [c, p]) => addParts(acc, convertParts(p, c, to, fx)), zero());
  let now = zero();
  let change: number | null = null;
  const rates: { from: string; rate: string; inverse: string }[] = [];
  for (const c of data.currencies) {
    now = addParts(now, convertParts(c, c.currency, to, fx));
    if (c.changeMinor != null) change = (change ?? 0) + convertMinor(c.changeMinor, c.currency, to, fx);
    if (c.currency !== to) rates.push({ from: c.currency, rate: crossRate(c.currency, to, fx), inverse: crossRate(to, c.currency, fx, 4) });
  }
  return {
    converted: { currency: to, ...now, changeMinor: change, fx: { source: fx.source, date: fx.date, rates } },
    series: data.series.map((p) => ({ ...p, converted: convertAll(p.byCurrency) })),
  };
}

/** Currencies the net worth touches (on any day of the series). */
export function netWorthCurrencies(data: Pick<NetWorth, "series" | "currencies">): string[] {
  const s = new Set(data.currencies.map((c) => c.currency));
  for (const p of data.series) for (const c of Object.keys(p.byCurrency)) s.add(c);
  return [...s].sort();
}

/**
 * Net worth on `asOf` (default today in the user's zone) with history for `range` (default 3m), per
 * currency; with `currency`, also converted through Frankfurter (cached daily). An FX failure leaves
 * `converted` null and fills `fxError`; per-currency numbers are always there.
 */
export async function netWorth(
  db: Db,
  user: CurrentUser,
  opts: NetWorthOptions = {},
  deps: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<NetWorth> {
  const asOf = opts.asOf ?? todayIn(await getTimeZone(db, user), (deps.now ?? (() => clockNow()))());
  const data = await netWorthData(db, user, { asOf, range: opts.range ?? "3m" });
  const out: NetWorth = { ...data, converted: null, fxError: null };
  const currencies = netWorthCurrencies(data);
  if (!opts.currency || currencies.length === 0) return out;
  try {
    const fx = await getFxRates(db, user, [...currencies, opts.currency], { fetch: deps.fetch, now: deps.now });
    Object.assign(out, convertNetWorth(data, opts.currency, fx));
  } catch (e) {
    if (!(e instanceof InvestError)) throw e;
    out.fxError = { code: e.code, params: e.params as Record<string, string | number>, message: e.message };
  }
  return out;
}

export interface NetWorthChange {
  from: string;
  to: string;
  /** Per currency: total at the end of `to` minus the total at the end of the day before `from`. */
  currencies: { currency: string; changeMinor: number }[];
  converted: { currency: string; changeMinor: number; fx: ConvertedNetWorth["fx"] } | null;
}

/**
 * How net worth changed over a period (Stats links to Assets with it). Null when no account balance is
 * known at the day before `from`. Converted only with `currency`, several currencies and available FX.
 */
export async function netWorthChange(
  db: Db,
  user: CurrentUser,
  period: { from: string; to: string; currency?: string },
  deps: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<NetWorthChange | null> {
  const before = addDays(period.from, -1);
  const t = await netWorthData(db, user, { asOf: period.to, range: "all", from: before });
  const first = t.series[0];
  const last = t.series[t.series.length - 1];
  if (!t.hasBalances || !first || !last || first.date !== before) return null;
  const codes = [...new Set([...Object.keys(first.byCurrency), ...Object.keys(last.byCurrency)])].sort();
  if (codes.length === 0) return null;
  const currencies = codes.map((currency) => ({
    currency,
    changeMinor: (last.byCurrency[currency]?.totalMinor ?? 0) - (first.byCurrency[currency]?.totalMinor ?? 0),
  }));
  let converted: NetWorthChange["converted"] = null;
  // One currency needs no rate: it is shown as is.
  if (period.currency && codes.length > 1) {
    try {
      const fx = await getFxRates(db, user, [...codes, period.currency], deps);
      const to = period.currency.toUpperCase();
      converted = {
        currency: to,
        changeMinor: currencies.reduce((n, c) => n + convertMinor(c.changeMinor, c.currency, to, fx), 0),
        fx: { source: fx.source, date: fx.date, rates: codes.filter((c) => c !== to).map((c) => ({ from: c, rate: crossRate(c, to, fx), inverse: crossRate(to, c, fx, 4) })) },
      };
    } catch (e) {
      if (!(e instanceof InvestError)) throw e;
    }
  }
  return { from: period.from, to: period.to, currencies, converted };
}
