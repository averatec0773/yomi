import { categories, type Db } from "@yomi/db";
import { eq } from "@yomi/db/orm";
import { LedgerError } from "../ledger/errors";
import { countsAsSpending } from "../ledger/share";
import { loadRangeRows, type SpendingRow } from "../ledger/transactions";
import { getMonthlyTarget, type MonthTarget } from "../month/target";
import { getTimeZone } from "../settings/time-zone";
import { clockNow, todayIn } from "../time/zone";
import type { CurrentUser } from "../user";
import { assertRange, type DateRange, daysInclusive, isDate, monthEnd, monthsIn, monthStart, previousRange, wholeMonths } from "./period";

export interface CategoryShare {
  categoryId: number | null;
  name: string;
  minor: number;
  count: number;
  /** Share of the period's spending in basis points (10000 = 100%). */
  share: number;
}

export interface LargestRow {
  id: number;
  merchant: string;
  minor: number;
  occurredAt: string;
  /** Day in the user's time zone. */
  occurredOn: string;
}

export interface PeriodMetrics {
  /** Σ my share (plan §3). */
  spendingMinor: number;
  incomeMinor: number;
  /** Rows counted as spending. */
  transactionCount: number;
  dailyAverageMinor: number;
}

export interface MonthlyPoint {
  month: string;
  spendingMinor: number;
  /** The range covers only part of this month, or the month is not over yet. */
  partial: boolean;
}

export interface RangeCurrencyOverview extends PeriodMetrics {
  currency: string;
  byCategory: CategoryShare[];
  smallPayments: { thresholdMinor: number; count: number; minor: number };
  largest: LargestRow[];
  /** Money I fronted for others on rows I paid (Σ others' owed). */
  sharedReceivableMinor: number;
  /** Same rule over the previous period, same currency; null when it has no spending rows. */
  previous: PeriodMetrics | null;
  /** Spending per calendar month, oldest first; null when the range sits inside one month. */
  monthly: MonthlyPoint[] | null;
  /** Only when the range is exactly one calendar month. */
  target: MonthTarget | null;
}

export interface RangeOverview {
  from: string;
  to: string;
  /** Days the daily average divides by (elapsed days while the range contains today). */
  days: number;
  /** Calendar length of the range in days. */
  lengthDays: number;
  /** The range contains today, so it is not over yet. */
  inProgress: boolean;
  previous: { from: string; to: string; days: number };
  /** 'YYYY-MM' when the range is exactly one calendar month, else null. */
  month: string | null;
  currencies: RangeCurrencyOverview[];
}

const SMALL_THRESHOLD: Record<string, number> = { CNY: 3000, USD: 1000 };
const DEFAULT_SMALL_THRESHOLD = 1000;
/** Name reported for rows without a category; the UI shows its own label for categoryId null. */
const UNCATEGORIZED = "Uncategorized";
const LARGEST = 5;

export function smallPaymentThreshold(currency: string): number {
  return SMALL_THRESHOLD[currency] ?? DEFAULT_SMALL_THRESHOLD;
}

