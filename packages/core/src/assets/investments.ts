import { type Db, investmentAccounts, investmentTransactions, type InvestTxnType, securities } from "@yomi/db";
import { and, desc, eq, inArray } from "@yomi/db/orm";
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
