import { type Db, holdingSnapshots, investmentAccounts, investmentDailyNav, investmentTransactions, securities } from "@yomi/db";
import { addDec, decimalToMinor, formatDec, type InvestStatement, type Notice, notice, parseDec } from "@yomi/importers";
import { and, eq, max } from "@yomi/db/orm";
import { minorDigits } from "../money";
import type { CurrentUser } from "../user";

export interface WriteStatementResult {
  asOf: string;
  accounts: number;
  positions: number;
  cashBalances: number;
  transactionsNew: number;
  transactionsUpdated: number;
  /** Daily account values (IBKR NAV in Base) written or overwritten. */
  navDays: number;
  /** Market value per currency of what was written, minor units. */
  totals: Record<string, number>;
  warnings: Notice[];
}

export const positionKey = (securityId: number | null, currency: string) => (securityId == null ? `cash:${currency}` : `sec:${securityId}`);

/**
 * Stores one provider pull in a single DB transaction. Accounts and securities are upserted by the
 * provider's id; each account's holdings for `statement.asOf` replace whatever that day already had
 * (a second run on the same day overwrites, a position sold since disappears); investment
 * transactions are upserted by (account, external id); daily values (NAV) by (account, day), so a re-pull
 * overwrites the same day. Decimal strings become minor units here, with
 * one rounding step each.
 */
