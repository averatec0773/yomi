import { categories, type Db, settlements } from "@yomi/db";
import { and, eq, isNotNull } from "@yomi/db/orm";
import { assertCurrency } from "../split/internal";
import { loadRangeRows } from "../ledger/transactions";
import { getTimeZone } from "../settings/time-zone";
import { cashFlow, incomeCategories } from "../stats/range";
import { todayIn } from "../time/zone";
import type { CurrentUser } from "../user";
import { type AnalysisSelection, selectionRange } from "./report";

export interface IncomeCategoryTotal {
  /** Dictionary key of a system category; null for one the user made or for rows without a category. */
  key: string | null;
  name: string;
  minor: number;
  count: number;
  counted: boolean;
}

export interface CurrencyIncome {
  currency: string;
  /** Income on categories that count as income. */
  incomeMinor: number;
  incomeNotCountedMinor: number;
  /** My share of spending (the hero number). */
  spendingMinor: number;
  netMinor: number;
  /** Basis points of income; null without income. */
  savingsRateBp: number | null;
  byCategory: IncomeCategoryTotal[];
  /** Money in on transfer rows that are not repayments (between my own accounts, payments arriving on a card). */
  transfersInMinor: number;
  /** Money friends paid me back (rows recorded as a settlement). */
  repaymentsMinor: number;
}

export interface IncomeSummary {
  from: string;
  to: string;
  currencies: CurrencyIncome[];
}

/**
 * Income and cash flow for an Analysis selection, per currency and never summed across currencies: counted income,
 * income on categories that do not count, spending (my share), net, savings rate, income per category, and the money in
 * that is not income (transfers, repayments). One function for the API and the MCP read; `currency` keeps one.
 */
export async function incomeSummary(
  db: Db,
  user: CurrentUser,
  sel: AnalysisSelection & { currency?: string },
  opts: { today?: string } = {},
): Promise<IncomeSummary> {
  const range = selectionRange(sel, opts.today ?? todayIn(await getTimeZone(db, user)));
  const only = sel.currency === undefined ? null : assertCurrency(sel.currency);
  const rows = (await loadRangeRows(db, user.id, range.from, range.to)).filter((r) => r.status === "ok" && r.duplicateOfId == null);
  const cats = await db.select({ id: categories.id, name: categories.name, key: categories.key }).from(categories).where(eq(categories.userId, user.id));
  const names = new Map(cats.map((c) => [c.id, c.name]));
  const keys = new Map(cats.map((c) => [c.id, c.key]));
  const settled = new Set(
    (await db
      .select({ id: settlements.transactionId })
      .from(settlements)
      .where(and(eq(settlements.userId, user.id), eq(settlements.kind, "payment"), isNotNull(settlements.transactionId)))).map((s) => s.id!),
  );
  const currencies = [...new Set(rows.filter((r) => r.kind !== "transfer" || r.amountMinor > 0).map((r) => r.currency))]
    .filter((c) => only === null || c === only)
    .sort();
  return {
    from: range.from,
    to: range.to,
    currencies: currencies.map((currency) => {
      const mine = rows.filter((r) => r.currency === currency);
      const moneyIn = mine.filter((r) => r.kind === "transfer" && r.amountMinor > 0);
      return {
        currency,
        ...cashFlow(mine),
        byCategory: incomeCategories(mine, names).map((c) => ({ key: c.categoryId == null ? null : (keys.get(c.categoryId) ?? null), name: c.name, minor: c.minor, count: c.count, counted: c.counted })),
        transfersInMinor: moneyIn.filter((r) => !settled.has(r.id)).reduce((a, r) => a + r.amountMinor, 0),
        repaymentsMinor: moneyIn.filter((r) => settled.has(r.id)).reduce((a, r) => a + r.amountMinor, 0),
      };
    }),
  };
}
