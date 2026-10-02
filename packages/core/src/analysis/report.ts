import { categories, type Db, transactions } from "@yomi/db";
import { and, eq, gte, inArray, lt, min } from "@yomi/db/orm";
import { investmentFlows } from "../assets/investments";
import { netWorthData } from "../assets/net-worth";
import { LedgerError } from "../ledger/errors";
import { countsAsSpending } from "../ledger/share";
import { loadRangeRows, type SpendingRow } from "../ledger/transactions";
import { getTimeZone } from "../settings/time-zone";
import { addDays, assertRange, type DateRange, daysInclusive, isDate } from "../stats/period";
import { type RangeCurrencyOverview, rangeOverview } from "../stats/range";
import { clockNow, localDate, todayIn } from "../time/zone";
import type { CurrentUser } from "../user";
import {
  attentionItems,
  type Attention,
  loadPlaidLogins,
  loadSourceActivity,
  loadSourceFacts,
  periodCompleteness,
  type SourceFreshness,
  sourceFreshness,
  type SourceTotal,
  sourceTotals,
} from "./freshness";
import {
  type CategoryAmount,
  type CategoryShift,
  categoryShifts,
  type InvestmentChange,
  type MerchantTotal,
  type NewMerchant,
  newMerchants,
  splitInvestmentChange,
  topMerchants,
  type Typical,
  typicalSpending,
  UNUSUAL_LOOKBACK_DAYS,
  type UnusualItem,
  unusualItems,
} from "./insights";
import { DEFAULT_WEEK_START, type PeriodKind, periodKindOf, typicalRanges, weekdayOf } from "./period";

/** A spending row of the day on the Day view. */
export interface DayRow {
  id: number;
  merchant: string;
  /** My share (refunds negative). */
  minor: number;
  occurredAt: string;
  occurredOn: string;
  source: string;
  categoryId: number | null;
}

export interface AnalysisCurrency extends RangeCurrencyOverview {
  /** Typical spending over the previous complete periods of the same kind; null without 2 periods of history. */
  typical: Typical | null;
  topMerchants: MerchantTotal[];
  /** Week, month and year: categories that moved most against typical (same number of days). */
  categoryShifts: CategoryShift[];
  unusual: UnusualItem[];
  /** Merchants first charged in the period (those already listed as a first large charge left out). */
  newMerchants: NewMerchant[];
  /** Keys of sources whose data ends before this period does: the numbers are partial and comparisons are hidden. */
  partialSources: string[];
  /** Day only: the day's spending rows (all when 8 or fewer, else the largest 5); null for weeks and months. */
  dayRows: DayRow[] | null;
}

/** Rows written on the day, whatever their occurred_on: what came in. */
export interface Arrival {
  source: string;
  count: number;
}

export interface MarketClose {
  /** The day is a weekday (holidays are not known). */
  marketDay: boolean;
  /** The close the day is compared with (weekday), or the last close (weekend). */
  previousClose: string;
}

export interface AnalysisReport {
  kind: PeriodKind | "range";
  from: string;
  to: string;
  today: string;
  weekStart: number;
  /** The period contains today ("so far"). */
  inProgress: boolean;
  /** The period starts after today. */
  future: boolean;
  /** Days the daily average divides by (elapsed days while in progress). */
  days: number;
  lengthDays: number;
  previous: { from: string; to: string; days: number };
  /** 'YYYY-MM' for a calendar month. */
  month: string | null;
  /** The periods "typical" averages over (oldest first); empty for a plain range. */
  typicalRanges: DateRange[];
  currencies: AnalysisCurrency[];
  /** Per currency, keys of the sources that leave the period incomplete (also for currencies without rows). */
  partial: Record<string, string[]>;
  /** Day only. */
  arrivals: Arrival[] | null;
  /** Holdings change per currency over the period; null when there are no investment accounts or the period is ahead. */
  investments: InvestmentChange[] | null;
  /** Day only. */
  close: MarketClose | null;
  attention: Attention[];
  freshness: SourceFreshness[];
  /** What each source adds to the period's counts and totals, per currency (sources without rows absent). */
  sourceTotals: SourceTotal[];
}

/** Day rows: all of them when 8 or fewer, else the largest 5. */
const DAY_ROWS_ALL = 8;
const DAY_ROWS_TOP = 5;

const UNCATEGORIZED = "Uncategorized";

