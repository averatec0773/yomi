import { type Db, investmentAccounts, investmentTransactions, type InvestTxnType, securities } from "@yomi/db";
import { and, asc, desc, eq, gte, inArray, lte } from "@yomi/db/orm";
import type { CurrentUser } from "../user";

export interface InvestmentActivity {
  id: number;
  accountName: string;
  date: string;
  type: InvestTxnType;
  symbol: string | null;
  /** Exact decimal string from the source; null for cash activity. */
  quantity: string | null;
  /** Positive = cash into the account. */
  amountMinor: number;
  currency: string;
}

export interface InvestFlow {
  date: string;
  /** transfer: cash deposited (positive) or withdrawn (negative); trades and dividends move cash inside the account. */
  type: "buy" | "sell" | "dividend" | "transfer";
  symbol: string | null;
  /** Positive = cash into the account. */
  amountMinor: number;
  currency: string;
  accountName: string;
  /** The amount in the converted currency (the same rate as the net worth); null without one. */
  convertedMinor: number | null;
}

/**
 * Trades, dividends and cash deposits or withdrawals of every investment account from `from` to `to`
 * (inclusive), oldest first. Transfers of securities (a transfer row with a security) are not cash and left out.
 */
export async function investmentFlows(db: Db, user: CurrentUser, range: { from: string; to: string }): Promise<InvestFlow[]> {
  const rows = await db
    .select({
      date: investmentTransactions.date,
      type: investmentTransactions.type,
      securityId: investmentTransactions.securityId,
      symbol: securities.symbol,
      amountMinor: investmentTransactions.amountMinor,
      currency: investmentTransactions.currency,
      accountName: investmentAccounts.name,
    })
    .from(investmentTransactions)
    .innerJoin(investmentAccounts, eq(investmentAccounts.id, investmentTransactions.investmentAccountId))
    .leftJoin(securities, eq(securities.id, investmentTransactions.securityId))
    .where(
      and(
        eq(investmentTransactions.userId, user.id),
        gte(investmentTransactions.date, range.from),
        lte(investmentTransactions.date, range.to),
        inArray(investmentTransactions.type, ["buy", "sell", "dividend", "transfer"]),
      ),
    )
    .orderBy(asc(investmentTransactions.date), asc(investmentTransactions.id));
  return rows
    .filter((r) => r.type !== "transfer" || r.securityId == null)
    .map((r) => ({
      date: r.date,
      type: r.type as InvestFlow["type"],
      symbol: r.symbol,
      amountMinor: r.amountMinor,
      currency: r.currency,
      accountName: r.accountName,
      convertedMinor: null,
    }));
}

/** Latest dividends and trades (buy, sell, dividend, interest) across investment accounts, newest first. */
export async function recentInvestmentActivity(db: Db, user: CurrentUser, opts: { limit?: number } = {}): Promise<InvestmentActivity[]> {
  return await db
    .select({
      id: investmentTransactions.id,
      accountName: investmentAccounts.name,
      date: investmentTransactions.date,
      type: investmentTransactions.type,
      symbol: securities.symbol,
      quantity: investmentTransactions.quantity,
      amountMinor: investmentTransactions.amountMinor,
      currency: investmentTransactions.currency,
    })
    .from(investmentTransactions)
    .innerJoin(investmentAccounts, eq(investmentAccounts.id, investmentTransactions.investmentAccountId))
    .leftJoin(securities, eq(securities.id, investmentTransactions.securityId))
    .where(and(eq(investmentTransactions.userId, user.id), inArray(investmentTransactions.type, ["buy", "sell", "dividend", "interest"])))
    .orderBy(desc(investmentTransactions.date), desc(investmentTransactions.id))
    .limit(opts.limit ?? 8);
}
