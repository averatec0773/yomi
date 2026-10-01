import type { Db } from "@yomi/db";
import { loadMonthRows } from "../ledger/transactions";
import { monthRangeOf } from "../stats/period";
import { type CategoryShare, type LargestRow, rangeOverview, receivable } from "../stats/range";
import type { CurrentUser } from "../user";
import { assertMonth, type MonthTarget } from "./target";

export { getMonthlyTarget, type MonthTarget, setMonthlyTarget, type TargetItem } from "./target";

export interface MonthCurrencyOverview {
  currency: string;
  /** Σ my share (plan §3). */
  spendingMinor: number;
  incomeMinor: number;
  /** Rows counted as spending. */
  transactionCount: number;
  byCategory: CategoryShare[];
  smallPayments: { thresholdMinor: number; count: number; minor: number };
  largest: LargestRow[];
  /** Same rule, previous month, same currency; null when that month has no spending rows. */
  previousMonthSpendingMinor: number | null;
  dailyAverageMinor: number;
  /** Money I fronted for others on rows I paid (Σ others' owed). */
  sharedReceivableMinor: number;
  target: MonthTarget | null;
}

export interface MonthOverview {
  month: string;
  /** Days the daily average divides by. */
  days: number;
  currencies: MonthCurrencyOverview[];
}

export async function sharedReceivable(db: Db, user: CurrentUser, month: string): Promise<{ currency: string; minor: number }[]> {
  assertMonth(month);
  const map = new Map<string, number>();
  for (const r of (await loadMonthRows(db, user.id, month))) {
    const v = receivable(r);
    if (v !== 0) map.set(r.currency, (map.get(r.currency) ?? 0) + v);
  }
  return [...map].map(([currency, minor]) => ({ currency, minor })).sort((a, b) => a.currency.localeCompare(b.currency));
}

/** One calendar month: rangeOverview over that month, in the pre-v0.1.10 shape. */
export async function monthOverview(db: Db, user: CurrentUser, month: string, opts: { today?: string } = {}): Promise<MonthOverview> {
  assertMonth(month);
  const o = await rangeOverview(db, user, monthRangeOf(month), opts);
  return {
    month,
    days: o.days,
    currencies: o.currencies.map((c) => ({
      currency: c.currency,
      spendingMinor: c.spendingMinor,
      incomeMinor: c.incomeMinor,
      transactionCount: c.transactionCount,
      byCategory: c.byCategory,
      smallPayments: c.smallPayments,
      largest: c.largest,
      previousMonthSpendingMinor: c.previous?.spendingMinor ?? null,
      dailyAverageMinor: c.dailyAverageMinor,
      sharedReceivableMinor: c.sharedReceivableMinor,
      target: c.target,
    })),
  };
}