/** Today in the server's local time; rangeOverview defaults to today in the user's zone instead. */
export function localToday(): string {
  const d = clockNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Σ others' owed on shared rows I paid (from my account, or my split row records the payment). */
export function receivable(r: SpendingRow): number {
  if (!countsAsSpending(r) || r.splits.length === 0) return 0;
  const othersPaid = r.splits.some((s) => !s.isSelf && s.paidMinor > 0);
  const selfPaid = r.splits.some((s) => s.isSelf && s.paidMinor > 0);
  if (othersPaid || !(selfPaid || r.accountId != null)) return 0;
  const owed = r.splits.filter((s) => !s.isSelf).reduce((a, s) => a + s.owedMinor, 0);
  return r.amountMinor > 0 ? -owed : owed;
}

/** Days to average over: the whole range once it is over, the elapsed part while it contains today, 1 before it starts. */
function divisorDays(r: DateRange, today: string): number {
  if (today > r.to) return daysInclusive(r.from, r.to);
  if (today < r.from) return 1;
  return daysInclusive(r.from, today);
}

const isIncome = (r: SpendingRow) => r.kind === "income" && r.status === "ok" && r.duplicateOfId == null;

function metrics(rows: readonly SpendingRow[], days: number): PeriodMetrics {
  const spend = rows.filter(countsAsSpending);
  const spendingMinor = spend.reduce((a, r) => a + r.myShareMinor, 0);
  return {
    spendingMinor,
    incomeMinor: rows.filter(isIncome).reduce((a, r) => a + r.amountMinor, 0),
    transactionCount: spend.length,
    dailyAverageMinor: Math.round(spendingMinor / days),
  };
}

/**
 * Spending statistics for an arbitrary period (inclusive dates, at most five years), per currency and
 * never summed across currencies. The spending rule is ledger/share.ts: my share of expense and
 * refund rows, closed rows and linked duplicates excluded, transfers never counted.
 */
export async function rangeOverview(
  db: Db,
  user: CurrentUser,
  range: DateRange,
  opts: { today?: string; largest?: number } = {},
): Promise<RangeOverview> {
  assertRange(range);
  const today = opts.today ?? todayIn(await getTimeZone(db, user));
  if (!isDate(today)) throw new LedgerError("invalid_input", "invalid_date", `Invalid date: ${today}`, { value: today });
  const userId = user.id;
  const rows = await loadRangeRows(db, userId, range.from, range.to);
  const prevRange = previousRange(range);
  const prevRows = await loadRangeRows(db, userId, prevRange.from, prevRange.to);
  const days = divisorDays(range, today);
  const prevDays = divisorDays(prevRange, today);
  const single = wholeMonths(range) === 1 ? range.from.slice(0, 7) : null;
  const target = single ? await getMonthlyTarget(db, user, single) : null;
  const names = new Map(
    (await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.userId, userId))
      )
      .map((c) => [c.id, c.name]),
  );

  // Months for the trend: every month the range touches that has started, plus any later one with rows.
  const touched = monthsIn(range);
  const seriesMonths =
    touched.length > 1
      ? touched.filter((m) => monthStart(m) <= today || rows.some((r) => countsAsSpending(r) && r.occurredOn.startsWith(m)))
      : null;

  const currencies = new Set<string>();
  for (const r of rows) {
    if (r.status === "ok" && r.duplicateOfId == null && r.kind !== "transfer") currencies.add(r.currency);
  }
  if (target) currencies.add(target.currency);

  const out: RangeCurrencyOverview[] = [];
  for (const currency of currencies) {
    const mine = rows.filter((r) => r.currency === currency);
    const spend = mine.filter(countsAsSpending);
    const m = metrics(mine, days);
    const { spendingMinor } = m;

    const cats = new Map<number | null, CategoryShare>();
    for (const r of spend) {
      const c = cats.get(r.categoryId) ?? {
        categoryId: r.categoryId,
        name: r.categoryId == null ? UNCATEGORIZED : (names.get(r.categoryId) ?? UNCATEGORIZED),
        minor: 0,
        count: 0,
        share: 0,
      };
      c.minor += r.myShareMinor;
      c.count += 1;
      cats.set(r.categoryId, c);
    }
    const byCategory = [...cats.values()]
      .map((c) => ({ ...c, share: spendingMinor > 0 ? Math.round((c.minor * 10000) / spendingMinor) : 0 }))
      .sort((a, b) => b.minor - a.minor || a.name.localeCompare(b.name));

    const thresholdMinor = smallPaymentThreshold(currency);
    const small = spend.filter((r) => r.kind === "expense" && r.myShareMinor > 0 && -r.amountMinor <= thresholdMinor);
    const largest = spend
      .filter((r) => r.kind === "expense" && r.myShareMinor > 0)
      .sort((a, b) => b.myShareMinor - a.myShareMinor || b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, opts.largest ?? LARGEST)
      .map((r) => ({ id: r.id, merchant: r.merchant, minor: r.myShareMinor, occurredAt: r.occurredAt, occurredOn: r.occurredOn }));

    const prevMine = prevRows.filter((r) => r.currency === currency);
    const previous = prevMine.some(countsAsSpending) ? metrics(prevMine, prevDays) : null;

    let monthly: MonthlyPoint[] | null = null;
    if (seriesMonths) {
      const byMonth = new Map<string, number>();
      for (const r of spend) {
        const k = r.occurredOn.slice(0, 7);
        byMonth.set(k, (byMonth.get(k) ?? 0) + r.myShareMinor);
      }
      monthly = seriesMonths.map((month) => ({
        month,
        spendingMinor: byMonth.get(month) ?? 0,
        partial: range.from > monthStart(month) || range.to < monthEnd(month) || today <= monthEnd(month),
      }));
    }

    out.push({
      currency,
      ...m,
      byCategory,
      smallPayments: { thresholdMinor, count: small.length, minor: small.reduce((a, r) => a + r.myShareMinor, 0) },
      largest,
      sharedReceivableMinor: mine.reduce((a, r) => a + receivable(r), 0),
      previous,
      monthly,
      target:
        target && target.currency === currency
          ? {
              amountMinor: target.amountMinor,
              currency,
              remainingMinor: target.amountMinor - spendingMinor,
              monthSpecific: target.month != null,
            }
          : null,
    });
  }
  out.sort((a, b) => b.spendingMinor - a.spendingMinor || a.currency.localeCompare(b.currency));
  return {
    from: range.from,
    to: range.to,
    days,
    lengthDays: daysInclusive(range.from, range.to),
    inProgress: today >= range.from && today <= range.to,
    previous: { ...prevRange, days: prevDays },
    month: single,
    currencies: out,
  };
}