export async function writeStatement(db: Db, user: CurrentUser, statement: InvestStatement, opts: { bankConnectionId?: number | null } = {}): Promise<WriteStatementResult> {
  const provider = statement.source;
  const out: WriteStatementResult = {
    asOf: statement.asOf,
    accounts: 0,
    positions: 0,
    cashBalances: 0,
    transactionsNew: 0,
    transactionsUpdated: 0,
    navDays: 0,
    totals: {},
    warnings: [...statement.warnings],
  };
  await db.transaction(async (tx) => {
    const accountIds = new Map<string, number>();
    for (const a of statement.accounts) {
      const id = (await tx
        .insert(investmentAccounts)
        .values({ userId: user.id, provider, externalId: a.externalId, bankConnectionId: opts.bankConnectionId ?? null, name: a.name, currency: a.currency })
        .onConflictDoUpdate({
          target: [investmentAccounts.userId, investmentAccounts.provider, investmentAccounts.externalId],
          set: { name: a.name, currency: a.currency, ...(opts.bankConnectionId != null ? { bankConnectionId: opts.bankConnectionId } : {}) },
        })
        .returning({ id: investmentAccounts.id })
        )[0]!.id;
      accountIds.set(a.externalId, id);
      out.accounts += 1;
    }

    const securityIds = new Map<string, number>();
    for (const s of statement.securities) {
      const values = { symbol: s.symbol, name: s.name, type: s.type, currency: s.currency, isin: s.isin, cusip: s.cusip, multiplier: s.multiplier };
      const id = (await tx
        .insert(securities)
        .values({ userId: user.id, provider, externalId: s.externalId, ...values })
        .onConflictDoUpdate({ target: [securities.userId, securities.provider, securities.externalId], set: values })
        .returning({ id: securities.id })
        )[0]!.id;
      securityIds.set(s.externalId, id);
    }

    for (const accountId of accountIds.values()) {
      await tx.delete(holdingSnapshots)
        .where(and(eq(holdingSnapshots.investmentAccountId, accountId), eq(holdingSnapshots.asOf, statement.asOf)));
    }
    // Two rows for one key (IBKR repeats cash per currency segment, a Plaid account can list the same
    // security twice) are summed into one snapshot row.
    const rows = new Map<string, typeof holdingSnapshots.$inferInsert>();
    for (const h of statement.holdings) {
      const accountId = accountIds.get(h.accountExternalId);
      if (accountId == null) {
        out.warnings.push(notice("invest_holding_unknown_account", "Holding for an account not in the statement skipped"));
        continue;
      }
      const securityId = h.securityExternalId == null ? null : (securityIds.get(h.securityExternalId) ?? null);
      if (h.securityExternalId != null && securityId == null) {
        out.warnings.push(notice("invest_holding_unknown_security", "Holding for a security not in the statement skipped"));
        continue;
      }
      const digits = minorDigits(h.currency);
      const key = `${accountId}|${positionKey(securityId, h.currency)}`;
      const marketValueMinor = decimalToMinor(h.marketValue, digits);
      const costBasisMinor = h.costBasis == null ? null : decimalToMinor(h.costBasis, digits);
      const prev = rows.get(key);
      if (prev) {
        out.warnings.push(notice("invest_duplicate_position_merged", "Duplicate rows for one position merged", { positionKey: positionKey(securityId, h.currency) }));
        prev.marketValueMinor += marketValueMinor;
        prev.quantity = formatDec(addDec(parseDec(prev.quantity), parseDec(h.quantity)));
        prev.costBasisMinor = prev.costBasisMinor == null || costBasisMinor == null ? null : prev.costBasisMinor + costBasisMinor;
        continue;
      }
      rows.set(key, {
        userId: user.id,
        investmentAccountId: accountId,
        securityId,
        positionKey: positionKey(securityId, h.currency),
        asOf: statement.asOf,
        quantity: h.quantity,
        price: h.price,
        marketValueMinor,
        costBasisMinor,
        currency: h.currency,
        sourceRaw: JSON.stringify(h.raw),
      });
    }
    for (const r of rows.values()) {
      await tx.insert(holdingSnapshots).values(r);
      if (r.securityId == null) out.cashBalances += 1;
      else out.positions += 1;
      out.totals[r.currency] = (out.totals[r.currency] ?? 0) + r.marketValueMinor;
    }

    for (const t of statement.transactions) {
      const accountId = accountIds.get(t.accountExternalId);
      if (accountId == null) continue;
      const values = {
        securityId: t.securityExternalId == null ? null : (securityIds.get(t.securityExternalId) ?? null),
        date: t.date,
        type: t.type,
        quantity: t.quantity,
        amountMinor: decimalToMinor(t.amount, minorDigits(t.currency)),
        currency: t.currency,
        description: t.description,
        raw: JSON.stringify(t.raw),
      };
      const existed = (await tx
        .select({ id: investmentTransactions.id })
        .from(investmentTransactions)
        .where(and(eq(investmentTransactions.investmentAccountId, accountId), eq(investmentTransactions.externalId, t.externalId)))
        .limit(1))[0];
      await tx.insert(investmentTransactions)
        .values({ userId: user.id, investmentAccountId: accountId, externalId: t.externalId, ...values })
        .onConflictDoUpdate({ target: [investmentTransactions.investmentAccountId, investmentTransactions.externalId], set: values });
      if (existed) out.transactionsUpdated += 1;
      else out.transactionsNew += 1;
    }

    for (const n of statement.navs ?? []) {
      const accountId = accountIds.get(n.accountExternalId);
      if (accountId == null) continue;
      const values = { totalMinor: decimalToMinor(n.total, minorDigits(n.currency)), currency: n.currency, raw: JSON.stringify(n.raw), updatedAt: new Date().toISOString() };
      await tx.insert(investmentDailyNav)
        .values({ userId: user.id, investmentAccountId: accountId, asOf: n.date, ...values })
        .onConflictDoUpdate({ target: [investmentDailyNav.investmentAccountId, investmentDailyNav.asOf], set: values });
      out.navDays += 1;
    }
  });
  return out;
}

/** Latest snapshot date of a provider's accounts, or null when nothing was stored yet. */
export async function latestSnapshotDate(db: Db, user: CurrentUser, provider: "ibkr" | "plaid"): Promise<string | null> {
  const r = (await db
    .select({ asOf: max(holdingSnapshots.asOf) })
    .from(holdingSnapshots)
    .innerJoin(investmentAccounts, eq(investmentAccounts.id, holdingSnapshots.investmentAccountId))
    .where(and(eq(holdingSnapshots.userId, user.id), eq(investmentAccounts.provider, provider)))
    .limit(1))[0];
  return r?.asOf ?? null;
}
