import { transactions, transactionSplits, type Db } from "@yomi/db";
import { and, desc, eq, isNotNull, isNull, notExists, type SQL } from "@yomi/db/orm";
import { suggestSplits } from "../split/suggest";
import type { CurrentUser } from "../user";

type Q = Db;

/**
 * "Unsplit" rows (backfill triage): my own card/wallet expenses that count and have no splits yet.
 * kind expense, status ok, not a duplicate, paid from one of my accounts, no transaction_splits.
 */
export function unsplitConditions(db: Q, userId: number): SQL[] {
  return [
    eq(transactions.userId, userId),
    eq(transactions.kind, "expense"),
    eq(transactions.status, "ok"),
    isNull(transactions.duplicateOfId),
    isNotNull(transactions.accountId),
    notExists(
      db
        .select({ id: transactionSplits.id })
        .from(transactionSplits)
        .where(eq(transactionSplits.transactionId, transactions.id)),
    ),
  ];
}

export interface UnsplitCurrencyTotal {
  currency: string;
  count: number;
  /** Σ −amount: positive = spent. */
  amountMinor: number;
}

export interface UnsplitMonth {
  /** "YYYY-MM" */
  month: string;
  count: number;
  totals: UnsplitCurrencyTotal[];
  /** Rows with a split suggestion (merchant rule or the category's learned set), so one tap accepts. */
  suggestedCount: number;
}

/** Unsplit rows per month, newest first; per-currency sums are never added across currencies. */
export async function unsplitSummary(db: Q, user: CurrentUser): Promise<UnsplitMonth[]> {
  const rows = await db
    .select({
      id: transactions.id,
      occurredOn: transactions.occurredOn,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      merchant: transactions.merchant,
      kind: transactions.kind,
      status: transactions.status,
      duplicateOfId: transactions.duplicateOfId,
      categoryId: transactions.categoryId,
      splitSuggestionDismissedAt: transactions.splitSuggestionDismissedAt,
    })
    .from(transactions)
    .where(and(...unsplitConditions(db, user.id)))
    .orderBy(desc(transactions.occurredOn));
  const suggested = await suggestSplits(
    db,
    user,
    rows.map((r) => ({ ...r, hasSplits: false })),
  );

  const months = new Map<string, UnsplitMonth>();
  for (const r of rows) {
    const key = r.occurredOn.slice(0, 7);
    let m = months.get(key);
    if (!m) {
      m = { month: key, count: 0, totals: [], suggestedCount: 0 };
      months.set(key, m);
    }
    m.count += 1;
    if (suggested.has(r.id)) m.suggestedCount += 1;
    let t = m.totals.find((x) => x.currency === r.currency);
    if (!t) {
      t = { currency: r.currency, count: 0, amountMinor: 0 };
      m.totals.push(t);
    }
    t.count += 1;
    t.amountMinor -= r.amountMinor;
  }
  const out = [...months.values()];
  for (const m of out) m.totals.sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency));
  return out;
}