/** The earliest day with a counted row, per currency ("typical" and "first large" need history). */
async function firstSpendingDays(db: Db, user: CurrentUser): Promise<Map<string, string>> {
  const rows = await db
    .select({ currency: transactions.currency, first: min(transactions.occurredOn) })
    .from(transactions)
    .where(and(eq(transactions.userId, user.id), inArray(transactions.kind, ["expense", "refund"]), eq(transactions.status, "ok")))
    .groupBy(transactions.currency);
  return new Map(rows.filter((r) => r.first != null).map((r) => [r.currency, r.first!]));
}

/** Rows written during `day` in the user's zone, counted per source. */
async function arrivalsOn(db: Db, user: CurrentUser, day: string, timeZone: string): Promise<Arrival[]> {
  // created_at is a UTC instant; any zone's day lies within a day either side of the UTC day.
  const rows = await db
    .select({ source: transactions.source, createdAt: transactions.createdAt })
    .from(transactions)
    .where(and(eq(transactions.userId, user.id), gte(transactions.createdAt, addDays(day, -1)), lt(transactions.createdAt, addDays(day, 2))));
  const counts = new Map<string, number>();
  for (const r of rows) if (localDate(r.createdAt, timeZone) === day) counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
  return [...counts].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

/**
 * Holdings per currency at the end of the day before `from` and at the end of `to` (capped at today), with the
 * period's deposits and dividends. Null when no investment account has a value on either day.
 */
async function investmentChanges(db: Db, user: CurrentUser, r: DateRange, today: string): Promise<InvestmentChange[] | null> {
  if (r.from > today) return null;
  const end = r.to < today ? r.to : today;
  const before = addDays(r.from, -1);
  const data = await netWorthData(db, user, { asOf: end, range: "all", from: before });
  const first = data.series.find((p) => p.date === before) ?? null;
  const last = data.series.at(-1) ?? null;
  if (!last) return null;
  const holds = (p: typeof last | null, c: string) => (p?.known[c] ?? []).includes("holdings");
  const codes = [...new Set([...Object.keys(first?.byCurrency ?? {}), ...Object.keys(last.byCurrency)])]
    .filter((c) => holds(first, c) || holds(last, c))
    .sort();
  if (codes.length === 0) return null;
  const flows = await investmentFlows(db, user, { from: r.from, to: end });
  const missing = (p: typeof last | null, c: string) => (p?.missing ?? []).some((m) => m.kind === "investment" && m.currencies.includes(c));
  return codes.map((c) => {
    const start = holds(first, c) ? first!.byCurrency[c]!.holdingsMinor : null;
    const stop = holds(last, c) ? last.byCurrency[c]!.holdingsMinor : null;
    return splitInvestmentChange(start, stop, flows, c, missing(first, c) || missing(last, c));
  });
}

function marketClose(day: string): MarketClose {
  const wd = weekdayOf(day);
  // Saturday and Sunday: the last close is Friday's. Monday compares with Friday.
  if (wd === 6) return { marketDay: false, previousClose: addDays(day, -1) };
  if (wd === 0) return { marketDay: false, previousClose: addDays(day, -2) };
  return { marketDay: true, previousClose: addDays(day, wd === 1 ? -3 : -1) };
}

/** Σ my share per category over rows, for the currency. */
function categoryTotals(rows: readonly SpendingRow[], currency: string, names: Map<number, string>): Map<number | null, CategoryAmount> {
  const out = new Map<number | null, CategoryAmount>();
  for (const r of rows) {
    if (r.currency !== currency || !countsAsSpending(r)) continue;
    const c = out.get(r.categoryId) ?? { categoryId: r.categoryId, name: r.categoryId == null ? UNCATEGORIZED : (names.get(r.categoryId) ?? UNCATEGORIZED), minor: 0 };
    c.minor += r.myShareMinor;
    out.set(r.categoryId, c);
  }
  return out;
}

/**
 * Everything Analysis shows for one period, per currency and never summed across currencies: the Stats overview of
 * the range (spending, income, categories, largest, small payments, target) plus typical spending, top merchants,
 * category shifts, unusual rows, data freshness and partial currencies, investment change, and for a day the rows,
 * the arrivals and the market close. The v0.3 narrative and MCP tools read this same report.
 */
export async function analysisReport(
  db: Db,
  user: CurrentUser,
  range: DateRange,
  opts: { today?: string; weekStart?: number; env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<AnalysisReport> {
  assertRange(range);
  const timeZone = await getTimeZone(db, user);
  const now = opts.now ?? clockNow();
  const today = opts.today ?? todayIn(timeZone, now);
  if (!isDate(today)) throw new LedgerError("invalid_input", "invalid_date", `Invalid date: ${today}`, { value: today });
  const weekStart = opts.weekStart ?? DEFAULT_WEEK_START;
  const kind = periodKindOf(range, weekStart);

  const overview = await rangeOverview(db, user, range, { today });
  const typical = kind === "range" ? [] : typicalRanges(range, kind);
  const historyFrom = [addDays(range.from, -UNUSUAL_LOOKBACK_DAYS), ...typical.map((t) => t.from)].sort()[0]!;
  const rows = await loadRangeRows(db, user.id, historyFrom, range.to);
  const inPeriod = rows.filter((r) => r.occurredOn >= range.from && r.occurredOn <= range.to);
  const firstDays = await firstSpendingDays(db, user);
  const names = new Map(
    (await db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.userId, user.id))).map((c) => [c.id, c.name]),
  );

  const facts = await loadSourceFacts(db, user, { timeZone, env: opts.env, now });
  const freshness = sourceFreshness(facts, today);
  const partial = periodCompleteness(freshness, await loadSourceActivity(db, user, range), range, today);

  const currencies: AnalysisCurrency[] = overview.currencies.map((c) => {
    const cur = c.currency;
    const since = firstDays.get(cur) ?? null;
    const t = typicalSpending(rows, typical, cur, since);
    let shifts: CategoryShift[] = [];
    if (kind === "week" || kind === "month" || kind === "year") {
      const usable = typical.filter((r) => since != null && r.from >= since);
      if (usable.length >= 2) {
        const usableDays = usable.reduce((a, r) => a + daysInclusive(r.from, r.to), 0);
        const typicalRows = rows.filter((r) => usable.some((u) => r.occurredOn >= u.from && r.occurredOn <= u.to));
        // Typical per category for as many days as the period has run.
        const scaled = [...categoryTotals(typicalRows, cur, names).values()].map((x) => ({ ...x, minor: Math.round((x.minor * overview.days) / usableDays) }));
        shifts = categoryShifts(
          c.byCategory.map((b) => ({ categoryId: b.categoryId, name: b.name, minor: b.minor })),
          scaled,
          cur,
        );
      }
    }
    let dayRows: DayRow[] | null = null;
    if (kind === "day") {
      const spend = inPeriod.filter((r) => r.currency === cur && countsAsSpending(r) && r.myShareMinor !== 0);
      const picked =
        spend.length <= DAY_ROWS_ALL
          ? [...spend].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id - b.id)
          : [...spend].sort((a, b) => b.myShareMinor - a.myShareMinor || a.id - b.id).slice(0, DAY_ROWS_TOP);
      dayRows = picked.map((r) => ({
        id: r.id,
        merchant: r.merchant,
        minor: r.myShareMinor,
        occurredAt: r.occurredAt,
        occurredOn: r.occurredOn,
        source: r.source,
        categoryId: r.categoryId,
      }));
    }
    const unusual = unusualItems(inPeriod, rows, cur, { since });
    const firstLarge = new Set(unusual.filter((u) => u.kind === "first_large").map((u) => u.merchant.trim().toLowerCase()));
    return {
      ...c,
      typical: t,
      topMerchants: topMerchants(inPeriod, cur),
      categoryShifts: shifts,
      unusual,
      newMerchants: newMerchants(inPeriod, rows, cur, { since }).filter((m) => !firstLarge.has(m.merchant.trim().toLowerCase())),
      partialSources: partial[cur] ?? [],
      dayRows,
    };
  });

  return {
    kind,
    from: range.from,
    to: range.to,
    today,
    weekStart,
    inProgress: overview.inProgress,
    future: range.from > today,
    days: overview.days,
    lengthDays: overview.lengthDays,
    previous: overview.previous,
    month: overview.month,
    typicalRanges: typical,
    currencies,
    partial,
    arrivals: kind === "day" ? await arrivalsOn(db, user, range.from, timeZone) : null,
    investments: await investmentChanges(db, user, range, today),
    close: kind === "day" ? marketClose(range.from) : null,
    attention: attentionItems(freshness),
    freshness,
    sourceTotals: sourceTotals(inPeriod, await loadPlaidLogins(db, user)),
  };
}
